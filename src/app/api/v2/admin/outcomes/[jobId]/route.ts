/**
 * PATCH /api/v2/admin/outcomes/:jobId
 *
 * Outcome recording — updates post-mortem fields on an existing
 * job_outcomes row. Used for:
 *   - Recording actual_outcome after job completion
 *   - Setting was_system_correct (Todd's judgment)
 *   - Classifying miss_type
 *   - Adding outcome notes and value
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { jobOutcomes, jobs, auditLog } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createLogger } from "@/lib/logger";

const log = createLogger("admin.outcomes");

const outcomeUpdateSchema = z.object({
  actual_outcome: z.enum([
    "completed", "disputed", "cancelled",
    "rejected", "evaluated_unresponsive", "inspected_declined",
    "inspected_committed", "diverted", "unresponsive",
    "not_pursued", "still_active",
  ]).optional(),
  outcome_value: z.number().int().min(0).optional(), // cents
  outcome_notes: z.string().optional(),
  miss_type: z.enum([
    "false_negative", "false_positive", "underquoted_risk",
    "overestimated_friction", "customer_turned_painful", "not_worth_travel",
    "ideal_fill_job_missed", "site_visit_wasted", "good_repeat_misread",
    "scope_creep", "too_small_but_took_anyway", "good_customer_low_value",
    "schedule_gap_fill", "none",
  ]).optional(),
  was_system_correct: z.boolean().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const db = await getDb();
    const { jobId } = await params;
    const body = await request.json();
    const parsed = outcomeUpdateSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const data = parsed.data;

    // ── Check outcome exists ────────────────
    const existing = await db
      .select()
      .from(jobOutcomes)
      .where(eq(jobOutcomes.jobId, jobId))
      .limit(1);

    if (existing.length === 0) {
      return NextResponse.json(
        { error: "No outcome row for this job. Take an action first." },
        { status: 404 }
      );
    }

    // ── Build update set ────────────────────
    const updateSet: any = {};
    if (data.actual_outcome !== undefined) updateSet.actualOutcome = data.actual_outcome;
    if (data.outcome_value !== undefined) updateSet.outcomeValue = data.outcome_value;
    if (data.outcome_notes !== undefined) updateSet.outcomeNotes = data.outcome_notes;
    if (data.miss_type !== undefined) updateSet.missType = data.miss_type;
    if (data.was_system_correct !== undefined) updateSet.wasSystemCorrect = data.was_system_correct;

    // Set resolvedAt when outcome is recorded
    if (data.actual_outcome && data.actual_outcome !== "still_active") {
      updateSet.resolvedAt = new Date();
    }

    await db
      .update(jobOutcomes)
      .set(updateSet)
      .where(eq(jobOutcomes.jobId, jobId));

    // ── Update needs_review on job ──────────
    // If all three required fields are now set, clear needs_review
    const updated = await db
      .select()
      .from(jobOutcomes)
      .where(eq(jobOutcomes.jobId, jobId))
      .limit(1);

    if (updated.length > 0) {
      const o = updated[0];
      const isComplete = o.humanDecision && o.actualOutcome && o.wasSystemCorrect !== null;
      if (isComplete) {
        await db
          .update(jobs)
          .set({ needsReview: false, updatedAt: new Date() })
          .where(eq(jobs.id, jobId));
      }
    }

    // Audit log
    const adminEmail = request.headers.get("x-session-admin-email") || "unknown";
    await db.insert(auditLog).values({
      actorType: "admin",
      actorId: adminEmail,
      action: "outcome.update",
      resourceType: "job_outcome",
      resourceId: jobId,
      metadata: parsed.data,
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
    });

    log.info({ adminEmail, jobId }, "admin.outcome.update");

    return NextResponse.json({ outcome: updated[0] || null });
  } catch (error: any) {
    log.error({ error: error.message }, "admin.outcome.update.error");
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
