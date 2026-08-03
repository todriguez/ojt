/**
 * Pricing model — Paskian learning loop for the ROM estimator.
 *
 * Structure
 * ─────────
 * For every trade, a singleton semantic object (vertical="trades",
 * objectKind="pricing-model", externalId=<trade>) anchors the learning
 * state. Its payload carries the rolling `PricingMultipliers` plus the
 * source outcomes that informed them. Adding a trade doesn't require
 * schema — the sem_objects row is upserted on first outcome.
 *
 * Process
 * ───────
 * Each `CompletedJobOutcome` (actualHours, actualCharge, ref to the
 * originally-emitted RomInstrument) lands as an `evidence_merge` patch
 * on the trade's pricing-model object. A subsequent `rescore` patch
 * recomputes the rolling multipliers from the last N outcomes.
 * Multipliers are clamped to [0.6, 1.4] — beyond that, Todd edits the
 * band tables directly or the trade has drifted enough that
 * re-categorisation is the right move.
 *
 * Persistence
 * ───────────
 * Outcomes land on sem_object_patches with patchKind=evidence_merge and
 * a deterministic delta payload. Multipliers land on sem_object_patches
 * with patchKind=rescore. Both carry prevStateHash / newStateHash so the
 * learning trajectory is as auditable as any other patch chain in the
 * system. A trade's entire pricing history is queryable as
 * "all patches on the pricing-model sem_object for that trade".
 *
 * Loop: conversation with the world
 * ─────────────────────────────────
 * The estimator's initial model says "fencing half-day = $350–$600".
 * Todd does 8 fencing half-days and actually charges $450–$720 on them.
 * Ratio avg ≈ 1.18. The rescore patch writes costMultiplier=1.18.
 * Next fencing half-day estimate comes out as $413–$708. Same loop, same
 * audit chain. Every estimate is a hypothesis; every outcome either
 * confirms or disconfirms the multipliers and updates them.
 *
 * This module is the PROCESS side. The chatService wires the read path
 * (load multipliers for the current trade before rescoring) and
 * something like `/api/v2/jobs/[id]/close` wires the write path (record
 * an outcome when Todd closes a job).
 */
import { createHash } from "crypto";
import { eq, and, desc } from "drizzle-orm";

import * as schema from "../../db/schema";
import { objectPatches, semanticObjects } from "../../semantos-kernel/schema.core";
import { isTradeCategory, type TradeCategory } from "../../lexicons/trades";
import type { PricingMultipliers } from "./sppEstimator";
import { IDENTITY_MULTIPLIERS } from "./sppEstimator";

// ── Constants ───────────────────────────────────────────────────────────────

/** Rolling window size — the last N outcomes per trade inform the
 *  multipliers. 20 balances responsiveness with noise suppression. */
const ROLLING_WINDOW = 20;

/** Multiplier bounds — two regimes.
 *
 *  EARLY regime (< EARLY_CONFIDENT_N outcomes): [0.4, 3.0]. Wide because
 *  we need to be able to correct order-of-magnitude misses in the base
 *  band tables. If Todd's actual painting jobs are consistently 3× the
 *  estimator's prediction, the first handful of outcomes should move
 *  painting hard toward 3.0 without getting pinned at a tight ceiling.
 *
 *  CONFIDENT regime (≥ EARLY_CONFIDENT_N): [0.6, 1.4]. Tight because by
 *  then the base band tables should be roughly calibrated — we're
 *  tracking drift, not correcting orders of magnitude. A 40% divergence
 *  is plenty of learning room once the baseline is settled.
 *
 *  Switch triggers per-trade. Fencing might be in CONFIDENT after 5
 *  outcomes while painting is still in EARLY — that's fine, they live
 *  on separate pricing-model sem_objects. */
const EARLY_MULTIPLIER_MIN = 0.4;
const EARLY_MULTIPLIER_MAX = 3.0;
const CONFIDENT_MULTIPLIER_MIN = 0.6;
const CONFIDENT_MULTIPLIER_MAX = 1.4;
const EARLY_CONFIDENT_N = 5;

