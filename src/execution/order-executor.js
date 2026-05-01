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
  constructor({ liveBroker }) {
    this.liveBroker = liveBroker;
  }

  async execute({ risk, market, mode = "live", confirmation = null }) {
    if (mode !== "live") {
      return blockedOrderResult({ risk: { order: risk?.order, reasons: [`unsupported_execution_mode:${mode}`] }, mode });
    }
    if (!risk?.allowed || !risk.order) {
      return blockedOrderResult({ risk: risk ?? { reasons: ["missing_risk_decision"] }, mode });
    }
    if (!this.liveBroker) {
      return blockedOrderResult({ risk: { order: risk.order, reasons: ["live_broker_unavailable"] }, mode });
    }
    return await this.liveBroker.submit(risk.order, market, confirmation);
  }
}
