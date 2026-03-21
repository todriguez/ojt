/**
 * Default Policy — Version 1
 *
 * Seeds the scoring_policies table with the exact values currently
 * hardcoded in the scoring services. This is the baseline that all
 * future tuning will be measured against.
 */

import type { PolicyWeights } from "./policyTypes";

export const DEFAULT_POLICY_WEIGHTS: PolicyWeights = {
  fit: {
    baseline: 50,
    acceptedRomBonus: 20,
    tentativeRomBonus: 10,
    clearCommunicationBonus: 12,
    practicalToneBonus: 8,
    photosProvidedBonus: 8,
    flexibleTimingBonus: 5,
    realisticUrgencyBonus: 5,
    offeredContactBonus: 8,
    willingContactBonus: 4,
    detailedScopeBonus: 10,
    knowsRepairReplaceBonus: 5,

    rejectedRomPenalty: -25,
    pushbackPenalty: -12,
    wantsExactPricePenalty: -15,
    rateShoppingPenalty: -8,
    cheapestMindsetPenalty: -15,
    micromanagerPenalty: -12,
    demandingTonePenalty: -10,
    suspiciousTonePenalty: -6,
    priceFocusedPenalty: -8,
    vagueCommunicationPenalty: -8,
    reluctantContactPenalty: -6,
    refusedContactPenalty: -12,
    fakeEmergencyPenalty: -5,

    adversarial2Cap: 35,
    adversarial3Cap: 15,
  },

  worthiness: {
    coreSuburbPoints: 25,
    extendedSuburbPoints: 15,
    unknownSuburbPoints: 5,
    locationCluePoints: 15,

    effortBandPoints: {
      quick: 5,
      short: 10,
      quarter_day: 18,
      half_day: 25,
      full_day: 30,
      multi_day: 28,
      unknown: 8,
    },

    fitContributionMultiplier: 0.2,
    acceptedEstimateBonus: 15,
    tentativeEstimateBonus: 8,
    pushbackPenalty: -5,
    rejectedPenalty: -15,
    wantsExactPricePenalty: -8,

    clearScopeBonus: 10,
    moderateScopeBonus: 5,
    scopeUndefinedCap: 25,

    cheapestMindsetPenalty: -10,
    micromanagerPenalty: -5,
    smallJobFarAwayPenalty: -10,

    adversarial2Cap: 35,
    adversarial3Cap: 15,
  },

  thresholds: {
    priorityLeadMinWorthiness: 70,
    priorityLeadMinFit: 60,
    probablyBookableMinWorthiness: 55,
    probablyBookableMinFit: 50,
    worthQuotingMinWorthiness: 45,
    worthQuotingMinFit: 40,
    onlyIfNearbyMinWorthiness: 25,

    fitHardRejectThreshold: 20,
    fitPushbackRejectThreshold: 40,
  },

  confidence: {
    scopeClarityWeight: 0.25,
    locationClarityWeight: 0.15,
    estimateReadinessWeight: 0.20,
    contactReadinessWeight: 0.10,
    jobTypeConfidenceWeight: 0.15,
    toneSignalWeight: 0.15,
    lowConfidenceThreshold: 35,
    siteVisitConfidenceThreshold: 25,
  },

  context: {
    nearExistingJobBonus: 10,
    repeatCustomerBonus: 8,
    highDayLoadPenalty: -5,
    weatherRiskPenalty: -3,
    materialsUnavailablePenalty: -5,
  },

  completeness: {
    scopeWeight: 0.30,
    locationWeight: 0.15,
    contactWeight: 0.15,
    estimateReadinessWeight: 0.20,
    decisionReadinessWeight: 0.20,
  },

  estimates: {
    presentEstimateMinReadiness: 50,
    fallbackEstimateMinClarity: 35,
    vagueHourlySeekerScopeMin: 40,
    scopeUndefinedMinClarity: 15,
  },
};

export const DEFAULT_POLICY_META = {
  version: 1,
  name: "Initial calibration — Sprint 3 hardcoded values",
  changeNotes:
    "Seed policy. All values extracted from hardcoded constants in " +
    "customerFitService.ts, quoteWorthinessService.ts, recommendationService.ts, " +
    "and confidenceService.ts. This is the baseline before any admin tuning.",
  createdBy: "system",
  tunedFromVersion: null as number | null,
  tuningLocked: false,
  isActive: true,
};
