/**
 * Chat Service — Main Orchestrator
 *
 * Sprint 3: Now includes scoring, estimate acknowledgement, and recommendations.
 *
 * Full cycle for each customer message:
 * 1. Save incoming message immediately (incremental persistence)
 * 2. Run extraction LLM to pull structured data
 * 3. Merge extraction into accumulated job state
 * 4. Classify estimate acknowledgement (if estimate was presented)
 * 5. Run customer fit scoring
 * 6. Run quote-worthiness scoring
 * 7. Generate recommendation
 * 8. Evaluate conversation state → decide next action
 * 9. Build chat prompt with any system injections
 * 10. Call chat LLM for the reply
 * 11. Save the AI reply message
 * 12. Update job record with all scores and state
 * 13. Return the reply + metadata
 */

import Anthropic from "@anthropic-ai/sdk";
import { eq, desc, and } from "drizzle-orm";
import { getDb } from "../db/client";
import * as schema from "../db/schema";
import {
  messageExtractionSchema,
  accumulatedJobStateSchema,
  mergeExtraction,
  type AccumulatedJobState,
  type MessageExtraction,
} from "../ai/extractors/extractionSchema";
import { buildSystemPrompt } from "../ai/prompts/systemPrompt";
import { buildExtractionPrompt } from "../ai/prompts/extractionPrompt";
import {
  evaluateConversationState,
  generateSystemInjection,
} from "../domain/workflow/conversationStateManager";
import { classifyEstimateAcknowledgement } from "../ai/classifiers/estimateAcknowledgementClassifier";
import { scoreCustomerFit } from "../domain/scoring/customerFitService";
import { scoreQuoteWorthiness } from "../domain/scoring/quoteWorthinessService";
import { generateRecommendation } from "../domain/scoring/recommendationService";
import { inferEffortBand } from "../domain/estimates/effortBandService";
import { generateRomEstimate } from "../domain/estimates/estimateService";
import {
  ensureSemanticObject,
  recordStateSnapshot,
  recordScores,
  recordEvidence,
  recordInstrument,
  recordStatusTransition,
  type SemanticJobContext,
} from "../domain/bridge/semanticRuntimeAdapter";
import { objectPatches } from "../semantos-kernel/schema.core";
import { formatHistoryBlock, listRecentPatches } from "./patchChain";
import {
  buildProposedSlotClassifier,
  runHandleMessage,
} from "./ojtHandleMessage";
import { getCalendarGuard } from "../calendar/guard";
import type { ProposedSlot } from "@semantos/intent";
import { bookSlot } from "@semantos/calendar-ext";
import { getCalendarDb } from "../calendar/db";
import type { LexiconName, TaggedFact } from "../lexicons";
import {
  validateAgainstLexicon,
  buildRePromptForInvalid,
} from "../lexicons/validator";

// ── Types ────────────────────────────────────

export interface ChatInput {
  jobId: string;
  customerId: string;
  message: string;
  messageType?: "text" | "voice" | "image";
  photos?: string[]; // Vercel Blob URLs
  channelId?: string; // Conversation channel for multi-participant scoping
  /**
   * OJT-P5: optional federated history block to inject ahead of the
   * system prompt. Produced by `formatHistoryBlock(listRecentPatches())`.
   * Undefined when called from legacy entry points — the prompt then
   * falls back to its original layout.
   */
  historyBlock?: string;
}

export interface ChatResult {
  reply: string;
  jobId: string; // May differ from input if job pivot created a new job
  channelId?: string; // Auto-created channel for this participant
  extraction: MessageExtraction;
  jobState: AccumulatedJobState;
  conversationPhase: string;
  completenessScore: number;
  estimatePresented: boolean;
  // Sprint 3 additions
  customerFitScore: number | null;
  customerFitLabel: string | null;
  quoteWorthinessScore: number | null;
  quoteWorthinessLabel: string | null;
  recommendation: string | null;
  recommendationReason: string | null;
  estimateAckStatus: string;
}

// ── Config ────────────────────────────────────

const EXTRACTION_MODEL = "claude-haiku-4-5-20251001";
const CHAT_MODEL = "claude-haiku-4-5-20251001";

// ── Service ──────────────────────────────────

