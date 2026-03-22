/**
 * GET /api/v2/admin/leads
 *
 * Lead queue endpoint — returns leads with all scoring badges
 * for the admin dashboard. Queries denormalized flat columns
 * for fast filtering and sorting.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { jobs, jobOutcomes, customers, estimates } from "@/lib/db/schema";
import { withAdminAuth } from "@/lib/middleware/withAdminAuth";
import { createLogger } from "@/lib/logger";

const log = createLogger("admin.leads");
import { eq, desc, asc, and, inArray, isNull, isNotNull, sql, ne } from "drizzle-orm";

// ── Valid filter/sort values ────────────────

const VALID_SORTS = [
  "worthiness", "fit", "confidence", "suburb", "updated_at", "created_at",
] as const;

const RECOMMENDATION_TIER_ORDER = [
  "priority_lead", "probably_bookable", "worth_quoting",
  "needs_site_visit", "only_if_nearby", "not_price_aligned",
  "not_a_fit", "ignore",
];

export async function GET(request: NextRequest) {
  try {
    const db = await getDb();
    const params = new URL(request.url).searchParams;

    // ── Parse query params ──────────────────
    const sortField = params.get("sort") || "updated_at";
    const sortOrder = params.get("order") === "asc" ? "asc" : "desc";
    const limit = Math.min(parseInt(params.get("limit") || "20"), 100);
    const offset = parseInt(params.get("offset") || "0");

    // Filters (comma-separated)
    const recommendationFilter = params.get("recommendation")?.split(",").filter(Boolean);
    const statusFilter = params.get("status")?.split(",").filter(Boolean);
    const effortBandFilter = params.get("effortBand")?.split(",").filter(Boolean);
    const suburbGroupFilter = params.get("suburbGroup")?.split(",").filter(Boolean);
    const estimateAckFilter = params.get("estimateAck")?.split(",").filter(Boolean);
    const needsReview = params.get("needsReview") === "true";
    const disagreement = params.get("disagreement") === "true";

    // ── Build WHERE conditions ──────────────
    const conditions: any[] = [];

    if (recommendationFilter?.length) {
      conditions.push(inArray(jobs.recommendation, recommendationFilter as any));
    }
    if (statusFilter?.length) {
      conditions.push(inArray(jobs.status, statusFilter as any));
    }
    if (effortBandFilter?.length) {
      conditions.push(inArray(jobs.effortBand, effortBandFilter as any));
    }
    if (suburbGroupFilter?.length) {
      conditions.push(inArray(jobs.suburbGroup, suburbGroupFilter as any));
    }
    if (estimateAckFilter?.length) {
      conditions.push(inArray(jobs.estimateAckStatus, estimateAckFilter as any));
    }
    if (needsReview) {
      conditions.push(eq(jobs.needsReview, true));
    }

    // ── Build ORDER BY ──────────────────────
    let orderBy: any;
    switch (sortField) {
      case "worthiness":
        orderBy = sortOrder === "asc" ? asc(jobs.quoteWorthinessScore) : desc(jobs.quoteWorthinessScore);
        break;
      case "fit":
        orderBy = sortOrder === "asc" ? asc(jobs.customerFitScore) : desc(jobs.customerFitScore);
        break;
      case "confidence":
        orderBy = sortOrder === "asc" ? asc(jobs.confidenceScore) : desc(jobs.confidenceScore);
        break;
      case "suburb":
        orderBy = sortOrder === "asc" ? asc(jobs.suburbGroup) : desc(jobs.suburbGroup);
        break;
      case "created_at":
        orderBy = sortOrder === "asc" ? asc(jobs.createdAt) : desc(jobs.createdAt);
        break;
      default:
        orderBy = desc(jobs.updatedAt);
    }

    // ── Query ───────────────────────────────
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [leadRows, countResult] = await Promise.all([
      db
        .select({
          // Core job fields
          id: jobs.id,
          jobType: jobs.jobType,
          subcategory: jobs.subcategory,
          descriptionSummary: jobs.descriptionSummary,
          status: jobs.status,
          urgency: jobs.urgency,
          effortBand: jobs.effortBand,
          estimatedCostMin: jobs.estimatedCostMin,
          estimatedCostMax: jobs.estimatedCostMax,
          estimatedHoursMin: jobs.estimatedHoursMin,
          estimatedHoursMax: jobs.estimatedHoursMax,
          // Denormalized scoring columns
          recommendation: jobs.recommendation,
          recommendationReason: jobs.recommendationReason,
          customerFitScore: jobs.customerFitScore,
          customerFitLabel: jobs.customerFitLabel,
          quoteWorthinessScore: jobs.quoteWorthinessScore,
          quoteWorthinessLabel: jobs.quoteWorthinessLabel,
          confidenceScore: jobs.confidenceScore,
          confidenceLabel: jobs.confidenceLabel,
          estimateAckStatus: jobs.estimateAckStatus,
          suburbGroup: jobs.suburbGroup,
          needsReview: jobs.needsReview,
          isRepeatCustomer: jobs.isRepeatCustomer,
          repeatJobCount: jobs.repeatJobCount,
          completenessScore: jobs.completenessScore,
          // Metadata for card content
          metadata: jobs.metadata,
          // Timestamps
          createdAt: jobs.createdAt,
          updatedAt: jobs.updatedAt,
        })
        .from(jobs)
        .where(whereClause)
        .orderBy(orderBy)
        .limit(limit)
        .offset(offset),

      db
        .select({ count: sql<number>`count(*)::int` })
        .from(jobs)
        .where(whereClause),
    ]);

    // ── Enrich with outcome data if disagreement filter needed ──
    // For the disagreement filter, we need to join job_outcomes
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let leads: any[] = leadRows.map((row: typeof leadRows[number]) => {
      const meta = row.metadata as any || {};
      return {
        id: row.id,
        jobType: row.jobType,
        subcategory: row.subcategory,
        scopeSummary: meta.scopeDescription?.substring(0, 120) || row.descriptionSummary || null,
        status: row.status,
        urgency: row.urgency,
        effortBand: row.effortBand,
        // Scoring badges
        recommendation: row.recommendation,
        recommendationReason: row.recommendationReason,
        customerFitScore: row.customerFitScore,
        customerFitLabel: row.customerFitLabel,
        quoteWorthinessScore: row.quoteWorthinessScore,
        quoteWorthinessLabel: row.quoteWorthinessLabel,
        confidenceScore: row.confidenceScore,
        confidenceLabel: row.confidenceLabel,
        estimateAckStatus: row.estimateAckStatus,
        // Location
        suburb: meta.suburb || null,
        suburbGroup: row.suburbGroup,
        // Estimate
        romRange: row.estimatedCostMin && row.estimatedCostMax
          ? { min: row.estimatedCostMin, max: row.estimatedCostMax }
          : null,
        estimatedHours: row.estimatedHoursMin && row.estimatedHoursMax
          ? { min: Number(row.estimatedHoursMin), max: Number(row.estimatedHoursMax) }
          : null,
        romConfidence: meta.romConfidence || null,
        labourOnly: meta.labourOnly ?? null,
        materialsNote: meta.materialsNote || null,
        effortBandReason: meta.effortBandReason || null,
        // Sub-scores
        scopeClarity: meta.scopeClarity ?? null,
        locationClarity: meta.locationClarity ?? null,
        estimateReadiness: meta.estimateReadiness ?? null,
        contactReadiness: meta.contactReadinessScore ?? null,
        // Customer
        customerName: meta.customerName || null,
        customerPhone: meta.customerPhone || null,
        isRepeatCustomer: row.isRepeatCustomer,
        repeatJobCount: row.repeatJobCount,
        // Context placeholders (null until integrations)
        scheduleContext: null,
        // Review state
        needsReview: row.needsReview,
        hasOutcome: false,  // enriched below
        humanDecision: null as string | null,
        // Timestamps
        updatedAt: row.updatedAt,
        createdAt: row.createdAt,
      };
    });

    // ── Enrich with outcome data ──────────
    if (leads.length > 0) {
      const jobIds: string[] = leads.map((l: any) => l.id);
      try {
        const outcomes = await db
          .select({
            jobId: jobOutcomes.jobId,
            humanDecision: jobOutcomes.humanDecision,
            systemRecommendation: jobOutcomes.systemRecommendation,
          })
          .from(jobOutcomes)
          .where(inArray(jobOutcomes.jobId, jobIds));

        const outcomeMap = new Map(outcomes.map((o: any) => [o.jobId, o] as const));
        leads = leads.map((lead: any) => {
          const outcome = outcomeMap.get(lead.id) as any;
          if (outcome) {
            return {
              ...lead,
              hasOutcome: true,
              humanDecision: outcome.humanDecision,
            };
          }
          return lead;
        });

        // Apply disagreement filter post-query (requires outcome data)
        if (disagreement) {
          leads = leads.filter((lead: any) => {
            const outcome = outcomeMap.get(lead.id) as any;
            if (!outcome) return false;
            return outcome.systemRecommendation !== outcome.humanDecision;
          });
        }
      } catch {
        // job_outcomes table might not exist yet
      }
    }

    return NextResponse.json({
      leads,
      total: countResult[0]?.count ?? 0,
      filters: {
        sort: sortField,
        order: sortOrder,
        recommendation: recommendationFilter || null,
        status: statusFilter || null,
        effortBand: effortBandFilter || null,
        suburbGroup: suburbGroupFilter || null,
        estimateAck: estimateAckFilter || null,
        needsReview: needsReview || null,
        disagreement: disagreement || null,
      },
    });
  } catch (error: any) {
    log.error({ error: error.message }, "admin.leads.list.error");
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
