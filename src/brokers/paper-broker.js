import { assertSchema } from "../domain/schemas.js";

export class PaperBroker {
  constructor(stateStore) {
    this.kind = "paper";
    this.stateStore = stateStore;
  }

  async preflight() {
    return { ok: true, broker: this.kind, checks: [{ key: "paper-state", ok: true }] };
  }

  async submit(order, market) {
    const outcome = market.outcomes.find((item) => item.tokenId === order.tokenId);
    const avgPrice = order.side === "SELL"
      ? outcome?.bestBid ?? outcome?.lastPrice ?? 0.5
      : outcome?.bestAsk ?? outcome?.lastPrice ?? 0.5;
    let fill;
    try {
      fill = await this.stateStore.applyPaperFill(order, market, avgPrice);
    } catch (error) {
      const result = assertSchema("OrderResult", {
        orderId: order.orderId,
        status: "rejected",
        mode: "paper",
        requestedUsd: order.amountUsd,
        filledUsd: 0,
        avgPrice,
        reason: error instanceof Error ? error.message : String(error)
      });
      await this.stateStore.recordOrder(result);
      return result;
    }
    const result = assertSchema("OrderResult", {
      orderId: order.orderId,
      status: "filled",
      mode: "paper",
      requestedUsd: order.amountUsd,
      filledUsd: fill.filledUsd,
      avgPrice,
      reason: null
    });
    await this.stateStore.recordOrder(result);
    return result;
  }

  async sync(markets = []) {
    if (markets.length > 0) {
      return await this.stateStore.markToMarket(markets);
    }
    return await this.stateStore.getPortfolio();
  }
}
