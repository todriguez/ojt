/**
 * ojtHandleMessage — OJT-side thin wrapper around
 * `@semantos/intent.handleMessage`.
 *
 * OJT-P5 scope: route every LLM turn through the intent pipeline so
 * triage (NO_INTENT / PROPOSES / RATIFIES) becomes the gate on
 * whether the expensive extraction/scoring loop runs. OJT's existing
 * chatService owns the real work — the kernel/cell-engine pipeline
 * inside handleMessage is wired to no-op stubs because OJT isn't
 * ready to run it yet (that's a later phase).
 *
 * Mirrors the shape of BRAP's `brapHandleMessage.ts` but:
 *   - HatContext is built from an `OjtIdentity` (phone- or admin-
 *     derived), not from a userId
 *   - we do NOT mirror the intent-package's patch into a separate
 *     ConversationPatch table — OJT's `sem_object_patches` already
 *     carries federation columns and serves both roles
 *   - the write/ratification callbacks capture patch shapes for
 *     downstream inspection but don't persist (chatService owns the
 *     DB write with federation columns; see persistTurnPatches)
 *   - lexicon is left undefined on patches in P5 — P6 threads
 *     `jural` (OJT) / `property-management` (REA) through
 */
import {
  createInMemoryLogger,
  createInMemoryPendingRegistry,
  extractProposedSlot,
  handleMessage,
  type CalendarGuard,
  type Classifier,
  type ClassifierInput,
  type ConversationPatchShape,
  type CorrelationId,
  type HandleMessageResult,
  type HatContext,
  type Intent,
  type IntentId,
  type PatchId,
  type PipelineDeps,
  type ProposedSlot,
  type RatificationPatchShape,
  type CellId,
} from "@semantos/intent";

import type { OjtIdentity } from "../identity";

/**
 * Identity shape accepted by runHandleMessage. Intentionally narrower
 * than `OjtIdentity` — we only need the two fields that flow into the
 * HatContext. Both the phone-derived `OjtIdentity` and the
 * test-friendly `{facetId, certId}` shape that `/api/v3/chat` hands
 * to `handleTenantMessage` satisfy this.
 */
export type HandleMessageIdentity =
  | OjtIdentity
  | { facetId: string; certId: string };

/** OJT's public triage hint — the string chatService switches on. */
export type OjtTriageHint =
  | "PROPOSES"
  | "RATIFIES"
  | "NO_INTENT"
  | "REJECT_CONFLICT";

export interface OjtHandleMessageInput {
  /** The semantic object this turn belongs to (e.g. `job:<uuid>`). */
  objectId: string;
  /** The authoring identity — phone-derived, admin, or a narrow stub. */
  identity: HandleMessageIdentity;
  /** The message body. */
  message: string;
  /** Optional correlationId to thread through the turn. */
  correlationId?: string;
  /**
   * A5: optional CalendarGuard. When supplied AND the classifier
   * produces an Intent whose `delta.proposedSlot` is populated,
   * handleMessage will short-circuit on conflict. When omitted,
   * legacy behaviour — the calendar step is skipped entirely.
   */
  calendarGuard?: CalendarGuard;
  /**
   * A5: optional override for the classifier so test seams (and any
   * future jobId-aware time extractors) can plug in a custom Intent
   * builder. Defaults to OJT's existing rules-only classifier, which
   * never carries a `proposedSlot` — i.e. supplying just a guard with
   * the default classifier is a no-op for guard purposes.
   */
  classifier?: Classifier;
}

export interface OjtHandleMessageResult {
  triageHint: OjtTriageHint;
  conversationPatchId: string;
  correlationId: string;
  /** Captured conversation-patch shape (for chatService.persistTurnPatches). */
  conversationPatch: ConversationPatchShape | null;
  /** Captured ratification-patch shape (when triage kind is RATIFIES). */
  ratificationPatch: RatificationPatchShape | null;
  /** Full orchestrator result — callers that want more detail can read it. */
  raw: HandleMessageResult;
}

/**
 * Rules-only classifier. OJT's chat turns are tenant-authored free-
 * form trade requests; every non-empty turn "proposes" new scoring
 * work, and a whitespace-only message is NO_INTENT. We never emit a
 * concrete Intent here — PROPOSES signals chatService to run the
 * existing extraction/scoring loop; the stub Intent flows through
 * the no-op pipeline deps and is discarded.
 */
const ojtClassifier: Classifier = {
  async classify(input: ClassifierInput) {
    const body = typeof input.body === "string" ? input.body : "";
    if (!body.trim()) {
      return { kind: "no_intent", reason: "empty_message" };
    }
    return { kind: "proposes", intent: buildStubIntent(input, body, null) };
  },
};

/**
 * A5: build the OJT stub Intent. Optionally carries a `proposedSlot`
 * delta — when supplied, handleMessage's CalendarGuard step will run.
 * Used by `buildProposedSlotClassifier` below to inject a deterministic
 * slot for tests and future LLM-driven flows.
 */
function buildStubIntent(
  input: ClassifierInput,
  body: string,
  proposedSlot: ProposedSlot | null,
): Intent {
  const intent: Intent = {
    id: `intent:${input.conversationPatchId}` as IntentId,
    correlationId: undefined,
    summary: body.slice(0, 120),
    // Casts are deliberate — OJT's classifier never produces a real
    // Intent; these fields are present to satisfy the type but the
    // no-op pipeline ignores them.
    category: { lexicon: "jural", category: "obligation" } as never,
    taxonomy: { path: ["ojt", "chat"] } as never,
    action: "chat",
    constraints: [],
    confidence: 0.5,
    source: input.source,
  };
  if (proposedSlot) {
    (intent as unknown as { delta?: Record<string, unknown> }).delta = {
      proposedSlot,
    };
  }
  return intent;
}