export async function processCustomerMessage(input: ChatInput): Promise<ChatResult> {
  const db = await getDb();
  const anthropic = new Anthropic();

  // 1. Save incoming customer message immediately
  const custId = input.customerId || null;
  const [savedMsg] = await db
    .insert(schema.messages)
    .values({
      jobId: input.jobId,
      customerId: custId || undefined,
      senderType: "customer",
      messageType: input.messageType || "text",
      rawContent: input.message,
      channelId: input.channelId || undefined,
    })
    .returning();

  // Update job's last customer message timestamp
  await db
    .update(schema.jobs)
    .set({ lastCustomerMessageAt: new Date() })
    .where(eq(schema.jobs.id, input.jobId));

  // 2. Load current job state
  const [job] = await db
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.id, input.jobId));

  if (!job) throw new Error(`Job not found: ${input.jobId}`);

  // ── Semantic layer: ensure object exists ──
  let semCtx: SemanticJobContext = await ensureSemanticObject(
    db, input.jobId, job.jobType ?? null
  );

  // ── Auto-create channel if not already provided ──
  if (!input.channelId && custId) {
    try {
      const { addParticipantWithChannel, getChannelForParticipant } = await import("@/lib/semantos-kernel/channelService");
      const identityRef = `customer:${custId}`;
      // Check if channel already exists for this participant
      const existingChannel = await getChannelForParticipant(semCtx.semanticObjectId, identityRef);
      if (existingChannel) {
        input.channelId = existingChannel.id;
      } else {
        const { channel } = await addParticipantWithChannel({
          objectId: semCtx.semanticObjectId,
          identityRef,
          identityKind: "customer",
          participantRole: "creator",
        });
        input.channelId = channel.id;
      }
    } catch (err) {
      console.warn("chat.channel.auto_create_failed", err);
      // Non-fatal: continue without channelId
    }
  }

  // ── Semantic layer: record customer message as evidence ──
  recordEvidence(db, semCtx, savedMsg.id, input.message, "customer", input.channelId);

  let currentState = loadJobState(job);

  // 3. Build conversation summary from recent messages
  //    If channelId is set, scope to that channel only (multi-participant privacy)
  const messageFilter = input.channelId
    ? and(eq(schema.messages.jobId, input.jobId), eq(schema.messages.channelId, input.channelId))
    : eq(schema.messages.jobId, input.jobId);
  const recentMessages = await db
    .select()
    .from(schema.messages)
    .where(messageFilter)
    .orderBy(desc(schema.messages.createdAt))
    .limit(20);

  const conversationSummary = recentMessages
    .reverse()
    .map((m: any) => `${m.senderType}: ${m.rawContent}`)
    .join("\n");

  // 4. Run extraction LLM
  // Append photo context if photos were sent
  let messageForExtraction = input.message;
  if (input.photos && input.photos.length > 0) {
    messageForExtraction += `\n[Customer also sent ${input.photos.length} photo(s)]`;
    currentState.photosReferenced = true;
  }

  const extractionPrompt = buildExtractionPrompt(
    currentState,
    messageForExtraction,
    conversationSummary
  );

  const extractionResponse = await anthropic.messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: extractionPrompt }],
  });

  const extractionText =
    extractionResponse.content[0].type === "text"
      ? extractionResponse.content[0].text
      : "";

  let extraction: MessageExtraction;
  try {
    // Strip markdown code fences if present
    let cleanText = extractionText.trim();
    if (cleanText.startsWith("```")) {
      cleanText = cleanText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    const parsed = JSON.parse(cleanText);
    extraction = messageExtractionSchema.parse(parsed);
  } catch (err) {
    console.warn("[chatService] Extraction parse failed:", (err as Error).message?.substring(0, 200));
    console.warn("[chatService] Raw extraction text:", extractionText.substring(0, 300));
    extraction = messageExtractionSchema.parse({});
  }

  // 4b. Handle job pivot — if customer switched to a completely different job,
  // create a new job record instead of merging into the current one.
  if (extraction.jobPivot === "different_job" && currentState.jobType) {
    // Save current job state as-is (don't overwrite with new extraction)
    await db.update(schema.jobs).set({ metadata: currentState }).where(eq(schema.jobs.id, input.jobId));

    // Create a new job for the different work
    const [newJob] = await db.insert(schema.jobs).values({
      organisationId: job.organisationId,
      customerId: input.customerId || undefined,
      leadSource: "website_chat" as const,
      status: "new_lead" as const,
    }).returning();

    // Re-run with the new job — reset state, use the new extraction
    input.jobId = newJob.id;
    // We'll continue processing with a fresh state below
    currentState = accumulatedJobStateSchema.parse({});
  }

  // 5. Merge extraction into accumulated state
  const mergeResult = mergeExtraction(currentState, extraction);
  // Cast to AccumulatedJobState — TypeScript can't always resolve the Zod inference
  // through MergeResult.state, but the runtime type is always AccumulatedJobState.
  const mergedState = mergeResult.state as AccumulatedJobState;

  // 6. Classify estimate acknowledgement if estimate was presented
  if (mergedState.estimatePresented && !mergedState.estimateAcknowledged) {
    const ackResult = classifyEstimateAcknowledgement(
      extraction.estimateReaction,
      extraction.budgetReaction,
      input.message
    );

    if (ackResult.status !== "unclear" && ackResult.status !== "pending") {
      mergedState.estimateAcknowledged = true;
      mergedState.estimateAckStatus = ackResult.status;
      mergedState.estimateAckMessageId = savedMsg.id;
      mergedState.estimateAckTimestamp = new Date().toISOString();
    }
  }

  // 7. Run scoring
  const fitResult = scoreCustomerFit(mergedState);
  mergedState.customerFitScore = fitResult.score;
  mergedState.customerFitLabel = fitResult.label;

  const worthinessResult = scoreQuoteWorthiness(mergedState, fitResult.score);
  mergedState.quoteWorthinessScore = worthinessResult.score;
  mergedState.quoteWorthinessLabel = worthinessResult.label;

  // 8. Generate recommendation
  const recResult = generateRecommendation(mergedState, fitResult, worthinessResult);
  mergedState.recommendation = recResult.recommendation;
  mergedState.recommendationReason = recResult.reason;

  // ── Semantic layer: record state snapshot + scores ──
  semCtx = await recordStateSnapshot(
    db, semCtx, mergeResult, mergedState, `message:${savedMsg.id}`
  );
  recordScores(db, semCtx, {
    customerFitScore: mergedState.customerFitScore,
    customerFitLabel: mergedState.customerFitLabel,
    quoteWorthinessScore: mergedState.quoteWorthinessScore,
    quoteWorthinessLabel: mergedState.quoteWorthinessLabel,
    completenessScore: mergedState.completenessScore,
  });

  // 9. Evaluate conversation state → decide action
  const action = evaluateConversationState(mergedState);
  const systemInjection = generateSystemInjection(action);

  // Track if we're presenting an estimate this turn
  let estimatePresented = mergedState.estimatePresented;
  if (action.type === "present_estimate") {
    estimatePresented = true;
    mergedState.estimatePresented = true;
  }

  // 10. Build chat messages (with PDF context + channel policy context if applicable)
  const pdfImportContext = job.leadSource === "agent_pdf" && mergedState.importedTasks?.length
    ? {
        address: mergedState.address || mergedState.suburb || "the property",
        tasks: mergedState.importedTasks.map((t: { description: string }) => t.description),
        agentName: mergedState.referringAgentName || undefined,
        gaps: mergedState.missingInfo || [],
      }
    : undefined;

  // Resolve channel policy for this participant (if channel exists)
  let channelContext: {
    participantRole: string;
    systemPromptAdditions?: string[];
    toneOverrides?: { formality?: string; role?: string };
    hiddenTopics?: string[];
  } | undefined = undefined;
  if (input.channelId && custId) {
    try {
      const { findParticipant } = await import("@/lib/semantos-kernel/channelService");
      const { evaluateChannelPolicy, filterStateForAi } = await import("@/lib/semantos-kernel/policyEvaluator");
      const identityRef = `customer:${custId}`;
      const participant = await findParticipant(semCtx.semanticObjectId, identityRef);
      if (participant) {
        const policyEval = await evaluateChannelPolicy(input.channelId, participant.id, participant.participantRole);
        if (policyEval) {
          // Determine hidden topics from field visibility
          const hiddenTopics: string[] = [];
          const roleRule = policyEval.roleRule;
          for (const [field, vis] of Object.entries(roleRule.fieldVisibility)) {
            if (vis === "hidden") {
              if (field.includes("estimate") || field.includes("rom") || field.includes("cost")) {
                hiddenTopics.push("pricing");
                hiddenTopics.push("estimates");
              }
            }
          }

          channelContext = {
            participantRole: participant.participantRole,
            systemPromptAdditions: policyEval.aiContext.systemPromptAdditions,
            toneOverrides: policyEval.aiContext.toneOverrides,
            hiddenTopics: [...new Set(hiddenTopics)],
          };
        }
      }
    } catch (err) {
      console.warn("chat.policy.evaluation_failed", err);
    }
  }

  const systemPrompt = buildSystemPrompt({
    pdfImportContext,
    channelContext,
    historyBlock: input.historyBlock,
  });
  const chatMessages: Anthropic.MessageParam[] = buildChatMessages(
    recentMessages,
    systemInjection
  );

  // 11. Call chat LLM
  const chatResponse = await anthropic.messages.create({
    model: CHAT_MODEL,
    max_tokens: 512,
    system: systemPrompt,
    messages: chatMessages,
  });

  const reply =
    chatResponse.content[0].type === "text"
      ? chatResponse.content[0].text
      : "Sorry, something went wrong. Can you say that again?";

  // 12. Save AI reply
  const [savedReply] = await db.insert(schema.messages).values({
    jobId: input.jobId,
    customerId: custId || undefined,
    senderType: "ai",
    messageType: "text",
    rawContent: reply,
    channelId: input.channelId || undefined,
  }).returning();

  // ── Semantic layer: record AI reply as evidence ──
  recordEvidence(db, semCtx, savedReply.id, reply, "ai", input.channelId);

  // 13. Update job record with all scores
  const jobUpdates: Record<string, unknown> = {
    completenessScore: mergedState.completenessScore,
    customerFitScore: mergedState.customerFitScore,
    quoteWorthinessScore: mergedState.quoteWorthinessScore,
    metadata: mergedState,
  };

  if (extraction.jobType) {
    jobUpdates.jobType = extraction.jobType;
  }
  if (extraction.scopeDescription && !job.descriptionRaw) {
    jobUpdates.descriptionRaw = extraction.scopeDescription;
  }
  if (extraction.urgency) {
    jobUpdates.urgency = extraction.urgency;
  }

  // Infer effort band — always re-infer as scope clarifies (not just first time)
  if (mergedState.scopeDescription && mergedState.jobType) {
    const effortResult = inferEffortBand({
      jobType: mergedState.jobType,
      subcategory: mergedState.jobSubcategory,
      quantity: mergedState.quantity,
      scopeDescription: mergedState.scopeDescription,
      materials: mergedState.materials,
      accessDifficulty: mergedState.accessDifficulty,
    });
    if (effortResult.band !== "unknown") {
      jobUpdates.effortBand = effortResult.band;
      mergedState.effortBandReason = effortResult.reason;
    }
  }

  // Update status based on conversation phase
  const newStatus = mapPhaseToStatus(extraction.conversationPhase, mergedState);
  if (newStatus && newStatus !== job.status) {
    const oldStatus = job.status;
    jobUpdates.status = newStatus;

    await db.insert(schema.jobStateEvents).values({
      jobId: input.jobId,
      fromState: oldStatus as typeof schema.jobStatusEnum.enumValues[number],
      toState: newStatus as typeof schema.jobStatusEnum.enumValues[number],
      actorType: "system" as const,
      reason: `Conversation phase: ${extraction.conversationPhase}`,
    });

    // ── Semantic layer: record status transition ──
    recordStatusTransition(db, semCtx, oldStatus, newStatus, `phase:${extraction.conversationPhase}`);
  }

  // Save estimate record if presenting one — also write back to jobs table
  if (action.type === "present_estimate") {
    const effortResult = inferEffortBand({
      jobType: mergedState.jobType,
      subcategory: mergedState.jobSubcategory,
      quantity: mergedState.quantity,
      scopeDescription: mergedState.scopeDescription,
      materials: mergedState.materials,
      accessDifficulty: mergedState.accessDifficulty,
    });
    const romEstimate = generateRomEstimate({
      effortBand: effortResult.band,
      jobType: mergedState.jobType,
      materials: mergedState.materials,
      quantity: mergedState.quantity,
    });

    await db.insert(schema.estimates).values({
      jobId: input.jobId,
      estimateType: "auto_rom",
      effortBand: effortResult.band,
      costMin: romEstimate.costMin,
      costMax: romEstimate.costMax,
      labourOnly: romEstimate.labourOnly,
      materialsNote: romEstimate.materialsNote,
    });

    // Write estimate data back to jobs table for fast admin queries
    jobUpdates.estimatedCostMin = romEstimate.costMin;
    jobUpdates.estimatedCostMax = romEstimate.costMax;
    jobUpdates.estimatedHoursMin = String(romEstimate.hoursMin);
    jobUpdates.estimatedHoursMax = String(romEstimate.hoursMax);
    jobUpdates.effortBand = effortResult.band;

    // Enrich metadata with estimate context
    mergedState.effortBandReason = effortResult.reason;
    mergedState.labourOnly = romEstimate.labourOnly;
    mergedState.materialsNote = romEstimate.materialsNote;

    // Compute ROM confidence from scope clarity
    const sc = mergedState.scopeClarity;
    const hasQuantity = !!mergedState.quantity;
    if (sc >= 60 && hasQuantity && effortResult.band !== "multi_day") {
      mergedState.romConfidence = "high";
    } else if (sc < 35 || effortResult.band === "multi_day") {
      mergedState.romConfidence = "low";
    } else {
      mergedState.romConfidence = "medium";
    }

    // Re-set metadata since we enriched it
    jobUpdates.metadata = mergedState;

    // ── Semantic layer: record ROM instrument ──
    recordInstrument(db, semCtx, {
      effortBand: effortResult.band,
      costMin: romEstimate.costMin,
      costMax: romEstimate.costMax,
      hoursMin: romEstimate.hoursMin,
      hoursMax: romEstimate.hoursMax,
      labourOnly: romEstimate.labourOnly,
      materialsNote: romEstimate.materialsNote || undefined,
    });
  }

  await db
    .update(schema.jobs)
    .set(jobUpdates)
    .where(eq(schema.jobs.id, input.jobId));

  // 14. Return full result
  return {
    reply,
    jobId: input.jobId,
    channelId: input.channelId,
    extraction,
    jobState: mergedState,
    conversationPhase: extraction.conversationPhase,
    completenessScore: mergedState.completenessScore,
    estimatePresented,
    customerFitScore: mergedState.customerFitScore,
    customerFitLabel: mergedState.customerFitLabel,
    quoteWorthinessScore: mergedState.quoteWorthinessScore,
    quoteWorthinessLabel: mergedState.quoteWorthinessLabel,
    recommendation: mergedState.recommendation,
    recommendationReason: mergedState.recommendationReason,
    estimateAckStatus: mergedState.estimateAckStatus,
  };
}

