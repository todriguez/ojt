/**
 * POST /api/v2/admin/leads/:id/action
 *
 * Quick-action endpoint — records human_decision and creates
 * job_outcomes row with scoring snapshot. Idempotent:
 *
 *   First call  → CREATE outcome row with full snapshot
 *   Later calls → UPDATE human_decision only (preserve original snapshot)
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { jobs, jobOutcomes, jobStateEvents, auditLog } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createLogger } from "@/lib/logger";

const log = createLogger("admin.action");
import { runScoringPipeline } from "@/lib/domain/scoring/scoringPipelineService";
import { getActivePolicy } from "@/lib/domain/policy/policyService";
import { emptyScoringContext } from "@/lib/domain/policy/policyTypes";
import type { AccumulatedJobState } from "@/lib/ai/extractors/extractionSchema";

const actionSchema = z.object({
  action: z.enum([
    "followed_up", "evaluated", "committed", "inspected",
    "declined", "archived", "deferred",
  ]),
  notes: z.string().optional(),
});

// Maps action → new job status
const ACTION_STATUS_MAP: Record<string, string> = {
  followed_up: "ready_for_review",
  evaluated: "estimate_presented",
  committed: "scheduled",
  inspected: "needs_site_visit",
  declined: "not_a_fit",
  archived: "archived",
  deferred: "", // no status change
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const db = await getDb();
    const { id: jobId } = await params;
    const body = await request.json();
    const parsed = actionSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const { action, notes } = parsed.data;

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

    // ── Check for existing outcome ──────────
    let existingOutcome = null;
    try {
      const rows = await db
        .select()
        .from(jobOutcomes)
        .where(eq(jobOutcomes.jobId, jobId))
        .limit(1);
      if (rows.length > 0) existingOutcome = rows[0];
    } catch {
      // Table might not exist
    }

    if (existingOutcome) {
      // ── IDEMPOTENT: Update human_decision only ──
      await db
        .update(jobOutcomes)
        .set({
          humanDecision: action as any,
          humanOverrideReason: notes || existingOutcome.humanOverrideReason,
        })
        .where(eq(jobOutcomes.jobId, jobId));
    } else {
      // ── FIRST ACTION: Create outcome with full snapshot ──
      const scoring = runScoringPipeline(state as AccumulatedJobState);
      let policyVersion = 1;
      let policySnapshot = null;

      try {
        const policy = await getActivePolicy(db);
        policyVersion = policy.version;
        policySnapshot = { weights: policy.weights, thresholds: policy.thresholds };
      } catch {
        // Use defaults
      }

      await db.insert(jobOutcomes).values({
        jobId,
        policyVersion,
        systemPolicySnapshot: policySnapshot,
        systemRecommendation: scoring.recommendation.recommendation,
        systemScores: scoring.snapshot,
        systemConfidence: scoring.confidence.score,
        scoringContext: emptyScoringContext(),
        humanDecision: action as any,
        humanOverrideReason: notes || null,
      });
    }

    // ── Update job status ───────────────────
    const newStatus = ACTION_STATUS_MAP[action];
    if (newStatus) {
      const oldStatus = job.status;
      await db
        .update(jobs)
        .set({
          status: newStatus as any,
          needsReview: true,
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, jobId));

      // Log state transition
      await db.insert(jobStateEvents).values({
        jobId,
        fromState: oldStatus as any,
        toState: newStatus as any,
        reason: `Quick action: ${action}${notes ? ` — ${notes}` : ""}`,
        actorType: "operator",
      });
    }

    // ── Audit log ──────────────────────────
    const adminEmail = request.headers.get("x-session-admin-email") || "unknown";
    await db.insert(auditLog).values({
      actorType: "admin",
      actorId: adminEmail,
      action: "lead.action",
      resourceType: "job",
      resourceId: jobId,
      metadata: { action, notes },
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
    });

    log.info({ adminEmail, jobId, action }, "admin.lead.action");

    // ── Return updated state ────────────────
    const updatedJob = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    const updatedOutcome = await db.select().from(jobOutcomes).where(eq(jobOutcomes.jobId, jobId)).limit(1);

    return NextResponse.json({
      lead: updatedJob[0] || null,
      outcome: updatedOutcome[0] || null,
    });
  } catch (error: any) {
    log.error({ error: error.message }, "admin.lead.action.error");
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
