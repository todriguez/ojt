import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { jobs, customers, sites, estimates, messages, jobStateEvents } from "@/lib/db/schema";
import { eq, desc, and, inArray, sql } from "drizzle-orm";
import { z } from "zod";

// ── Validation ──────────────────────────────

const createJobSchema = z.object({
  organisationId: z.string().uuid(),
  customerId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  assignedOperatorId: z.string().uuid().optional(),
  leadSource: z.enum(["website_chat", "facebook", "instagram", "phone", "referral", "repeat", "walk_in", "other"]).default("website_chat"),
  jobType: z.enum(["carpentry", "plumbing", "electrical", "painting", "general", "fencing", "tiling", "roofing", "doors_windows", "gardening", "cleaning", "other"]).default("general"),
  subcategory: z.string().optional(),
  descriptionRaw: z.string().optional(),
  descriptionSummary: z.string().optional(),
  status: z.enum([
    "new_lead", "partial_intake", "awaiting_customer", "ready_for_review",
    "estimate_presented", "estimate_accepted", "not_price_aligned", "not_a_fit",
    "needs_site_visit", "bookable", "scheduled", "in_progress",
    "hanging_weather", "hanging_parts", "return_visit_required", "complete",
    "invoice_pending", "invoiced", "paid", "archived",
  ]).default("new_lead"),
  urgency: z.enum(["emergency", "urgent", "next_week", "next_2_weeks", "flexible", "when_convenient", "unspecified"]).default("unspecified"),
  effortBand: z.enum(["quick", "short", "quarter_day", "half_day", "full_day", "multi_day", "unknown"]).optional(),
});

// ── GET /api/v2/jobs ────────────────────────

export async function GET(request: NextRequest) {
  try {
    const db = await getDb();
    const { searchParams } = new URL(request.url);

    const status = searchParams.get("status");
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100);
    const offset = parseInt(searchParams.get("offset") || "0");

    // Build query
    const statusFilter = status
      ? inArray(jobs.status, status.split(",") as any[])
      : undefined;

    const baseQuery = db
      .select({
        job: jobs,
        customer: customers,
        site: sites,
      })
      .from(jobs)
      .leftJoin(customers, eq(jobs.customerId, customers.id))
      .leftJoin(sites, eq(jobs.siteId, sites.id))
      .$dynamic();

    const results = await (statusFilter
      ? baseQuery.where(statusFilter).orderBy(desc(jobs.createdAt)).limit(limit).offset(offset)
      : baseQuery.orderBy(desc(jobs.createdAt)).limit(limit).offset(offset));

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(jobs);
    const total = Number(countResult[0]?.count || 0);

    return NextResponse.json({
      jobs: results.map((r: any) => {
        const meta = (r.job.metadata && typeof r.job.metadata === "object") ? r.job.metadata as Record<string, unknown> : {};
        return {
          ...r.job,
          customer: r.customer,
          site: r.site,
          scoring: {
            customerFitScore: meta.customerFitScore ?? r.job.customerFitScore ?? null,
            customerFitLabel: meta.customerFitLabel ?? null,
            quoteWorthinessScore: meta.quoteWorthinessScore ?? r.job.quoteWorthinessScore ?? null,
            quoteWorthinessLabel: meta.quoteWorthinessLabel ?? null,
            recommendation: meta.recommendation ?? null,
            recommendationReason: meta.recommendationReason ?? null,
            estimateAckStatus: meta.estimateAckStatus ?? "pending",
          },
        };
      }),
      total,
      limit,
      offset,
    });
  } catch (error) {
    console.error("GET /api/v2/jobs error:", error);
    return NextResponse.json({ error: "Failed to fetch jobs" }, { status: 500 });
  }
}

// ── POST /api/v2/jobs ───────────────────────

export async function POST(request: NextRequest) {
  try {
    const db = await getDb();
    const body = await request.json();
    const validated = createJobSchema.parse(body);

    const [newJob] = await db
      .insert(jobs)
      .values(validated)
      .returning();

    // Log state event
    await db.insert(jobStateEvents).values({
      jobId: newJob.id,
      toState: newJob.status,
      actorType: "system",
      reason: "Job created",
    });

    return NextResponse.json(newJob, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.issues },
        { status: 400 }
      );
    }
    console.error("POST /api/v2/jobs error:", error);
    return NextResponse.json({ error: "Failed to create job" }, { status: 500 });
  }
}
