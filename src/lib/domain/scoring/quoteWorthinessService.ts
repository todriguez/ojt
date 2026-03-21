/**
 * Quote-Worthiness Scoring Service
 *
 * The operational "should Todd bother?" score from 0-100.
 * Combines job economics, travel, schedule practicality, and customer quality.
 *
 * Rule-based, inspectable, tuneable.
 */

import type { AccumulatedJobState } from "../../ai/extractors/extractionSchema";
import type { EffortBand } from "../estimates/effortBandService";

export interface QuoteWorthinessResult {
  score: number;               // 0-100
  label: QuoteWorthinessLabel;
  reasoning: string[];
  recommendation: string;      // Short sentence for admin
}

export type QuoteWorthinessLabel =
  | "ignore"
  | "only_if_convenient"
  | "maybe_quote"
  | "worth_quoting"
  | "priority";

/**
 * Known suburbs in Todd's core service area (Noosa/Sunshine Coast).
 */
const CORE_AREA_SUBURBS = new Set([
  "noosa heads", "noosaville", "sunshine beach", "sunrise beach",
  "peregian beach", "peregian springs", "marcus beach", "castaways beach",
  "tewantin", "cooroy", "pomona", "cooran", "doonan", "verrierdale",
  "eumundi", "yandina", "nambour", "weyba downs",
  "coolum beach", "coolum", "yaroomba", "mount coolum",
  "bli bli", "pacific paradise", "mudjimba", "marcoola",
]);

const EXTENDED_AREA_SUBURBS = new Set([
  "maroochydore", "mooloolaba", "alexandra headland", "buderim",
  "sippy downs", "forest glen", "palmwoods", "montville",
  "maleny", "mapleton", "flaxton", "kenilworth",
  "caloundra", "kawana", "minyama", "parrearra",
  "noosa north shore", "boreen point", "lake cootharaba",
  "gympie", "tin can bay", "rainbow beach",
]);

interface LocationScore {
  points: number;
  reason: string;
}

function scoreLocation(state: AccumulatedJobState): LocationScore {
  const suburb = (state.suburb || "").toLowerCase().trim();

  if (!suburb && !state.locationClue) {
    return { points: 0, reason: "No location info" };
  }

  if (CORE_AREA_SUBURBS.has(suburb)) {
    return { points: 25, reason: `Core area: ${state.suburb}` };
  }

  if (EXTENDED_AREA_SUBURBS.has(suburb)) {
    return { points: 15, reason: `Extended area: ${state.suburb}` };
  }

  // Check if location clue hints at core area
  const clue = (state.locationClue || "").toLowerCase();
  if (clue.includes("noosa") || clue.includes("sunshine coast")) {
    return { points: 15, reason: `Location clue suggests service area: ${state.locationClue}` };
  }

  if (suburb) {
    return { points: 5, reason: `Unknown suburb: ${state.suburb} — may be outside service area` };
  }

  return { points: 0, reason: "No clear location" };
}

interface EffortScore {
  points: number;
  reason: string;
}

function scoreEffort(state: AccumulatedJobState): EffortScore {
  const band = state.estimatePresented
    ? (state as any).effortBand || inferBandFromScope(state)
    : inferBandFromScope(state);

  const scores: Record<string, number> = {
    quick: 5,
    short: 10,
    quarter_day: 18,
    half_day: 25,
    full_day: 30,
    multi_day: 28, // slightly less — more risk
    unknown: 8,
  };

  const points = scores[band] || 8;
  return { points, reason: `Effort band: ${band} (${points} pts)` };
}

function inferBandFromScope(state: AccumulatedJobState): string {
  // Quick inference from description length and quantity
  const descLen = (state.scopeDescription || "").length;
  const hasQuantity = !!state.quantity;

  if (descLen < 20 && !hasQuantity) return "unknown";
  if (descLen < 40) return "short";
  if (hasQuantity) return "quarter_day";
  return "half_day";
}

/**
 * Calculate quote-worthiness score.
 */
