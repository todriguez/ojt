import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import {
  jobs,
  customers,
  sites,
  estimates,
  messages,
  uploads,
  visits,
  jobStateEvents,
} from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";

// ── Validation ──────────────────────────────

const updateJobSchema = z.object({
  status: z.enum([
    "new_lead", "partial_intake", "awaiting_customer", "ready_for_review",
    "estimate_presented", "estimate_accepted", "not_price_aligned", "not_a_fit",
    "needs_site_visit", "bookable", "scheduled", "in_progress",
    "hanging_weather", "hanging_parts", "return_visit_required", "complete",
    "invoice_pending", "invoiced", "paid", "archived",
  ]).optional(),
  assignedOperatorId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  descriptionRaw: z.string().optional(),
  descriptionSummary: z.string().optional(),
  urgency: z.enum(["emergency", "urgent", "next_week", "next_2_weeks", "flexible", "when_convenient", "unspecified"]).optional(),
  effortBand: z.enum(["quick", "short", "quarter_day", "half_day", "full_day", "multi_day", "unknown"]).optional(),
  estimatedHoursMin: z.string().optional(),
  estimatedHoursMax: z.string().optional(),
  estimatedCostMin: z.number().optional(),
  estimatedCostMax: z.number().optional(),
  customerFitScore: z.number().min(0).max(100).optional(),
  quoteWorthinessScore: z.number().min(0).max(100).optional(),
  completenessScore: z.number().min(0).max(100).optional(),
  requiresSiteVisit: z.boolean().optional(),
  serviceAreaOk: z.boolean().optional(),
  // For state transitions
  transitionReason: z.string().optional(),
  actorType: z.enum(["operator", "customer", "system", "ai"]).optional(),
  actorId: z.string().uuid().optional(),
});

type RouteParams = { params: Promise<{ id: string }> };

// ── GET /api/v2/jobs/:id ────────────────────

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const db = await getDb();

    // Fetch job with all related data
    const [job] = await db
      .select()
      .from(jobs)
      .where(eq(jobs.id, id))
      .limit(1);

    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    // Fetch related data in parallel
    const [customer, site, jobEstimates, jobMessages, jobUploads, jobVisits, stateHistory] =
      await Promise.all([
        job.customerId
          ? db.select().from(customers).where(eq(customers.id, job.customerId)).limit(1)
          : Promise.resolve([]),
        job.siteId
          ? db.select().from(sites).where(eq(sites.id, job.siteId)).limit(1)
          : Promise.resolve([]),
        db.select().from(estimates).where(eq(estimates.jobId, id)).orderBy(desc(estimates.createdAt)),
        db.select().from(messages).where(eq(messages.jobId, id)).orderBy(messages.createdAt),
        db.select().from(uploads).where(eq(uploads.jobId, id)).orderBy(uploads.createdAt),
        db.select().from(visits).where(eq(visits.jobId, id)).orderBy(desc(visits.scheduledStart)),
        db.select().from(jobStateEvents).where(eq(jobStateEvents.jobId, id)).orderBy(desc(jobStateEvents.createdAt)),
      ]);

    // Extract scoring signals from metadata
    const meta = (job.metadata && typeof job.metadata === "object") ? job.metadata as Record<string, unknown> : {};
    const scoring = {
      customerFitScore: meta.customerFitScore ?? job.customerFitScore ?? null,
      customerFitLabel: meta.customerFitLabel ?? null,
      quoteWorthinessScore: meta.quoteWorthinessScore ?? job.quoteWorthinessScore ?? null,
      quoteWorthinessLabel: meta.quoteWorthinessLabel ?? null,
      recommendation: meta.recommendation ?? null,
      recommendationReason: meta.recommendationReason ?? null,
      estimateAckStatus: meta.estimateAckStatus ?? "pending",
      completenessScore: meta.completenessScore ?? job.completenessScore ?? 0,
      scopeClarity: meta.scopeClarity ?? 0,
      locationClarity: meta.locationClarity ?? 0,
      contactReadinessScore: meta.contactReadinessScore ?? 0,
      estimateReadiness: meta.estimateReadiness ?? 0,
      decisionReadiness: meta.decisionReadiness ?? 0,
    };

    return NextResponse.json({
      ...job,
      scoring,
      customer: customer[0] || null,
      site: site[0] || null,
      estimates: jobEstimates,
      messages: jobMessages,
      uploads: jobUploads,
      visits: jobVisits,
      stateHistory,
    });
  } catch (error) {
    console.error("GET /api/v2/jobs/:id error:", error);
    return NextResponse.json({ error: "Failed to fetch job" }, { status: 500 });
  }
}

// ── PATCH /api/v2/jobs/:id ──────────────────

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const db = await getDb();
    const body = await request.json();
    const validated = updateJobSchema.parse(body);

    // Get current job for state transition logging
    const [currentJob] = await db
      .select()
      .from(jobs)
      .where(eq(jobs.id, id))
      .limit(1);

    if (!currentJob) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    // Extract transition metadata
    const { transitionReason, actorType, actorId, ...updateFields } = validated;

    // Apply update
    const [updatedJob] = await db
      .update(jobs)
      .set({ ...updateFields, updatedAt: new Date() })
      .where(eq(jobs.id, id))
      .returning();

    // Log state transition if status changed
    if (validated.status && validated.status !== currentJob.status) {
      await db.insert(jobStateEvents).values({
        jobId: id,
        fromState: currentJob.status,
        toState: validated.status,
        reason: transitionReason || `Status changed from ${currentJob.status} to ${validated.status}`,
        actorType: actorType || "operator",
        actorId: actorId || undefined,
      });
    }

    return NextResponse.json(updatedJob);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.issues },
        { status: 400 }
      );
    }
    console.error("PATCH /api/v2/jobs/:id error:", error);
    return NextResponse.json({ error: "Failed to update job" }, { status: 500 });
  }
}
