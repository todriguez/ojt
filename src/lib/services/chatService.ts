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

// ── Types ────────────────────────────────────

export interface ChatInput {
  jobId: string;
  customerId: string;
  message: string;
  messageType?: "text" | "voice" | "image";
  photos?: string[]; // Vercel Blob URLs
  channelId?: string; // Conversation channel for multi-participant scoping
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

  const systemPrompt = buildSystemPrompt({ pdfImportContext, channelContext });
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

  // Resolve-or-create a job for this tenant. P5 will rework this to
  // run the handoff through the semantic-object bridge; P4 just needs
  // a jobId so processCustomerMessage can run.
  let jobId = input.jobId;
  if (!jobId) {
    // Look for the default organisation (seeded in dev). If none
    // exists yet, create a minimal placeholder so the pipeline can
    // still run for /api/v3/chat tests.
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

  // NB: processCustomerMessage's ChatInput requires customerId; P4
  // skips customer resolution (P5 will handle the identity-→-customer
  // mapping via the semantic-object bridge). Pass an empty string;
  // downstream code tolerates it via `input.customerId || null`.
  const result = await processCustomerMessage({
    jobId,
    customerId: "",
    message: input.message,
  });

  return { reply: result.reply, jobId: result.jobId };
}

