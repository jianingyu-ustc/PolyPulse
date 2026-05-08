import { assertSchema } from "../domain/schemas.js";
import { maskAddress, redactSecrets, validateEnvConfig } from "../config/env.js";
import { LivePolymarketClient, summarizeLiveClientError } from "./live-polymarket-client.js";
import { SimulatedLiveWalletClient } from "./simulated-live-wallet-client.js";

function blockedResult(order, reason) {
  return assertSchema("OrderResult", {
    orderId: order.orderId,
    status: "blocked",
    requestedUsd: order.amountUsd,
    filledUsd: 0,
    avgPrice: null,
    reason
  });
}

export class LiveBroker {
  constructor(config) {
    this.kind = "live";
    this.config = config;
    this.dynamicFeeService = config.dynamicFeeService ?? null;
    this.client = config.liveWalletMode === "simulated"
      ? new SimulatedLiveWalletClient(config)
      : new LivePolymarketClient(config);
  }

  async preflight() {
    const env = validateEnvConfig(this.config);
    if (!env.ok) {
      return {
        ...env,
        ok: false,
        broker: this.kind,
        client: { ok: false, source: "not_checked", error: "env_preflight_failed" }
      };
    }
    const client = await this.client.preflight();
    return {
      ...env,
      ok: env.ok && client.ok,
      broker: this.kind,
      client,
      account: {
        walletMode: this.config.liveWalletMode ?? "real",
        funderAddress: maskAddress(this.config.funderAddress || this.config.simulatedWalletAddress)
      }
    };
  }

  async getBalance() {
    const preflight = await this.preflight();
    if (!preflight.ok) {
      throw new Error(`live_preflight_failed: ${preflight.client?.error ?? "env"}`);
    }
    try {
      const balance = await this.client.getCollateralBalance();
      return {
        source: this.config.liveWalletMode === "simulated" ? "simulated-live-wallet" : "polymarket-clob",
        collateralBalance: balance.collateralBalance,
        allowance: balance.allowance,
        raw: redactSecrets(balance.raw)
      };
    } catch (error) {
      throw new Error(`live_balance_failed: ${summarizeLiveClientError(error)}`);
    }
  }

  async approveCollateralAllowance() {
    const preflight = await this.preflight();
    if (!preflight.ok) {
      throw new Error(`live_preflight_failed: ${preflight.client?.error ?? "env"}`);
    }
    try {
      const updated = await this.client.updateCollateralAllowance();
      return {
        source: this.config.liveWalletMode === "simulated" ? "simulated-live-wallet" : "polymarket-clob",
        collateralBalance: updated.collateralBalance,
        allowance: updated.allowance,
        raw: redactSecrets(updated.raw)
      };
    } catch (error) {
      throw new Error(`live_allowance_update_failed: ${summarizeLiveClientError(error)}`);
    }
  }

  async getOpenOrders(params = {}) {
    if (typeof this.client.getOpenOrders !== "function") {
      return [];
    }
    return await this.client.getOpenOrders(params);
  }

  async getTrades(params = {}) {
    if (typeof this.client.getTrades !== "function") {
      return [];
    }
    return await this.client.getTrades(params);
  }

  async submit(order, _market, confirmation = null) {
    if (confirmation !== "LIVE") {
      return blockedResult(order, "live_requires_confirm_live");
    }
    const preflight = await this.preflight();
    if (!preflight.ok) {
      return blockedResult(order, "live_preflight_failed");
    }
    let balance;
    try {
      balance = await this.getBalance();
    } catch (error) {
      return blockedResult(order, `live_balance_failed: ${summarizeLiveClientError(error)}`);
    }
    if (order.side === "BUY" && Number(balance.collateralBalance) < order.amountUsd) {
      return blockedResult(order, "insufficient_live_collateral");
    }
    if (order.side === "BUY" && Number(balance.allowance) < order.amountUsd) {
      return blockedResult(order, "insufficient_live_allowance");
    }
    let feeVerification = null;
    if (this.dynamicFeeService) {
      try {
        feeVerification = await this.dynamicFeeService.verifyAndLog({
          tokenId: order.tokenId,
          conditionId: _market?.marketId,
          marketSlug: _market?.marketSlug,
          categorySlug: _market?.category,
          market: _market
        });
      } catch {
        // fee verification failure must not block order execution
      }
    }
    try {
      const posted = await this.client.postMarketOrder(order);
      return assertSchema("OrderResult", {
        orderId: posted.orderId ?? order.orderId,
        status: posted.ok ? "filled" : "rejected",
        requestedUsd: order.amountUsd,
        filledUsd: Number(posted.filledUsd ?? 0),
        avgPrice: posted.avgPrice ?? null,
        reason: posted.ok ? null : "polymarket_order_rejected",
        raw: redactSecrets(posted.raw),
        feeVerification
      });
    } catch (error) {
      return assertSchema("OrderResult", {
        orderId: order.orderId,
        status: "rejected",
        requestedUsd: order.amountUsd,
        filledUsd: 0,
        avgPrice: null,
        reason: `live_order_failed: ${summarizeLiveClientError(error)}`
      });
    }
  }

  async sync() {
    const balance = await this.getBalance();
    return {
      accountId: maskAddress(this.config.funderAddress || this.config.simulatedWalletAddress),
      cashUsd: balance.collateralBalance,
      totalEquityUsd: balance.collateralBalance,
      positions: [],
      updatedAt: new Date().toISOString()
    };
  }
}
