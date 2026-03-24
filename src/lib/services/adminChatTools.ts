/**
 * Admin Chat Tools — DB operation functions for Claude tool use.
 *
 * Each tool is a pure async function that takes typed params,
 * hits the DB via drizzle, and returns a JSON-serializable result.
 */

import { eq, desc, asc, and, ilike, inArray, between, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import type { AccumulatedJobState } from "@/lib/ai/extractors/extractionSchema";
import { createLogger } from "@/lib/logger";

const log = createLogger("admin-chat-tools");

// ─────────────────────────────────────────────
// 1. search_jobs
// ─────────────────────────────────────────────

interface SearchJobsParams {
  status?: string[];
  suburb?: string;
  customerName?: string;
  jobType?: string;
  leadSource?: string;
  limit?: number;
}

export async function searchJobs(params: SearchJobsParams) {
  const db = await getDb();
  const conditions: any[] = [];

  if (params.status?.length) {
    conditions.push(inArray(schema.jobs.status, params.status as any));
  }
  if (params.jobType) {
    conditions.push(eq(schema.jobs.jobType, params.jobType as any));
  }
  if (params.leadSource) {
    conditions.push(eq(schema.jobs.leadSource, params.leadSource as any));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = Math.min(params.limit || 10, 20);

  const rows = await db
    .select({
      id: schema.jobs.id,
      jobType: schema.jobs.jobType,
      status: schema.jobs.status,
      urgency: schema.jobs.urgency,
      effortBand: schema.jobs.effortBand,
      estimatedCostMin: schema.jobs.estimatedCostMin,
      estimatedCostMax: schema.jobs.estimatedCostMax,
      recommendation: schema.jobs.recommendation,
      metadata: schema.jobs.metadata,
      createdAt: schema.jobs.createdAt,
      updatedAt: schema.jobs.updatedAt,
    })
    .from(schema.jobs)
    .where(whereClause)
    .orderBy(desc(schema.jobs.updatedAt))
    .limit(limit);

  // Post-filter by suburb and customer name from metadata
  let results = rows.map((r) => {
    const meta = (r.metadata as any) || {};
    return {
      id: r.id,
      jobType: r.jobType,
      status: r.status,
      urgency: r.urgency,
      effortBand: r.effortBand,
      costRange: r.estimatedCostMin && r.estimatedCostMax
        ? `$${r.estimatedCostMin}-$${r.estimatedCostMax}`
        : null,
      recommendation: r.recommendation,
      suburb: meta.suburb || null,
      customerName: meta.customerName || null,
      customerPhone: meta.customerPhone || null,
      scopeSummary: meta.scopeDescription?.substring(0, 100) || null,
      leadSource: meta.pdfImportSource ? `REA: ${meta.pdfImportSource}` : null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });

  // Client-side filter for suburb and customer name (stored in JSONB)
  if (params.suburb) {
    const sub = params.suburb.toLowerCase();
    results = results.filter((r) => r.suburb?.toLowerCase().includes(sub));
  }
  if (params.customerName) {
    const name = params.customerName.toLowerCase();
    results = results.filter((r) => r.customerName?.toLowerCase().includes(name));
  }

  return { jobs: results, count: results.length };
}

// ─────────────────────────────────────────────
// 2. get_job_detail
// ─────────────────────────────────────────────

export async function getJobDetail(params: { jobId: string }) {
  const db = await getDb();

  const [job] = await db
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.id, params.jobId))
    .limit(1);

  if (!job) return { error: "Job not found" };

  const meta = (job.metadata as any) || {};

  // Load conversation
  const msgs = await db
    .select({
      id: schema.messages.id,
      senderType: schema.messages.senderType,
      content: schema.messages.rawContent,
      messageType: schema.messages.messageType,
      createdAt: schema.messages.createdAt,
    })
    .from(schema.messages)
    .where(eq(schema.messages.jobId, params.jobId))
    .orderBy(asc(schema.messages.createdAt));

  // Load estimates
  const jobEstimates = await db
    .select()
    .from(schema.estimates)
    .where(eq(schema.estimates.jobId, params.jobId))
    .orderBy(desc(schema.estimates.createdAt));

  // Load uploads
  const jobUploads = await db
    .select()
    .from(schema.uploads)
    .where(eq(schema.uploads.jobId, params.jobId));

  return {
    id: job.id,
    status: job.status,
    jobType: job.jobType,
    urgency: job.urgency,
    effortBand: job.effortBand,
    costRange: job.estimatedCostMin && job.estimatedCostMax
      ? `$${job.estimatedCostMin}-$${job.estimatedCostMax}`
      : null,
    suburb: meta.suburb,
    address: meta.address,
    customerName: meta.customerName,
    customerPhone: meta.customerPhone,
    customerEmail: meta.customerEmail,
    scopeDescription: meta.scopeDescription,
    accessNotes: meta.accessNotes,
    importedTasks: meta.importedTasks || [],
    operatorNotes: meta.operatorNotes || [],
    referringAgent: meta.referringAgentName
      ? `${meta.referringAgentName} (${meta.pdfImportSource || ""})`
      : null,
    referringAgentPhone: meta.referringAgentPhone,
    referringAgentEmail: meta.referringAgentEmail,
    conversation: msgs.map((m) => ({
      sender: m.senderType,
      type: m.messageType,
      content: m.content,
      time: m.createdAt,
    })),
    estimates: jobEstimates.map((e) => ({
      type: e.estimateType,
      effortBand: e.effortBand,
      costRange: e.costMin && e.costMax ? `$${e.costMin}-$${e.costMax}` : null,
      hours: e.hoursMin && e.hoursMax ? `${e.hoursMin}-${e.hoursMax}hrs` : null,
      materials: e.materialsNote,
      assumptions: e.assumptionNotes,
      createdAt: e.createdAt,
    })),
    photos: jobUploads.map((u) => ({
      url: u.storageUrl,
      type: u.fileType,
      createdAt: u.createdAt,
    })),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

// ─────────────────────────────────────────────
// 3. add_job_note
// ─────────────────────────────────────────────

interface AddJobNoteParams {
  jobId: string;
  note: string;
  noteType?: "general" | "measurement" | "materials" | "access";
}

export async function addJobNote(params: AddJobNoteParams) {
  const db = await getDb();
  const { jobId, note, noteType = "general" } = params;

  // Insert as operator message
  await db.insert(schema.messages).values({
    jobId,
    senderType: "operator",
    messageType: "text",
    rawContent: `[${noteType}] ${note}`,
  });

  // Update metadata with operator notes
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  if (job) {
    const meta = (job.metadata as any) || {};
    const notes = meta.operatorNotes || [];
    notes.push({ type: noteType, text: note, timestamp: new Date().toISOString() });
    await db.update(schema.jobs).set({
      metadata: { ...meta, operatorNotes: notes },
    }).where(eq(schema.jobs.id, jobId));
  }

  log.info({ jobId, noteType }, "admin-chat.note.added");
  return { success: true, noteType, jobId };
}

// ─────────────────────────────────────────────
// 4. add_job_photos
// ─────────────────────────────────────────────

interface AddJobPhotosParams {
  jobId: string;
  photoUrls: string[];
  captions?: string[];
}

export async function addJobPhotos(params: AddJobPhotosParams) {
  const db = await getDb();
  const { jobId, photoUrls, captions } = params;

  // Insert upload records
  for (let i = 0; i < photoUrls.length; i++) {
    await db.insert(schema.uploads).values({
      jobId,
      fileType: "image/jpeg",
      storageUrl: photoUrls[i],
      metadataJson: captions?.[i] ? { caption: captions[i] } : undefined,
    });
  }

  // Insert operator message referencing photos
  await db.insert(schema.messages).values({
    jobId,
    senderType: "operator",
    messageType: "image",
    rawContent: `[Operator uploaded ${photoUrls.length} photo(s)]`,
  });

  // Update metadata
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  if (job) {
    const meta = (job.metadata as any) || {};
    const photos = meta.operatorPhotos || [];
    photoUrls.forEach((url, i) => {
      photos.push({ url, caption: captions?.[i] || null, timestamp: new Date().toISOString() });
    });
    await db.update(schema.jobs).set({
      metadata: { ...meta, operatorPhotos: photos },
    }).where(eq(schema.jobs.id, jobId));
  }

  log.info({ jobId, count: photoUrls.length }, "admin-chat.photos.added");
  return { success: true, count: photoUrls.length, jobId };
}

// ─────────────────────────────────────────────
// 5. update_job_estimate
// ─────────────────────────────────────────────

interface UpdateJobEstimateParams {
  jobId: string;
  effortBand?: string;
  hoursMin?: number;
  hoursMax?: number;
  costMin?: number;
  costMax?: number;
  materials?: string;
  assumptions?: string;
}

export async function updateJobEstimate(params: UpdateJobEstimateParams) {
  const db = await getDb();
  const { jobId, ...estimateData } = params;

  // Upsert operator ROM estimate
  const [existing] = await db
    .select()
    .from(schema.estimates)
    .where(and(
      eq(schema.estimates.jobId, jobId),
      eq(schema.estimates.estimateType, "operator_rom"),
    ))
    .limit(1);

  const values: any = {
    jobId,
    estimateType: "operator_rom" as const,
    ...(estimateData.effortBand && { effortBand: estimateData.effortBand }),
    ...(estimateData.hoursMin !== undefined && { hoursMin: String(estimateData.hoursMin) }),
    ...(estimateData.hoursMax !== undefined && { hoursMax: String(estimateData.hoursMax) }),
    ...(estimateData.costMin !== undefined && { costMin: estimateData.costMin }),
    ...(estimateData.costMax !== undefined && { costMax: estimateData.costMax }),
    ...(estimateData.materials && { materialsNote: estimateData.materials }),
    ...(estimateData.assumptions && { assumptionNotes: estimateData.assumptions }),
  };

  if (existing) {
    await db.update(schema.estimates).set(values).where(eq(schema.estimates.id, existing.id));
  } else {
    await db.insert(schema.estimates).values(values);
  }

  // Update denormalized columns on job
  const jobUpdates: any = {};
  if (estimateData.effortBand) jobUpdates.effortBand = estimateData.effortBand;
  if (estimateData.costMin !== undefined) jobUpdates.estimatedCostMin = estimateData.costMin;
  if (estimateData.costMax !== undefined) jobUpdates.estimatedCostMax = estimateData.costMax;
  if (estimateData.hoursMin !== undefined) jobUpdates.estimatedHoursMin = String(estimateData.hoursMin);
  if (estimateData.hoursMax !== undefined) jobUpdates.estimatedHoursMax = String(estimateData.hoursMax);

  if (Object.keys(jobUpdates).length > 0) {
    await db.update(schema.jobs).set(jobUpdates).where(eq(schema.jobs.id, jobId));
  }

  log.info({ jobId, effortBand: estimateData.effortBand }, "admin-chat.estimate.updated");
  return { success: true, jobId, estimate: values };
}

// ─────────────────────────────────────────────
// 6. update_job_status
// ─────────────────────────────────────────────

interface UpdateJobStatusParams {
  jobId: string;
  newStatus: string;
  reason?: string;
}

export async function updateJobStatus(params: UpdateJobStatusParams) {
  const db = await getDb();
  const { jobId, newStatus, reason } = params;

  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  if (!job) return { error: "Job not found" };

  const oldStatus = job.status;

  await db.update(schema.jobs).set({
    status: newStatus as any,
  }).where(eq(schema.jobs.id, jobId));

  await db.insert(schema.jobStateEvents).values({
    jobId,
    fromState: oldStatus as any,
    toState: newStatus as any,
    actorType: "operator",
    reason: reason || `Status updated via admin chat`,
  });

  log.info({ jobId, from: oldStatus, to: newStatus }, "admin-chat.status.updated");
  return { success: true, jobId, from: oldStatus, to: newStatus };
}

// ─────────────────────────────────────────────
// 7. get_schedule_summary
// ─────────────────────────────────────────────

interface GetScheduleSummaryParams {
  period?: "today" | "this_week" | "next_week" | "all_active";
}

export async function getScheduleSummary(params: GetScheduleSummaryParams) {
  const db = await getDb();
  const { period = "all_active" } = params;

  const activeStatuses = [
    "needs_site_visit", "scheduled", "in_progress",
    "partial_intake", "awaiting_customer", "ready_for_review",
    "estimate_presented", "bookable",
  ];

  const rows = await db
    .select({
      id: schema.jobs.id,
      jobType: schema.jobs.jobType,
      status: schema.jobs.status,
      urgency: schema.jobs.urgency,
      effortBand: schema.jobs.effortBand,
      metadata: schema.jobs.metadata,
      updatedAt: schema.jobs.updatedAt,
    })
    .from(schema.jobs)
    .where(inArray(schema.jobs.status, activeStatuses as any))
    .orderBy(desc(schema.jobs.updatedAt))
    .limit(30);

  const summary = rows.map((r) => {
    const meta = (r.metadata as any) || {};
    return {
      id: r.id,
      jobType: r.jobType,
      status: r.status,
      urgency: r.urgency,
      effortBand: r.effortBand,
      suburb: meta.suburb,
      customerName: meta.customerName,
      scopeSummary: meta.scopeDescription?.substring(0, 80),
    };
  });

  // Group by status
  const byStatus: Record<string, typeof summary> = {};
  for (const job of summary) {
    const s = job.status || "unknown";
    if (!byStatus[s]) byStatus[s] = [];
    byStatus[s].push(job);
  }

  return { total: summary.length, byStatus };
}

// ─────────────────────────────────────────────
// 8. generate_formal_quote (placeholder — wired in Phase 6)
// ─────────────────────────────────────────────

interface GenerateFormalQuoteParams {
  jobId: string;
  lineItems?: Array<{ description: string; amount: number }>;
  notes?: string;
  validDays?: number;
}

export async function generateFormalQuote(params: GenerateFormalQuoteParams) {
  const db = await getDb();
  const detail = await getJobDetail({ jobId: params.jobId });
  if ("error" in detail) return detail;

  // Build simple text quote
  const lineItems = params.lineItems || [{
    description: detail.scopeDescription || "Works as discussed",
    amount: detail.estimates?.[0]?.costRange
      ? parseInt(detail.estimates[0].costRange.split("-")[1]?.replace(/\D/g, "") || "0")
      : 0,
  }];

  const subtotal = lineItems.reduce((sum, item) => sum + item.amount, 0);
  const gst = Math.round(subtotal * 0.1);
  const total = subtotal + gst;

  const quoteText = [
    `QUOTE — Odd Job Todd`,
    `Date: ${new Date().toLocaleDateString("en-AU")}`,
    `Valid for: ${params.validDays || 14} days`,
    ``,
    `Customer: ${detail.customerName || "TBC"}`,
    `Property: ${detail.address || detail.suburb || "TBC"}`,
    detail.referringAgent ? `Agent: ${detail.referringAgent}` : null,
    ``,
    `--- Scope of Works ---`,
    ...lineItems.map((item, i) => `${i + 1}. ${item.description} — $${item.amount}`),
    ``,
    `Subtotal: $${subtotal}`,
    `GST (10%): $${gst}`,
    `TOTAL: $${total}`,
    ``,
    params.notes ? `Notes: ${params.notes}` : null,
    ``,
    `Terms: Payment on completion. Materials included unless stated otherwise.`,
  ].filter(Boolean).join("\n");

  log.info({ jobId: params.jobId, total }, "admin-chat.quote.generated");
  return {
    success: true,
    jobId: params.jobId,
    quoteText,
    total,
    lineItems,
  };
}
