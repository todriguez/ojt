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
import { eq, desc } from "drizzle-orm";
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

// ── Types ────────────────────────────────────

export interface ChatInput {
  jobId: string;
  customerId: string;
  message: string;
  messageType?: "text" | "voice" | "image";
}

export interface ChatResult {
  reply: string;
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

  let currentState = loadJobState(job);

  // 3. Build conversation summary from recent messages
  const recentMessages = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.jobId, input.jobId))
    .orderBy(desc(schema.messages.createdAt))
    .limit(20);

  const conversationSummary = recentMessages
    .reverse()
    .map((m: any) => `${m.senderType}: ${m.rawContent}`)
    .join("\n");

  // 4. Run extraction LLM
  const extractionPrompt = buildExtractionPrompt(
    currentState,
    input.message,
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

  // 5. Merge extraction into accumulated state
  const mergedState = mergeExtraction(currentState, extraction);

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

  // 9. Evaluate conversation state → decide action
  const action = evaluateConversationState(mergedState);
  const systemInjection = generateSystemInjection(action);

  // Track if we're presenting an estimate this turn
  let estimatePresented = mergedState.estimatePresented;
  if (action.type === "present_estimate") {
    estimatePresented = true;
    mergedState.estimatePresented = true;
  }

  // 10. Build chat messages
  const systemPrompt = buildSystemPrompt();
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
  await db.insert(schema.messages).values({
    jobId: input.jobId,
    customerId: custId || undefined,
    senderType: "ai",
    messageType: "text",
    rawContent: reply,
  });

  // 13. Update job record with all scores
  const jobUpdates: Record<string, unknown> = {
    completenessScore: mergedState.completenessScore,
    customerFitScore: mergedState.customerFitScore,
    quoteWorthinessScore: mergedState.quoteWorthinessScore,
    metadata: mergedState,
  };

  if (extraction.jobType && !job.jobType) {
    jobUpdates.jobType = extraction.jobType;
  }
  if (extraction.scopeDescription && !job.descriptionRaw) {
    jobUpdates.descriptionRaw = extraction.scopeDescription;
  }
  if (extraction.urgency) {
    jobUpdates.urgency = extraction.urgency;
  }

  // Infer effort band
  if (mergedState.scopeDescription && mergedState.jobType && !job.effortBand) {
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
  }

  // Save estimate record if presenting one
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
  }

  await db
    .update(schema.jobs)
    .set(jobUpdates)
    .where(eq(schema.jobs.id, input.jobId));

  // 14. Return full result
  return {
    reply,
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
