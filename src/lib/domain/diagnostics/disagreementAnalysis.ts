/**
 * Disagreement Analysis — Diagnostics Phase
 *
 * This is the commerce compiler's profile-guided optimisation (PGO) engine.
 *
 * It takes completed job outcomes and computes:
 *   1. Disagreement type (system vs human decision mismatch classification)
 *   2. Signal attribution (which signals most contributed to the wrong decision)
 *   3. Policy gradient (suggested weight adjustments to reduce future errors)
 *   4. Aggregate diagnostics (patterns across many outcomes)
 *
 * The key insight: we store the full SystemScoresSnapshot and PolicyWeights
 * at decision time. This means we can replay the scoring with different weights
 * and find the minimum adjustment that would have produced the correct recommendation.
 *
 * This is not ML. It's deterministic analysis of structured disagreements.
 */

import type { SystemScoresSnapshot } from "../policy/policyTypes";
import type {
  PolicyWeights,
  FitWeights,
  WorthinessWeights,
  RecommendationThresholds,
} from "../policy/policyTypes";

// ── Types ───────────────────────────────────────────

/** Human decision enum values from the DB schema */
export type HumanDecision =
  | "followed_up"
  | "evaluated"
  | "committed"
  | "inspected"
  | "declined"
  | "archived"
  | "referred_out"
  | "deferred"
  | "let_expire";

/** Actual outcome enum values from the DB schema */
export type ActualOutcome =
  | "completed"
  | "disputed"
  | "cancelled"
  | "rejected"
  | "evaluated_unresponsive"
  | "inspected_declined"
  | "inspected_committed"
  | "diverted"
  | "unresponsive"
  | "not_pursued"
  | "still_active";

/** Miss type enum values from the DB schema */
export type MissType =
  | "false_negative"
  | "false_positive"
  | "underquoted_risk"
  | "overestimated_friction"
  | "customer_turned_painful"
  | "not_worth_travel"
  | "ideal_fill_job_missed"
  | "site_visit_wasted"
  | "good_repeat_misread"
  | "scope_creep"
  | "too_small_but_took_anyway"
  | "good_customer_low_value"
  | "schedule_gap_fill"
  | "none";

/** System recommendation enum values */
export type SystemRecommendation =
  | "priority_lead"
  | "probably_bookable"
  | "worth_quoting"
  | "only_if_nearby"
  | "needs_more_info"
  | "needs_site_visit"
  | "not_a_fit"
  | "not_price_aligned";

/** A single outcome record (matches job_outcomes table shape) */
export interface OutcomeRecord {
  jobId: string;
  policyVersion: number;
  systemRecommendation: SystemRecommendation;
  systemScores: SystemScoresSnapshot;
  systemConfidence: number;
  systemPolicySnapshot: PolicyWeights | null;
  humanDecision: HumanDecision | null;
  actualOutcome: ActualOutcome | null;
  outcomeValue: number | null; // cents
  missType: MissType | null;
  wasSystemCorrect: boolean | null;
}

// ── Disagreement Classification ─────────────────────

/** Direction of the disagreement */
export type DisagreementDirection =
  | "system_too_optimistic"   // system said pursue, human/outcome said no
  | "system_too_pessimistic"  // system said skip, but job was good
  | "aligned"                 // system and human agreed
  | "human_override_correct"  // human overrode system, outcome proved human right
  | "human_override_wrong"    // human overrode system, outcome proved system right
  | "insufficient_data";      // outcome not yet recorded

/** Classified disagreement with attribution */
export interface DisagreementResult {
  direction: DisagreementDirection;
  severity: "none" | "minor" | "moderate" | "severe";
  description: string;

  // Which signals were most responsible?
  signalAttribution: SignalAttribution[];

  // What would the system have needed to get it right?
  suggestedAdjustments: PolicyAdjustment[];
}

/** Attribution of a specific signal to the disagreement */
export interface SignalAttribution {
  signal: string;           // e.g. "fit.cheapestMindsetPenalty", "worthiness.coreSuburbPoints"
  phase: "fit" | "worthiness" | "confidence" | "recommendation";
  direction: "over" | "under"; // signal was over-weighted or under-weighted
  impact: number;            // estimated point impact (positive = contributed to error)
  explanation: string;
}