// ── Types ───────────────────────────────────────────────────────────────────

/** CompletedJobOutcome — what Todd records when a job wraps. The ref to
 *  the original RomInstrument lets the learning loop compare estimate
 *  vs. reality for exactly-that-estimate (not "fencing jobs in general"
 *  — that's what the rolling average is for). */
export interface CompletedJobOutcome {
  /** The OJT job that completed. */
  jobId: string;
  /** Trade as recorded at estimation time. */
  trade: TradeCategory;
  /** Reference to the RomInstrument that was emitted for this job. */
  originalInstrumentId: string;
  /** The cost range that was quoted to the customer. */
  estimatedCostMin: number;
  estimatedCostMax: number;
  /** Hours range that was estimated. */
  estimatedHoursMin: number;
  estimatedHoursMax: number;
  /** Actual hours worked, reported by Todd. */
  actualHours: number;
  /** Actual amount charged, reported by Todd. */
  actualCharge: number;
  /** When the outcome was recorded. */
  recordedAt: string;
  /** Free-text note — why the job went longer/shorter/etc. */
  note: string | null;
}

/** Payload stored on the pricing-model sem_object for a given trade. */
export interface PricingModelState {
  trade: TradeCategory;
  multipliers: PricingMultipliers;
  /** Last N outcomes (most recent first). Bounded so the state stays
   *  small enough to serialise into a cell payload comfortably. */
  recentOutcomes: CompletedJobOutcome[];
  /** Monotonically-increasing version of this learning state. */
  version: number;
  /** ISO timestamp of the most recent outcome merged. */
  lastUpdatedAt: string | null;
}

function emptyPricingModelState(trade: TradeCategory): PricingModelState {
  return {
    trade,
    multipliers: { ...IDENTITY_MULTIPLIERS, trade },
    recentOutcomes: [],
    version: 0,
    lastUpdatedAt: null,
  };
}

// ── Hash helper (same contract as hashEstimatorState) ──────────────────────

function hashPricingModelState(state: PricingModelState): string {
  const projection = Object.keys(state)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = (state as unknown as Record<string, unknown>)[key];
      return acc;
    }, {});
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}

// ── Upsert the pricing-model sem_object for a trade ─────────────────────────

const PRICING_MODEL_TYPE_PATH = "services.trades.pricing-model";
function pricingModelTypeHash(trade: TradeCategory): string {
  return createHash("sha256")
    .update(`${PRICING_MODEL_TYPE_PATH}:${trade}`)
    .digest("hex");
}

/** Ensure a pricing-model sem_object exists for the given trade.
 *  Returns its id. Idempotent — safe to call on every outcome write. */
export async function ensurePricingModelObject(
  db: Awaited<ReturnType<typeof import("../../db/client").getDb>>,
  trade: TradeCategory,
): Promise<string> {
  const typeHash = pricingModelTypeHash(trade);
  const existing = await db
    .select()
    .from(semanticObjects)
    .where(
      and(
        eq(semanticObjects.typeHash, typeHash),
        eq(semanticObjects.externalId, trade),
      ),
    )
    .limit(1);
  if (existing.length > 0) return existing[0].id;

  const initialState = emptyPricingModelState(trade);
  const initialHash = hashPricingModelState(initialState);
  const [created] = await db
    .insert(semanticObjects)
    .values({
      vertical: "trades",
      objectKind: "pricing-model",
      typeHash,
      typePath: `${PRICING_MODEL_TYPE_PATH}.${trade}`,
      externalId: trade,
      linearity: "AFFINE", // the model evolves but is never "spent"
      currentVersion: 0,
      currentStateHash: initialHash,
    })
    .returning();
  return created.id;
}

// ── Read path: compute multipliers for a trade ──────────────────────────────

/** Load recent outcomes for a trade from the patch chain, compute rolling
 *  multipliers, return them. If no outcomes exist yet, returns identity
 *  multipliers — the estimator operates on the base tables unchanged. */
