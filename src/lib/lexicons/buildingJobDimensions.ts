/**
 * BuildingJobDimensionsLexicon — typed dimensions of a trade job.
 *
 * Orthogonal to TradesLexicon: `trades` tags WHAT the job is
 * (carpentry / painting / plumbing), `building-job-dimensions` tags the
 * attributes that drive the deterministic estimator's effort-band math
 * (interior vs exterior, how much prep, how many rooms, what dwelling,
 * what access, etc.).
 *
 * Eight dimension categories, each a "kind of fact" rather than a
 * (kind, value) pair. The VALUE for a fact lives in the standard
 * TaggedFact.fact string as a controlled-vocab token — the dimension
 * parser downstream maps those tokens to typed enum values in
 * EstimatorState. This matches the existing lexicon sizing pattern
 * (Jural: 7, PropertyManagement: 7, ControlSystems: 7, Trades: 12)
 * without blowing the category list up to ~25 (dimension, value) pairs.
 *
 * Controlled vocab per category (the `fact` field must match one of
 * these when tagged — the parser rejects / demotes unknown values):
 *   - surface:         interior | exterior | mixed
 *   - prep_level:      clean | scuff_sand | fill_patch | plaster_repair | strip_back
 *   - room_count:      <integer as string — e.g. "1", "8", "12+">
 *   - dwelling_type:   apartment | townhouse | house | commercial
 *   - access:          ground | ladder | scaffold | difficult
 *   - material_tier:   standard | mid | premium
 *   - quantity_signal: single | small_batch | large_batch
 *   - work_type:       repair | replace | install | inspect
 *
 * UPSTREAM STATUS: OJT-local. An attempted lift into
 * `core/semantos-sir/src/lexicons.ts` was rolled back upstream; the
 * canonical home for these dimensions remains TBD (probably a separate
 * `building-trades-extension` package once the trades vertical is more
 * settled). Until then, the local Lexicon<Cat> contract is upheld here
 * so callers (the estimator, validator, chat prompts) treat it
 * identically to a registered upstream lexicon. The Lean proof template
 * exists at `semantos-core/proofs/lean/Semantos/Lexicons/Trades.lean`
 * and the same shape would apply here when ready.
 */
import type { Lexicon } from "@semantos/semantos-sir";

export type BuildingJobDimensionsCategory =
  | "surface"
  | "prep_level"
  | "room_count"
  | "dwelling_type"
  | "access"
  | "material_tier"
  | "quantity_signal"
  | "work_type";

export const BuildingJobDimensionsLexicon: Lexicon<BuildingJobDimensionsCategory> = {
  name: "building-job-dimensions",
  categories: [
    "surface",
    "prep_level",
    "room_count",
    "dwelling_type",
    "access",
    "material_tier",
    "quantity_signal",
    "work_type",
  ] as const,
  header: (c) => c.toUpperCase(),
};

export function isBuildingJobDimensionsCategory(
  value: string,
): value is BuildingJobDimensionsCategory {
  return (BuildingJobDimensionsLexicon.categories as readonly string[]).includes(value);
}

// ── Controlled vocabularies per category ────────────────────────────────────
// The LLM emits `fact` as one of these tokens (or a bare integer for
// room_count). The dimension parser validates and maps to typed slots.

export const SURFACE_VALUES = ["interior", "exterior", "mixed"] as const;
export type SurfaceValue = (typeof SURFACE_VALUES)[number];

export const PREP_LEVEL_VALUES = [
  "clean",
  "scuff_sand",
  "fill_patch",
  "plaster_repair",
  "strip_back",
] as const;
export type PrepLevelValue = (typeof PREP_LEVEL_VALUES)[number];

export const DWELLING_TYPE_VALUES = [
  "apartment",
  "townhouse",
  "house",
  "commercial",
] as const;
export type DwellingTypeValue = (typeof DWELLING_TYPE_VALUES)[number];

export const ACCESS_VALUES = [
  "ground",
  "ladder",
  "scaffold",
  "difficult",
] as const;
export type AccessValue = (typeof ACCESS_VALUES)[number];

export const MATERIAL_TIER_VALUES = ["standard", "mid", "premium"] as const;
export type MaterialTierValue = (typeof MATERIAL_TIER_VALUES)[number];

export const QUANTITY_SIGNAL_VALUES = [
  "single",
  "small_batch",
  "large_batch",
] as const;
export type QuantitySignalValue = (typeof QUANTITY_SIGNAL_VALUES)[number];

export const WORK_TYPE_VALUES = [
  "repair",
  "replace",
  "install",
  "inspect",
] as const;
export type WorkTypeValue = (typeof WORK_TYPE_VALUES)[number];
