/**
 * POST /api/v2/admin/leads/:id/rescore
 *
 * Re-scores a lead with current policy + current metadata.
 * Returns before/after diff. Updates denormalized columns.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { jobs, jobStateEvents } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { runScoringPipeline } from "@/lib/domain/scoring/scoringPipelineService";
import { scoreAndSyncJob } from "@/lib/domain/scoring/jobScoringSync";
import type { AccumulatedJobState } from "@/lib/ai/extractors/extractionSchema";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const db = await getDb();
    const { id: jobId } = await params;

    // ── Load job ────────────────────────────
    const jobRows = await db
      .select()
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1);

    if (jobRows.length === 0) {
      return NextResponse.json({ error: "Lead not found" }, { status: 404 });
    }

    const job = jobRows[0];
    const state = (job.metadata as AccumulatedJobState) || {};

    // ── Capture "before" state ──────────────
    const before = {
      fit: job.customerFitScore,
      fitLabel: job.customerFitLabel,
      worthiness: job.quoteWorthinessScore,
      worthinessLabel: job.quoteWorthinessLabel,
      confidence: job.confidenceScore,
      confidenceLabel: job.confidenceLabel,
      recommendation: job.recommendation,
    };

    // ── Re-score and sync ───────────────────
    const syncResult = await scoreAndSyncJob(
      db,
      jobId,
      state as AccumulatedJobState,
      {
        isRepeat: job.isRepeatCustomer ?? false,
        previousJobCount: job.repeatJobCount ?? 0,
      }
    );

    // ── Capture "after" state ───────────────
    const after = {
      fit: syncResult.scoring.fit.score,
      fitLabel: syncResult.scoring.fit.label,
      worthiness: syncResult.scoring.worthiness.score,
      worthinessLabel: syncResult.scoring.worthiness.label,
      confidence: syncResult.scoring.confidence.score,
      confidenceLabel: syncResult.scoring.confidence.label,
      recommendation: syncResult.scoring.recommendation.recommendation,
    };

    const changed =
      before.fit !== after.fit ||
      before.worthiness !== after.worthiness ||
      before.confidence !== after.confidence ||
      before.recommendation !== after.recommendation;

    // ── Log re-score event ──────────────────
    if (changed) {
      await db.insert(jobStateEvents).values({
        jobId,
        fromState: job.status as any,
        toState: job.status as any,
        reason: `Re-scored: fit ${before.fit}→${after.fit}, worth ${before.worthiness}→${after.worthiness}, rec ${before.recommendation}→${after.recommendation}`,
        actorType: "operator",
      });
    }

    return NextResponse.json({ before, after, changed });
  } catch (error: any) {
    console.error("POST /api/v2/admin/leads/:id/rescore error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