/** Suggested weight adjustment to fix a class of disagreement */
export interface PolicyAdjustment {
  weight: string;           // dotpath into PolicyWeights, e.g. "fit.cheapestMindsetPenalty"
  currentValue: number;
  suggestedValue: number;
  rationale: string;
  confidence: "high" | "medium" | "low";
}

// ── Core Analysis ───────────────────────────────────

/**
 * Classify a single outcome as a disagreement and attribute signals.
 */
export function analyzeDisagreement(outcome: OutcomeRecord): DisagreementResult {
  // No outcome data yet
  if (!outcome.humanDecision && !outcome.actualOutcome) {
    return {
      direction: "insufficient_data",
      severity: "none",
      description: "No human decision or actual outcome recorded yet",
      signalAttribution: [],
      suggestedAdjustments: [],
    };
  }

  const direction = classifyDirection(outcome);
  const severity = classifySeverity(outcome, direction);
  const description = describeDisagreement(outcome, direction);
  const signalAttribution = attributeSignals(outcome, direction);
  const suggestedAdjustments = suggestAdjustments(outcome, direction, signalAttribution);

  return {
    direction,
    severity,
    description,
    signalAttribution,
    suggestedAdjustments,
  };
}

// ── Aggregate Analysis ──────────────────────────────

/** Summary statistics across a batch of outcomes */
export interface DiagnosticsSummary {
  totalOutcomes: number;
  withHumanDecision: number;
  withActualOutcome: number;
  agreementRate: number;           // 0-1, how often system and human agreed
  correctRate: number;             // 0-1, how often system was right (per actual outcome)

  // Disagreement breakdown
  disagreementsByDirection: Record<DisagreementDirection, number>;
  disagreementsBySeverity: Record<string, number>;
  disagreementsByMissType: Partial<Record<MissType, number>>;

  // Signal patterns (which signals appear most in disagreements)
  topOverweightedSignals: { signal: string; count: number; avgImpact: number }[];
  topUnderweightedSignals: { signal: string; count: number; avgImpact: number }[];

  // Category patterns
  disagreementsByCategory: Record<string, { total: number; disagreements: number; rate: number }>;

  // Revenue impact
  falseNegativeRevenueLost: number;    // cents: jobs we said skip but were actually good
  falsePositiveTimeLost: number;       // estimated hours wasted on bad recommendations

  // Recommended policy changes
  recommendedAdjustments: PolicyAdjustment[];
}

/**
 * Analyze a batch of outcomes to produce aggregate diagnostics.
 *
 * This is the main entry point for periodic analysis (cron job or manual trigger).
 */
