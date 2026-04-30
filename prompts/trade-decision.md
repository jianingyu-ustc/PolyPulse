# PolyPulse Trade Decision Prompt

Compare the AI probability estimate against the market implied probability and decide whether a trade candidate exists.

Inputs:

- Market snapshot.
- ProbabilityEstimate.
- PortfolioSnapshot.
- Risk configuration summary.

Rules:

- AI output is advisory. Final execution must pass RiskEngine.
- Do not trade on low confidence, stale evidence, missing prices, missing token ids, or unsupported claims.
- Compute edge as `ai_probability - market_implied_probability` for the suggested side.
- Compute expected value before risk controls.
- If edge is negative, too small, or evidence is insufficient, output no-trade with a concrete reason.
- Never bypass live confirmation, preflight, dry-run, or recommend-only controls.

Required output fields:

- suggested_side
- market_implied_probability
- edge
- expected_value
- suggested_notional_before_risk
- action
- no_trade_reason