export function scoreQuoteWorthiness(
  state: AccumulatedJobState,
  customerFitScore: number
): QuoteWorthinessResult {
  const reasoning: string[] = [];
  let score = 0;

  // 1. Location (0-25 points)
  const loc = scoreLocation(state);
  score += loc.points;
  reasoning.push(loc.reason);

  // 2. Effort band / job size (0-30 points)
  const effort = scoreEffort(state);
  score += effort.points;
  reasoning.push(effort.reason);

  // 3. Customer fit contribution (0-20 points)
  const fitContribution = Math.round(customerFitScore * 0.2);
  score += fitContribution;
  reasoning.push(`Customer fit: ${customerFitScore} → ${fitContribution} pts`);

  // 4. Estimate acknowledgement (0-15 points)
  if (state.estimateAckStatus === "accepted") {
    score += 15;
    reasoning.push("+15: Estimate accepted");
  } else if (state.estimateAckStatus === "tentative") {
    score += 8;
    reasoning.push("+8: Estimate tentatively accepted");
  } else if (state.estimateAckStatus === "pushback") {
    score -= 5;
    reasoning.push("-5: Estimate pushback");
  } else if (state.estimateAckStatus === "rejected") {
    score -= 15;
    reasoning.push("-15: Estimate rejected");
  } else if (state.estimateAckStatus === "wants_exact_price") {
    score -= 8;
    reasoning.push("-8: Wants exact price");
  }

  // 5. Scope clarity bonus (0-10 points) / scope-undefined penalty
  if (state.scopeClarity >= 70) {
    score += 10;
    reasoning.push("+10: Clear scope (clarity ≥70)");
  } else if (state.scopeClarity >= 40) {
    score += 5;
    reasoning.push("+5: Moderate scope clarity");
  } else if (state.scopeClarity < 15 || !state.scopeDescription) {
    // Scope-undefined is a first-class blocker.
    // If the customer hasn't described a job, cap worthiness hard.
    score = Math.min(score, 25);
    reasoning.push("BLOCKER: No real scope defined → worthiness capped at 25");
  }

  // 6. Penalties for red flags
  if (state.cheapestMindset) {
    score -= 10;
    reasoning.push("-10: Cheapest-mindset customer");
  }

  if (state.micromanagerSignals) {
    score -= 5;
    reasoning.push("-5: Micromanager signals");
  }

  // Quick job + far away penalty
  const band = inferBandFromScope(state);
  const isLocal = loc.points >= 20;
  if ((band === "quick" || band === "short") && !isLocal) {
    score -= 10;
    reasoning.push("-10: Small job outside core area");
  }

  // ── Adversarial stacking cap ──
  // Mirror the fit service: when multiple red flags stack, cap worthiness too.
  const adversarialCount = [
    state.cheapestMindset === true,
    state.estimateAckStatus === "wants_exact_price" || state.estimateAckStatus === "rate_shopping",
    state.budgetReaction === "wants_hourly",
    state.customerToneSignal === "price_focused",
    state.customerToneSignal === "demanding" || state.customerToneSignal === "impatient",
    state.micromanagerSignals === true,
  ].filter(Boolean).length;

  if (adversarialCount >= 3) {
    score = Math.min(score, 15);
    reasoning.push(`STACKING: ${adversarialCount} adversarial signals → worthiness capped at 15`);
  } else if (adversarialCount >= 2) {
    score = Math.min(score, 35);
    reasoning.push(`STACKING: ${adversarialCount} adversarial signals → worthiness capped at 35`);
  }

  // Clamp
  score = Math.max(0, Math.min(100, score));
  const label = scoreToLabel(score);

  return {
    score,
    label,
    reasoning,
    recommendation: buildRecommendation(label, state, reasoning),
  };
}

function scoreToLabel(score: number): QuoteWorthinessLabel {
  if (score <= 20) return "ignore";
  if (score <= 40) return "only_if_convenient";
  if (score <= 60) return "maybe_quote";
  if (score <= 80) return "worth_quoting";
  return "priority";
}

function buildRecommendation(
  label: QuoteWorthinessLabel,
  state: AccumulatedJobState,
  _reasoning: string[]
): string {
  const band = inferBandFromScope(state);
  const suburb = state.suburb || "unknown location";

  switch (label) {
    case "priority":
      return `Strong lead — ${band} job in ${suburb}, customer aligned on range. Follow up promptly.`;
    case "worth_quoting":
      return `Decent lead — worth following up. ${suburb}, ${band} scope.`;
    case "maybe_quote":
      return `Borderline — might be worth it if schedule has gaps. ${suburb}.`;
    case "only_if_convenient":
      return `Low priority — only pick up if passing through ${suburb} or schedule is light.`;
    case "ignore":
      return `Not worth pursuing — poor economics or customer mismatch.`;
  }
}