export function analyzeBatch(outcomes: OutcomeRecord[]): DiagnosticsSummary {
  const analyses = outcomes.map(analyzeDisagreement);

  const withHumanDecision = outcomes.filter((o) => o.humanDecision != null);
  const withActualOutcome = outcomes.filter((o) => o.actualOutcome != null);

  // Agreement rate: system recommendation aligned with human decision
  const agreements = outcomes.filter((o) => {
    if (!o.humanDecision) return false;
    return isAligned(o.systemRecommendation, o.humanDecision);
  });
  const agreementRate = withHumanDecision.length > 0
    ? agreements.length / withHumanDecision.length
    : 0;

  // Correct rate: based on wasSystemCorrect flag
  const correctOutcomes = outcomes.filter((o) => o.wasSystemCorrect === true);
  const incorrectOutcomes = outcomes.filter((o) => o.wasSystemCorrect === false);
  const correctRate = (correctOutcomes.length + incorrectOutcomes.length) > 0
    ? correctOutcomes.length / (correctOutcomes.length + incorrectOutcomes.length)
    : 0;

  // Disagreement breakdowns
  const disagreementsByDirection: Record<DisagreementDirection, number> = {
    system_too_optimistic: 0,
    system_too_pessimistic: 0,
    aligned: 0,
    human_override_correct: 0,
    human_override_wrong: 0,
    insufficient_data: 0,
  };

  const disagreementsBySeverity: Record<string, number> = {
    none: 0,
    minor: 0,
    moderate: 0,
    severe: 0,
  };

  const disagreementsByMissType: Partial<Record<MissType, number>> = {};

  for (const analysis of analyses) {
    disagreementsByDirection[analysis.direction]++;
    disagreementsBySeverity[analysis.severity]++;
  }

  for (const outcome of outcomes) {
    if (outcome.missType) {
      disagreementsByMissType[outcome.missType] = (disagreementsByMissType[outcome.missType] ?? 0) + 1;
    }
  }

  // Signal frequency analysis
  const signalCounts = new Map<string, { count: number; totalImpact: number; direction: "over" | "under" }>();
  for (const analysis of analyses) {
    for (const attr of analysis.signalAttribution) {
      const key = `${attr.direction}:${attr.signal}`;
      const existing = signalCounts.get(key) ?? { count: 0, totalImpact: 0, direction: attr.direction };
      existing.count++;
      existing.totalImpact += attr.impact;
      signalCounts.set(key, existing);
    }
  }

  const topOverweightedSignals = [...signalCounts.entries()]
    .filter(([_, v]) => v.direction === "over")
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([key, v]) => ({
      signal: key.replace("over:", ""),
      count: v.count,
      avgImpact: v.totalImpact / v.count,
    }));

  const topUnderweightedSignals = [...signalCounts.entries()]
    .filter(([_, v]) => v.direction === "under")
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([key, v]) => ({
      signal: key.replace("under:", ""),
      count: v.count,
      avgImpact: v.totalImpact / v.count,
    }));

  // Category patterns
  const disagreementsByCategory: Record<string, { total: number; disagreements: number; rate: number }> = {};
  for (let i = 0; i < outcomes.length; i++) {
    const catPath = outcomes[i].systemScores.category?.path ?? "unknown";
    if (!disagreementsByCategory[catPath]) {
      disagreementsByCategory[catPath] = { total: 0, disagreements: 0, rate: 0 };
    }
    disagreementsByCategory[catPath].total++;
    if (analyses[i].direction !== "aligned" && analyses[i].direction !== "insufficient_data") {
      disagreementsByCategory[catPath].disagreements++;
    }
  }
  for (const cat of Object.values(disagreementsByCategory)) {
    cat.rate = cat.total > 0 ? cat.disagreements / cat.total : 0;
  }

  // Revenue impact
  const falseNegatives = outcomes.filter(
    (o, i) => analyses[i].direction === "system_too_pessimistic" && o.outcomeValue
  );
  const falseNegativeRevenueLost = falseNegatives.reduce(
    (sum, o) => sum + (o.outcomeValue ?? 0),
    0
  );

  const falsePositives = outcomes.filter(
    (o, i) => analyses[i].direction === "system_too_optimistic"
  );
  // Rough estimate: 1.5 hours wasted per false positive (travel + assessment + admin)
  const falsePositiveTimeLost = falsePositives.length * 1.5;

  // Aggregate adjustment recommendations
  const allAdjustments = analyses.flatMap((a) => a.suggestedAdjustments);
  const recommendedAdjustments = consolidateAdjustments(allAdjustments);

  return {
    totalOutcomes: outcomes.length,
    withHumanDecision: withHumanDecision.length,
    withActualOutcome: withActualOutcome.length,
    agreementRate,
    correctRate,
    disagreementsByDirection,
    disagreementsBySeverity,
    disagreementsByMissType,
    topOverweightedSignals,
    topUnderweightedSignals,
    disagreementsByCategory,
    falseNegativeRevenueLost,
    falsePositiveTimeLost,
    recommendedAdjustments,
  };
}

// ── Internal: Direction Classification ──────────────

/** Map system recommendations to an optimism spectrum */
const RECOMMENDATION_RANK: Record<SystemRecommendation, number> = {
  priority_lead: 7,
  probably_bookable: 6,
  worth_quoting: 5,
  needs_site_visit: 4,
  needs_more_info: 3,
  only_if_nearby: 2,
  not_price_aligned: 1,
  not_a_fit: 0,
};

/** Map human decisions to an action spectrum */
const DECISION_RANK: Record<HumanDecision, number> = {
  committed: 7,
  inspected: 6,
  evaluated: 5,
  followed_up: 4,
  deferred: 3,
  referred_out: 2,
  let_expire: 1,
  archived: 1,
  declined: 0,
};

/** Map actual outcomes to a positivity spectrum */
const OUTCOME_RANK: Record<ActualOutcome, number> = {
  completed: 7,
  inspected_committed: 6,
  still_active: 5,
  rejected: 3,
  evaluated_unresponsive: 2,
  inspected_declined: 2,
  cancelled: 2,
  disputed: 2,
  diverted: 1,
  unresponsive: 1,
  not_pursued: 0,
};