/**
 * Build a classifier that always emits a Intent carrying the supplied
 * `proposedSlot`. Wired by chatService when the chat turn carries an
 * explicit slot (extracted by an upstream LLM classifier or — for the
 * test gates — handed in directly via the pipeline). When the slot is
 * null the classifier degrades to the default behaviour.
 */
export function buildProposedSlotClassifier(
  proposedSlot: ProposedSlot | null,
): Classifier {
  if (!proposedSlot) return ojtClassifier;
  return {
    async classify(input: ClassifierInput) {
      const body = typeof input.body === "string" ? input.body : "";
      if (!body.trim()) {
        return { kind: "no_intent", reason: "empty_message" };
      }
      return {
        kind: "proposes",
        intent: buildStubIntent(input, body, proposedSlot),
      };
    },
  };
}

/**
 * Re-export `extractProposedSlot` from @semantos/intent so callers can
 * reach it without importing two paths. Used by chatService and by the
 * G5 unit test.
 */
export { extractProposedSlot };

/**
 * No-op PipelineDeps. OJT-P5 does NOT run the SIR/IR/cell-engine
 * pipeline through handleMessage — chatService keeps ownership of
 * the real LLM work. If triage ever dispatches to `processIntent`,
 * it runs through these stubs and produces a discarded result.
 */
function createNoopPipelineDeps(): PipelineDeps {
  return {
    emitBytes: () => new Uint8Array(),
    executeScript: async () => ({
      ok: true,
      stackDepth: 0,
      opcount: 0,
      gasUsed: 0,
    }),
    buildCellFromBytes: (bytes) => ({
      id: "cell:ojt:noop" as unknown as CellId,
      bytes,
    }),
    writeCell: async () => undefined,
    sign: () => new Uint8Array(),
    now: () => Date.now(),
    uuid: () => randomId(),
  };
}

function randomId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? (crypto as Crypto).randomUUID()
    : `ojt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Build a HatContext from an OjtIdentity. P5 does not yet consume
 * capabilities or domainFlag — the pipeline stubs don't care. Once
 * the cell-engine side lands these will carry real values.
 */
function buildOjtHat(identity: HandleMessageIdentity): HatContext {
  return {
    hatId: `ojt-hat:${identity.facetId}`,
    facetId: identity.facetId,
    certId: identity.certId ?? null,
    capabilities: [],
    extensionId: "ojt",
    domainFlag: 0,
    maxTrustClass: "interpretive" as unknown as HatContext["maxTrustClass"],
  };
}

/** Translate the orchestrator's `kind` into OJT's triageHint string. */
function mapTriageHint(result: HandleMessageResult): OjtTriageHint {
  switch (result.kind) {
    case "no_intent":
      return "NO_INTENT";
    case "proposed":
      return "PROPOSES";
    case "ratified":
      return "RATIFIES";
    case "reject_conflict":
      return "REJECT_CONFLICT";
  }
}

/**
 * Run a chat turn through `handleMessage`. Never throws — any error
 * from the orchestrator becomes a NO_INTENT fallback so chatService
 * can short-circuit without blowing up the HTTP request. The raw
 * error is captured on the result (via the in-memory logger, which
 * we currently discard; P6 wires it to pino).
 */
export async function runHandleMessage(
  input: OjtHandleMessageInput,
): Promise<OjtHandleMessageResult> {
  const logger = createInMemoryLogger();
  const pendingRegistry = createInMemoryPendingRegistry();
  const hat = buildOjtHat(input.identity);

  const captured: {
    conv: ConversationPatchShape | null;
    ratification: RatificationPatchShape | null;
  } = { conv: null, ratification: null };

  try {
    const result = await handleMessage(
      {
        objectId: input.objectId,
        hat,
        body: input.message,
        source: "nl",
        // lexicon is NULL in P5 — P6 fills in ('jural' for tenant/admin,
        // 'property-management' for REA).
        authorLexicon: undefined,
      },
      {
        conversation: {
          write: (_objectId, patch) => {
            captured.conv = patch;
          },
          generatePatchId: () => randomId(),
          generateCorrelationId: () =>
            input.correlationId ?? randomId(),
        },
        ratification: {
          write: (_objectId, patch: RatificationPatchShape) => {
            captured.ratification = patch;
          },
          generatePatchId: () => randomId(),
        },
        classifier: input.classifier ?? ojtClassifier,
        pendingRegistry,
        pipeline: createNoopPipelineDeps(),
        logger,
        calendarGuard: input.calendarGuard,
      },
    );

    return {
      triageHint: mapTriageHint(result),
      conversationPatchId: String(result.conversationPatchId),
      correlationId: String(result.correlationId),
      conversationPatch: captured.conv,
      ratificationPatch: captured.ratification,
      raw: result,
    };
  } catch (err) {
    // handleMessage's preconditions (missing hat, bad classifier)
    // throw — we swallow those into NO_INTENT so chatService stays
    // responsive. The shape mirrors the orchestrator's no_intent
    // branch so downstream consumers can't tell the difference.
    const reason = err instanceof Error ? err.message : String(err);
    const correlationId = input.correlationId ?? randomId();
    const conversationPatchId = randomId();
    return {
      triageHint: "NO_INTENT",
      conversationPatchId,
      correlationId,
      conversationPatch: null,
      ratificationPatch: null,
      raw: {
        kind: "no_intent",
        conversationPatchId: conversationPatchId as unknown as PatchId,
        correlationId: correlationId as unknown as CorrelationId,
        reason: `handleMessage_error:${reason}`,
      },
    };
  }
}
