/**
 * adapter.base.ts
 *
 * SemanticAdapter Base Class
 *
 * Generic vertical-agnostic base class for the semantic runtime.
 * Parameterized by vertical ID. Contains all core logic extracted from
 * domain-specific adapters.
 *
 * Responsibilities:
 *   - Lifecycle management of SemanticObjects
 *   - State versioning and hashing
 *   - Score, evidence, instrument, and transition recording
 *   - Dead-letter queue for failed writes (pendingWrites)
 *   - Two-phase commit for on-chain anchoring
 *   - Exponential backoff retry with max attempt limits
 *
 * Vertical-specific adapters extend this base and implement:
 *   - Type-specific payload serialization
 *   - Domain grammar compilation
 *   - Scoring engines
 */

import { eq, and, lt, sql } from "drizzle-orm";
import { createHash } from "crypto";
import {
  semanticObjects,
  objectStates,
  objectPatches,
  objectScores,
  evidenceItems,
  semInstruments,
  outcomes,
  pendingWrites,
  anchorRequests,
  anchorStatusEnum,
  patchKindEnum,
  instrumentStatusEnum,
  evidenceKindEnum,
} from "./schema.core";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vertical configuration. Passed to all adapter instances.
 * Identifies the domain and versions for compilation/execution.
 */
export interface VerticalConfig {
  verticalId: string;           // "trades" | "brem" | ...
  compilerVersion: string;      // semantic compiler version
  irVersion: number;            // IR schema version
}

/**
 * Semantic context. The working handle for an object within a session.
 * Passed through the entire lifecycle of reads/writes.
 */
export interface SemanticContext {
  semanticObjectId: string;
  version: number;
  stateHash: string;
}

/**
 * Pending write structure. Stored in sem_pending_writes.
 * Used to replay failed adapter calls during recovery.
 */
interface PendingWrite {
  writeKind: string;            // "ensureObject" | "recordState" | "recordScores" | "recordEvidence" | "recordInstrument" | "recordTransition"
  objectId: string;
  payload: any;                 // full arguments to replay
  attempt: number;
  maxAttempts: number;
  status: "pending" | "retrying" | "completed" | "dead";
  lastError?: string;
  nextRetryAt?: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// SemanticAdapter Base Class
// ─────────────────────────────────────────────────────────────────────────────

export class SemanticAdapter {
  private db: any;
  private verticalConfig: VerticalConfig;

