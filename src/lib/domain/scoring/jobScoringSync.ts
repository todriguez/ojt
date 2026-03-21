/**
 * Job Scoring Sync — Single Writer for Denormalized Columns
 *
 * ONE place that writes all flat scoring columns on the jobs table.
 * Called after every scoring event:
 *   - New message extraction
 *   - Manual re-score
 *   - Metadata correction
 *
 * Pipeline:
 *   1. Run full scoring pipeline (fit, worthiness, recommendation, confidence)
 *   2. Classify suburb group
 *   3. Detect repeat customer
 *   4. Compute needs_review flag
 *   5. Write ALL flat columns in a single UPDATE
 *   6. Optionally return the snapshot for job_outcomes storage
 *
 * No other code should write recommendation, customer_fit_label,
 * confidence_score, suburb_group, etc. directly.
 */

import { eq } from "drizzle-orm";
import type { Database } from "../../db/client";
import { jobs, jobOutcomes } from "../../db/schema";
import type { AccumulatedJobState } from "../../ai/extractors/extractionSchema";
import { runScoringPipeline, type ScoringPipelineResult } from "./scoringPipelineService";
import type { ScoringContext } from "../policy/policyTypes";

export interface SyncResult {
  scoring: ScoringPipelineResult;
  needsReview: boolean;
  isRepeatCustomer: boolean;
  repeatJobCount: number;
}

/**
 * Score a job and write all denormalized columns.
 *
 * @param db - Database instance
 * @param jobId - UUID of the job to update
 * @param state - Accumulated job state from extraction
 * @param repeatInfo - Repeat customer info (from detectRepeatCustomer)
 * @param context - Optional scoring context (schedule, weather, etc.)
 */
export async function scoreAndSyncJob(
  db: Database,
  jobId: string,
  state: AccumulatedJobState,
  repeatInfo?: { isRepeat: boolean; previousJobCount: number },
  context?: ScoringContext
): Promise<SyncResult> {
  // 1. Run full scoring pipeline
  const scoring = runScoringPipeline(state, context);

  // 2. Determine repeat customer status
  const isRepeatCustomer = repeatInfo?.isRepeat ?? false;
  const repeatJobCount = repeatInfo?.previousJobCount ?? 0;

  // 3. Compute needs_review: true if there's a job_outcomes row
  //    with human_decision but no actual_outcome, or if the job
  //    is in a terminal state with no outcome row at all
  const needsReview = await computeNeedsReview(db, jobId);

  // 4. Single UPDATE — all flat columns at once
  await db
    .update(jobs)
    .set({
      recommendation: scoring.recommendation.recommendation as any,
      recommendationReason: scoring.recommendation.reason,
      customerFitScore: scoring.fit.score,
      customerFitLabel: scoring.fit.label as any,
      quoteWorthinessScore: scoring.worthiness.score,
      quoteWorthinessLabel: scoring.worthiness.label as any,
      confidenceScore: scoring.confidence.score,
      confidenceLabel: scoring.confidence.label as any,
      estimateAckStatus: mapEstimateAck(state.estimateAckStatus),
      suburbGroup: scoring.suburbGroup as any,
      needsReview,
      isRepeatCustomer,
      repeatJobCount,
      completenessScore: scoring.snapshot.completeness.total,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, jobId));

  return { scoring, needsReview, isRepeatCustomer, repeatJobCount };
}

/**
 * Compute the needs_review flag for a job.
 * True when:
 *  - There's a job_outcomes row with human_decision but no actual_outcome
 *  - There's a job_outcomes row with actual_outcome but no was_system_correct
 *  - Job is in a terminal state but has no job_outcomes row
 */
async function computeNeedsReview(db: Database, jobId: string): Promise<boolean> {
  try {
    const outcomes = await db
      .select({
        humanDecision: jobOutcomes.humanDecision,
        actualOutcome: jobOutcomes.actualOutcome,
        wasSystemCorrect: jobOutcomes.wasSystemCorrect,
      })
      .from(jobOutcomes)
      .where(eq(jobOutcomes.jobId, jobId))
      .limit(1);

    if (outcomes.length === 0) {
      // Check if job is in terminal state without an outcome row
      const jobRows = await db
        .select({ status: jobs.status })
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .limit(1);

      if (jobRows.length > 0) {
        const terminalStatuses = ["complete", "invoiced", "paid", "archived", "not_a_fit", "not_price_aligned"];
        return terminalStatuses.includes(jobRows[0].status);
      }
      return false;
    }

    const outcome = outcomes[0];
    // Has decision but no outcome yet
    if (outcome.humanDecision && !outcome.actualOutcome) return true;
    // Has outcome but no judgment
    if (outcome.actualOutcome && outcome.wasSystemCorrect === null) return true;

    return false;
  } catch {
    // Table might not exist yet in tests
    return false;
  }
}

/**
 * Map extraction estimateAckStatus to the DB enum value.
 * Returns null for values not in the DB enum.
 */
function mapEstimateAck(status: string | null | undefined): any {
  if (!status) return null;
  const validValues = ["pending", "accepted", "tentative", "pushback", "rejected", "wants_exact_price", "rate_shopping"];
  return validValues.includes(status) ? status : null;
}
