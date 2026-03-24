/**
 * adapter.trades.ts
 *
 * TradesSemanticAdapter — Vertical-Specific Adapter
 *
 * Extends SemanticAdapter with trades/services-specific logic:
 *   - Trades job creation and lifecycle
 *   - Denormalized scoring in trades projection tables
 *   - Evidence recording for messages and documents
 *   - ROM quote instrument generation
 *   - Status transitions with audit trail
 *
 * All writes are safe (queued on failure) via the base adapter.
 */

import { eq } from "drizzle-orm";
import { SemanticAdapter, SemanticContext, VerticalConfig } from "../../adapter.base";
import {
  tradesJobs,
  tradesCustomers,
  tradesSites,
  tradesVisits,
} from "./schema.trades";
import {
  AccumulatedJobState,
  MergeResult,
} from "../../../ai/extractors/extractionSchema";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const VERTICAL = "trades";
const COMPILER_VERSION = "trades-v5.1";

// ─────────────────────────────────────────────────────────────────────────────
// TradesSemanticAdapter Class
// ─────────────────────────────────────────────────────────────────────────────

export class TradesSemanticAdapter extends SemanticAdapter {
  private dbInstance: any;

  constructor(db: any, verticalConfig?: VerticalConfig) {
    // Use passed config or default trades config
    const config: VerticalConfig = verticalConfig || {
      verticalId: VERTICAL,
      compilerVersion: COMPILER_VERSION,
      irVersion: 1,
    };
    super(db, config);
    this.dbInstance = db;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Trades-Specific Operations
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * ensureTradesJob: Creates a semantic object for a trades job and
   * initializes the denormalized tradesJobs projection row.
   *
   * @param jobId unique job identifier
   * @param jobType job category (e.g., "plumbing", "carpentry")
   * @param ownerId operator or organization ID
   * @returns SemanticContext for further operations
   */
  async ensureTradesJob(
    jobId: string,
    jobType: string,
    ownerId?: string
  ): Promise<SemanticContext> {
    // Call base to create semantic object
    const typeHash = this._computeTypeHash("job", jobType);
    const typePath = `trades.job.${jobType}`;

    const ctx = await this.ensureObject("job", typeHash, typePath, ownerId);

    // Create tradesJobs projection row
    try {
      await this.dbInstance.insert(tradesJobs).values({
        objectId: ctx.semanticObjectId,
        legacyJobId: jobId,
        jobType,
        jobStatus: "new_lead",
        completenessScore: 0,
      }).onConflictDoNothing();
    } catch (err: any) {
      console.error(`Failed to create trades job projection: ${err.message}`);
    }

    return ctx;
  }

  /**
   * recordTradesState: Records an object state and updates the denormalized
   * tradesJobs projection with extracted fields for fast querying.
   *
   * @param ctx current semantic context
   * @param mergeResult the merged state from extraction pipeline
   * @param state the accumulated job state
   * @param source where this state came from ("extraction", "merge", etc.)
   * @returns updated SemanticContext
   */
  async recordTradesState(
    ctx: SemanticContext,
    mergeResult: MergeResult,
    state: AccumulatedJobState,
    source: string
  ): Promise<SemanticContext> {
    // Call base to record state
    const payload = state as any;
    await this.recordState(
      ctx,
      mergeResult.stateHash,
      mergeResult.prevStateHash,
      payload,
      JSON.stringify(payload).length,
      source
    );

    // Update tradesJobs projection with denormalized fields
    const updates: Record<string, any> = {
      updatedAt: new Date(),
    };

    // Denormalize extraction results
    if (state.customerName) updates.customerName = state.customerName;
    if (state.suburb) updates.suburb = state.suburb;
    if (state.postcode) updates.postcode = state.postcode;
    if (state.jobType) updates.jobType = state.jobType;
    if (state.jobSubcategory) updates.jobSubcategory = state.jobSubcategory;
    if (state.urgency) updates.urgency = state.urgency;
    if (state.effortBandReason) updates.effortBand = state.effortBandReason;

    // Denormalize scores
    if (state.customerFitScore !== null && state.customerFitScore !== undefined) {
      updates.customerFitScore = state.customerFitScore;
    }
    if (state.customerFitLabel) updates.customerFitLabel = state.customerFitLabel;
    if (state.quoteWorthinessScore !== null && state.quoteWorthinessScore !== undefined) {
      updates.quoteWorthinessScore = state.quoteWorthinessScore;
    }
    if (state.quoteWorthinessLabel) updates.quoteWorthinessLabel = state.quoteWorthinessLabel;
    if (state.completenessScore !== null && state.completenessScore !== undefined) {
      updates.completenessScore = state.completenessScore;
    }
    if (state.recommendation) updates.recommendation = state.recommendation;
    if (state.recommendationReason) updates.recommendationReason = state.recommendationReason;

    // Denormalize estimate tracking
    if (state.estimatePresented) updates.estimatePresented = state.estimatePresented;
    if (state.estimateAcknowledged) updates.estimateAcknowledged = state.estimateAcknowledged;
    if (state.estimateAckStatus) updates.estimateAckStatus = state.estimateAckStatus;

    try {
      await this.dbInstance
        .update(tradesJobs)
        .set(updates)
        .where(eq(tradesJobs.objectId, ctx.semanticObjectId));
    } catch (err: any) {
      console.error(`Failed to update trades job projection: ${err.message}`);
    }

    return ctx;
  }

  /**
   * recordTradesScores: Records three trades-specific scoring dimensions:
   *   - customer-fit: likelihood customer is a good fit
   *   - quote-worthiness: estimated ROI if quoted
   *   - confidence: system confidence in the classification
   *
   * @param ctx current semantic context
   * @param scores object with fit, worthiness, confidence fields
   */
  async recordTradesScores(
    ctx: SemanticContext,
    scores: {
      fit?: number;
      worthiness?: number;
      confidence?: number;
      fitLabel?: string;
      worthinessLabel?: string;
      confidenceLabel?: string;
    }
  ): Promise<void> {
    if (scores.fit !== undefined) {
      await this.recordScore(ctx, "trades-customer-fit", {
        score: scores.fit,
        label: scores.fitLabel || "unknown",
      });
    }

    if (scores.worthiness !== undefined) {
      await this.recordScore(ctx, "trades-quote-worthiness", {
        score: scores.worthiness,
        label: scores.worthinessLabel || "unknown",
      });
    }

    if (scores.confidence !== undefined) {
      await this.recordScore(ctx, "trades-confidence", {
        score: scores.confidence,
        label: scores.confidenceLabel || "unknown",
      });
    }
  }

  /**
   * recordTradesEvidence: Records evidence (messages, documents, observations)
   * linked to a trades job.
   *
   * @param ctx current semantic context
   * @param messageId unique identifier for the source message
   * @param content the extracted or raw message text
   * @param senderType "customer" | "operator" | "system"
   */
  async recordTradesEvidence(
    ctx: SemanticContext,
    messageId: string,
    content: string,
    senderType: string
  ): Promise<void> {
    await this.recordEvidence(
      ctx,
      "message",
      content,
      messageId,
      0.9 // default confidence for message evidence
    );
  }

  /**
   * recordTradesInstrument: Records a generated ROM (rough order of magnitude) quote
   * or formal quote as an instrument artifact.
   *
   * @param ctx current semantic context
   * @param estimate the quote/estimate data
   */
  async recordTradesInstrument(
    ctx: SemanticContext,
    estimate: {
      estimateId: string;
      costMin: number;
      costMax: number;
      effortBand: string;
      confidence: "low" | "medium" | "high";
      notes?: string;
    }
  ): Promise<void> {
    await this.recordInstrument(
      ctx,
      "rom-quote",
      `trades.quote.${estimate.estimateId}`,
      {
        estimateId: estimate.estimateId,
        costMin: estimate.costMin,
        costMax: estimate.costMax,
        effortBand: estimate.effortBand,
        confidence: estimate.confidence,
        notes: estimate.notes,
      },
      "RELEVANT" // ROM quotes are referenceable
    );
  }

  /**
   * recordTradesTransition: Records a status transition (new_lead → quoted, etc.)
   * and updates the trades projection with the new status.
   *
   * @param ctx current semantic context
   * @param fromStatus previous status
   * @param toStatus new status
   * @param reason why the transition occurred
   */
  async recordTradesTransition(
    ctx: SemanticContext,
    fromStatus: string,
    toStatus: string,
    reason: string
  ): Promise<void> {
    // Call base to record transition
    const delta = { jobStatus: { from: fromStatus, to: toStatus } };
    await this.recordTransition(
      ctx,
      ctx.version,
      ctx.version + 1,
      "",
      "",
      delta,
      `trades:${reason}`
    );

    // Update trades projection
    try {
      await this.dbInstance
        .update(tradesJobs)
        .set({
          jobStatus: toStatus,
          updatedAt: new Date(),
        })
        .where(eq(tradesJobs.objectId, ctx.semanticObjectId));
    } catch (err: any) {
      console.error(`Failed to update trades job status: ${err.message}`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private Helpers
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Compute type hash for trades objects.
   * Format: SHA256(vertical:objectKind:subtype)
   */
  private _computeTypeHash(objectKind: string, subtype: string): string {
    // Simplified — in production, this would SHA256 the concatenated string
    const { createHash } = require("crypto");
    const input = `${VERTICAL}:${objectKind}:${subtype}`;
    return createHash("sha256").update(input).digest("hex");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Factory function to create a trades adapter instance.
 */
export function createTradesAdapter(db: any): TradesSemanticAdapter {
  return new TradesSemanticAdapter(db, {
    verticalId: VERTICAL,
    compilerVersion: COMPILER_VERSION,
    irVersion: 1,
  });
}
