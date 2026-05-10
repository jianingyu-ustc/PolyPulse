import { assertSchema } from "../domain/schemas.js";
import { maskAddress, redactSecrets, validateEnvConfig } from "../config/env.js";
import { LivePolymarketClient, summarizeLiveClientError } from "./live-polymarket-client.js";
import { PaperOrderClient } from "./paper-order-client.js";

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
    const liveClient = new LivePolymarketClient(config);
    this.queryClient = liveClient;
    this.client = config.executionMode === "paper"
      ? new PaperOrderClient(config)
      : liveClient;
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
        executionMode: this.config.executionMode ?? "live",
        funderAddress: maskAddress(this.config.funderAddress)
      }
    };
  }

  async getBalance() {
    const preflight = await this.preflight();
    if (!preflight.ok) {
      throw new Error(`live_preflight_failed: ${preflight.client?.error ?? "env"}`);
    }
    try {
      const balance = await this.queryClient.getCollateralBalance();
      return {
        source: "polymarket-clob",
        collateralBalance: balance.collateralBalance,
        allowance: balance.allowance,
        raw: redactSecrets(balance.raw)
      };
    } catch (queryError) {
      if (this.config.executionMode === "paper") {
        const balance = await this.client.getCollateralBalance();
        return {
          source: "paper-wallet",
          collateralBalance: balance.collateralBalance,
          allowance: balance.allowance,
          raw: redactSecrets(balance.raw)
        };
      }
      throw new Error(`live_balance_failed: ${summarizeLiveClientError(queryError)}`);
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
        source: this.config.executionMode === "paper" ? "paper-wallet" : "polymarket-clob",
        collateralBalance: updated.collateralBalance,
        allowance: updated.allowance,
        raw: redactSecrets(updated.raw)
      };
    } catch (error) {
      throw new Error(`live_allowance_update_failed: ${summarizeLiveClientError(error)}`);
    }
  }

  async getOpenOrders(params = {}) {
    try {
      return await this.queryClient.getOpenOrders(params);
    } catch {
      return [];
    }
  }

  async getTrades(params = {}) {
    try {
      return await this.queryClient.getTrades(params);
    } catch {
      return [];
    }
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
      accountId: maskAddress(this.config.funderAddress),
      cashUsd: balance.collateralBalance,
      totalEquityUsd: balance.collateralBalance,
      positions: [],
      updatedAt: new Date().toISOString()
    };
  }
}