// ── Helpers ──────────────────────────────────

function loadJobState(job: typeof schema.jobs.$inferSelect): AccumulatedJobState {
  if (job.metadata && typeof job.metadata === "object") {
    try {
      return accumulatedJobStateSchema.parse(job.metadata);
    } catch {
      // Fall through
    }
  }

  return accumulatedJobStateSchema.parse({
    jobType: job.jobType,
    scopeDescription: job.descriptionRaw,
    urgency: job.urgency,
    completenessScore: job.completenessScore ?? 0,
    conversationPhase: "greeting",
  });
}

function buildChatMessages(
  dbMessages: (typeof schema.messages.$inferSelect)[],
  systemInjection: string | null
): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];

  const sorted = [...dbMessages].reverse();
  for (const msg of sorted) {
    const role = msg.senderType === "customer" ? "user" : "assistant";
    if (msg.senderType === "system") continue;
    messages.push({ role, content: msg.rawContent || "" });
  }

  if (systemInjection) {
    messages.push({ role: "user", content: systemInjection });
  }

  return normaliseMessageOrder(messages);
}

function normaliseMessageOrder(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length === 0) return [{ role: "user", content: "Hi" }];

  const normalised: Anthropic.MessageParam[] = [];
  for (const msg of messages) {
    const last = normalised[normalised.length - 1];
    if (last && last.role === msg.role) {
      last.content = `${last.content}\n\n${msg.content}`;
    } else {
      normalised.push({ ...msg });
    }
  }

  if (normalised[0]?.role !== "user") {
    normalised.unshift({ role: "user", content: "Hi" });
  }

  return normalised;
}

