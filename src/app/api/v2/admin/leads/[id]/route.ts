/**
 * GET /api/v2/admin/leads/:id
 *
 * Lead detail endpoint — full view of a single lead including
 * scoring breakdown, conversation history, metadata, and outcome.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { jobs, jobOutcomes, messages, estimates } from "@/lib/db/schema";
import { eq, asc } from "drizzle-orm";
import { runScoringPipeline } from "@/lib/domain/scoring/scoringPipelineService";
import type { AccumulatedJobState } from "@/lib/ai/extractors/extractionSchema";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const db = await getDb();
    const { id } = await params;

    // ── Load job ────────────────────────────
    const jobRows = await db
      .select()
      .from(jobs)
      .where(eq(jobs.id, id))
      .limit(1);

    if (jobRows.length === 0) {
      return NextResponse.json({ error: "Lead not found" }, { status: 404 });
    }

    const job = jobRows[0];
    const state = (job.metadata as AccumulatedJobState) || {};

    // ── Live scoring (always fresh) ─────────
    const scoring = runScoringPipeline(state as AccumulatedJobState);

    // ── Conversation history ────────────────
    let conversation: any[] = [];
    try {
      const msgs = await db
        .select({
          id: messages.id,
          senderType: messages.senderType,
          content: messages.rawContent,
          extractedJson: messages.extractedJson,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(eq(messages.jobId, id))
        .orderBy(asc(messages.createdAt));

      conversation = msgs.map((m: typeof msgs[number]) => ({
        id: m.id,
        senderType: m.senderType,
        content: m.content,
        extraction: m.extractedJson || null,
        timestamp: m.createdAt,
      }));
    } catch {
      // Messages might not exist for this job
    }

    // ── Outcome ─────────────────────────────
    let outcome = null;
    try {
      const outcomeRows = await db
        .select()
        .from(jobOutcomes)
        .where(eq(jobOutcomes.jobId, id))
        .limit(1);

      if (outcomeRows.length > 0) {
        outcome = outcomeRows[0];
      }
    } catch {
      // Table might not exist
    }

    // ── Estimate history ────────────────────
    let estimateHistory: any[] = [];
    try {
      const estRows = await db
        .select()
        .from(estimates)
        .where(eq(estimates.jobId, id))
        .orderBy(asc(estimates.createdAt));
      estimateHistory = estRows;
    } catch {
      // No estimates
    }

    // ── Channels ────────────────────────────
    let channelsData: any[] = [];
    try {
      const { ensureSemanticObject } = await import("@/lib/domain/bridge/semanticRuntimeAdapter");
      const { getChannelsForObject, getParticipants } = await import("@/lib/semantos-kernel/channelService");
      const semCtx = await ensureSemanticObject(db, id, job.jobType);
      const allChannels = await getChannelsForObject(semCtx.semanticObjectId);
      const allParticipants = await getParticipants(semCtx.semanticObjectId);
      channelsData = allChannels.map((ch: any) => ({
        id: ch.id,
        kind: ch.channelKind,
        label: ch.label,
        participants: (ch.participantIds as string[]).map((pid: string) => {
          const p = allParticipants.find((pp: any) => pp.id === pid);
          return p ? { id: p.id, identityRef: p.identityRef, role: p.participantRole, displayName: p.displayName } : { id: pid };
        }),
      }));
    } catch {
      // No semantic object yet — channels not available
    }

    return NextResponse.json({
      job: {
        id: job.id,
        status: job.status,
        jobType: job.jobType,
        subcategory: job.subcategory,
        urgency: job.urgency,
        effortBand: job.effortBand,
        estimatedCostMin: job.estimatedCostMin,
        estimatedCostMax: job.estimatedCostMax,
        recommendation: job.recommendation,
        customerFitScore: job.customerFitScore,
        quoteWorthinessScore: job.quoteWorthinessScore,
        confidenceScore: job.confidenceScore,
        suburbGroup: job.suburbGroup,
        isRepeatCustomer: job.isRepeatCustomer,
        repeatJobCount: job.repeatJobCount,
        needsReview: job.needsReview,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      },
      scoring: {
        fit: scoring.snapshot.fit,
        worthiness: scoring.snapshot.worthiness,
        recommendation: scoring.snapshot.recommendation,
        confidence: scoring.snapshot.confidence,
        completeness: scoring.snapshot.completeness,
        estimateAck: scoring.snapshot.estimateAck,
      },
      conversation,
      metadata: state,
      outcome,
      // Placeholders for future enrichment
      repeatHistory: {
        isRepeat: job.isRepeatCustomer,
        previousJobs: [],
      },
      channels: channelsData,
      scheduleContext: null,
      policyVersion: 1, // Will come from getActivePolicy once wired
    });
  } catch (error: any) {
    console.error("GET /api/v2/admin/leads/:id error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
