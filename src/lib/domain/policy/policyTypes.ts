/**
 * Policy Types
 *
 * Type definitions for the scoring policy system.
 * These types define the shape of the JSON stored in
 * the scoring_policies table's weights and thresholds columns.
 */

// ── Policy Weights ──────────────────────────

export interface FitWeights {
  baseline: number;
  acceptedRomBonus: number;
  tentativeRomBonus: number;
  clearCommunicationBonus: number;
  practicalToneBonus: number;
  photosProvidedBonus: number;
  flexibleTimingBonus: number;
  realisticUrgencyBonus: number;
  offeredContactBonus: number;
  willingContactBonus: number;
  detailedScopeBonus: number;
  knowsRepairReplaceBonus: number;

  rejectedRomPenalty: number;
  pushbackPenalty: number;
  wantsExactPricePenalty: number;
  rateShoppingPenalty: number;
  cheapestMindsetPenalty: number;
  micromanagerPenalty: number;
  demandingTonePenalty: number;
  suspiciousTonePenalty: number;
  priceFocusedPenalty: number;
  vagueCommunicationPenalty: number;
  reluctantContactPenalty: number;
  refusedContactPenalty: number;
  fakeEmergencyPenalty: number;

  adversarial2Cap: number;
  adversarial3Cap: number;
}

export interface EffortBandPoints {
  quick: number;
  short: number;
  quarter_day: number;
  half_day: number;
  full_day: number;
  multi_day: number;
  unknown: number;
}

export interface WorthinessWeights {
  coreSuburbPoints: number;
  extendedSuburbPoints: number;
  unknownSuburbPoints: number;
  locationCluePoints: number;

  effortBandPoints: EffortBandPoints;

  fitContributionMultiplier: number;
  acceptedEstimateBonus: number;
  tentativeEstimateBonus: number;
  pushbackPenalty: number;
  rejectedPenalty: number;
  wantsExactPricePenalty: number;

  clearScopeBonus: number;
  moderateScopeBonus: number;
  scopeUndefinedCap: number;

  cheapestMindsetPenalty: number;
  micromanagerPenalty: number;
  smallJobFarAwayPenalty: number;

  adversarial2Cap: number;
  adversarial3Cap: number;
}

export interface RecommendationThresholds {
  priorityLeadMinWorthiness: number;
  priorityLeadMinFit: number;
  probablyBookableMinWorthiness: number;
  probablyBookableMinFit: number;
  worthQuotingMinWorthiness: number;
  worthQuotingMinFit: number;
  onlyIfNearbyMinWorthiness: number;

  fitHardRejectThreshold: number;
  fitPushbackRejectThreshold: number;
}

export interface ConfidenceWeights {
  scopeClarityWeight: number;
  locationClarityWeight: number;
  estimateReadinessWeight: number;
  contactReadinessWeight: number;
  jobTypeConfidenceWeight: number;
  toneSignalWeight: number;
  lowConfidenceThreshold: number;
  siteVisitConfidenceThreshold: number;
}

export interface ContextWeights {
  nearExistingJobBonus: number;
  repeatCustomerBonus: number;
  highDayLoadPenalty: number;
  weatherRiskPenalty: number;
  materialsUnavailablePenalty: number;
}

export interface CompletenessWeights {
  scopeWeight: number;
  locationWeight: number;
  contactWeight: number;
  estimateReadinessWeight: number;
  decisionReadinessWeight: number;
}

export interface EstimateControls {
  presentEstimateMinReadiness: number;
  fallbackEstimateMinClarity: number;
  vagueHourlySeekerScopeMin: number;
  scopeUndefinedMinClarity: number;
}

export interface PolicyWeights {
  fit: FitWeights;
  worthiness: WorthinessWeights;
  thresholds: RecommendationThresholds;
  confidence: ConfidenceWeights;
  context: ContextWeights;
  completeness: CompletenessWeights;
  estimates: EstimateControls;
}

// ── Scoring Context ─────────────────────────

export interface ScoringContext {
  distanceKm: number | null;
  travelTimeMin: number | null;
  isNearExistingJob: boolean | null;
  dayLoadScore: number | null;
  weekLoadScore: number | null;
  weatherRisk: string | null;
  isRepeatCustomer: boolean;
  previousJobCount: number;
  previousOutcomeAvg: string | null;
  materialsAvailable: boolean | null;
}

// ── System Scores Snapshot ──────────────────

export interface SystemScoresSnapshot {
  fit: {
    score: number;
    label: string;
    reasoning: string[];
    positiveSignals: string[];
    negativeSignals: string[];
  };
  worthiness: {
    score: number;
    label: string;
    reasoning: string[];
  };
  recommendation: {
    value: string;
    reason: string;
    actionHint: string;
  };
  confidence: {
    score: number;
    label: string;
    factors: string[];
  };
  completeness: {
    total: number;
    scopeClarity: number;
    locationClarity: number;
    contactReadiness: number;
    estimateReadiness: number;
    decisionReadiness: number;
  };
  estimateAck: {
    status: string | null;
    presented: boolean;
    acknowledged: boolean;
  };
}

// ── Convenience: empty context ──────────────

export function emptyScoringContext(): ScoringContext {
  return {
    distanceKm: null,
    travelTimeMin: null,
    isNearExistingJob: null,
    dayLoadScore: null,
    weekLoadScore: null,
    weatherRisk: null,
    isRepeatCustomer: false,
    previousJobCount: 0,
    previousOutcomeAvg: null,
    materialsAvailable: null,
  };
}