function classifyDirection(outcome: OutcomeRecord): DisagreementDirection {
  const sysRank = RECOMMENDATION_RANK[outcome.systemRecommendation] ?? 3;

  // If we have actual outcome, that's ground truth
  if (outcome.actualOutcome) {
    const outcomeRank = OUTCOME_RANK[outcome.actualOutcome] ?? 3;

    if (outcome.humanDecision) {
      const humanRank = DECISION_RANK[outcome.humanDecision] ?? 3;
      const sysOptimism = sysRank - outcomeRank;
      const humanOptimism = humanRank - outcomeRank;

      // System was wrong, human was right
      if (Math.abs(sysOptimism) > 2 && Math.abs(humanOptimism) <= 1) {
        return "human_override_correct";
      }
      // System was right, human was wrong
      if (Math.abs(humanOptimism) > 2 && Math.abs(sysOptimism) <= 1) {
        return "human_override_wrong";
      }
    }

    // System too optimistic: recommended pursue, outcome was negative
    if (sysRank >= 4 && outcomeRank <= 2) return "system_too_optimistic";
    // System too pessimistic: recommended skip, outcome was positive
    if (sysRank <= 2 && outcomeRank >= 5) return "system_too_pessimistic";

    return "aligned";
  }

  // No actual outcome — compare system vs human decision
  if (outcome.humanDecision) {
    const humanRank = DECISION_RANK[outcome.humanDecision] ?? 3;
    const gap = sysRank - humanRank;

    if (gap >= 3) return "system_too_optimistic";
    if (gap <= -3) return "system_too_pessimistic";
    return "aligned";
  }

  return "insufficient_data";
}

function classifySeverity(
  outcome: OutcomeRecord,
  direction: DisagreementDirection
): "none" | "minor" | "moderate" | "severe" {
  if (direction === "aligned" || direction === "insufficient_data") return "none";

  // Severity based on score gap and outcome value
  const scores = outcome.systemScores;
  const fitScore = scores.fit.score;
  const worthinessScore = scores.worthiness.score;

  if (direction === "system_too_optimistic") {
    // High confidence wrong recommendation is worse
    if (outcome.systemConfidence >= 70 && worthinessScore >= 60) return "severe";
    if (outcome.systemConfidence >= 50) return "moderate";
    return "minor";
  }

  if (direction === "system_too_pessimistic") {
    // Missed revenue makes it worse
    const value = outcome.outcomeValue ?? 0;
    if (value >= 100000) return "severe";  // > $1000
    if (value >= 30000) return "moderate";  // > $300
    return "minor";
  }

  if (direction === "human_override_correct") {
    // System was wrong but human saved it
    if (outcome.systemConfidence >= 60) return "moderate"; // system was confident and wrong
    return "minor";
  }

  return "minor";
}

// ── Internal: Signal Attribution ────────────────────

function attributeSignals(
  outcome: OutcomeRecord,
  direction: DisagreementDirection
): SignalAttribution[] {
  if (direction === "aligned" || direction === "insufficient_data") return [];

  const scores = outcome.systemScores;
  const attrs: SignalAttribution[] = [];

  if (direction === "system_too_optimistic") {
    // System was too generous. Look for over-weighted positive signals.

    // Fit signals that inflated the score
    for (const signal of scores.fit.positiveSignals) {
      attrs.push({
        signal: `fit.${signalToKey(signal)}`,
        phase: "fit",
        direction: "over",
        impact: estimateSignalImpact(signal, scores.fit.score, "positive"),
        explanation: `Positive signal "${signal}" may have inflated fit score`,
      });
    }

    // If worthiness was high but outcome was bad — check what drove it
    if (scores.worthiness.score >= 55) {
      for (const reason of scores.worthiness.reasoning) {
        if (reason.startsWith("+")) {
          attrs.push({
            signal: `worthiness.${reasonToKey(reason)}`,
            phase: "worthiness",
            direction: "over",
            impact: extractPointValue(reason),
            explanation: `Worthiness boost "${reason}" contributed to over-optimistic score`,
          });
        }
      }
    }

    // Under-weighted negative signals (penalties that should have been higher)
    for (const signal of scores.fit.negativeSignals) {
      attrs.push({
        signal: `fit.${signalToKey(signal)}`,
        phase: "fit",
        direction: "under",
        impact: estimateSignalImpact(signal, scores.fit.score, "negative"),
        explanation: `Penalty "${signal}" may have been insufficient`,
      });
    }
  }

  if (direction === "system_too_pessimistic") {
    // System was too harsh. Look for over-weighted negative signals.

    for (const signal of scores.fit.negativeSignals) {
      attrs.push({
        signal: `fit.${signalToKey(signal)}`,
        phase: "fit",
        direction: "over",
        impact: estimateSignalImpact(signal, scores.fit.score, "negative"),
        explanation: `Penalty "${signal}" may have been too aggressive`,
      });
    }

    // Worthiness penalties that dragged score down
    for (const reason of scores.worthiness.reasoning) {
      if (reason.startsWith("-") || reason.startsWith("−")) {
        attrs.push({
          signal: `worthiness.${reasonToKey(reason)}`,
          phase: "worthiness",
          direction: "over",
          impact: Math.abs(extractPointValue(reason)),
          explanation: `Worthiness penalty "${reason}" may have been too harsh`,
        });
      }
    }

    // Under-weighted positive signals
    for (const signal of scores.fit.positiveSignals) {
      attrs.push({
        signal: `fit.${signalToKey(signal)}`,
        phase: "fit",
        direction: "under",
        impact: estimateSignalImpact(signal, scores.fit.score, "positive"),
        explanation: `Bonus "${signal}" may have been insufficient`,
      });
    }
  }

  // Sort by impact (highest first), limit to top 5
  return attrs
    .sort((a, b) => b.impact - a.impact)
    .slice(0, 5);
}

