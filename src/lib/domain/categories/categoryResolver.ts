/**
 * Category Resolver
 *
 * Bridge between the extraction pipeline and the universal taxonomy.
 * Resolves AccumulatedJobState → (WHAT, HOW, INSTRUMENT) triple.
 * Generates category-aware extraction hints for LLM prompt injection.
 */

import type { AccumulatedJobState } from "@/lib/ai/extractors/extractionSchema";
import {
  classifyJob,
  inferTxType,
  deriveInstrument,
  getExtractionHints,
  getScoringContext,
  getCategoryByPath,
  type CategoryNode,
  type TransactionType,
} from "./categoryTree";
import { computeTypeHash } from "../bridge/typeHashRegistry";

// ── Types ────────────────────────────────────────

export interface CategoryResolution {
  // WHAT dimension
  path: string;
  name: string;
  confidence: "high" | "medium" | "low";
  attributes: { name: string; type: string; required: boolean; description: string }[];

  // HOW dimension
  txType: string;
  txName: string;
  settlementPattern: string;

  // INSTRUMENT dimension
  instrumentPath: string;

  // Scoring context
  scoringContext: {
    valueMultiplier: number;
    siteVisitLikely: boolean;
    licensedTrade: boolean;
  };

  // Semantos bridge: deterministic type hash for cell header
  typeHash: string; // hex-encoded SHA256(path:txType:instrumentPath)
}

// ── Resolution ───────────────────────────────────

/**
 * Resolve the full (WHAT, HOW, INSTRUMENT) triple from conversation state.
 */
export function resolveCategory(
  state: AccumulatedJobState
): CategoryResolution | null {
  // Classify WHAT
  const whatResult = classifyJob(state.jobType, state.scopeDescription);
  if (!whatResult) return null;

  const { node, confidence } = whatResult;

  // Infer HOW (for OJT, almost always tx.hire)
  const tx: TransactionType = inferTxType(state.scopeDescription);

  // Derive INSTRUMENT from state
  const instrumentPath = deriveInstrument(node.path, tx.slug, {
    estimatePresented: !!state.estimatePresented,
    estimateAccepted: state.estimateAckStatus === "accepted",
  });

  // Get scoring context
  const scoring = getScoringContext(node.path);

  // Compute deterministic type hash: SHA256(what:how:inst)
  const typeHash = computeTypeHash(node.path, tx.slug, instrumentPath).toString("hex");

  return {
    path: node.path,
    name: node.name,
    confidence,
    attributes: node.attributes.map((a) => ({
      name: a.name,
      type: a.type,
      required: a.required,
      description: a.description,
    })),
    txType: tx.slug,
    txName: tx.name,
    settlementPattern: tx.settlementPattern,
    instrumentPath,
    scoringContext: scoring,
    typeHash,
  };
}

// ── Extraction Hint Injection ────────────────────

/**
 * Build category-aware extraction hints for the LLM prompt.
 *
 * Injected into the extraction prompt between extraction rules and the
 * output instruction. Gives the LLM category-specific field knowledge.
 */
export function buildCategoryAwareExtractionHints(
  state: AccumulatedJobState
): string {
  const result = classifyJob(state.jobType, state.scopeDescription);
  if (!result) return "";

  const { node } = result;
  const hints = getExtractionHints(node.path);

  if (hints.attributes.length === 0) return "";

  const lines: string[] = [];
  lines.push(`\n--- CATEGORY-SPECIFIC EXTRACTION (${node.name}) ---`);
  lines.push(`Category path: ${node.path}`);
  lines.push(`If you detect this is a ${node.name.toLowerCase()} job, also extract:`);

  for (const attr of hints.attributes) {
    lines.push(`  - "${attr.name}": ${attr.description}`);
    if (attr.extractionHint) {
      lines.push(`    Hint: ${attr.extractionHint}`);
    }
  }

  if (node.siteVisitLikely) {
    lines.push(`Note: ${node.name} jobs typically require a site visit. Extract access details if mentioned.`);
  }
  if (node.licensedTrade) {
    lines.push(`Note: ${node.name} is a licensed trade. Note any licensing requirements mentioned.`);
  }

  lines.push(`--- END CATEGORY HINTS ---\n`);
  return lines.join("\n");
}
