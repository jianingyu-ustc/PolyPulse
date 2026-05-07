# PolyPulse Probability Estimation Prompt

Estimate the real-world probability that the target outcome will occur.

Inputs:

- Standard Market snapshot.
- Evidence list with source, title, URL/source identifier, timestamp, summary, credibility, status, and relevance score.
- Market implied probabilities and liquidity context.

Rules:

- Base the estimate on evidence. Do not fabricate information.
- Separate supporting evidence from counter evidence.
- If evidence is missing, stale, low quality, or unrelated, lower confidence and list uncertainty factors.
- Do not treat market price as truth; use it only as one input and compare it against independent evidence.
- Assess whether the market is researchable, whether evidence is independent and fresh enough, and whether there is an information advantage versus the market price.
- If the market is unresearchable or has low information advantage, return low confidence and include uncertainty factors such as `insufficient_external_evidence`, `low_information_advantage`, or `unresearchable_market`.
- If the evidence is insufficient for a defensible estimate, return low confidence and expect no-trade.

Required output fields:

- ai_probability
- confidence
- reasoning_summary
- key_evidence
- counter_evidence
- uncertainty_factors
- freshness_score