export async function getMultipliersForTrade(
  db: Awaited<ReturnType<typeof import("../../db/client").getDb>>,
  trade: TradeCategory,
): Promise<PricingMultipliers> {
  const objectId = await findPricingModelObjectId(db, trade);
  if (!objectId) return { ...IDENTITY_MULTIPLIERS, trade };

  const recent = await db
    .select()
    .from(objectPatches)
    .where(
      and(
        eq(objectPatches.objectId, objectId),
        eq(objectPatches.patchKind, "evidence_merge"),
      ),
    )
    .orderBy(desc(objectPatches.createdAt))
    .limit(ROLLING_WINDOW);

  const outcomes: CompletedJobOutcome[] = [];
  for (const row of recent) {
    const d = row.delta as { outcome?: CompletedJobOutcome } | null;
    if (d && d.outcome && isTradeCategory(d.outcome.trade)) {
      outcomes.push(d.outcome);
    }
  }
  return computeMultipliersFromOutcomes(outcomes, trade);
}

/** Pure — compute rolling multipliers from a window of outcomes. Uses the
 *  geometric mean of (actual / estimated-midpoint) so one hugely
 *  underpriced job doesn't drag the multiplier excessively. */
export function computeMultipliersFromOutcomes(
  outcomes: ReadonlyArray<CompletedJobOutcome>,
  trade: TradeCategory | null,
): PricingMultipliers {
  if (outcomes.length === 0) {
    return { ...IDENTITY_MULTIPLIERS, trade };
  }

  let logCostSum = 0;
  let logHoursSum = 0;
  let costSamples = 0;
  let hoursSamples = 0;

  for (const o of outcomes) {
    const estCostMid = (o.estimatedCostMin + o.estimatedCostMax) / 2;
    const estHoursMid = (o.estimatedHoursMin + o.estimatedHoursMax) / 2;
    if (estCostMid > 0 && o.actualCharge > 0) {
      logCostSum += Math.log(o.actualCharge / estCostMid);
      costSamples++;
    }
    if (estHoursMid > 0 && o.actualHours > 0) {
      logHoursSum += Math.log(o.actualHours / estHoursMid);
      hoursSamples++;
    }
  }

  const rawCostMult = costSamples > 0 ? Math.exp(logCostSum / costSamples) : 1.0;
  const rawHoursMult = hoursSamples > 0 ? Math.exp(logHoursSum / hoursSamples) : 1.0;

  return {
    costMultiplier: clampMult(rawCostMult, outcomes.length),
    hoursMultiplier: clampMult(rawHoursMult, outcomes.length),
    sampleSize: outcomes.length,
    trade,
  };
}

function clampMult(m: number, sampleSize: number): number {
  if (!Number.isFinite(m)) return 1.0;
  const isEarly = sampleSize < EARLY_CONFIDENT_N;
  const lo = isEarly ? EARLY_MULTIPLIER_MIN : CONFIDENT_MULTIPLIER_MIN;
  const hi = isEarly ? EARLY_MULTIPLIER_MAX : CONFIDENT_MULTIPLIER_MAX;
  return Math.max(lo, Math.min(hi, m));
}

// ── Write path: record an outcome ───────────────────────────────────────────

/** Record a completed-job outcome as an evidence_merge patch on the
 *  trade's pricing-model sem_object. Safe to call multiple times per
 *  job — subsequent calls append; the rolling window handles duplicates
 *  gracefully because they'll age out together. */
