import { randomUUID } from "node:crypto";
import { maskAddress, redactSecrets } from "../config/env.js";

function numberFrom(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export class PaperOrderClient {
  constructor(config) {
    this.config = config;
    this.balanceUsd = 0;
    this.address = config.funderAddress || "0x0000000000000000000000000000000000000000";
  }

  setBalance(usd) {
    this.balanceUsd = numberFrom(usd, 0);
  }

  async preflight() {
    return {
      ok: true,
      source: "paper-wallet",
      executionMode: "paper",
      address: maskAddress(this.address),
      error: null
    };
  }

  async getCollateralBalance() {
    return {
      collateralBalance: this.balanceUsd,
      allowance: this.balanceUsd,
      raw: redactSecrets({
        executionMode: "paper",
        address: maskAddress(this.address),
        balanceUsd: this.balanceUsd,
        allowanceUsd: this.balanceUsd
      })
    };
  }

  async updateCollateralAllowance() {
    return {
      ok: true,
      collateralBalance: this.balanceUsd,
      allowance: this.balanceUsd,
      raw: {
        executionMode: "paper",
        address: maskAddress(this.address),
        balanceUsd: this.balanceUsd,
        allowanceUsd: this.balanceUsd
      }
    };
  }

  async postMarketOrder(order) {
    const filledUsd = Math.min(this.balanceUsd, numberFrom(order.amountUsd, 0));
    if (order.side === "BUY") {
      this.balanceUsd = Math.max(0, this.balanceUsd - filledUsd);
    }
    return {
      ok: filledUsd > 0,
      orderId: `paper-${randomUUID()}`,
      avgPrice: null,
      filledUsd,
      raw: {
        executionMode: "paper",
        originalOrderId: order.orderId,
        address: maskAddress(this.address)
      }
    };
  }
}