// ── Internal: Policy Adjustment Suggestions ─────────

function suggestAdjustments(
  outcome: OutcomeRecord,
  direction: DisagreementDirection,
  attribution: SignalAttribution[]
): PolicyAdjustment[] {
  if (direction === "aligned" || direction === "insufficient_data") return [];
  if (!outcome.systemPolicySnapshot) return [];

  const policy = outcome.systemPolicySnapshot;
  const adjustments: PolicyAdjustment[] = [];

  for (const attr of attribution.slice(0, 3)) {
    const weightPath = attr.signal;
    const currentValue = getNestedValue(policy, weightPath);

    if (currentValue == null || typeof currentValue !== "number") continue;

    let suggestedValue: number;
    let rationale: string;

    if (attr.direction === "over") {
      // Signal was over-weighted — reduce it
      const reduction = Math.min(Math.abs(currentValue * 0.2), attr.impact);
      suggestedValue = currentValue > 0
        ? Math.max(0, currentValue - reduction)   // reduce bonus
        : currentValue + reduction;                // reduce penalty (make less negative)
      rationale = `Signal contributed ${attr.impact} points to ${direction.replace(/_/g, " ")} error. Suggest ${Math.round(reduction * 10) / 10} point reduction.`;
    } else {
      // Signal was under-weighted — increase it
      const increase = Math.min(Math.abs(currentValue * 0.2), attr.impact);
      suggestedValue = currentValue > 0
        ? currentValue + increase                  // increase bonus
        : currentValue - increase;                 // increase penalty
      rationale = `Signal was insufficient (${attr.impact} point gap). Suggest ${Math.round(increase * 10) / 10} point increase.`;
    }

    adjustments.push({
      weight: weightPath,
      currentValue,
      suggestedValue: Math.round(suggestedValue * 10) / 10,
      rationale,
      confidence: attr.impact >= 10 ? "high" : attr.impact >= 5 ? "medium" : "low",
    });
  }

  // Threshold adjustments
  if (direction === "system_too_optimistic") {
    const scores = outcome.systemScores;
    const recValue = scores.recommendation.value;

    // If we recommended too aggressively, suggest raising the threshold
    if (recValue === "worth_quoting" || recValue === "probably_bookable") {
      const thresholdKey = recValue === "worth_quoting"
        ? "thresholds.worthQuotingMinWorthiness"
        : "thresholds.probablyBookableMinWorthiness";
      const current = getNestedValue(policy, thresholdKey);
      if (typeof current === "number") {
        adjustments.push({
          weight: thresholdKey,
          currentValue: current,
          suggestedValue: Math.min(current + 5, 80),
          rationale: `Raise ${recValue.replace(/_/g, " ")} threshold to filter out borderline cases`,
          confidence: "medium",
        });
      }
    }
  }

  if (direction === "system_too_pessimistic") {
    // Lower the threshold that blocked this lead
    const scores = outcome.systemScores;
    const worthiness = scores.worthiness.score;

    if (worthiness < 45) {
      const current = getNestedValue(policy, "thresholds.worthQuotingMinWorthiness");
      if (typeof current === "number" && worthiness < current) {
        adjustments.push({
          weight: "thresholds.worthQuotingMinWorthiness",
          currentValue: current,
          suggestedValue: Math.max(current - 5, 30),
          rationale: `Lower threshold to catch good leads with worthiness around ${worthiness}`,
          confidence: "medium",
        });
      }
    }
  }

  return adjustments;
}