function mapPhaseToStatus(
  phase: string,
  state: AccumulatedJobState
): string | null {
  // Let estimate acknowledgement drive status more precisely
  if (state.estimateAckStatus === "rejected") return "not_price_aligned";
  if (state.estimateAckStatus === "accepted" && state.customerPhone) return "ready_for_review";
  if (state.estimateAckStatus === "accepted") return "estimate_accepted";

  switch (phase) {
    case "greeting":
    case "describing_job":
    case "providing_details":
    case "providing_location":
      return "partial_intake";
    case "reviewing_estimate":
      return "estimate_presented";
    case "providing_contact":
      return "estimate_presented";
    case "confirmed":
      return "ready_for_review";
    case "disengaged":
      return state.estimatePresented ? "not_price_aligned" : "partial_intake";
    default:
      return null;
  }
}

// ─────────────────────────────────────────────
// OJT-P4: handleTenantMessage — HTTP-edge wrapper
//
// Thin adapter on top of processCustomerMessage that takes the
// phone-derived identity carried in by /api/v3/chat and turns it into
// the {jobId, customerId, message} contract the existing pipeline
// expects. P4 does not rewire the pipeline — P5 will replace the
// internals with handleMessage. Kept minimal on purpose.
// ─────────────────────────────────────────────

export interface HandleTenantMessageInput {
  identity: { facetId: string; certId: string };
  message: string;
  jobId?: string;
  /**
   * A5: optional time slot the tenant is proposing for this turn.
   * When supplied AND the calendar guard is enabled, the wired
   * classifier emits an Intent carrying this slot in its delta — the
   * orchestrator then runs the guard before any LLM work. In production
   * this is filled in by an upstream extractor (LLM with prompt §6
   * guidance); test gates pass it directly.
   */
  proposedSlot?: ProposedSlot;
  /**
   * A5: when the happy-path proposal should atomically book the slot
   * after the LLM confirms. Tests set this to true to exercise G2's
   * cal_bookings write; production wires it from a downstream
   * confirmation classifier (deferred to A5.3).
   */
  confirmBooking?: boolean;
}

