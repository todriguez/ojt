/**
 * Recommendation Service
 *
 * Combines all scoring signals into a single actionable recommendation
 * for the admin view.
 */

import type { AccumulatedJobState } from "../../ai/extractors/extractionSchema";
import type { CustomerFitResult } from "./customerFitService";
import type { QuoteWorthinessResult } from "./quoteWorthinessService";

export type Recommendation =
  | "ignore"
  | "only_if_nearby"
  | "needs_site_visit"
  | "probably_bookable"
  | "worth_quoting"
  | "priority_lead"
  | "not_price_aligned"
  | "not_a_fit";

export interface RecommendationResult {
  recommendation: Recommendation;
  reason: string;
  actionHint: string; // What Todd should do next
}

/**
 * Generate a recommendation from all available signals.
 */
export function generateRecommendation(
  state: AccumulatedJobState,
  fitResult: CustomerFitResult,
  worthinessResult: QuoteWorthinessResult
): RecommendationResult {
  const ack = state.estimateAckStatus;
  const fitScore = fitResult.score;
  const worthScore = worthinessResult.score;

  // ── Scope-undefined blocker ──
  // If the customer hasn't actually described a job, don't recommend anything above only_if_nearby
  const hasNoScope = !state.scopeDescription || state.scopeClarity < 15;

  // Hard disqualifiers first
  if (ack === "rejected") {
    return {
      recommendation: "not_price_aligned",
      reason: `Customer rejected ROM estimate. Fit score: ${fitScore}.`,
      actionHint: "Archive unless they come back.",
    };
  }

  if (fitScore <= 20) {
    return {
      recommendation: "not_a_fit",
      reason: `Customer fit score very low (${fitScore}). Signals: ${fitResult.negativeSignals.join(", ")}.`,
      actionHint: "Don't pursue. Archive the lead.",
    };
  }

  if (ack === "pushback" && fitScore <= 40) {
    return {
      recommendation: "not_price_aligned",
      reason: `Estimate pushback combined with low fit score (${fitScore}).`,
      actionHint: "Likely not worth the hassle. Archive.",
    };
  }

  // Needs site visit detection
  const needsSiteVisit = detectSiteVisitNeeded(state);
  if (needsSiteVisit) {
    return {
      recommendation: "needs_site_visit",
      reason: needsSiteVisit,
      actionHint: "Schedule a look-see before committing to a price.",
    };
  }

  // ── Scope-undefined cap ──
  if (hasNoScope && worthScore <= 35) {
    return {
      recommendation: "only_if_nearby",
      reason: `No real job scope defined. Worthiness: ${worthScore}, fit: ${fitScore}.`,
      actionHint: "Customer hasn't described a real job yet. Wait for more detail.",
    };
  }

  // Priority lead — high scores + accepted estimate
  if (!hasNoScope && worthScore >= 70 && fitScore >= 60 && (ack === "accepted" || ack === "tentative")) {
    return {
      recommendation: "priority_lead",
      reason: `High worthiness (${worthScore}), good fit (${fitScore}), estimate ${ack}.`,
      actionHint: "Follow up today. This one's solid.",
    };
  }

  // Probably bookable — good enough to slot in
  if (!hasNoScope && worthScore >= 55 && fitScore >= 50 && ack === "accepted") {
    return {
      recommendation: "probably_bookable",
      reason: `Decent scores (worthiness: ${worthScore}, fit: ${fitScore}), estimate accepted.`,
      actionHint: "Book when a slot opens up. Straightforward job.",
    };
  }

  // Worth quoting — decent lead
  if (worthScore >= 45 && fitScore >= 40) {
    return {
      recommendation: "worth_quoting",
      reason: `Moderate scores (worthiness: ${worthScore}, fit: ${fitScore}). ${worthinessResult.recommendation}`,
      actionHint: "Follow up with more detail or a site visit.",
    };
  }

  // Only if nearby — low priority but not garbage
  if (worthScore >= 25) {
    return {
      recommendation: "only_if_nearby",
      reason: `Low-priority lead (worthiness: ${worthScore}, fit: ${fitScore}).`,
      actionHint: "Only pick up if you're in the area with time to spare.",
    };
  }

  // Ignore — not worth the time
  return {
    recommendation: "ignore",
    reason: `Very low scores (worthiness: ${worthScore}, fit: ${fitScore}). ${worthinessResult.recommendation}`,
    actionHint: "Not worth pursuing.",
  };
}

/**
 * Detect if a site visit is likely needed before pricing.
 */
function detectSiteVisitNeeded(state: AccumulatedJobState): string | null {
  const desc = (state.scopeDescription || "").toLowerCase();
  const condition = (state.materialCondition || "").toLowerCase();

  // Tier 1: Definitely hazardous — always flag
  const hazardousKeywords = /asbestos|termit|subsid|structur(?:al|e)\s+(?:damage|issue|problem|fail)/;
  if (hazardousKeywords.test(desc) || hazardousKeywords.test(condition)) {
    return "Possible hazardous or structural issue — need to inspect before pricing.";
  }

  // Tier 2: Concerning but only if multiple signals present
  const concerningWords = ["rotten", "sagg", "lean", "mould", "collaps", "buckl", "cave"];
  const matchCount = concerningWords.filter((w) => desc.includes(w) || condition.includes(w)).length;

  if (matchCount >= 2) {
    return "Multiple concerning indicators — should inspect before committing to a price.";
  }

  if (matchCount === 1 && condition && /rot|decay|water.?damage|soft.*through|crumbl/.test(condition)) {
    return "Material condition suggests possible hidden damage — worth inspecting.";
  }

  // Multi-day with vague scope
  if (state.scopeClarity < 40 && (desc.includes("renovation") || desc.includes("rebuild"))) {
    return "Large/complex scope with limited detail — site visit needed.";
  }

  // Customer can't describe the problem
  if (state.clarityScore === "confused" && state.scopeClarity < 30) {
    return "Customer unclear on the issue — need to see it in person.";
  }

  return null;
}
