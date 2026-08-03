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
import { eq, desc, and, or, isNull } from "drizzle-orm";
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
import { generateEstimateWordingFromInstrument } from "../domain/estimates/estimateWordingService";
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
import { LEXICON_REGISTRY, type LexiconName, type TaggedFact } from "../lexicons";
import { isTradeCategory } from "../lexicons/trades";
import {
  validateAgainstLexicon,
  buildRePromptForInvalid,
} from "../lexicons/validator";
import {
  emptyEstimatorState,
  runEstimatorTurn,
  anchorForMessage,
  DEFAULT_PRICING_POLICY,
  IDENTITY_MULTIPLIERS,
  type EstimatorState,
  type EstimatorPatch,
  type RomInstrument,
  type PricingMultipliers,
} from "../domain/estimates/sppEstimator";
import {
  packRomInstrumentCell,
  romCellContentHash,
} from "../domain/estimates/romInstrumentCell";
import { getMultipliersForTrade } from "../domain/estimates/pricingModel";
import { pickNextQuestion } from "../domain/estimates/nextQuestionPolicy";

const KNOWN_LEXICON_NAMES = Object.keys(LEXICON_REGISTRY) as LexiconName[];
function asLexiconName(value: unknown): LexiconName | null {
  if (value == null) return null;
  if (typeof value !== "string") return null;
  return (KNOWN_LEXICON_NAMES as string[]).includes(value)
    ? (value as LexiconName)
    : (value as LexiconName); // pass through so validator can reject with a clear reason
}

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
  //    If channelId is set, scope to that channel only (multi-participant privacy).
  //    Also include rows where channelId IS NULL — these are pre-channel writes
  //    (most importantly the customer message we just saved at step 1, since the
  //    auto-create above may have set input.channelId AFTER that insert ran).
  //    Without this, the very turn that auto-creates a channel queries with the
  //    new channelId and finds zero history → bot replies with the opener.
  const messageFilter = input.channelId
    ? and(
        eq(schema.messages.jobId, input.jobId),
        or(
          eq(schema.messages.channelId, input.channelId),
          isNull(schema.messages.channelId),
        ),
      )
    : eq(schema.messages.jobId, input.jobId);
  const recentMessages = await db
    .select()
    .from(schema.messages)
    .where(messageFilter)
    .orderBy(desc(schema.messages.createdAt))
    .limit(20);

  console.info(
    "chat.history.loaded",
    {
      jobId: input.jobId,
      channelId: input.channelId ?? null,
      recentCount: recentMessages.length,
      lastSender: recentMessages[0]?.senderType ?? null,
    },
  );

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
  //
  // Guard: never pivot mid-estimate-review. Pushback on price/method/timing
  // ("seems cheap", "5 hrs on the box?", "how do you do two coats in that") is
  // easily mis-tagged by the extractor as different_job because the surface
  // form doesn't reference the original scope. Pivoting there resets state
  // and re-runs the chat LLM against a near-empty history, producing a
  // generic intake opener — exactly the bug we hit. Same guard applies once
  // an estimate is on the table even if the phase has drifted.
  const wouldPivot = extraction.jobPivot === "different_job" && currentState.jobType;
  const pivotBlocked =
    wouldPivot &&
    (currentState.estimatePresented ||
      currentState.conversationPhase === "reviewing_estimate");

  console.info("chat.pivot.decision", {
    jobId: input.jobId,
    jobPivot: extraction.jobPivot,
    currentJobType: currentState.jobType,
    phase: currentState.conversationPhase,
    estimatePresented: currentState.estimatePresented,
    willPivot: wouldPivot && !pivotBlocked,
    blocked: pivotBlocked,
  });

  if (wouldPivot && !pivotBlocked) {
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

  // ── SPP estimator turn ──
  // Structure: typed trade lexicon + dimensions drive the pipeline.
  // Process : extraction → evidence_merge → rescore → instrument_emit,
  //   with a Paskian read-path: multipliers learned from prior completed
  //   jobs for this trade get factored into the rescore.
  // Persistence: each patch lands in sem_object_patches with its real
  //   patchKind; EstimatorState lives on job.metadata.estimatorState
  //   with a prev/new state-hash chain; the trade's PricingModel object
  //   owns the cross-job learning state in its own patch chain.
  // Chat LLM only ever sees the emitted RomInstrument's numbers — never
  // invents its own, never sees multipliers or policy directly.
  const priorEstState = loadEstimatorState(job);
  const turnFacts = buildTradeFactsFromExtraction(extraction, input.message);

  // Load multipliers for the trade we *already* knew from prior turns.
  // The first-turn-that-establishes-trade case is handled on the NEXT
  // turn — identity multipliers leave the base tables unchanged, which
  // is the right default for a trade we've never completed a job in.
  let multipliers: PricingMultipliers = IDENTITY_MULTIPLIERS;
  if (priorEstState.trade) {
    try {
      multipliers = await getMultipliersForTrade(db, priorEstState.trade);
    } catch (err) {
      console.warn("chat.spp.multipliers.load_failed", err);
    }
  }

  const estTurn = runEstimatorTurn(priorEstState, turnFacts, input.message, {
    policy: DEFAULT_PRICING_POLICY,
    multipliers,
    anchor: anchorForMessage(savedMsg.id, input.message),
  });
  mergedState.estimatorState = estTurn.state;
  if (estTurn.instrument) {
    mergedState.romInstrument = estTurn.instrument;
  }
  await persistEstimatorPatches(
    db,
    semCtx.semanticObjectId,
    estTurn.patches,
    `message:${savedMsg.id}`,
  );

  // Persistence: pack the RomInstrument into a 1 KB cell (or two, if the
  // evidence payload overflows) and persist its content hash. The cell
  // itself is content-addressed and anchor-ready — the bytes never need
  // to change again once emitted.
  let romCellHash: string | null = null;
  let romCellBytes: number | null = null;
  if (estTurn.instrument) {
    try {
      const packed = packRomInstrumentCell({
        instrument: estTurn.instrument,
        prevStateHash: Buffer.from(
          estTurn.patches[estTurn.patches.length - 1]?.newStateHash ?? "",
          "hex",
        ),
        rawMessage: input.message,
      });
      romCellHash = romCellContentHash(packed.buffer);
      romCellBytes = packed.buffer.length;
      mergedState.romInstrument = {
        ...estTurn.instrument,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      // Cell bytes aren't stored on job.metadata — keep metadata small.
      // The authoritative copy lives in sem_object_patches.delta.instrument
      // via the instrument_emit patch, and will land in sem_cells once the
      // anchor pipeline is wired.
    } catch (err) {
      console.warn("chat.spp.packRomCell.failed", err);
    }
  }

  console.info("chat.spp.turn", {
    jobId: input.jobId,
    patches: estTurn.patches.map((p) => p.kind),
    phase: estTurn.state.phase,
    version: estTurn.state.version,
    instrumentId: estTurn.instrument?.id ?? null,
    band: estTurn.instrument?.band ?? null,
    costMin: estTurn.instrument?.costMin ?? null,
    costMax: estTurn.instrument?.costMax ?? null,
    confidence: estTurn.instrument?.confidence ?? null,
    revision: estTurn.instrument?.revision ?? null,
    supersedes: estTurn.instrument?.supersedes ?? null,
    isAmendment: estTurn.instrument?.supersedes !== null && estTurn.instrument?.supersedes !== undefined,
    amendmentCount: estTurn.state.amendmentCount,
    multipliers: {
      cost: multipliers.costMultiplier,
      hours: multipliers.hoursMultiplier,
      n: multipliers.sampleSize,
    },
    policyVersion: DEFAULT_PRICING_POLICY.version,
    romCellHash,
    romCellBytes,
  });

  // 9. Evaluate conversation state → decide action
  let action = evaluateConversationState(mergedState);

  // Amendment override: when the rescore this turn produced a NEW
  // instrument that supersedes the prior one (customer added scope,
  // revealed damage, changed access after a ROM was already presented),
  // force-fire `present_estimate` regardless of `estimatePresented`.
  // Without this, a returning customer who adds scope would never see
  // the updated ROM — evaluateConversationState's present_estimate gate
  // is `!state.estimatePresented`, which is false on amendment.
  if (
    estTurn.instrument?.supersedes &&
    action.type !== "present_estimate" &&
    action.type !== "not_worth_pursuing" &&
    action.type !== "needs_site_visit"
  ) {
    action = {
      type: "present_estimate",
      wording: "",           // populated below by the instrument wording
      expectationCheck: "",  // same
    };
  }

  // Instrument-first: if the SPP estimator produced an instrument this turn
  // AND evaluateConversationState decided to present an estimate, replace
  // the action's wording with the instrument-derived wording so the chat
  // LLM relays the canonical RomInstrument verbatim. This removes the last
  // path where pricing could drift from the typed instrument.
  //
  // Amendment path: if the new instrument supersedes the prior one
  // (customer added scope / revealed damage / changed access after a ROM
  // was already presented), the wording layer produces the "previously
  // $A–$B, now $X–$Y" framing so the customer sees WHY the number moved.
  if (action.type === "present_estimate" && estTurn.instrument) {
    const priorInstrument =
      estTurn.instrument.supersedes !== null ? priorEstState.lastInstrument : null;
    const instrumentWording = generateEstimateWordingFromInstrument(
      estTurn.instrument,
      priorInstrument,
    );
    action = {
      type: "present_estimate",
      wording: instrumentWording.customerFacing,
      expectationCheck: instrumentWording.expectationCheck,
    };
  }
  let systemInjection = generateSystemInjection(action);

  // Next-question hint: when we're not presenting an estimate this turn,
  // the dimension policy decides what's the highest-value missing slot
  // for the trade in question. Inject it as a steering hint so the chat
  // LLM asks about the load-bearing dimension instead of the first thing
  // that comes to mind. Debuggable: the rationale is in the chat.spp.turn
  // log so we can see WHY the bot asked about (say) prep_level.
  if (action.type !== "present_estimate" && action.type !== "summarise_and_close") {
    const next = pickNextQuestion(estTurn.state);
    if (next) {
      const nextHint = `[SYSTEM: The estimator's next-question policy says the highest-value missing dimension is "${next.slot}". Ask the customer something like: "${next.question}" — feel free to rephrase to fit the conversation, but the dimension you're asking about is ${next.slot}. Reason: ${next.rationale}.]`;
      systemInjection = systemInjection ? `${systemInjection}\n\n${nextHint}` : nextHint;
      console.info("chat.spp.next_question", {
        jobId: input.jobId,
        slot: next.slot,
        rationale: next.rationale,
      });
    }
  }

  // Track if we're presenting an estimate this turn
  let estimatePresented = mergedState.estimatePresented;
  if (action.type === "present_estimate") {
    estimatePresented = true;
    mergedState.estimatePresented = true;
    // Amendment: the prior ack is against the PRIOR instrument. The
    // customer needs to re-acknowledge the updated ROM — reset the ack
    // state so the post-ROM flow gates properly.
    if (estTurn.instrument?.supersedes) {
      mergedState.estimateAcknowledged = false;
      mergedState.estimateAckStatus = "pending";
    }
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
      lexicon: asLexiconName(lexicon),
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
      lexicon: asLexiconName(rec.lexicon),
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

// ─────────────────────────────────────────────
// SPP estimator helpers — load/save state, synthesise tagged facts
// from the existing extraction, persist patches into sem_object_patches.
// ─────────────────────────────────────────────

/** Load the EstimatorState carried on job.metadata (if any), or seed a
 *  fresh one. The shape is typed permissively on disk (estimatorState is
 *  `unknown` in the accumulated-state schema); we do a single typeguard
 *  at load time and fall back to an empty state on mismatch. */
function loadEstimatorState(job: typeof schema.jobs.$inferSelect): EstimatorState {
  const md = job.metadata as { estimatorState?: unknown } | null;
  const stored = md?.estimatorState;
  if (stored && typeof stored === "object" && "version" in stored) {
    return stored as EstimatorState;
  }
  return emptyEstimatorState();
}

/** Synthesize trades-tagged TaggedFacts from the existing extraction.
 *  Transitional: the extractor LLM already produces `extraction.jobType`
 *  and `extraction.scopeDescription` reliably. Once the extraction prompt
 *  is retrained to emit `lexicon: "trades"` natively, we'll use those
 *  facts directly and delete this helper. */
function buildTradeFactsFromExtraction(
  extraction: MessageExtraction,
  rawMessage: string,
): TaggedFact[] {
  const out: TaggedFact[] = [];
  if (extraction.jobType && isTradeCategory(extraction.jobType)) {
    out.push({
      lexicon: "trades",
      category: extraction.jobType,
      // Confidence bumps for "certain", falls below the validator floor
      // for "guess" so a low-confidence jobType doesn't lock the state.
      confidence:
        extraction.jobTypeConfidence === "certain" ? 0.9
        : extraction.jobTypeConfidence === "likely" ? 0.75
        : 0.4,
      fact: `Trade is ${extraction.jobType}`,
      source: extraction.scopeDescription || rawMessage.slice(0, 200),
    });
  }

  // Transitional: synthesise building-job-dimensions facts from the
  // existing extraction fields the LLM already produces. This is
  // belt-and-suspenders — once the extractor prompt is retrained to emit
  // these facts natively, the LLM-emitted version wins and this synthesis
  // is redundant. Until then, it bridges the gap so typed slots
  // (prepLevel, quantity, access, roomCount, dwellingType) actually reach
  // the estimator instead of being extracted-and-dropped.
  const src = extraction.scopeDescription || rawMessage.slice(0, 200);
  const text = `${extraction.scopeDescription ?? ""} ${rawMessage}`.toLowerCase();
  for (const f of synthesiseDimensionFacts(extraction, text, src)) out.push(f);

  // Carry through any facts the LLM already tagged — validator will decide.
  const carried = (extraction as unknown as { taggedFacts?: TaggedFact[] }).taggedFacts;
  if (Array.isArray(carried)) {
    for (const f of carried) out.push(f);
  }
  return out;
}

/** Best-effort synthesis of building-job-dimensions TaggedFacts from the
 *  extraction's existing free-form fields + the raw message. Conservative
 *  on confidence so the validator demotes weak signals. */
function synthesiseDimensionFacts(
  extraction: MessageExtraction,
  text: string,
  src: string,
): TaggedFact[] {
  const facts: TaggedFact[] = [];

  // work_type — from the existing repairReplaceSignal enum
  if (extraction.repairReplaceSignal && extraction.repairReplaceSignal !== "unclear") {
    facts.push({
      lexicon: "building-job-dimensions",
      category: "work_type",
      confidence: 0.85,
      fact: extraction.repairReplaceSignal,
      source: src,
    });
  }

  // access — from the existing accessDifficulty enum (maps 1:1 after
  // stripping the `_required` suffix — ground_level → ground, etc).
  if (extraction.accessDifficulty) {
    const accessVal =
      extraction.accessDifficulty === "ground_level" ? "ground"
      : extraction.accessDifficulty === "ladder_required" ? "ladder"
      : extraction.accessDifficulty === "scaffolding_required" ? "scaffold"
      : extraction.accessDifficulty === "difficult_access" ? "difficult"
      : null;
    if (accessVal) {
      facts.push({
        lexicon: "building-job-dimensions",
        category: "access",
        confidence: 0.85,
        fact: accessVal,
        source: src,
      });
    }
  }

  // surface — keyword scan on the raw message. Same signals
  // applyEvidenceMergePatch's internal detectSurface uses, emitted here
  // so the path is uniform (everything flows through dimension facts).
  if (/\b(exterior|outdoor|outside|outdoors|facade|eaves|fascia|weatherboards?|cladding)\b/.test(text)
      || /\brepaint the house|house repaint|house painting\b/.test(text)) {
    facts.push({
      lexicon: "building-job-dimensions",
      category: "surface",
      confidence: 0.8,
      fact: "exterior",
      source: src,
    });
  } else if (/\b(interior|indoor|inside|indoors|living room|bedroom|bathroom|hallway|kitchen|lounge|dining|laundry|feature wall|skirting|architrave|ceiling|interior repaint|inside painted)\b/.test(text)) {
    facts.push({
      lexicon: "building-job-dimensions",
      category: "surface",
      confidence: 0.8,
      fact: "interior",
      source: src,
    });
  }

  // dwelling_type
  if (/\b(apartment|unit|flat|condo)\b/.test(text)) {
    facts.push({
      lexicon: "building-job-dimensions",
      category: "dwelling_type",
      confidence: 0.85,
      fact: "apartment",
      source: src,
    });
  } else if (/\btownhouse|town house|duplex\b/.test(text)) {
    facts.push({
      lexicon: "building-job-dimensions",
      category: "dwelling_type",
      confidence: 0.85,
      fact: "townhouse",
      source: src,
    });
  } else if (/\bhouse|home|place|property\b/.test(text) && !/\bapartment|unit|flat|condo\b/.test(text)) {
    facts.push({
      lexicon: "building-job-dimensions",
      category: "dwelling_type",
      confidence: 0.7,
      fact: "house",
      source: src,
    });
  } else if (/\boffice|shop|warehouse|commercial|retail\b/.test(text)) {
    facts.push({
      lexicon: "building-job-dimensions",
      category: "dwelling_type",
      confidence: 0.85,
      fact: "commercial",
      source: src,
    });
  }

  // prep_level — painting-centric keyword scan.
  if (/\bplaster\s+repair|plaster.*wall|re-?plaster|plasterer|plaster the/.test(text)) {
    facts.push({
      lexicon: "building-job-dimensions",
      category: "prep_level",
      confidence: 0.9,
      fact: "plaster_repair",
      source: src,
    });
  } else if (/\bscrew hole|nail hole|curtain rod|handle.*through|door handle.*wall|patch|holes? in the wall|fill.*(holes?|wall)|spackle|putty/.test(text)) {
    facts.push({
      lexicon: "building-job-dimensions",
      category: "prep_level",
      confidence: 0.85,
      fact: "fill_patch",
      source: src,
    });
  } else if (/\bstrip.*(paint|back)|peeling paint|sand back|sand down|lead paint/.test(text)) {
    facts.push({
      lexicon: "building-job-dimensions",
      category: "prep_level",
      confidence: 0.85,
      fact: "strip_back",
      source: src,
    });
  } else if (/\bscuff.?sand|light sand|fine sand/.test(text)) {
    facts.push({
      lexicon: "building-job-dimensions",
      category: "prep_level",
      confidence: 0.8,
      fact: "scuff_sand",
      source: src,
    });
  }

  // room_count — count the rooms the customer listed. Only fires when
  // multiple rooms appear in the same sentence.
  const roomCount = countRoomsInText(text);
  if (roomCount > 0) {
    facts.push({
      lexicon: "building-job-dimensions",
      category: "room_count",
      confidence: 0.9,
      fact: String(roomCount),
      source: src,
    });
  }

  // quantity_signal — derive from extraction.quantity string or from
  // room count. The parser also sets quantity from room_count, so this
  // is mostly redundant, but keeps the intent explicit in the chain.
  if (roomCount > 0) {
    const q = roomCount <= 1 ? "single" : roomCount <= 3 ? "small_batch" : "large_batch";
    facts.push({
      lexicon: "building-job-dimensions",
      category: "quantity_signal",
      confidence: 0.85,
      fact: q,
      source: src,
    });
  } else if (extraction.quantity) {
    const q = parseQuantityString(extraction.quantity);
    if (q) {
      facts.push({
        lexicon: "building-job-dimensions",
        category: "quantity_signal",
        confidence: 0.7,
        fact: q,
        source: src,
      });
    }
  }

  return facts;
}

/** Count distinct room types in a customer message by matching against
 *  a small vocabulary. Handles "2 bed, 2 bath, wc, laundry, hallway,
 *  living, kitchen" → 8. */
function countRoomsInText(text: string): number {
  // Explicit "N rooms"
  const explicit = text.match(/(\d+)\s*(?:rooms?|bedrooms?|beds?)\b/);
  let count = 0;
  if (explicit) {
    const n = parseInt(explicit[1], 10);
    if (Number.isFinite(n)) count += n;
  }
  // Additional specific rooms mentioned
  const extras = [
    /\b(?:bath|bathroom)s?\b/g,
    /\b(?:wc|toilet|powder room|ensuite)\b/g,
    /\b(?:laundry)\b/g,
    /\b(?:hallway|hall)\b/g,
    /\b(?:living|lounge|family|rumpus|sitting)\s*(?:room|area)?\b/g,
    /\b(?:dining|meals)\s*(?:room|area)?\b/g,
    /\b(?:kitchen)\b/g,
    /\b(?:study|office)\b/g,
    /\b(?:entry|foyer|entrance)\b/g,
  ];
  let extrasCount = 0;
  for (const rx of extras) {
    const matches = text.match(rx);
    if (matches) extrasCount += matches.length;
  }
  // Cap the "extras" — the same room mentioned twice shouldn't double-count.
  // This is coarse; the LLM's job in the retrained prompt will be exact.
  extrasCount = Math.min(extrasCount, 6);
  count += extrasCount;
  return count;
}

function parseQuantityString(q: string): "single" | "small_batch" | "large_batch" | null {
  const m = q.match(/(\d+)/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n)) return null;
    return n <= 1 ? "single" : n <= 4 ? "small_batch" : "large_batch";
  }
  if (/\bseveral|multiple|lots|many\b/i.test(q)) return "large_batch";
  if (/\bpair|couple|few\b/i.test(q)) return "small_batch";
  if (/\bone|single|a\b/i.test(q)) return "single";
  return null;
}

/** Persist each EstimatorPatch into sem_object_patches with its real
 *  patchKind. Each patch carries its own from/toVersion and prev/newStateHash
 *  from sppEstimator — this just writes them. */
async function persistEstimatorPatches(
  db: Awaited<ReturnType<typeof getDb>>,
  objectId: string,
  patches: ReadonlyArray<EstimatorPatch>,
  source: string,
): Promise<void> {
  if (patches.length === 0) return;
  try {
    for (const patch of patches) {
      // Inline the patch's anchor under `_anchor` inside the JSONB delta
      // so a reader can eyeball the driving customer message without a
      // cross-table join:
      //   SELECT delta->'_anchor'->>'rawMessagePreview'
      //   FROM sem_object_patches WHERE object_id = '...';
      // `_anchor.sourceMessageId` also lets us confirm the FK matches
      // the `source` column (which carries `message:<id>` as a string).
      const deltaWithAnchor = {
        ...(patch.delta as Record<string, unknown>),
        _anchor: {
          sourceMessageId: patch.sourceMessageId,
          rawMessagePreview: patch.rawMessagePreview,
          sourceKind: patch.sourceKind,
        },
      };
      await db.insert(objectPatches).values({
        objectId,
        fromVersion: patch.fromVersion,
        toVersion: patch.toVersion,
        prevStateHash: patch.prevStateHash,
        newStateHash: patch.newStateHash,
        patchKind: patch.kind,
        delta: deltaWithAnchor,
        deltaCount: Object.keys(deltaWithAnchor).length,
        source,
        consumed: true,
        timestamp: Date.now(),
      });
    }
  } catch (err) {
    console.warn("chat.spp.persistPatches.failed", err);
  }
}