export async function recordCompletedOutcome(
  db: Awaited<ReturnType<typeof import("../../db/client").getDb>>,
  outcome: CompletedJobOutcome,
): Promise<{ objectId: string; patchId: string }> {
  if (!isTradeCategory(outcome.trade)) {
    throw new Error(`recordCompletedOutcome: unknown trade ${outcome.trade}`);
  }

  const objectId = await ensurePricingModelObject(db, outcome.trade);

  // Read current version/hash for the chain link.
  const [obj] = await db
    .select()
    .from(semanticObjects)
    .where(eq(semanticObjects.id, objectId))
    .limit(1);
  const fromVersion = obj?.currentVersion ?? 0;
  const prevHash = obj?.currentStateHash ?? "";
  const toVersion = fromVersion + 1;

  // Synthesise a new state hash — we don't need the full next state here;
  // the rescore patch below recomputes multipliers and writes the real
  // new hash. Use a stable derivative of the outcome for the evidence
  // merge so replays match.
  const evidenceHash = createHash("sha256")
    .update(JSON.stringify({ prev: prevHash, outcome }))
    .digest("hex");

  const [insertedRow] = await db
    .insert(objectPatches)
    .values({
      objectId,
      fromVersion,
      toVersion,
      prevStateHash: prevHash,
      newStateHash: evidenceHash,
      patchKind: "evidence_merge",
      // `_anchor` scheme matches the estimator patches — a reader can
      // always find the driver of a patch at delta._anchor, whether that
      // driver was a customer utterance or a job-close event.
      delta: {
        outcome,
        _anchor: {
          sourceMessageId: null,
          rawMessagePreview: outcome.note
            ? `[close] actualHours=${outcome.actualHours} actualCharge=$${outcome.actualCharge} — ${outcome.note}`
            : `[close] actualHours=${outcome.actualHours} actualCharge=$${outcome.actualCharge}`,
          sourceKind: "job_close",
        },
      } as Record<string, unknown>,
      deltaCount: 1,
      source: `job:${outcome.jobId}:closed`,
      consumed: true,
      timestamp: Date.now(),
      lexicon: "trades",
    })
    .returning();

  // Recompute multipliers from the updated window and write the rescore
  // patch so the multipliers themselves are anchored in the chain.
  const recomputed = await getMultipliersForTrade(db, outcome.trade);
  const rescoreState: PricingModelState = {
    trade: outcome.trade,
    multipliers: recomputed,
    recentOutcomes: [], // not materialised into the object state — chain is authoritative
    version: toVersion + 1,
    lastUpdatedAt: outcome.recordedAt,
  };
  const rescoreHash = hashPricingModelState(rescoreState);

  await db.insert(objectPatches).values({
    objectId,
    fromVersion: toVersion,
    toVersion: toVersion + 1,
    prevStateHash: evidenceHash,
    newStateHash: rescoreHash,
    patchKind: "rescore",
    delta: {
      multipliers: recomputed,
      window: ROLLING_WINDOW,
      _anchor: {
        sourceMessageId: null,
        rawMessagePreview: `[refine] trade=${outcome.trade} n=${recomputed.sampleSize} cost×${recomputed.costMultiplier.toFixed(3)} hours×${recomputed.hoursMultiplier.toFixed(3)}`,
        sourceKind: "scheduled_refine",
      },
    } as Record<string, unknown>,
    deltaCount: 1,
    source: `pricing-model:refine:${outcome.trade}`,
    consumed: true,
    timestamp: Date.now(),
    lexicon: "trades",
  });

  // Advance the sem_object's version anchor to the post-rescore hash.
  await db
    .update(semanticObjects)
    .set({
      currentVersion: toVersion + 1,
      currentStateHash: rescoreHash,
      updatedAt: new Date(),
    })
    .where(eq(semanticObjects.id, objectId));

  return { objectId, patchId: insertedRow.id };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function findPricingModelObjectId(
  db: Awaited<ReturnType<typeof import("../../db/client").getDb>>,
  trade: TradeCategory,
): Promise<string | null> {
  const typeHash = pricingModelTypeHash(trade);
  const rows = await db
    .select({ id: semanticObjects.id })
    .from(semanticObjects)
    .where(
      and(
        eq(semanticObjects.typeHash, typeHash),
        eq(semanticObjects.externalId, trade),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

// Parameter-only guard: forces schema to be referenced (silences unused-
// import warnings when schema is imported for its types only).
export const _schemaRef = schema.jobs;
