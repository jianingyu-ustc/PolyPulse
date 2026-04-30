import { maskAddress, summarizeEnvConfig, validateEnvConfig } from "../config/env.js";
import { LiveBroker } from "../brokers/live-broker.js";

function paperBalance({ config, portfolio }) {
  const address = config.funderAddress || config.simulatedWalletAddress;
  return {
    executionMode: "paper",
    env: summarizeEnvConfig(config, { mode: "paper" }),
    wallet: {
      walletMode: "paper",
      funderAddress: maskAddress(address),
      proxyAddress: maskAddress(address)
    },
    collateral: {
      balanceUsd: portfolio.cashUsd,
      totalEquityUsd: portfolio.totalEquityUsd,
      source: "paper-state"
    },
    positions: {
      count: portfolio.positions.length,
      currentValueUsd: portfolio.positions.reduce((sum, position) => sum + position.currentValueUsd, 0)
    },
    updatedAt: new Date().toISOString()
  };
}

export class AccountService {
  constructor({ config, stateStore, liveBroker = null }) {
    this.config = config;
    this.stateStore = stateStore;
    this.liveBroker = liveBroker ?? new LiveBroker(config);
  }

  async getBalance({ mode = null } = {}) {
    const executionMode = mode ?? this.config.executionMode;
    if (executionMode !== "live") {
      const portfolio = await this.stateStore.getPortfolio();
      return paperBalance({ config: this.config, portfolio });
    }

    const preflight = validateEnvConfig(this.config, { mode: "live" });
    if (!preflight.ok) {
      const missing = preflight.checks.filter((item) => item.blocking && !item.ok).map((item) => item.key);
      throw new Error(`live_preflight_failed: ${missing.join(", ")}`);
    }

    const balance = await this.liveBroker.getBalance();
    const address = this.config.funderAddress || this.config.simulatedWalletAddress;
    return {
      executionMode: "live",
      env: summarizeEnvConfig(this.config, { mode: "live" }),
      wallet: {
        walletMode: this.config.liveWalletMode ?? "real",
        funderAddress: maskAddress(address),
        proxyAddress: maskAddress(address)
      },
      collateral: {
        balanceUsd: balance.collateralBalance,
        allowanceUsd: balance.allowance,
        source: balance.source
      },
      raw: balance.raw,
      updatedAt: new Date().toISOString()
    };
  }
}
