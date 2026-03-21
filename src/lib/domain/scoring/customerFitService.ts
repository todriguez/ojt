/**
 * Customer Fit Scoring Service
 *
 * Scores 0-100 based on whether this customer is worth dealing with.
 * Not just about budget — captures communication quality, realism,
 * and likelihood of being a good working relationship.
 *
 * Rule-based and inspectable. Weights are explicit and tuneable.
 */

import type { AccumulatedJobState } from "../../ai/extractors/extractionSchema";

export interface CustomerFitResult {
  score: number;            // 0-100
  label: CustomerFitLabel;
  reasoning: string[];      // List of factors with their impact
  positiveSignals: string[];
  negativeSignals: string[];
}

export type CustomerFitLabel = "poor_fit" | "risky" | "mixed" | "good_fit" | "strong_fit";

/**
 * Weighted signal definitions.
 * Positive signals add points, negative signals subtract.
 */
interface Signal {
  name: string;
  points: number;
  check: (state: AccumulatedJobState) => boolean;
}

const POSITIVE_SIGNALS: Signal[] = [
  {
    name: "Accepted ROM estimate",
    points: 20,
    check: (s) => s.estimateAckStatus === "accepted",
  },
  {
    name: "Tentatively accepted ROM estimate",
    points: 10,
    check: (s) => s.estimateAckStatus === "tentative",
  },
  {
    name: "Clear communication",
    points: 12,
    check: (s) => s.clarityScore === "very_clear" || s.clarityScore === "clear",
  },
  {
    name: "Practical tone",
    points: 8,
    check: (s) => s.customerToneSignal === "practical" || s.customerToneSignal === "friendly",
  },
  {
    name: "Provided photos",
    points: 8,
    check: (s) => s.photosReferenced === true,
  },
  {
    name: "Flexible timing",
    points: 5,
    check: (s) => s.urgency === "flexible" || s.urgency === "when_convenient",
  },
  {
    name: "Realistic urgency",
    points: 5,
    check: (s) => s.urgency !== null && s.urgency !== "unspecified" && s.urgency !== "emergency",
  },
  {
    name: "Proactively offered contact details",
    points: 8,
    check: (s) => s.contactReadiness === "offered",
  },
  {
    name: "Willing to provide details",
    points: 4,
    check: (s) => s.contactReadiness === "willing",
  },
  {
    name: "Scope description is detailed",
    points: 10,
    check: (s) => (s.scopeDescription?.length ?? 0) > 60,
  },
  {
    name: "Knows what they want (repair vs replace)",
    points: 5,
    check: (s) => s.repairReplaceSignal !== null && s.repairReplaceSignal !== "unclear",
  },
];

const NEGATIVE_SIGNALS: Signal[] = [
  {
    name: "Rejected ROM estimate",
    points: -25,
    check: (s) => s.estimateAckStatus === "rejected",
  },
  {
    name: "Pushback on ROM estimate",
    points: -12,
    check: (s) => s.estimateAckStatus === "pushback",
  },
  {
    name: "Wants exact price before seeing job",
    points: -15,
    check: (s) => s.estimateAckStatus === "wants_exact_price",
  },
  {
    name: "Rate shopping",
    points: -8,
    check: (s) => s.estimateAckStatus === "rate_shopping",
  },
  {
    name: "Cheapest mindset",
    points: -15,
    check: (s) => s.cheapestMindset === true,
  },
  {
    name: "Micromanager signals",
    points: -12,
    check: (s) => s.micromanagerSignals === true,
  },
  {
    name: "Demanding tone",
    points: -10,
    check: (s) => s.customerToneSignal === "demanding" || s.customerToneSignal === "impatient",
  },
  {
    name: "Suspicious tone",
    points: -6,
    check: (s) => s.customerToneSignal === "suspicious",
  },
  {
    name: "Price-focused communication",
    points: -8,
    check: (s) => s.customerToneSignal === "price_focused",
  },
  {
    name: "Vague or confused communication",
    points: -8,
    check: (s) => s.clarityScore === "vague" || s.clarityScore === "confused",
  },
  {
    name: "Reluctant to share contact details",
    points: -6,
    check: (s) => s.contactReadiness === "reluctant",
  },
  {
    name: "Refused to share contact details",
    points: -12,
    check: (s) => s.contactReadiness === "refused",
  },
  {
    name: "Emergency urgency for non-emergency job",
    points: -5,
    check: (s) => s.urgency === "emergency" && !isActualEmergency(s),
  },
];

function isActualEmergency(state: AccumulatedJobState): boolean {
  const desc = (state.scopeDescription || "").toLowerCase();
  return /flood|burst|fire|gas|electri|danger|falling|collapse/.test(desc);
}

/**
 * Calculate customer fit score.
 */
export function scoreCustomerFit(state: AccumulatedJobState): CustomerFitResult {
  const positiveSignals: string[] = [];
  const negativeSignals: string[] = [];
  const reasoning: string[] = [];

  // Start at a neutral baseline
  let score = 50;

  for (const signal of POSITIVE_SIGNALS) {
    if (signal.check(state)) {
      score += signal.points;
      positiveSignals.push(signal.name);
      reasoning.push(`+${signal.points}: ${signal.name}`);
    }
  }

  for (const signal of NEGATIVE_SIGNALS) {
    if (signal.check(state)) {
      score += signal.points; // points are already negative
      negativeSignals.push(signal.name);
      reasoning.push(`${signal.points}: ${signal.name}`);
    }
  }

  // ── Adversarial stacking penalty ──
  // When 2+ strong negative signals fire together, the customer is almost certainly
  // going to be painful. Cap the score hard instead of hoping positives will offset.
  const adversarialSignals = [
    state.cheapestMindset === true,
    state.estimateAckStatus === "wants_exact_price" || state.estimateAckStatus === "rate_shopping",
    state.budgetReaction === "wants_hourly",
    state.customerToneSignal === "price_focused",
    state.customerToneSignal === "demanding" || state.customerToneSignal === "impatient",
    state.micromanagerSignals === true,
    state.contactReadiness === "refused",
    // Vague scope + pricing focus = fishing, not a real lead
    (state.clarityScore === "vague" || state.clarityScore === "confused") &&
      (state.customerToneSignal === "price_focused" || state.cheapestMindset === true),
  ].filter(Boolean).length;

  if (adversarialSignals >= 3) {
    score = Math.min(score, 15); // hard cap: poor_fit
    reasoning.push(`STACKING: ${adversarialSignals} adversarial signals → capped at 15`);
  } else if (adversarialSignals >= 2) {
    score = Math.min(score, 35); // hard cap: risky
    reasoning.push(`STACKING: ${adversarialSignals} adversarial signals → capped at 35`);
  }

  // Clamp
  score = Math.max(0, Math.min(100, score));

  return {
    score,
    label: scoreToLabel(score),
    reasoning,
    positiveSignals,
    negativeSignals,
  };
}

function scoreToLabel(score: number): CustomerFitLabel {
  if (score <= 20) return "poor_fit";
  if (score <= 40) return "risky";
  if (score <= 60) return "mixed";
  if (score <= 80) return "good_fit";
  return "strong_fit";
}
