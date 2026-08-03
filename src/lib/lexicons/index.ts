/**
 * OJT lexicons — sourced from `@semantos/semantos-sir`.
 *
 * Two lexicons are in scope for OJT-P6:
 *   - `jural` (declaration, obligation, permission, prohibition, power,
 *     condition, transfer) — how tenant/admin utterances map into
 *     Hohfeldian legal relations.
 *   - `property-management` (lease, maintenance, inspection, rent,
 *     violation, renewal, termination) — rental-operations lifecycle.
 *
 * CRITICAL: this module must NEVER inline category strings. Every
 * category comes from the imported `Lexicon.categories` array so the
 * Lean-verified injectivity in semantos-core is the single source of
 * truth. The G6 gate test grep-enforces this.
 */
import {
  JuralLexicon,
  PropertyManagementLexicon,
} from "@semantos/semantos-sir";
import { TradesLexicon } from "./trades";
import { BuildingJobDimensionsLexicon } from "./buildingJobDimensions";

/** Readonly arrays sourced from the canonical lexicons. */
export const JURAL_CATEGORIES = JuralLexicon.categories;
export const PM_CATEGORIES = PropertyManagementLexicon.categories;
export const TRADES_CATEGORIES = TradesLexicon.categories;
export const BUILDING_JOB_DIMENSIONS_CATEGORIES = BuildingJobDimensionsLexicon.categories;

/** The lexicon names OJT understands. `trades` and `building-job-dimensions`
 *  are OJT-local pending lift to semantos-sir; see the per-file migration
 *  notes. */
export type LexiconName =
  | "jural"
  | "property-management"
  | "trades"
  | "building-job-dimensions";

/** A lexicon-tagged fact produced by the extraction LLM. */
export interface TaggedFact {
  /** `null` means the LLM declined to tag (preferred over guessing). */
  lexicon: LexiconName | null;
  /** `null` whenever `lexicon` is `null`. */
  category: string | null;
  /** Model-reported confidence in [0, 1]. Below 0.6 is demoted. */
  confidence: number;
  /** One-sentence canonicalised fact (not the raw utterance). */
  fact: string;
  /** Verbatim slice of the source utterance this fact was extracted from. */
  source: string;
}

/**
 * Registry mapping lexicon name → the allowed category set. The
 * validator does every membership check against this map. Adding a
 * new lexicon means: (a) import it here, (b) extend `LexiconName`.
 */
export const LEXICON_REGISTRY: Record<LexiconName, readonly string[]> = {
  jural: JURAL_CATEGORIES,
  "property-management": PM_CATEGORIES,
  trades: TRADES_CATEGORIES,
  "building-job-dimensions": BUILDING_JOB_DIMENSIONS_CATEGORIES,
};

export { TradesLexicon, isTradeCategory } from "./trades";
export type { TradeCategory } from "./trades";
export {
  BuildingJobDimensionsLexicon,
  isBuildingJobDimensionsCategory,
  SURFACE_VALUES,
  PREP_LEVEL_VALUES,
  DWELLING_TYPE_VALUES,
  ACCESS_VALUES,
  MATERIAL_TIER_VALUES,
  QUANTITY_SIGNAL_VALUES,
  WORK_TYPE_VALUES,
} from "./buildingJobDimensions";
export type {
  BuildingJobDimensionsCategory,
  SurfaceValue,
  PrepLevelValue,
  DwellingTypeValue,
  AccessValue,
  MaterialTierValue,
  QuantitySignalValue,
  WorkTypeValue,
} from "./buildingJobDimensions";
