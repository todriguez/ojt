/**
 * Confidence Score Service
 *
 * Derives a 0-100 confidence score measuring how certain the system is
 * about its recommendation. High confidence = we have enough data to
 * trust the scoring. Low confidence = the lead needs more info or a
 * site visit before committing.
 *
 * Inputs: accumulated job state sub-scores + job type confidence.
 * Weights are explicit and will be policy-driven in Phase 2.
 */

import type { AccumulatedJobState } from "../../ai/extractors/extractionSchema";

export type ConfidenceLabel = "low" | "medium" | "high";

export interface ConfidenceResult {
  score: number;         // 0-100
  label: ConfidenceLabel;
  factors: string[];     // what contributed (or detracted)
}

/**
 * Default confidence weights — will move to policy table in Phase 2.
 */
const WEIGHTS = {
  scopeClarityWeight: 0.25,
  locationClarityWeight: 0.15,
  estimateReadinessWeight: 0.20,
  contactReadinessWeight: 0.10,
  jobTypeConfidenceWeight: 0.15,
  toneSignalWeight: 0.15,
};

const LOW_THRESHOLD = 35;
const HIGH_THRESHOLD = 65;

/**
 * Map jobTypeConfidence string to a 0-100 value.
 */
function jobTypeConfidenceToScore(value: string | null): number {
  switch (value) {
    case "certain": return 100;
    case "likely": return 70;
    case "guess": return 30;
    default: return 0;
  }
}

/**
 * Map contactReadiness to a 0-100 value.
 */
function contactReadinessToScore(value: string | null): number {
  switch (value) {
    case "offered": return 100;
    case "willing": return 70;
    case "reluctant": return 30;
    case "refused": return 10;
    default: return 0;
  }
}

/**
 * Map estimateAckStatus to a 0-100 value for readiness.
 */
function estimateReadinessToScore(state: AccumulatedJobState): number {
  if (!state.estimatePresented) return 0;

  switch (state.estimateAckStatus) {
    case "accepted": return 100;
    case "tentative": return 70;
    case "pushback": return 40;
    case "rejected": return 60; // at least we know where we stand
    case "wants_exact_price": return 30;
    case "rate_shopping": return 20;
    default: return 10; // estimate presented but no ack yet
  }
}

/**
 * Whether any tone signal was detected (has data vs null).
 */
function toneSignalToScore(state: AccumulatedJobState): number {
  let score = 0;
  // Having tone data at all is informative
  if (state.customerToneSignal) score += 50;
  if (state.clarityScore && state.clarityScore !== "unknown") score += 30;
  if (state.cheapestMindset !== null) score += 20;
  return Math.min(score, 100);
}

/**
 * Calculate confidence score from accumulated job state.
 */
export function scoreConfidence(state: AccumulatedJobState): ConfidenceResult {
  const factors: string[] = [];

  // 1. Scope clarity
  const scopeClarity = state.scopeClarity ?? 0;
  factors.push(`Scope clarity: ${scopeClarity}/100 (weight: ${WEIGHTS.scopeClarityWeight})`);

  // 2. Location clarity
  const locationScore = state.locationClarity ?? 0;
  factors.push(`Location clarity: ${locationScore}/100 (weight: ${WEIGHTS.locationClarityWeight})`);

  // 3. Estimate readiness
  const estimateScore = estimateReadinessToScore(state);
  factors.push(`Estimate readiness: ${estimateScore}/100 (weight: ${WEIGHTS.estimateReadinessWeight})`);

  // 4. Contact readiness
  const contactScore = contactReadinessToScore(state.contactReadiness ?? null);
  factors.push(`Contact readiness: ${contactScore}/100 (weight: ${WEIGHTS.contactReadinessWeight})`);

  // 5. Job type confidence
  const jtcScore = jobTypeConfidenceToScore(state.jobTypeConfidence ?? null);
  factors.push(`Job type confidence: ${jtcScore}/100 (weight: ${WEIGHTS.jobTypeConfidenceWeight})`);

  // 6. Tone signal
  const toneScore = toneSignalToScore(state);
  factors.push(`Tone signal: ${toneScore}/100 (weight: ${WEIGHTS.toneSignalWeight})`);

  // Weighted sum
  const rawScore =
    scopeClarity * WEIGHTS.scopeClarityWeight +
    locationScore * WEIGHTS.locationClarityWeight +
    estimateScore * WEIGHTS.estimateReadinessWeight +
    contactScore * WEIGHTS.contactReadinessWeight +
    jtcScore * WEIGHTS.jobTypeConfidenceWeight +
    toneScore * WEIGHTS.toneSignalWeight;

  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  let label: ConfidenceLabel;
  if (score < LOW_THRESHOLD) {
    label = "low";
    factors.push(`Below low threshold (${LOW_THRESHOLD}) → low confidence`);
  } else if (score >= HIGH_THRESHOLD) {
    label = "high";
    factors.push(`Above high threshold (${HIGH_THRESHOLD}) → high confidence`);
  } else {
    label = "medium";
  }

  return { score, label, factors };
}
