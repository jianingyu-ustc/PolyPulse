import { redactSecrets } from "../config/env.js";

const COLLATERAL_DECIMALS = 6;

function errorSummary(error) {
  const message = error instanceof Error ? error.message : String(error);
  return String(redactSecrets(message));
}

function numberFrom(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function decimalFromCollateralUnits(value, fallback = 0) {
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return numberFrom(value, fallback) / 10 ** COLLATERAL_DECIMALS;
  }
  if (typeof value === "bigint") {
    return Number(value) / 10 ** COLLATERAL_DECIMALS;
  }
  return numberFrom(value, fallback);
}

function normalizePrivateKey(privateKey) {
  const trimmed = String(privateKey ?? "").trim();
  const normalized = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new Error("PRIVATE_KEY must be a 32-byte hex private key.");
  }
  return normalized;
}

function extractCollateralBalance(raw) {
  const normalizedCandidates = [
    raw?.collateral,
    raw?.collateralBalance,
    raw?.collateral_balance,
    raw?.available,
    raw?.availableBalance
  ];
  const value = normalizedCandidates.find((item) => item != null);
  if (value != null) {
    return numberFrom(value, 0);
  }
  if (raw?.balance != null) {
    return decimalFromCollateralUnits(raw.balance, 0);
  }
  return 0;
}

function extractAllowance(raw) {
  const candidates = [
    raw?.allowance,
    raw?.collateralAllowance,
    raw?.collateral_allowance
  ];
  const value = candidates.find((item) => item != null);
  return numberFrom(value, 0);
}

export class LivePolymarketClient {
  constructor(config) {
    this.config = config;
    this.cachedClient = null;
  }

  async preflight() {
    try {
      await this.getClient();
      return { ok: true, source: "polymarket-clob-client", error: null };
    } catch (error) {
      return { ok: false, source: "polymarket-clob-client", error: errorSummary(error) };
    }
  }

  async getClient() {
    if (this.cachedClient) {
      return this.cachedClient;
    }
    let clobModule;
    let viemModule;
    let viemAccountsModule;
    try {
      clobModule = await import("@polymarket/clob-client-v2");
      viemModule = await import("viem");
      viemAccountsModule = await import("viem/accounts");
    } catch (error) {
      throw new Error(`Polymarket SDK unavailable: ${errorSummary(error)}`);
    }
    const { ClobClient } = clobModule;
    const { createWalletClient, custom } = viemModule;
    const { privateKeyToAccount } = viemAccountsModule;
    const account = privateKeyToAccount(normalizePrivateKey(this.config.privateKey));
    const signer = createWalletClient({
      account,
      // CLOB auth only needs local EIP-712 signing; no Polygon RPC is required here.
      transport: custom({
        request: async ({ method }) => {
          if (method === "eth_accounts" || method === "eth_requestAccounts") {
            return [account.address];
          }
          throw new Error(`Unsupported wallet RPC method: ${method}`);
        }
      })
    });
    const boot = new ClobClient({
      host: this.config.polymarketHost,
      chain: this.config.chainId,
      signer
    });
    const derive = boot.deriveApiKey?.bind(boot);
    const createOrDerive = boot.createOrDeriveApiKey?.bind(boot);
    const creds = derive ? await derive() : createOrDerive ? await createOrDerive() : null;
    if (!creds) {
      throw new Error("Polymarket SDK did not return API credentials.");
    }
    this.cachedClient = new ClobClient({
      host: this.config.polymarketHost,
      chain: this.config.chainId,
      signer,
      creds,
      signatureType: Number(this.config.signatureType),
      funderAddress: this.config.funderAddress
    });
    return this.cachedClient;
  }

  async getCollateralBalance() {
    const client = await this.getClient();
    const raw = await client.getBalanceAllowance({ asset_type: "COLLATERAL" });
    return {
      collateralBalance: extractCollateralBalance(raw),
      allowance: extractAllowance(raw),
      raw: redactSecrets(raw)
    };
  }

  async postMarketOrder(order) {
    const client = await this.getClient();
    const clobModule = await import("@polymarket/clob-client-v2").catch(() => ({}));
    const sideValue = order.side === "BUY" ? clobModule.Side?.BUY ?? "BUY" : clobModule.Side?.SELL ?? "SELL";
    const orderType = clobModule.OrderType?.FOK ?? "FOK";
    const response = await client.createAndPostMarketOrder(
      {
        tokenID: order.tokenId,
        amount: order.amountUsd,
        side: sideValue,
        orderType
      },
      undefined,
      orderType
    );
    const taking = numberFrom(response?.takingAmount, 0);
    const making = numberFrom(response?.makingAmount, 0);
    const avgPrice = making > 0 && taking > 0
      ? order.side === "BUY" ? making / taking : taking / making
      : numberFrom(response?.price ?? response?.avgPrice, null);
    const filledUsd = order.side === "BUY"
      ? making > 0 ? making : order.amountUsd
      : taking > 0 ? taking : order.amountUsd * (avgPrice ?? 0);
    return {
      ok: Boolean(response?.success ?? response?.orderID ?? response?.orderId),
      orderId: response?.orderID ?? response?.orderId ?? order.orderId,
      avgPrice,
      filledUsd,
      raw: redactSecrets(response)
    };
  }
}

export function summarizeLiveClientError(error) {
  return errorSummary(error);
}