/** Consolidate adjustments from multiple outcomes into consensus recommendations */
function consolidateAdjustments(all: PolicyAdjustment[]): PolicyAdjustment[] {
  const byWeight = new Map<string, PolicyAdjustment[]>();
  for (const adj of all) {
    const existing = byWeight.get(adj.weight) ?? [];
    existing.push(adj);
    byWeight.set(adj.weight, existing);
  }

  const consolidated: PolicyAdjustment[] = [];
  for (const [weight, adjustments] of byWeight.entries()) {
    if (adjustments.length < 2) continue; // need at least 2 data points to recommend

    const avgSuggested = adjustments.reduce((sum, a) => sum + a.suggestedValue, 0) / adjustments.length;
    const current = adjustments[0].currentValue;
    const highConfCount = adjustments.filter((a) => a.confidence === "high").length;

    consolidated.push({
      weight,
      currentValue: current,
      suggestedValue: Math.round(avgSuggested * 10) / 10,
      rationale: `${adjustments.length} outcomes suggest adjusting this weight (${highConfCount} high-confidence)`,
      confidence: highConfCount >= adjustments.length / 2 ? "high" : "medium",
    });
  }

  return consolidated.sort((a, b) => {
    const confRank = { high: 3, medium: 2, low: 1 };
    return confRank[b.confidence] - confRank[a.confidence];
  });
}

// ── Internal: Helpers ───────────────────────────────

/** Check if system recommendation and human decision are roughly aligned */
function isAligned(recommendation: SystemRecommendation, decision: HumanDecision): boolean {
  const sysRank = RECOMMENDATION_RANK[recommendation] ?? 3;
  const humanRank = DECISION_RANK[decision] ?? 3;
  return Math.abs(sysRank - humanRank) <= 2;
}

function describeDisagreement(outcome: OutcomeRecord, direction: DisagreementDirection): string {
  const sys = outcome.systemRecommendation.replace(/_/g, " ");
  const human = outcome.humanDecision?.replace(/_/g, " ") ?? "no decision";
  const actual = outcome.actualOutcome?.replace(/_/g, " ") ?? "unknown";

  switch (direction) {
    case "system_too_optimistic":
      return `System recommended "${sys}" but outcome was "${actual}" (human: "${human}")`;
    case "system_too_pessimistic":
      return `System recommended "${sys}" but outcome was "${actual}" — this was a missed opportunity`;
    case "human_override_correct":
      return `Human overrode "${sys}" with "${human}" — outcome "${actual}" proved them right`;
    case "human_override_wrong":
      return `Human overrode "${sys}" with "${human}" — outcome "${actual}" proved system was right`;
    case "aligned":
      return `System "${sys}" aligned with human "${human}" (outcome: "${actual}")`;
    case "insufficient_data":
      return `System recommended "${sys}" — awaiting human decision and outcome`;
  }
}

/** Convert a signal description string to a camelCase key */
function signalToKey(signal: string): string {
  return signal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/(^_|_$)/g, "")
    .replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** Convert a reasoning string to a key */
function reasonToKey(reason: string): string {
  // Strip leading +/-N: prefix
  const stripped = reason.replace(/^[+\-−]\d+:\s*/, "");
  return signalToKey(stripped);
}

/** Extract point value from reasoning string like "+10: Core suburb" */
function extractPointValue(reason: string): number {
  const match = reason.match(/^[+\-−](\d+)/);
  return match ? parseInt(match[1], 10) : 5; // default to 5 if can't parse
}

/** Estimate how much a signal contributed to the score */
function estimateSignalImpact(signal: string, totalScore: number, type: "positive" | "negative"): number {
  // Rough heuristic: each signal is worth about 5-15 points
  // More signals = less impact per signal
  return type === "positive" ? 8 : 6;
}

/** Get a nested value from an object by dot path */
function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
