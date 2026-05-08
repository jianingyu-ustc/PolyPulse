const primitiveChecks = {
  string: (value) => typeof value === "string",
  number: (value) => typeof value === "number" && Number.isFinite(value),
  boolean: (value) => typeof value === "boolean",
  object: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
  array: (value) => Array.isArray(value)
};

export const schemas = {
  Outcome: {
    id: "string",
    label: "string",
    tokenId: "string",
    bestBid: "number?",
    bestAsk: "number?",
    lastPrice: "number?",
    impliedProbability: "number?"
  },
  Market: {
    marketId: "string",
    eventId: "string",
    marketSlug: "string",
    eventSlug: "string",
    question: "string",
    title: "string?",
    marketUrl: "string?",
    outcomes: "array",
    endDate: "string?",
    resolutionRules: "string?",
    resolutionSourceUrl: "string?",
    liquidityUsd: "number",
    volumeUsd: "number",
    volume24hUsd: "number",
    category: "string?",
    tags: "array",
    active: "boolean",
    closed: "boolean",
    tradable: "boolean",
    source: "string",
    riskFlags: "array",
    fetchedAt: "string"
  },
  Evidence: {
    evidenceId: "string",
    marketId: "string",
    source: "string",
    sourceUrl: "string?",
    url: "string?",
    title: "string",
    summary: "string",
    status: "string",
    credibility: "string",
    retrievedAt: "string",
    timestamp: "string",
    relevanceScore: "number",
    relevance_score: "number"
  },
  ProbabilityEstimate: {
    marketId: "string",
    targetOutcome: "string",
    ai_probability: "number",
    aiProbability: "number",
    confidence: "string",
    reasoning_summary: "string",
    reasoningSummary: "string",
    key_evidence: "array",
    keyEvidence: "array",
    counter_evidence: "array",
    counterEvidence: "array",
    uncertainty_factors: "array",
    uncertaintyFactors: "array",
    freshness_score: "number",
    freshnessScore: "number",
    outcomeEstimates: "array",
    diagnostics: "object"
  },
  TradeCandidate: {
    marketId: "string",
    tokenId: "string",
    side: "string",
    marketProbability: "number",
    aiProbability: "number",
    grossEdge: "number",
    netEdge: "number",
    confidence: "string",
    market_implied_probability: "number?",
    marketImpliedProbability: "number?",
    edge: "number?",
    expected_value: "number?",
    expectedValue: "number?",
    suggested_side: "string?",
    suggestedSide: "string?",
    suggested_notional_before_risk: "number?",
    suggestedNotionalUsd: "number?",
    action: "string?",
    noTradeReason: "string?"
  },
  TradeDecision: {
    action: "string",
    marketId: "string",
    eventId: "string",
    tokenId: "string",
    side: "string",
    marketProbability: "number?",
    aiProbability: "number?",
    grossEdge: "number?",
    netEdge: "number?",
    confidence: "string",
    requestedUsd: "number",
    thesis: "string",
    sources: "array",
    market_implied_probability: "number?",
    marketImpliedProbability: "number?",
    edge: "number?",
    expected_value: "number?",
    expectedValue: "number?",
    suggested_side: "string?",
    suggestedSide: "string?",
    suggested_notional_before_risk: "number?",
    suggestedNotionalUsd: "number?",
    noTradeReason: "string?"
  },
  RiskDecision: {
    allow: "boolean",
    allowed: "boolean",
    reasons: "array",
    blocked_reasons: "array",
    blockedReasons: "array",
    warnings: "array",
    applied_limits: "object",
    appliedLimits: "object",
    adjusted_notional: "number",
    adjustedNotional: "number",
    approvedUsd: "number",
    order: "object?"
  },
  OrderRequest: {
    orderId: "string",
    marketId: "string",
    tokenId: "string",
    side: "string",
    amountUsd: "number"
  },
  OrderResult: {
    orderId: "string",
    status: "string",
    requestedUsd: "number",
    filledUsd: "number",
    avgPrice: "number?",
    reason: "string?"
  },
  PortfolioSnapshot: {
    accountId: "string",
    cashUsd: "number",
    totalEquityUsd: "number",
    positions: "array",
    updatedAt: "string"
  },
  RunArtifact: {
    kind: "string",
    runId: "string",
    path: "string",
    publishedAt: "string"
  }
};

function checkType(value, descriptor) {
  const optional = descriptor.endsWith("?");
  const type = optional ? descriptor.slice(0, -1) : descriptor;
  if (value == null) {
    return optional;
  }
  return primitiveChecks[type]?.(value) ?? false;
}

export function validateSchema(name, value) {
  const schema = schemas[name];
  if (!schema) {
    throw new Error(`Unknown schema: ${name}`);
  }
  if (!primitiveChecks.object(value)) {
    return { ok: false, issues: [`${name} must be an object.`] };
  }
  const issues = [];
  for (const [field, descriptor] of Object.entries(schema)) {
    if (!checkType(value[field], descriptor)) {
      issues.push(`${name}.${field} must be ${descriptor}.`);
    }
  }
  return { ok: issues.length === 0, issues };
}

export function assertSchema(name, value) {
  const result = validateSchema(name, value);
  if (!result.ok) {
    throw new Error(result.issues.join(" "));
  }
  return value;
}
