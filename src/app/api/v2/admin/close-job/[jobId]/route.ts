/**
 * POST /api/v2/admin/close-job/:jobId
 *
 * Paskian learning loop — the write path. Todd calls this when a job
 * actually completes to feed real-world data (actualHours, actualCharge)
 * back into the estimator's pricing model for the relevant trade.
 *
 * Behaviour:
 *   1. Loads the job's `romInstrument` from metadata (must exist — if we
 *      never quoted, there's nothing to calibrate against).
 *   2. Writes a `CompletedJobOutcome` as an evidence_merge patch on the
 *      trade's pricing-model sem_object.
 *   3. The pricingModel module then runs a rescore patch in the same
 *      transaction, so the rolling multipliers update immediately and
 *      the next estimate on that trade reflects the learning.
 *
 * The endpoint is deliberately thin: the SPP discipline lives in
 * `recordCompletedOutcome` — this just authenticates, validates, and
 * dispatches.
 *
 * Auth: admin-session header (same as outcomes endpoint). Audit-logged.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { jobs, auditLog } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import { recordCompletedOutcome } from "@/lib/domain/estimates/pricingModel";
import { isTradeCategory } from "@/lib/lexicons/trades";
import type { RomInstrument } from "@/lib/domain/estimates/sppEstimator";

const log = createLogger("admin.close-job");

const closeJobSchema = z.object({
  actualHours: z.number().positive().finite(),
  actualCharge: z.number().positive().finite(),
  note: z.string().max(500).optional().nullable(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    const adminEmail = request.headers.get("x-session-admin-email");
    if (!adminEmail) {
      return NextResponse.json({ error: "admin session required" }, { status: 401 });
    }

    const { jobId } = await params;
    const body = await request.json();
    const parsed = closeJobSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const db = await getDb();
    const [job] = await db
      .select()
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1);
    if (!job) {
      return NextResponse.json({ error: "job not found" }, { status: 404 });
    }

    const md = job.metadata as { romInstrument?: RomInstrument } | null;
    const instrument = md?.romInstrument;
    if (!instrument) {
      return NextResponse.json(
        { error: "job has no ROM instrument — nothing to calibrate against" },
        { status: 409 },
      );
    }
    if (!isTradeCategory(instrument.trade)) {
      return NextResponse.json(
        { error: `job trade "${instrument.trade}" not in TradesLexicon` },
        { status: 409 },
      );
    }

    const { objectId, patchId } = await recordCompletedOutcome(db, {
      jobId,
      trade: instrument.trade,
      originalInstrumentId: instrument.id,
      estimatedCostMin: instrument.costMin,
      estimatedCostMax: instrument.costMax,
      estimatedHoursMin: instrument.hoursMin,
      estimatedHoursMax: instrument.hoursMax,
      actualHours: parsed.data.actualHours,
      actualCharge: parsed.data.actualCharge,
      recordedAt: new Date().toISOString(),
      note: parsed.data.note ?? null,
    });

    await db.insert(auditLog).values({
      actorType: "admin",
      actorId: adminEmail,
      action: "close-job.calibrate",
      resourceType: "job",
      resourceId: jobId,
      metadata: {
        pricingModelObjectId: objectId,
        patchId,
        trade: instrument.trade,
        estimatedCostMin: instrument.costMin,
        estimatedCostMax: instrument.costMax,
        actualHours: parsed.data.actualHours,
        actualCharge: parsed.data.actualCharge,
      },
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
    });

    log.info(
      {
        adminEmail,
        jobId,
        trade: instrument.trade,
        pricingModelObjectId: objectId,
      },
      "admin.close-job.calibrated",
    );

    return NextResponse.json({
      ok: true,
      jobId,
      trade: instrument.trade,
      pricingModelObjectId: objectId,
      patchId,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.error({ detail }, "admin.close-job.error");
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}
