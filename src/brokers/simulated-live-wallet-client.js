import { randomUUID } from "node:crypto";
import { maskAddress, redactSecrets } from "../config/env.js";

function numberFrom(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export class SimulatedLiveWalletClient {
  constructor(config) {
    this.config = config;
    this.balanceUsd = numberFrom(config.simulatedWalletBalanceUsd, 100);
    this.address = config.simulatedWalletAddress || "0x0000000000000000000000000000000000000000";
  }

  async preflight() {
    return {
      ok: true,
      source: "simulated-live-wallet",
      walletMode: "simulated",
      address: maskAddress(this.address),
      error: null
    };
  }

  async getCollateralBalance() {
    return {
      collateralBalance: this.balanceUsd,
      allowance: this.balanceUsd,
      raw: redactSecrets({
        walletMode: "simulated",
        address: maskAddress(this.address),
        balanceUsd: this.balanceUsd
      })
    };
  }

  async postMarketOrder(order) {
    const filledUsd = Math.min(this.balanceUsd, numberFrom(order.amountUsd, 0));
    if (order.side === "BUY") {
      this.balanceUsd = Math.max(0, this.balanceUsd - filledUsd);
    }
    return {
      ok: filledUsd > 0,
      orderId: `sim-live-${randomUUID()}`,
      avgPrice: null,
      filledUsd,
      raw: {
        walletMode: "simulated",
        originalOrderId: order.orderId,
        address: maskAddress(this.address)
      }
    };
  }
}