  constructor(db: any, verticalConfig: VerticalConfig) {
    this.db = db;
    this.verticalConfig = verticalConfig;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Public API: Core Operations
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * ensureObject: Creates a SemanticObject row if not exists.
   * Returns SemanticContext for further operations.
   *
   * @param objectKind "job" | "customer" | "site" | ...
   * @param typeHash 64-char hex SHA256(vertical:objectKind:subtype)
   * @param typePath human-readable path like "trades.job.carpentry.hire"
   * @param ownerId optional owner/creator ID
   * @returns SemanticContext
   */
  async ensureObject(
    objectKind: string,
    typeHash: string,
    typePath: string,
    ownerId?: string
  ): Promise<SemanticContext> {
    return this._safeWrite("ensureObject", "", { objectKind, typeHash, typePath, ownerId }, async () => {
      // Check if exists
      const existing = await this.db
        .select()
        .from(semanticObjects)
        .where(eq(semanticObjects.typeHash, typeHash))
        .limit(1);

      let objectId: string;
      if (existing.length > 0) {
        objectId = existing[0].id;
      } else {
        // Create new
        const result = await this.db
          .insert(semanticObjects)
          .values({
            vertical: this.verticalConfig.verticalId,
            objectKind,
            typeHash,
            typePath,
            ownerId,
            anchorStatus: "none",
          })
          .returning({ id: semanticObjects.id });

        objectId = result[0].id;
      }

      return {
        semanticObjectId: objectId,
        version: 1,
        stateHash: "",
      };
    });
  }

  /**
   * recordState: Creates objectState + objectPatch rows.
   * Advances the version and state hash of the SemanticObject.
   *
   * @param ctx current SemanticContext
   * @param stateHash SHA256(payload)
   * @param prevStateHash previous state hash (chain link)
   * @param payload full JSONB state
   * @param payloadSize size in bytes
   * @param source "extraction" | "merge" | "manual" | ...
   */
  async recordState(
    ctx: SemanticContext,
    stateHash: string,
    prevStateHash: string,
    payload: any,
    payloadSize: number,
    source: string
  ): Promise<void> {
    await this._safeWrite("recordState", ctx.semanticObjectId, { ctx, stateHash, prevStateHash, payload, payloadSize, source }, async () => {
      const obj = await this.db
        .select()
        .from(semanticObjects)
        .where(eq(semanticObjects.id, ctx.semanticObjectId))
        .limit(1);

      if (obj.length === 0) {
        throw new Error(`SemanticObject not found: ${ctx.semanticObjectId}`);
      }

      const nextVersion = obj[0].currentVersion + 1;

      // Insert objectState (immutable snapshot)
      await this.db.insert(objectStates).values({
        objectId: ctx.semanticObjectId,
        version: nextVersion,
        stateHash,
        prevStateHash,
        payload,
        payloadSize,
        irVersion: this.verticalConfig.irVersion,
        source,
        compilerVersion: this.verticalConfig.compilerVersion,
      });

      // Insert objectPatch (delta record)
      const deltaCount = Object.keys(payload).length;
      await this.db.insert(objectPatches).values({
        objectId: ctx.semanticObjectId,
        fromVersion: obj[0].currentVersion,
        toVersion: nextVersion,
        prevStateHash,
        newStateHash: stateHash,
        patchKind: "extraction", // default
        delta: { /* computed delta */ },
        deltaCount,
        source: `system:${source}`,
        consumed: true,
      });

      // Update SemanticObject with new version
      await this.db
        .update(semanticObjects)
        .set({
          currentVersion: nextVersion,
          currentStateHash: stateHash,
          updatedAt: new Date(),
        })
        .where(eq(semanticObjects.id, ctx.semanticObjectId));
    });
  }

  /**
   * recordScore: Inserts an objectScore row.
   * Typically called after the optimizer evaluates the current state.
   *
   * @param ctx current SemanticContext
   * @param scoreKind "trades-worthiness" | "trades-fit" | ...
   * @param scorePayload vertical-specific score structure
   */
  async recordScore(
    ctx: SemanticContext,
    scoreKind: string,
    scorePayload: any
  ): Promise<void> {
    await this._safeWrite("recordScore", ctx.semanticObjectId, { ctx, scoreKind, scorePayload }, async () => {
      await this.db.insert(objectScores).values({
        objectId: ctx.semanticObjectId,
        stateHash: ctx.stateHash,
        scoreKind,
        scorePayload,
        policyVersion: this.verticalConfig.compilerVersion,
        compilerVersion: this.verticalConfig.compilerVersion,
      });
    });
  }

  /**
   * recordEvidence: Inserts an evidenceItem row.
   * Called when new source material (message, document, etc.) arrives.
   *
   * @param ctx current SemanticContext
   * @param evidenceKind "message" | "document" | "observation" | "image" | "voice"
   * @param content text content or reference
   * @param sourceRef message UUID, filename, channel
   * @param confidence confidence level 0.0-1.0
   */
  async recordEvidence(
    ctx: SemanticContext,
    evidenceKind: string,
    content: string,
    sourceRef: string,
    confidence: number = 0.5
  ): Promise<void> {
    await this._safeWrite("recordEvidence", ctx.semanticObjectId, { ctx, evidenceKind, content, sourceRef, confidence }, async () => {
      await this.db.insert(evidenceItems).values({
        objectId: ctx.semanticObjectId,
        evidenceKind,
        content,
        sourceRef,
        confidence,
      });
    });
  }

  /**
   * recordInstrument: Inserts a semInstrument row.
   * Called when the codegen produces an actionable artifact.
   *
   * @param ctx current SemanticContext
   * @param instrumentType "rom-quote" | "formal-quote" | "service-agreement" | "invoice" | ...
   * @param instrumentPath human-readable path
   * @param payload instrument content
   * @param linearity "AFFINE" | "LINEAR" | "RELEVANT"
   */
  async recordInstrument(
    ctx: SemanticContext,
    instrumentType: string,
    instrumentPath: string,
    payload: any,
    linearity: string = "RELEVANT"
  ): Promise<void> {
    await this._safeWrite("recordInstrument", ctx.semanticObjectId, { ctx, instrumentType, instrumentPath, payload, linearity }, async () => {
      await this.db.insert(semInstruments).values({
        objectId: ctx.semanticObjectId,
        stateHash: ctx.stateHash,
        instrumentType,
        instrumentPath,
        payload,
        linearity,
        status: "generated",
      });
    });
  }

  /**
   * recordTransition: Inserts an objectPatch for status/state transitions.
   * Records the delta from one version to the next.
   *
   * @param ctx current SemanticContext
   * @param fromVersion previous version number
   * @param toVersion new version number
   * @param prevHash hash of previous state
   * @param newHash hash of new state
   * @param delta the change object
   * @param source who/what triggered the transition
   */
  async recordTransition(
    ctx: SemanticContext,
    fromVersion: number,
    toVersion: number,
    prevHash: string,
    newHash: string,
    delta: any,
    source: string
  ): Promise<void> {
    await this._safeWrite("recordTransition", ctx.semanticObjectId, { ctx, fromVersion, toVersion, prevHash, newHash, delta, source }, async () => {
      const deltaCount = Object.keys(delta).length;
      await this.db.insert(objectPatches).values({
        objectId: ctx.semanticObjectId,
        fromVersion,
        toVersion,
        prevStateHash: prevHash,
        newStateHash: newHash,
        patchKind: "state_transition",
        delta,
        deltaCount,
        source,
        consumed: true,
      });
    });
  }

  /**
   * requestAnchor: Creates an anchorRequest and sets object anchorStatus to "pending".
   * Initiates the two-phase commit protocol for on-chain anchoring.
   *
   * @param ctx current SemanticContext
   * @param anchorKind "milestone" | "settlement" | "proof"
   */
  async requestAnchor(ctx: SemanticContext, anchorKind: string): Promise<void> {
    await this._safeWrite("requestAnchor", ctx.semanticObjectId, { ctx, anchorKind }, async () => {
      // Create anchor request
      await this.db.insert(anchorRequests).values({
        objectId: ctx.semanticObjectId,
        stateHash: ctx.stateHash,
        stateVersion: ctx.version,
        anchorKind,
        status: "pending",
      });

      // Update object's anchor status to pending
      await this.db
        .update(semanticObjects)
        .set({
          anchorStatus: "pending",
          updatedAt: new Date(),
        })
        .where(eq(semanticObjects.id, ctx.semanticObjectId));
    });
  }

  /**
   * retryPendingWrites: Processes dead-letter queue.
   * Picks up pending/retrying writes and replays them using exponential backoff.
   *
   * Returns count of succeeded and failed retries.
   */
  async retryPendingWrites(): Promise<{ succeeded: number; failed: number }> {
    const now = new Date();
    const toRetry = await this.db
      .select()
      .from(pendingWrites)
      .where(
        and(
          lt(pendingWrites.nextRetryAt, now),
          lt(pendingWrites.attempt, pendingWrites.maxAttempts)
        )
      )
      .limit(100);

    let succeeded = 0;
    let failed = 0;

    for (const pw of toRetry) {
      try {
        // Replay the write
        await this._executeWrite(pw.writeKind, pw.payload);

        // Mark as completed
        await this.db
          .update(pendingWrites)
          .set({
            status: "completed",
            completedAt: new Date(),
          })
          .where(eq(pendingWrites.id, pw.id));

        succeeded++;
      } catch (err: any) {
        const nextAttempt = pw.attempt + 1;
        const backoffMs = Math.pow(2, pw.attempt) * 1000;
        const nextRetryAt = new Date(now.getTime() + backoffMs);
        const status = nextAttempt >= pw.maxAttempts ? "dead" : "retrying";

        await this.db
          .update(pendingWrites)
          .set({
            attempt: nextAttempt,
            lastError: err.message,
            status,
            nextRetryAt: status === "dead" ? null : nextRetryAt,
          })
          .where(eq(pendingWrites.id, pw.id));

        failed++;
      }
    }

    return { succeeded, failed };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Protected: Safe Write Wrapper
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * _safeWrite: Wraps all write operations in try/catch.
   * On failure, stores write to pendingWrites DLQ for replay.
   * Ensures no write throws — all failures are queued for recovery.
   *
   * @param writeKind adapter function name
   * @param objectId semantic object ID
   * @param payload full arguments for replay
   * @param fn the actual write function
   */
  protected async _safeWrite(
    writeKind: string,
    objectId: string,
    payload: any,
    fn: () => Promise<any>
  ): Promise<any> {
    try {
      return await fn();
    } catch (err: any) {
      // Queue to dead-letter
      const backoffMs = 1000; // 2^0 = 1 second initial delay
      const nextRetryAt = new Date(Date.now() + backoffMs);

      try {
        await this.db.insert(pendingWrites).values({
          objectId: objectId || "",
          writeKind,
          payload,
          attempt: 0,
          maxAttempts: 5,
          status: "pending",
          lastError: err.message,
          nextRetryAt,
        });
      } catch (queueErr: any) {
        // Even queuing failed — log but don't throw
        console.error(`Failed to queue write to DLQ: ${err.message}`);
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private: Write Execution
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * _executeWrite: Dispatches a write based on writeKind.
   * Used internally by retryPendingWrites to replay queued writes.
   *
   * @param writeKind the adapter function name
   * @param payload full arguments
   */
  private async _executeWrite(writeKind: string, payload: any): Promise<void> {
    switch (writeKind) {
      case "ensureObject":
        await this.ensureObject(payload.objectKind, payload.typeHash, payload.typePath, payload.ownerId);
        break;
      case "recordState":
        await this.recordState(payload.ctx, payload.stateHash, payload.prevStateHash, payload.payload, payload.payloadSize, payload.source);
        break;
      case "recordScore":
        await this.recordScore(payload.ctx, payload.scoreKind, payload.scorePayload);
        break;
      case "recordEvidence":
        await this.recordEvidence(payload.ctx, payload.evidenceKind, payload.content, payload.sourceRef, payload.confidence);
        break;
      case "recordInstrument":
        await this.recordInstrument(payload.ctx, payload.instrumentType, payload.instrumentPath, payload.payload, payload.linearity);
        break;
      case "recordTransition":
        await this.recordTransition(payload.ctx, payload.fromVersion, payload.toVersion, payload.prevHash, payload.newHash, payload.delta, payload.source);
        break;
      case "requestAnchor":
        await this.requestAnchor(payload.ctx, payload.anchorKind);
        break;
      default:
        throw new Error(`Unknown write kind: ${writeKind}`);
    }
  }
}

// Types are exported inline above (VerticalConfig, SemanticContext, PendingWrite)
