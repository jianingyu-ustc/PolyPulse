/**
 * @typedef {Object} Outcome
 * @property {string} id
 * @property {string} label
 * @property {string} tokenId
 * @property {number|null} bestBid
 * @property {number|null} bestAsk
 * @property {number|null} lastPrice
 * @property {number|null} impliedProbability
 */

/**
 * @typedef {Object} Market
 * @property {string} marketId
 * @property {string} eventId
 * @property {string} marketSlug
 * @property {string} eventSlug
 * @property {string} question
 * @property {string|null} title
 * @property {string|null} marketUrl
 * @property {Outcome[]} outcomes
 * @property {string|null} endDate
 * @property {string|null} resolutionRules
 * @property {string|null} resolutionSourceUrl
 * @property {number} liquidityUsd
 * @property {number} volumeUsd
 * @property {number} volume24hUsd
 * @property {string|null} category
 * @property {string[]} tags
 * @property {boolean} active
 * @property {boolean} closed
 * @property {boolean} tradable
 * @property {string} source
 * @property {string[]} riskFlags
 * @property {string} fetchedAt
 */

/**
 * @typedef {Object} Evidence
 * @property {string} evidenceId
 * @property {string} marketId
 * @property {string} source
 * @property {string} sourceUrl
 * @property {string} url
 * @property {string} title
 * @property {string} summary
 * @property {"fetched"|"cached"|"stale"|"failed"|"placeholder"} status
 * @property {"low"|"medium"|"high"} credibility
 * @property {string} retrievedAt
 * @property {string} timestamp
 * @property {number} relevanceScore
 * @property {number} relevance_score
 */

/**
 * @typedef {Object} ProbabilityEstimate
 * @property {string} marketId
 * @property {"yes"|"no"} targetOutcome
 * @property {number} ai_probability
 * @property {number} aiProbability
 * @property {"low"|"medium"|"high"} confidence
 * @property {string} reasoning_summary
 * @property {string} reasoningSummary
 * @property {Evidence[]} key_evidence
 * @property {Evidence[]} keyEvidence
 * @property {Evidence[]} counter_evidence
 * @property {Evidence[]} counterEvidence
 * @property {string[]} uncertainty_factors
 * @property {string[]} uncertaintyFactors
 * @property {number} freshness_score
 * @property {number} freshnessScore
 * @property {Array<{tokenId: string, label: string, aiProbability: number, marketProbability: number|null, confidence: string, reasoning: string, evidenceIds: string[]}>} outcomeEstimates
 * @property {{provider: string, model: string, generatedAt: string, missingEvidence: string[]}} diagnostics
 */

/**
 * @typedef {Object} TradeCandidate
 * @property {string} marketId
 * @property {string} tokenId
 * @property {"yes"|"no"} side
 * @property {number} marketProbability
 * @property {number} aiProbability
 * @property {number} grossEdge
 * @property {number} netEdge
 * @property {string} confidence
 * @property {number|null} market_implied_probability
 * @property {number|null} marketImpliedProbability
 * @property {number|null} edge
 * @property {number|null} expected_value
 * @property {number|null} expectedValue
 * @property {"yes"|"no"|null} suggested_side
 * @property {"yes"|"no"|null} suggestedSide
 * @property {number|null} suggested_notional_before_risk
 * @property {number|null} suggestedNotionalUsd
 * @property {"open"|"skip"|null} action
 * @property {string|null} noTradeReason
 */

/**
 * @typedef {Object} TradeDecision
 * @property {"open"|"hold"|"reduce"|"close"|"skip"} action
 * @property {string} marketId
 * @property {string} eventId
 * @property {string} tokenId
 * @property {"BUY"|"SELL"} side
 * @property {number|null} marketProbability
 * @property {number|null} aiProbability
 * @property {number|null} grossEdge
 * @property {number|null} netEdge
 * @property {string} confidence
 * @property {number} requestedUsd
 * @property {string} thesis
 * @property {string[]} sources
 * @property {number|null} market_implied_probability
 * @property {number|null} marketImpliedProbability
 * @property {number|null} edge
 * @property {number|null} expected_value
 * @property {number|null} expectedValue
 * @property {"yes"|"no"|null} suggested_side
 * @property {"yes"|"no"|null} suggestedSide
 * @property {number|null} suggested_notional_before_risk
 * @property {number|null} suggestedNotionalUsd
 * @property {string|null} noTradeReason
 */

/**
 * @typedef {Object} RiskDecision
 * @property {boolean} allow
 * @property {boolean} allowed
 * @property {string[]} reasons
 * @property {string[]} blocked_reasons
 * @property {string[]} blockedReasons
 * @property {string[]} warnings
 * @property {Object} applied_limits
 * @property {Object} appliedLimits
 * @property {number} adjusted_notional
 * @property {number} adjustedNotional
 * @property {number} approvedUsd
 * @property {OrderRequest|null} order
 */

/**
 * @typedef {Object} OrderRequest
 * @property {string} orderId
 * @property {"live"} mode
 * @property {string} marketId
 * @property {string} tokenId
 * @property {"BUY"|"SELL"} side
 * @property {number} amountUsd
 */

/**
 * @typedef {Object} OrderResult
 * @property {string} orderId
 * @property {"filled"|"rejected"|"blocked"|"dry-run"} status
 * @property {"live"} mode
 * @property {number} requestedUsd
 * @property {number} filledUsd
 * @property {number|null} avgPrice
 * @property {string|null} reason
 */

/**
 * @typedef {Object} PortfolioSnapshot
 * @property {string} accountId
 * @property {number} cashUsd
 * @property {number} totalEquityUsd
 * @property {Array<{marketId: string, tokenId: string, side: string, size: number, avgPrice: number, currentValueUsd: number}>} positions
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} RunArtifact
 * @property {string} kind
 * @property {string} runId
 * @property {string} path
 * @property {string} publishedAt
 */

export const domainTypeNames = [
  "Market",
  "Outcome",
  "Evidence",
  "ProbabilityEstimate",
  "TradeCandidate",
  "TradeDecision",
  "RiskDecision",
  "OrderRequest",
  "OrderResult",
  "PortfolioSnapshot",
  "RunArtifact"
];