export interface HandleTenantMessageResult {
  reply: string;
  jobId: string;
}

// Test-only override hook. When set (via __setHandleTenantMessageForTests)
// /api/v3/chat runs this instead of the real pipeline. Production code
// must never touch it; the real implementation is exported unchanged.
let _handleTenantMessageOverride:
  | ((input: HandleTenantMessageInput) => Promise<HandleTenantMessageResult>)
  | null = null;

export function __setHandleTenantMessageForTests(
  fn:
    | ((input: HandleTenantMessageInput) => Promise<HandleTenantMessageResult>)
    | null,
): void {
  _handleTenantMessageOverride = fn;
}

export async function handleTenantMessage(
  input: HandleTenantMessageInput,
): Promise<HandleTenantMessageResult> {
  if (_handleTenantMessageOverride) {
    return _handleTenantMessageOverride(input);
  }
  const db = await getDb();

  // ── Resolve-or-create a job ────────────────────────────────────
  //
  // We still need a legacy `jobs` row so processCustomerMessage runs,
  // but we also need the `sem_objects` row (the semantic-object id)
  // because that's the objectId every federation patch references.
  let jobId = input.jobId;
  if (!jobId) {
    const [org] = await db.select().from(schema.organisations).limit(1);
    let organisationId: string;
    if (org) {
      organisationId = org.id;
    } else {
      const [created] = await db
        .insert(schema.organisations)
        .values({ name: "OJT" })
        .returning();
      organisationId = created.id;
    }

    const [newJob] = await db
      .insert(schema.jobs)
      .values({
        organisationId,
        leadSource: "website_chat",
        status: "new_lead",
      })
      .returning();
    jobId = newJob.id;
  }

  // Materialise the semantic object so we have a stable objectId for
  // the patch chain + handleMessage's conversation patch.
  const [jobRow] = await db
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.id, jobId));
  if (!jobRow) {
    throw new Error(`handleTenantMessage: job not found: ${jobId}`);
  }
  const semCtx = await ensureSemanticObject(db, jobId, jobRow.jobType ?? null);
  const semObjectId = semCtx.semanticObjectId;

  // ── 1. Load patch chain for LLM context ───────────────────────
  const n = readPatchChainLimit();
  const chain = await listRecentPatches(semObjectId, n);
  const historyBlock = formatHistoryBlock(chain);

  // ── 2. Resolve A5 calendar guard (singleton; null when flag off) ─
  const calendarGuard = await getCalendarGuard();

  // ── 2a. Run handleMessage to get triage hint ──────────────────
  // When the caller supplied a proposedSlot we wire a classifier that
  // carries it in the Intent's delta so the orchestrator's guard step
  // can fire. Otherwise we fall through to the default rules-only
  // classifier and the guard is a no-op.
  const triage = await runHandleMessage({
    objectId: semObjectId,
    identity: input.identity,
    message: input.message,
    calendarGuard: calendarGuard ?? undefined,
    classifier: input.proposedSlot
      ? buildProposedSlotClassifier(input.proposedSlot)
      : undefined,
  });

  // ── 3. NO_INTENT short-circuit — no LLM, no patches ───────────
  if (triage.triageHint === "NO_INTENT") {
    return {
      reply: "Got nothing to work with there — can you give me a bit more detail?",
      jobId,
    };
  }

  // ── 3b. A5: REJECT_CONFLICT short-circuit ─────────────────────
  // The guard reported the proposed slot collides with a booking
  // (or live hold) on the schedule. Skip the LLM entirely — render
  // the conflict + free windows, persist a conflict patch, and return.
  if (triage.triageHint === "REJECT_CONFLICT") {
    const raw = triage.raw as Extract<
      typeof triage.raw,
      { kind: "reject_conflict" }
    >;
    const replyMsg = formatConflictReply(raw);
    await persistTurnPatch({
      objectId: semObjectId,
      identity: input.identity,
      // 'calendar' isn't in OJT's LexiconName union (jural | property-
      // management) but the underlying sem_object_patches.lexicon
      // column is varchar(100) — federation consumers filter by string
      // match. Cast through the local alias for the call site.
      lexicon: "calendar" as unknown as LexiconName,
      delta: {
        verb: "conflict",
        proposedSlot: serializeSlot(raw.proposedSlot),
        conflictingBookings: raw.conflictingBookings.map((b) => ({
          id: b.id,
          hatId: b.hatId,
          startAt:
            b.startAt instanceof Date
              ? b.startAt.toISOString()
              : String(b.startAt),
          endAt:
            b.endAt instanceof Date
              ? b.endAt.toISOString()
              : String(b.endAt),
          subjectKind: b.subjectKind,
          subjectId: b.subjectId,
        })),
        freeWindows: raw.freeWindows.slice(0, 3).map((w) => ({
          startAt:
            w.startAt instanceof Date
              ? w.startAt.toISOString()
              : String(w.startAt),
          endAt:
            w.endAt instanceof Date
              ? w.endAt.toISOString()
              : String(w.endAt),
        })),
      },
      source: `handleMessage:${triage.correlationId}`,
    });
    return { reply: replyMsg, jobId };
  }

  // ── 4. Run existing LLM pipeline (extraction + scoring + chat) ─
  const result = await processCustomerMessage({
    jobId,
    customerId: "",
    message: input.message,
    historyBlock,
  });

  // ── 4a. A5: atomic bookSlot on happy-path proposal confirmation ─
  // When the caller flagged confirmBooking AND the guard didn't reject,
  // book the slot now. We deliberately put the bookSlot call BEFORE the
  // turn-patch persist below so a booking failure aborts the whole turn
  // (caller sees a 500; no half-written state). The booking itself is
  // an `appendPatch` on the schedule sem_object so it shares the
  // calendar DB's transaction semantics; we don't bracket it with
  // OJT's main DB because they're separate databases by design.
  if (input.proposedSlot && input.confirmBooking && calendarGuard) {
    try {
      const calDb = await getCalendarDb();
      await bookSlot(calDb as never, {
        hatId: input.proposedSlot.hatId,
        startAt: input.proposedSlot.startAt,
        endAt: input.proposedSlot.endAt,
        subjectKind: input.proposedSlot.subjectKind,
        subjectId: input.proposedSlot.subjectId,
        bookedByCertId:
          input.proposedSlot.proposedByCertId || input.identity.certId,
        scheduleObjectId: process.env.CAL_SCHEDULE_OBJECT_ID,
      });
    } catch (err) {
      // Hard failure per A5 §2: rollback the chat turn. Throwing here
      // bubbles to /api/v3/chat which returns a 500 with detail.
      throw new Error(
        `bookSlot failed for proposedSlot: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ── 4b. OJT-P6: validate lexicon-tagged facts, one re-prompt on failure ─
  // The extractor LLM emits taggedFacts alongside the usual fields.
  // validateAgainstLexicon enforces the semantos registry. If any fact
  // is invalid we fire ONE corrective re-prompt to the extractor; any
  // still-invalid facts after that are dropped to null-tagged. Never a
  // second retry — bounded by the anti-bullshit rule.
  const initialFacts = extractTaggedFactsFromExtraction(result.extraction);
  const validation = await runValidationWithOneRetry(
    initialFacts,
    input.message,
  );
  const dominantLexicon = pickDominantLexicon(validation.ok);

  // ── 5. Persist a turn patch carrying federation columns ───────
  //    P6: the patch now carries both the validator's summary (so
  //    downstream can see how many tags were demoted / dropped) and
  //    the dominant lexicon — threaded into persistTurnPatch as a
  //    first-class column, not shoved into delta.
  await persistTurnPatch({
    objectId: semObjectId,
    identity: input.identity,
    lexicon: dominantLexicon,
    delta: {
      triage: triage.triageHint,
      correlationId: triage.correlationId,
      conversationPatchId: triage.conversationPatchId,
      extraction: {
        jobType: result.extraction.jobType ?? null,
        conversationPhase: result.conversationPhase,
      },
      scores: {
        customerFitScore: result.customerFitScore,
        quoteWorthinessScore: result.quoteWorthinessScore,
        completenessScore: result.completenessScore,
      },
      taggedFacts: validation.ok,
      taggedFactsSummary: {
        total: initialFacts.length,
        okCount: validation.ok.length,
        invalidCount: validation.finalInvalidCount,
        rePromptUsed: validation.rePromptUsed,
      },
      reply: result.reply.slice(0, 400),
    },
    source: `handleMessage:${triage.correlationId}`,
  });

  return { reply: result.reply, jobId: result.jobId };
}

// ─────────────────────────────────────────────
// OJT-P6: tagged-fact extraction + validation + one-shot re-prompt
// ─────────────────────────────────────────────

/**
 * Pull TaggedFact[] off the MessageExtraction. The extraction schema's
 * `taggedFacts` is permissively typed (any strings + numbers) so we
 * coerce here into the stricter TaggedFact shape. Any malformed entry
 * is dropped silently — the validator would invalidate them anyway and
 * we'd rather keep the fast-path clean.
 */
function extractTaggedFactsFromExtraction(
  extraction: MessageExtraction,
): TaggedFact[] {
  const raw = (extraction as unknown as { taggedFacts?: Array<Record<string, unknown>> })
    .taggedFacts;
  if (!Array.isArray(raw)) return [];
  const out: TaggedFact[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const lexicon = r.lexicon as unknown;
    const category = r.category as unknown;
    const confidence = typeof r.confidence === "number" ? r.confidence : 0;
    const fact = typeof r.fact === "string" ? r.fact : "";
    const source = typeof r.source === "string" ? r.source : "";
    out.push({
      lexicon:
        lexicon === "jural" || lexicon === "property-management"
          ? (lexicon as LexiconName)
          : lexicon == null
            ? null
            : (lexicon as LexiconName), // pass through unknown strings so validator can reject with a clear reason
      category: typeof category === "string" ? category : null,
      confidence,
      fact,
      source,
    });
  }
  return out;
}

interface ValidationOutcome {
  ok: TaggedFact[];
  finalInvalidCount: number;
  rePromptUsed: boolean;
}

/**
 * Run validateAgainstLexicon, and on any invalid facts, fire exactly
 * ONE corrective re-prompt to the extractor. Any facts still invalid
 * after the retry are demoted to null-tagged and pass through. Never
 * more than one retry — per anti-bullshit rule 3.
 */
async function runValidationWithOneRetry(
  initialFacts: TaggedFact[],
  originalMessage: string,
): Promise<ValidationOutcome> {
  const first = validateAgainstLexicon(initialFacts);
  if (first.invalid.length === 0) {
    return { ok: first.ok, finalInvalidCount: 0, rePromptUsed: false };
  }

  const rePrompt = buildRePromptForInvalid(first.invalid);
  let retriedFacts: TaggedFact[] = [];
  try {
    retriedFacts = await callExtractorForRePrompt(rePrompt, originalMessage);
  } catch (err) {
    console.warn("chat.p6.lexicon.reprompt_failed", err);
    // On re-prompt failure, fall back to demoting every invalid fact
    // to null-tagged and carrying on — better than a silent drop.
    retriedFacts = first.invalid.map(({ fact }) => ({
      ...fact,
      lexicon: null,
      category: null,
    }));
  }

  const second = validateAgainstLexicon(retriedFacts);
  // Any fact still invalid after the retry is demoted to null-tagged.
  const demotedFromRetry: TaggedFact[] = second.invalid.map(({ fact }) => ({
    ...fact,
    lexicon: null,
    category: null,
  }));

  return {
    ok: [...first.ok, ...second.ok, ...demotedFromRetry],
    finalInvalidCount: second.invalid.length,
    rePromptUsed: true,
  };
}

/**
 * Fire ONE corrective extractor call asking for a clean taggedFacts
 * array. The reply is expected to be JSON — either the array directly
 * or an object with a `taggedFacts` property. Anything else is treated
 * as an empty array (caller's retry budget is already spent).
 *
 * Test seam: `__setExtractorForLexiconTests(fn)` below swaps this out
 * so the G4 test can assert exactly one re-prompt call without hitting
 * the real API.
 */
async function callExtractorForRePrompt(
  rePrompt: string,
  originalMessage: string,
): Promise<TaggedFact[]> {
  if (_extractorOverride) {
    return _extractorOverride(rePrompt, originalMessage);
  }

  const anthropic = new Anthropic();
  const prompt = `${rePrompt}

Original customer message:
"${originalMessage}"

Re-emit ONLY a JSON array of TaggedFact objects — no prose, no markdown fences. Shape:
[
  { "lexicon": "jural" | "property-management" | null, "category": string | null, "confidence": number, "fact": string, "source": string }
]`;
  const response = await anthropic.messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const text =
    response.content[0]?.type === "text" ? response.content[0].text : "";
  return parseTaggedFactsFromResponse(text);
}

/**
 * Test-only extractor override. G4 asserts exactly one re-prompt call
 * fires when the first extraction returns invalid tags — this seam lets
 * the test count invocations without stubbing Anthropic globally.
 */
let _extractorOverride:
  | ((rePrompt: string, originalMessage: string) => Promise<TaggedFact[]>)
  | null = null;

export function __setExtractorForLexiconTests(
  fn:
    | ((rePrompt: string, originalMessage: string) => Promise<TaggedFact[]>)
    | null,
): void {
  _extractorOverride = fn;
}

/**
 * Parse a tagged-facts JSON blob out of an extractor reply. Accepts:
 *   - a bare JSON array
 *   - a JSON object with a `taggedFacts: [...]` property
 *   - either wrapped in ```json fences
 * Anything else returns an empty array.
 */
export function parseTaggedFactsFromResponse(
  raw: string,
): TaggedFact[] {
  if (!raw) return [];
  let clean = raw.trim();
  if (clean.startsWith("```")) {
    clean = clean.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(clean);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { taggedFacts?: unknown }).taggedFacts)
      ? (parsed as { taggedFacts: unknown[] }).taggedFacts
      : null;
  if (!arr) return [];

  const out: TaggedFact[] = [];
  for (const r of arr) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    out.push({
      lexicon:
        rec.lexicon === "jural" || rec.lexicon === "property-management"
          ? (rec.lexicon as LexiconName)
          : rec.lexicon == null
            ? null
            : (rec.lexicon as LexiconName),
      category: typeof rec.category === "string" ? rec.category : null,
      confidence: typeof rec.confidence === "number" ? rec.confidence : 0,
      fact: typeof rec.fact === "string" ? rec.fact : "",
      source: typeof rec.source === "string" ? rec.source : "",
    });
  }
  return out;
}

/**
 * Pick the lexicon name carried by the most tagged facts. Used to
 * stamp the `lexicon` column on the turn's sem_object_patches row.
 * Returns null if no fact is tagged (i.e. everything was null-tagged).
 */
function pickDominantLexicon(
  facts: TaggedFact[],
): LexiconName | null {
  const counts = new Map<LexiconName, number>();
  for (const f of facts) {
    if (f.lexicon === null) continue;
    counts.set(f.lexicon, (counts.get(f.lexicon) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let best: LexiconName | null = null;
  let bestCount = -1;
  for (const [lex, n] of counts) {
    if (n > bestCount) {
      best = lex;
      bestCount = n;
    }
  }
  return best;
}

// ─────────────────────────────────────────────
// OJT-P5 helpers — patch-chain fetch + federation-tagged writes
// ─────────────────────────────────────────────

function readPatchChainLimit(): number {
  const raw = process.env.OJT_PATCH_CHAIN_N;
  if (!raw) return 10;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 10;
}

interface PersistTurnPatchInput {
  objectId: string;
  identity: { facetId: string; certId: string };
  delta: Record<string, unknown>;
  source: string;
  /**
   * OJT-P6: the lexicon the turn's tagged facts predominantly map to,
   * or null when every fact was null-tagged (no lexicon fit). Written
   * to the sem_object_patches.lexicon column so federation consumers
   * can filter by vocabulary.
   */
  lexicon?: LexiconName | null;
}

/**
 * Write a single `sem_object_patches` row tagged with the OJT-P1
 * federation columns (`timestamp`, `facetId`). Uses `patchKind:
 * action` — the enum's catch-all for "the LLM ran a turn and
 * something changed". P6 now also stamps `lexicon` with the dominant
 * lexicon from the turn's validated taggedFacts (or null).
 *
 * Reads the current semantic-object row to populate the version
 * chain fields (fromVersion, toVersion, prevStateHash, newStateHash)
 * — the patch records "a turn occurred on this state" without
 * mutating the version itself, matching the BRAP pattern where the
 * conversation patch is a sibling of the real state transition.
 */
async function persistTurnPatch(input: PersistTurnPatchInput): Promise<void> {
  const db = await getDb();
  try {
    const [obj] = await db
      .select()
      .from(semanticObjectsTable)
      .where(eq(semanticObjectsTable.id, input.objectId))
      .limit(1);
    const v = obj?.currentVersion ?? 0;
    const h = obj?.currentStateHash ?? "";
    await db.insert(objectPatches).values({
      objectId: input.objectId,
      fromVersion: v,
      toVersion: v,
      prevStateHash: h,
      newStateHash: h,
      patchKind: "action",
      delta: input.delta,
      deltaCount: Object.keys(input.delta).length,
      source: input.source,
      consumed: true,
      // ── OJT-P1 federation columns ──
      timestamp: Date.now(),
      facetId: input.identity.facetId,
      // ── OJT-P6: lexicon attribution ──
      lexicon: input.lexicon ?? null,
      // facetCapabilities still null — wired in a later phase.
    });
  } catch (err) {
    // Never let patch persistence break the HTTP turn. Log and carry.
    console.warn("chat.p5.persistTurnPatch.failed", err);
  }
}

// Re-import the semanticObjects table without colliding with
// recordStateSnapshot's internal reference. Aliased at the bottom to
// keep the import block at the top stable for diff readability.
import { semanticObjects as semanticObjectsTable } from "../semantos-kernel/schema.core";

// ─────────────────────────────────────────────
// A5 helpers — conflict reply formatter + slot serializer
// ─────────────────────────────────────────────

/**
 * Format the user-facing conflict message per A5 §2. Lists at most
 * three free windows so the reply doesn't overwhelm. Times rendered in
 * Australia/Brisbane TZ to match the operator's locale.
 */
export function formatConflictReply(rejection: {
  proposedSlot: ProposedSlot;
  conflictingBookings: ReadonlyArray<{ subjectKind: string }>;
  freeWindows: ReadonlyArray<{ startAt: Date | string; endAt: Date | string }>;
}): string {
  const startAt = formatBrisbane(rejection.proposedSlot.startAt);
  const subjectKind =
    rejection.conflictingBookings[0]?.subjectKind ?? "commitment";
  const windows = rejection.freeWindows.slice(0, 3);
  const windowLines =
    windows.length === 0
      ? "  (no free slots in the next 3 weeks — try a date further out)"
      : windows
          .map(
            (w) =>
              `  • ${
                w.startAt instanceof Date
                  ? w.startAt.toISOString()
                  : String(w.startAt)
              }`,
          )
          .join("\n");
  return `Sorry, Todd isn't free ${startAt}.\nHe's committed to another ${subjectKind}. Some free slots:\n${windowLines}`;
}

function formatBrisbane(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  try {
    return new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Brisbane",
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function serializeSlot(slot: ProposedSlot): Record<string, unknown> {
  return {
    startAt:
      slot.startAt instanceof Date ? slot.startAt.toISOString() : slot.startAt,
    endAt:
      slot.endAt instanceof Date ? slot.endAt.toISOString() : slot.endAt,
    hatId: slot.hatId,
    subjectKind: slot.subjectKind,
    subjectId: slot.subjectId,
    proposedByCertId: slot.proposedByCertId,
  };
}

