/**
 * Semantic Runtime Adapter — SHIM
 *
 * This file now delegates to the extracted semantos-kernel.
 * It preserves the original function signatures so chatService.ts
 * and any other consumers don't need to change immediately.
 *
 * The real implementation lives in:
 *   src/lib/semantos-kernel/adapter.base.ts       (vertical-agnostic)
 *   src/lib/semantos-kernel/verticals/trades/      (trades-specific)
 *
 * Migration path:
 *   1. [DONE] Extract kernel from this file
 *   2. [CURRENT] Shim old exports through new kernel
 *   3. [NEXT] Update chatService to import from kernel directly
 *   4. [LATER] Remove this shim
 */

import type { Database } from "../../db/client";
import type { AccumulatedJobState, MergeResult } from "../../ai/extractors/extractionSchema";
import { TradesSemanticAdapter } from "../../semantos-kernel/verticals/trades/adapter.trades";
import type { SemanticContext } from "../../semantos-kernel/adapter.base";

// ─── Re-export the context type under its old name ──────────────────────
export type SemanticJobContext = SemanticContext;

// ─── Adapter singleton cache ────────────────────────────────────────────
let _adapter: TradesSemanticAdapter | null = null;

function getAdapter(db: Database): TradesSemanticAdapter {
  if (!_adapter) {
    _adapter = new TradesSemanticAdapter(db);
  }
  return _adapter;
}

// ─── Shimmed exports matching original function signatures ──────────────

export async function ensureSemanticObject(
  db: Database,
  jobId: string,
  jobType: string | null,
  ownerId?: string,
): Promise<SemanticJobContext> {
  const adapter = getAdapter(db);
  return adapter.ensureTradesJob(jobId, jobType || "general", ownerId);
}

export async function recordStateSnapshot(
  db: Database,
  ctx: SemanticJobContext,
  mergeResult: MergeResult,
  state: AccumulatedJobState,
  source: string,
): Promise<SemanticJobContext> {
  const adapter = getAdapter(db);
  return adapter.recordTradesState(ctx, mergeResult, state, source);
}

export async function recordScores(
  db: Database,
  ctx: SemanticJobContext,
  scores: {
    customerFitScore: number | null;
    customerFitLabel: string | null;
    quoteWorthinessScore: number | null;
    quoteWorthinessLabel: string | null;
    completenessScore: number;
  },
): Promise<void> {
  const adapter = getAdapter(db);
  return adapter.recordTradesScores(ctx, {
    fit: scores.customerFitScore ?? undefined,
    fitLabel: scores.customerFitLabel ?? undefined,
    worthiness: scores.quoteWorthinessScore ?? undefined,
    worthinessLabel: scores.quoteWorthinessLabel ?? undefined,
    confidence: scores.completenessScore,
  });
}

export async function recordEvidence(
  db: Database,
  ctx: SemanticJobContext,
  messageId: string,
  content: string,
  senderType: "customer" | "ai" | "system",
): Promise<void> {
  const adapter = getAdapter(db);
  return adapter.recordTradesEvidence(ctx, messageId, content, senderType);
}

export async function recordInstrument(
  db: Database,
  ctx: SemanticJobContext,
  estimate: {
    effortBand: string;
    costMin: number;
    costMax: number;
    hoursMin?: number;
    hoursMax?: number;
    labourOnly: boolean;
    materialsNote?: string;
  },
): Promise<void> {
  const adapter = getAdapter(db);
  return adapter.recordTradesInstrument(ctx, {
    estimateId: crypto.randomUUID(),
    costMin: estimate.costMin,
    costMax: estimate.costMax,
    effortBand: estimate.effortBand,
    confidence: "medium",
    notes: estimate.materialsNote,
  });
}

export async function recordStatusTransition(
  db: Database,
  ctx: SemanticJobContext,
  fromStatus: string,
  toStatus: string,
  reason: string,
): Promise<void> {
  const adapter = getAdapter(db);
  return adapter.recordTradesTransition(ctx, fromStatus, toStatus, reason);
}
