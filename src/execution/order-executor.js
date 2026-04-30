import { assertSchema } from "../domain/schemas.js";

function blockedOrderResult({ risk, mode }) {
  return assertSchema("OrderResult", {
    orderId: risk.order?.orderId ?? "blocked-before-order",
    status: "blocked",
    mode,
    requestedUsd: risk.order?.amountUsd ?? 0,
    filledUsd: 0,
    avgPrice: null,
    reason: risk.reasons?.length ? risk.reasons.join(",") : "risk_not_allowed"
  });
}

export class OrderExecutor {
  constructor({ paperBroker, liveBroker }) {
    this.paperBroker = paperBroker;
    this.liveBroker = liveBroker;
  }

  async execute({ risk, market, mode = "paper", confirmation = null }) {
    if (!risk?.allowed || !risk.order) {
      return blockedOrderResult({ risk: risk ?? { reasons: ["missing_risk_decision"] }, mode });
    }
    const broker = mode === "live" ? this.liveBroker : this.paperBroker;
    if (!broker) {
      return blockedOrderResult({ risk: { order: risk.order, reasons: [`${mode}_broker_unavailable`] }, mode });
    }
    return await broker.submit(risk.order, market, confirmation);
  }
}
