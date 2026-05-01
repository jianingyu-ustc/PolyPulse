# Predict-Raven Lessons Applied

Last updated: 2026-05-06

PolyPulse keeps the useful separation of duties:

- AI estimates probability and cites evidence.
- Code computes fees, edge, Kelly sizing, ranking, risk, and executable orders.
- Broker execution is never controlled by provider output.
- Provider runtime receives a bounded market snapshot, evidence JSON, risk doc,
  and output schema.

PolyPulse does not keep alternate market sources or alternate execution modes.
The only supported market source is current Polymarket Gamma, and the only
supported execution mode is live.
