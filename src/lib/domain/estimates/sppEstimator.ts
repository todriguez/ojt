/**
 * SPP-shaped ROM estimator — Structure / Process / Persistence.
 *
 * STRUCTURE
 * ─────────
 * Categories come from the registered TradesLexicon (no inlined trade
 * strings). Typed dimensions (EffortBand, WorkType, QuantityClass,
 * AccessClass, MaterialClass, RomConfidence) are the units the estimator
 * speaks. Lookup tables (BAND_RANGES, FIRST_PASS_BAND, MATERIAL_HINTS,
 * PER_UNIT_PRICES, KEYWORD_RULES) are keyed by those dimensions and
 * exhaust the relevant Cartesian product — no defaulting to magic strings.
 *
 * PROCESS
 * ───────
 * EstimatorState is a typed semantic-object payload. It evolves through
 * patches whose `kind` is drawn from the `patchKindEnum` already in
 * schema.core (extraction, evidence_merge, rescore, instrument_emit,
 * state_transition). The phase machine is advance-only — the only escape
 * from `estimated` is forwards to `acknowledged` or sideways to
 * `challenged` (which records pushback against the instrument without
 * regressing the phase). This mirrors BRAP's `riskSelectionGates` LINEAR
 * lifecycle.
 *
 * Patches are pure functions: they take the prior state and an input,
 * return the next state plus a typed delta record. The chatService
 * persists those records via `sem_object_patches`. Hashing the state at
 * each step gives the prevStateHash → newStateHash chain needed for
 * Persistence — the version chain is constructed *here*, not bolted on.
 *
 * PERSISTENCE
 * ───────────
 * `hashEstimatorState` is stable and deterministic — the value drops into
 * `sem_object_patches.prevStateHash / newStateHash`. The RomInstrument is
 * shaped to pack into a 1 KB cell (header has trade, band, costMin/Max,
 * hoursMin/Max, confidence; payload carries the source TaggedFacts and
 * the active rule attribution). Cell-packing itself lives in
 * semantos-kernel/cellPacker.ts and is wired in a later step.
 *
 * Anti-bullshit rules:
 *   - Pricing only ever comes out of `applyRescorePatch` — the chat LLM
 *     reads the resulting RomInstrument verbatim. There is no other
 *     surface that can produce a dollar figure.
 *   - The phase machine is advance-only. Pushback creates a `challenged`
 *     edge but does NOT roll the state back to `scope_clear`.
 *   - Every category is an enum drawn from a typed source.
 */
import { createHash } from "crypto";
import type { TaggedFact } from "../../lexicons";
import { isTradeCategory, type TradeCategory } from "../../lexicons/trades";
import {
  ACCESS_VALUES,
  DWELLING_TYPE_VALUES,
  MATERIAL_TIER_VALUES,
  PREP_LEVEL_VALUES,
  QUANTITY_SIGNAL_VALUES,
  SURFACE_VALUES,
  WORK_TYPE_VALUES,
  type BuildingJobDimensionsCategory,
} from "../../lexicons/buildingJobDimensions";

// ═══════════════════════════════════════════════════════════════════════════
// STRUCTURE — typed dimensions
// ═══════════════════════════════════════════════════════════════════════════

/** Effort bands — coarse buckets the estimator's time/cost tables key on.
 *  `mega` added for genuinely large jobs (whole-house exterior repaints,
 *  full bathroom renos, full roofing replacements) where multi_day's
 *  $1500–$5500 ceiling would undercount significantly. */
export type EffortBand =
  | "quick"        // < 1 hour
  | "short"        // 1–2 hours
  | "quarter_day"  // 2–3 hours
  | "half_day"     // 3–5 hours
  | "full_day"     // 5–8 hours
  | "multi_day"    // 1–3 days
  | "mega"         // 3+ days / whole-house scale
  | "unknown";

export const EFFORT_BANDS: readonly EffortBand[] = [
  "quick",
  "short",
  "quarter_day",
  "half_day",
  "full_day",
  "multi_day",
  "mega",
] as const;

/** What the customer is asking for. */
export type WorkType = "repair" | "replace" | "install" | "inspect" | "unclear";

/** Coarse quantity class — bumps the band when high. */
export type QuantityClass = "single" | "small_batch" | "large_batch" | "unknown";

/** Access conditions — bumps the band when difficult. */
export type AccessClass =
  | "ground"
  | "ladder"
  | "scaffold"
  | "difficult"
  | "unknown";

/** Material tier — informs the materials note and per-unit pricing. */
export type MaterialClass = "standard" | "mid" | "premium" | "unknown";

/** SurfaceClass — interior vs exterior vs mixed. Used by painting +
 *  cleaning + fencing where the exterior multiplier is material (weather
 *  windows, scaffolding, prep differ markedly). Orthogonal to AccessClass
 *  — "exterior ground-level" and "exterior scaffold" are both exterior
 *  but have different access bumps. */
export type SurfaceClass = "interior" | "exterior" | "mixed" | "unknown";

/** PrepLevel — how much surface preparation the job requires. The big
 *  driver for painting, also relevant to tiling and plastering trades. */
export type PrepLevel =
  | "clean"           // no prep — paint over what's there
  | "scuff_sand"      // light sand + dust off
  | "fill_patch"      // fill screw holes / minor patches
  | "plaster_repair"  // significant plaster damage to repair
  | "strip_back"      // strip old paint / lead-paint protocols
  | "unknown";

/** DwellingType — informs access (apartments = no scaffolding, lift use,
 *  building access rules), waste removal logistics, and job timing. */
export type DwellingType =
  | "apartment"
  | "townhouse"
  | "house"
  | "commercial"
  | "unknown";

/** Confidence band on the emitted RomInstrument. */
export type RomConfidence = "first_pass" | "rough" | "tight";

// ═══════════════════════════════════════════════════════════════════════════
// STRUCTURE — pricing policy + Paskian multipliers
// ═══════════════════════════════════════════════════════════════════════════

/** PricingPolicy — Todd's commercial floor. No emitted RomInstrument may
 *  undercut it. Versioned so the patch chain records which policy was in
 *  force when any given instrument was produced. */
export interface PricingPolicy {
  /** Effective minimum hourly rate in AUD. A band's cost range will be
   *  widened upward if it implies an hourly rate below this floor. */
  minHourlyRate: number;
  /** Optional per-band absolute minimum cost. Overrides the band range
   *  when higher than the hourly-derived floor. */
  floorPerBand: Partial<Record<Exclude<EffortBand, "unknown">, number>>;
  /** Per-trade markup — multiplied into the final cost range. Default 1.0
   *  leaves the range untouched; >1 raises for trades Todd wants to
   *  favour profit on, <1 is rarely useful. */
  markupPerTrade: Partial<Record<TradeCategory, number>>;
  /** Semantic version for this policy. Bumped whenever Todd edits the
   *  floors — every instrument emitted after the bump records the new
   *  version number. */
  version: number;
}

/** Default policy — conservative. Min $85/hr effective, no per-trade
 *  markup, no hard floors per band. Callers overlay overrides on top. */
export const DEFAULT_PRICING_POLICY: PricingPolicy = {
  minHourlyRate: 85,
  floorPerBand: {},
  markupPerTrade: {},
  version: 1,
};

/** PricingMultipliers — what the Paskian learning loop feeds back into
 *  the estimator. Computed from the rolling average of
 *  `CompletedJobOutcome.actualCharge / originalInstrument.costMax` (and
 *  likewise for hours). Clamped to a sensible range so one outlier job
 *  can't warp the estimator. */
export interface PricingMultipliers {
  /** Multiply the band's cost range by this. Starts at 1.0 (no evidence). */
  costMultiplier: number;
  /** Multiply the band's hours range by this. Starts at 1.0. */
  hoursMultiplier: number;
  /** How many completed outcomes informed these multipliers. */
  sampleSize: number;
  /** Trade these multipliers apply to — null means "default / cross-trade". */
  trade: TradeCategory | null;
}

export const IDENTITY_MULTIPLIERS: PricingMultipliers = {
  costMultiplier: 1.0,
  hoursMultiplier: 1.0,
  sampleSize: 0,
  trade: null,
};

/** Clamp-range for a multiplier. Outcomes can push the estimator ±40%
 *  in either direction — beyond that, Todd's edit the band tables
 *  directly or the trade has drifted enough that re-catagorisation is
 *  the right move, not a silent multiplier creep. */
const MULTIPLIER_MIN = 0.6;
const MULTIPLIER_MAX = 1.4;

/** Phase of the estimator — advance-only state machine. */
export type EstimatePhase =
  | "unknown"        // nothing yet
  | "trade_known"    // jobType resolved; nothing else
  | "scope_partial"  // some scope text but no quantity / access
  | "scope_clear"    // scope rich enough to band-classify
  | "estimated"      // a RomInstrument has been emitted
  | "acknowledged"   // customer accepted the bracket
  | "reconciled";    // estimate locked, follow-up booked

const PHASE_ORDER: readonly EstimatePhase[] = [
  "unknown",
  "trade_known",
  "scope_partial",
  "scope_clear",
  "estimated",
  "acknowledged",
  "reconciled",
] as const;

/** Patch kinds drawn from `patchKindEnum` in schema.core. The estimator
 *  uses five of the seven; the other two are out of scope. */
export type EstimatorPatchKind =
  | "extraction"
  | "evidence_merge"
  | "rescore"
  | "instrument_emit"
  | "state_transition";

/** Anchor back to whatever drove the patch — message id + preview so the
 *  patch chain carries its own context. Use `anchorForMessage` to build
 *  from a raw customer message; use `EMPTY_ANCHOR` for system-triggered
 *  transitions (policy edits, scheduled refines) that don't originate
 *  from an utterance. */
export interface PatchAnchor {
  sourceMessageId: string | null;
  rawMessagePreview: string | null;
  sourceKind: "chat_turn" | "job_close" | "policy_edit" | "scheduled_refine" | "unknown";
}

export const EMPTY_ANCHOR: PatchAnchor = {
  sourceMessageId: null,
  rawMessagePreview: null,
  sourceKind: "unknown",
};

/** Max bytes of raw message to inline on each patch. Keeps the patch
 *  chain self-contained for debugging without ballooning JSONB rows. */
const RAW_MESSAGE_PREVIEW_MAX = 240;

/** Build a patch anchor from a customer message. `messageId` is the FK
 *  into `schema.messages.id`; the preview is the first 240 chars, which
 *  has been enough to diagnose every miss so far. */
export function anchorForMessage(
  messageId: string,
  rawMessage: string,
): PatchAnchor {
  return {
    sourceMessageId: messageId,
    rawMessagePreview:
      rawMessage.length > RAW_MESSAGE_PREVIEW_MAX
        ? `${rawMessage.slice(0, RAW_MESSAGE_PREVIEW_MAX)}…`
        : rawMessage,
    sourceKind: "chat_turn",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// STRUCTURE — deterministic tables keyed off TradeCategory
// ═══════════════════════════════════════════════════════════════════════════

/** Band → cost range and hours range. Source of every dollar figure.
 *  Updated 2026-04-24: lifted multi_day ceiling from $2500 → $5500 and
 *  added a `mega` band for genuinely whole-scale work. The prior
 *  $900–$2500 multi_day ceiling produced a $6k painting job as $900–$2500
 *  (3x–6x undercall) because there was no band above it. */
export const BAND_RANGES: Record<
  Exclude<EffortBand, "unknown">,
  { costMin: number; costMax: number; hoursMin: number; hoursMax: number }
> = {
  quick:       { costMin: 80,   costMax: 150,   hoursMin: 0.5, hoursMax: 1 },
  short:       { costMin: 150,  costMax: 280,   hoursMin: 1,   hoursMax: 2 },
  quarter_day: { costMin: 250,  costMax: 400,   hoursMin: 2,   hoursMax: 3 },
  half_day:    { costMin: 350,  costMax: 600,   hoursMin: 3,   hoursMax: 5 },
  full_day:    { costMin: 550,  costMax: 900,   hoursMin: 5,   hoursMax: 8 },
  multi_day:   { costMin: 1500, costMax: 5500,  hoursMin: 12,  hoursMax: 28 },
  mega:        { costMin: 4500, costMax: 12000, hoursMin: 28,  hoursMax: 80 },
};

/** First-pass band per trade — used when scope is too thin to keyword-match
 *  but the trade is known. Wide range, "first_pass" confidence. */
export const FIRST_PASS_BAND: Record<TradeCategory, EffortBand> = {
  doors_windows: "full_day",
  carpentry:     "half_day",
  fencing:       "full_day",
  painting:      "full_day",
  plumbing:      "quarter_day",
  tiling:        "half_day",
  roofing:       "half_day",
  electrical:    "quarter_day",
  general:       "quarter_day",
  gardening:     "quarter_day",
  cleaning:      "quarter_day",
  other:         "half_day",
};

/** Per-unit all-in pricing for trades where "supplied & fitted" beats
 *  labour+materials separately. Empty entry means standard pricing applies. */
export const PER_UNIT_PRICES: Partial<
  Record<TradeCategory, { min: number; max: number; note: string }>
> = {
  doors_windows: {
    min: 300,
    max: 400,
    note:
      "Standard interior hollow-core doors supplied and fitted. Solid or custom doors cost more. Painting extra if needed.",
  },
};

/** Materials hint per trade — mid sentence, lower-cased on the trailing edge. */
export const MATERIAL_HINTS: Record<TradeCategory, string> = {
  doors_windows: "Plus hardware if needed — handles, hinges, locks etc.",
  carpentry:     "Plus timber and hardware",
  fencing:       "Plus materials: posts ($30–50 each), concrete, rails, palings — roughly $50–80 per metre for standard timber",
  painting:      "Plus paint and prep materials — roughly $50–100 per room",
  plumbing:      "Plus parts and fittings",
  tiling:        "Plus tiles, adhesive, and grout",
  roofing:       "Plus tiles/sheets and flashing",
  electrical:    "Plus fittings and cable",
  general:       "Plus any materials needed",
  gardening:     "Plus plants, mulch, or soil if needed",
  cleaning:      "Cleaning products included",
  other:         "Plus any materials needed",
};

/** Keyword → band rules, keyed off the trade. The rule with the highest
 *  band wins when multiple keywords match. */
export const KEYWORD_RULES: Record<TradeCategory, ReadonlyArray<{ band: EffortBand; keywords: readonly string[] }>> = {
  doors_windows: [
    { band: "short",       keywords: ["adjust", "lock", "handle", "latch", "hinge", "window sash", "window adjust", "window repair", "window not close", "sticky window"] },
    { band: "quarter_day", keywords: ["window replace", "single window", "one window"] },
    { band: "half_day",    keywords: ["1 door", "single door", "one door", "dog door", "pet door", "2 window", "two window"] },
    { band: "full_day",    keywords: ["2 door", "two door", "3 door", "three door", "frame", "mortise", "hung", "paint", "3 window", "three window", "sliding window"] },
    { band: "multi_day",   keywords: ["4 door", "four door", "5 door", "five door", "multiple door", "all door", "4 window", "four window", "5 window", "whole house", "renovation", "custom"] },
  ],
  carpentry: [
    { band: "short",       keywords: ["shelf", "bracket", "small repair"] },
    { band: "quarter_day", keywords: ["shelving", "patch", "board", "minor"] },
    { band: "half_day",    keywords: ["deck repair", "railing", "balustrade", "stair", "cabinet"] },
    { band: "full_day",    keywords: ["deck", "cupboard", "kitchen", "install"] },
    { band: "multi_day",   keywords: ["pergola", "carport", "build deck", "new deck", "renovation", "extension", "full kitchen"] },
  ],
  fencing: [
    { band: "quarter_day", keywords: ["gate", "latch", "repair"] },
    { band: "half_day",    keywords: ["1 post", "single post", "panel", "3m", "4m"] },
    { band: "full_day",    keywords: ["section", "5m", "6m", "few metres", "side fence", "boundary", "fallen", "storm", "blown"] },
    { band: "multi_day",   keywords: ["10m", "15m", "20m", "30m", "full fence", "whole yard", "perimeter", "replace post", "dig out", "new post"] },
  ],
  painting: [
    { band: "short",       keywords: ["touch up", "patch", "small area"] },
    { band: "quarter_day", keywords: ["1 room", "one room", "single room", "feature wall"] },
    { band: "half_day",    keywords: ["2 room", "two room", "bathroom", "laundry"] },
    { band: "full_day",    keywords: ["3 room", "three room", "4 room"] },
    { band: "multi_day",   keywords: ["5 room", "five room", "all interior", "full interior", "whole interior"] },
    { band: "mega",        keywords: ["whole house", "all rooms", "entire house", "full house", "full exterior", "whole exterior", "house exterior", "repaint house", "house repaint", "exterior repaint", "repaint the house"] },
  ],
  plumbing: [
    { band: "quick",       keywords: ["washer", "drip", "aerator"] },
    { band: "short",       keywords: ["tap", "faucet", "toilet seat", "unblock", "drain"] },
    { band: "quarter_day", keywords: ["toilet", "cistern", "mixer", "shower head"] },
    { band: "half_day",    keywords: ["hot water", "pipe", "vanity", "basin"] },
    { band: "full_day",    keywords: ["bathroom", "kitchen plumbing", "reroute"] },
  ],
  tiling: [
    { band: "quarter_day", keywords: ["repair", "replace tile", "crack", "grout"] },
    { band: "half_day",    keywords: ["splash back", "splashback", "small area"] },
    { band: "full_day",    keywords: ["bathroom floor", "laundry", "shower"] },
    { band: "multi_day",   keywords: ["full bathroom", "kitchen floor", "outdoor"] },
  ],
  roofing: [
    { band: "quarter_day", keywords: ["leak", "single tile", "ridge cap"] },
    { band: "half_day",    keywords: ["flashing", "few tiles", "gutter", "valley"] },
    { band: "full_day",    keywords: ["section", "roof repair", "whirlybird"] },
    { band: "multi_day",   keywords: ["re-roof", "full roof", "roof replacement"] },
  ],
  electrical: [
    { band: "quick",       keywords: ["light globe", "bulb"] },
    { band: "short",       keywords: ["power point", "switch", "dimmer"] },
    { band: "quarter_day", keywords: ["light fitting", "fan", "downlight"] },
    { band: "half_day",    keywords: ["circuit", "safety switch", "multiple light"] },
    { band: "full_day",    keywords: ["rewire", "switchboard", "full house"] },
  ],
  general: [
    { band: "quick",       keywords: ["hang", "picture", "curtain rod", "towel rail", "hook", "mirror small"] },
    { band: "short",       keywords: ["mount tv", "tv mount", "tv wall", "tv on the wall", "shelf bracket", "single flatpack", "small flatpack", "hang mirror", "heavy mirror"] },
    { band: "quarter_day", keywords: ["assemble", "flatpack", "ikea", "wardrobe assembly", "bedside", "small wardrobe", "small built-in", "letterbox", "clothesline"] },
    { band: "half_day",    keywords: ["wardrobe", "tallboy", "bookshelf", "desk", "bed frame", "odd jobs", "few things", "handyman list", "bits n bobs"] },
    { band: "full_day",    keywords: ["large wardrobe", "walk-in", "built-in wardrobe", "kitchen flatpack", "several", "multiple", "list of"] },
    { band: "multi_day",   keywords: ["full day", "big list", "many jobs", "whole house assembly", "whole apartment"] },
  ],
  gardening: [
    { band: "short",       keywords: ["mow", "edge", "small garden"] },
    { band: "quarter_day", keywords: ["hedge", "prune", "weed"] },
    { band: "half_day",    keywords: ["garden bed", "mulch", "clean up"] },
    { band: "full_day",    keywords: ["landscaping", "retaining wall", "full yard"] },
  ],
  cleaning: [
    { band: "short",       keywords: ["small clean", "window", "pressure wash small"] },
    { band: "quarter_day", keywords: ["pressure wash", "driveway"] },
    { band: "half_day",    keywords: ["house wash", "roof clean", "gutter clean"] },
    { band: "full_day",    keywords: ["full property", "end of lease"] },
  ],
  other: [],
};

// ═══════════════════════════════════════════════════════════════════════════
// STRUCTURE — payload shapes (semantic-object state + emitted instrument)
// ═══════════════════════════════════════════════════════════════════════════

/** EstimatorState — the typed payload of the estimator semantic object.
 *  Lives under a `sem_objects.payload` row keyed by the OJT job. */
export interface EstimatorState {
  trade: TradeCategory | null;
  workType: WorkType;
  quantity: QuantityClass;
  access: AccessClass;
  material: MaterialClass;
  /** Interior / exterior / mixed. Drives a painting bump (exterior ≈ 1
   *  band-step) and will drive cleaning / fencing bumps as those learn. */
  surface: SurfaceClass;
  /** How much prep work the job needs. Big painting cost driver. */
  prepLevel: PrepLevel;
  /** Apartment / house / etc — drives waste removal + access logistics. */
  dwellingType: DwellingType;
  /** Specific room / unit count when the customer states one (e.g. 8 for
   *  "2 bed, 2 bath, wc, laundry, hallway, living, kitchen"). null when
   *  unknown — coarse `quantity` enum still applies as a fallback. */
  roomCount: number | null;
  /** Free-text scope used for keyword inference. Built from the merged
   *  TaggedFacts plus the customer's raw scope description. */
  scopeText: string;
  /** Append-only log of facts that informed the current state. */
  evidence: TaggedFact[];
  /** Phase of the state machine. Advance-only. */
  phase: EstimatePhase;
  /** The most recently emitted instrument (null until phase ≥ estimated). */
  lastInstrument: RomInstrument | null;
  /** Append-only log of pushback events against the active instrument. */
  challenges: ReadonlyArray<{
    at: string;        // ISO timestamp
    note: string;      // canonical pushback line
    instrumentRef: string | null;
  }>;
  /** How many times the ROM has been re-emitted after phase first reached
   *  `estimated`. Starts at 0. Increments on each genuine amendment —
   *  i.e. when scope changes enough to produce a materially different
   *  ROM after the customer's already seen one. The next instrument's
   *  `revision` is `amendmentCount + 1`. */
  amendmentCount: number;
  /** Monotonically-increasing version number — used for the version chain. */
  version: number;
}

/** Initial empty state. */
export function emptyEstimatorState(): EstimatorState {
  return {
    trade: null,
    workType: "unclear",
    quantity: "unknown",
    access: "unknown",
    material: "unknown",
    surface: "unknown",
    prepLevel: "unknown",
    dwellingType: "unknown",
    roomCount: null,
    scopeText: "",
    evidence: [],
    phase: "unknown",
    lastInstrument: null,
    challenges: [],
    amendmentCount: 0,
    version: 0,
  };
}

/** RomInstrument — what the chat layer is allowed to relay verbatim.
 *  Header-shaped so cellPacker can serialise it into a 1 KB cell:
 *    trade (5 bytes) | band (1 byte) | costMin/Max (4 each) |
 *    hoursMin/Max (2 each) | confidence (1 byte) | reserved (rest)
 *  The TaggedFacts that justified it land in the 768-byte payload region. */
export interface RomInstrument {
  /** Stable id — the chat layer references it on pushback. */
  id: string;
  /** Trade this estimate belongs to. */
  trade: TradeCategory;
  band: EffortBand;
  costMin: number;
  costMax: number;
  hoursMin: number;
  hoursMax: number;
  /** True when materials are billed separately. False when all-in. */
  labourOnly: boolean;
  materialsNote: string | null;
  confidence: RomConfidence;
  /** Human-readable attribution — which rule fired ("matched 'wardrobe' →
   *  half_day", "first-pass bracket: general"). */
  reason: string;
  /** TaggedFacts that justified this estimate, for the cell payload. */
  evidenceRefs: ReadonlyArray<TaggedFact>;
  /** When this instrument was emitted — ISO timestamp. */
  emittedAt: string;
  /** ID of the previous RomInstrument this one supersedes, or null when
   *  this is the first ROM for the job. Supersession is how amendments
   *  work: the old instrument moves to `sem_instruments.status = superseded`,
   *  the new one takes over. The full chain is reconstructible by walking
   *  `supersedes` links backwards. */
  supersedes: string | null;
  /** Monotonically-increasing revision number. 1 for the first ROM on a
   *  job, 2 for the first amendment, etc. Matches EstimatorState.amendmentCount + 1. */
  revision: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// PROCESS — typed patches (one record per applied transition)
// ═══════════════════════════════════════════════════════════════════════════

/** Common header on every patch record — drops into `sem_object_patches`.
 *  Every patch carries its own anchor back to the driving message so the
 *  chain is self-contained: you should never need a cross-table join to
 *  see what the customer actually said at the moment a state changed.
 *
 *  - `sourceMessageId`: FK into `schema.messages.id`. Null when the patch
 *    was triggered by something other than a customer utterance (policy
 *    edit, scheduled refine, outcome close).
 *  - `rawMessagePreview`: first ~240 chars of the customer's raw message,
 *    inline. Redundant with `sem_evidence_items.content` but carried on
 *    the patch so a reader can eyeball the trigger without joining.
 *  - `sourceKind`: what kind of thing drove the patch. "chat_turn" for
 *    customer messages, "job_close" for outcome recording, "policy_edit"
 *    for Todd editing the policy, etc.
 */
export interface BasePatch {
  kind: EstimatorPatchKind;
  prevStateHash: string;
  newStateHash: string;
  fromVersion: number;
  toVersion: number;
  sourceMessageId: string | null;
  rawMessagePreview: string | null;
  sourceKind: "chat_turn" | "job_close" | "policy_edit" | "scheduled_refine" | "unknown";
}

/** Extraction patch — LLM emitted facts. Pure pass-through; doesn't mutate
 *  the state on its own (an evidence_merge follows). Carrying the raw facts
 *  separately makes the chain auditable: which extraction → which merge. */
export interface ExtractionPatch extends BasePatch {
  kind: "extraction";
  delta: { facts: TaggedFact[]; rawMessage: string };
}

/** Evidence merge — facts are folded into the EstimatorState. */
export interface EvidenceMergePatch extends BasePatch {
  kind: "evidence_merge";
  delta: {
    accepted: TaggedFact[];
    rejected: TaggedFact[];
    diff: Record<string, { from: unknown; to: unknown }>;
  };
}

/** Rescore — the deterministic estimator runs against the merged state.
 *  The new RomInstrument is referenced here; its `instrument_emit` patch
 *  follows on the same turn. The delta carries the full arithmetic trace
 *  so the chain is replayable from band→bumps→multipliers→clamp. */
export interface RescorePatch extends BasePatch {
  kind: "rescore";
  delta: {
    band: EffortBand;
    bandSource: "keyword_match" | "first_pass" | "unknown";
    bumpsApplied: ReadonlyArray<{ kind: "quantity" | "access" | "cure" | "surface" | "prep" | "dwelling"; steps: number }>;
    instrumentId: string;
    /** Paskian stage: pre-multiplier → post-multiplier cost/hours range. */
    multipliers: {
      costMultiplier: number;
      hoursMultiplier: number;
      sampleSize: number;
      preCostMin: number;
      preCostMax: number;
      preHoursMin: number;
      preHoursMax: number;
    };
    /** Policy clamp stage: pre-clamp range + whether a clamp fired. */
    clamp: {
      policyVersion: number;
      preCostMin: number;
      preCostMax: number;
      clamped: boolean;
      clampedBy: string | null;
    };
    /** Amendment metadata — null when this is the first ROM for the job
     *  or when the rescore produced the same ROM as before. Non-null when
     *  the new ROM materially supersedes the prior one (band changed or
     *  >20% midpoint shift). Gives readers of the patch chain an explicit
     *  "this was an amendment" signal without scanning prior instruments. */
    amendment: {
      isAmendment: boolean;
      supersededInstrumentId: string | null;
      priorCostMin: number | null;
      priorCostMax: number | null;
      priorBand: EffortBand | null;
      revision: number;
    };
  };
}

/** Instrument emission — publishes a RomInstrument for the chat layer to
 *  relay. Carries the full instrument payload so the cell packer has
 *  everything it needs in one record. */
export interface InstrumentEmitPatch extends BasePatch {
  kind: "instrument_emit";
  delta: { instrument: RomInstrument };
}

/** Phase advance — never regresses. The from/to phases are recorded so
 *  the audit trail shows how the conversation moved. */
export interface StateTransitionPatch extends BasePatch {
  kind: "state_transition";
  delta: { fromPhase: EstimatePhase; toPhase: EstimatePhase; reason: string };
}

export type EstimatorPatch =
  | ExtractionPatch
  | EvidenceMergePatch
  | RescorePatch
  | InstrumentEmitPatch
  | StateTransitionPatch;

// ═══════════════════════════════════════════════════════════════════════════
// PERSISTENCE — version chain
// ═══════════════════════════════════════════════════════════════════════════

/** Stable, deterministic SHA256 over a sorted JSON projection of the state.
 *  Drops directly into `sem_object_patches.prevStateHash / newStateHash`. */
export function hashEstimatorState(state: EstimatorState): string {
  const projection = Object.keys(state)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = (state as unknown as Record<string, unknown>)[key];
      return acc;
    }, {});
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}

// ═══════════════════════════════════════════════════════════════════════════
// PROCESS — pure transition functions
// ═══════════════════════════════════════════════════════════════════════════

/** Extraction: record what the LLM produced. State is unchanged; the
 *  follow-up `applyEvidenceMerge` does the real work. */
export function applyExtractionPatch(
  state: EstimatorState,
  rawMessage: string,
  facts: TaggedFact[],
  anchor: PatchAnchor,
): { state: EstimatorState; patch: ExtractionPatch } {
  const prevHash = hashEstimatorState(state);
  // Extraction is a no-op on state by design — the merge step decides
  // what's accepted. This split lets the audit chain show "the LLM
  // produced X" separately from "we accepted Y of those".
  return {
    state,
    patch: {
      kind: "extraction",
      prevStateHash: prevHash,
      newStateHash: prevHash,
      fromVersion: state.version,
      toVersion: state.version,
      sourceMessageId: anchor.sourceMessageId,
      rawMessagePreview: anchor.rawMessagePreview,
      sourceKind: anchor.sourceKind,
      delta: { facts, rawMessage },
    },
  };
}

/** Evidence merge: fold accepted facts into the EstimatorState.
 *  Acceptance rule: lexicon === "trades" with a known TradeCategory and
 *  confidence ≥ 0.6. Other lexicons are recorded as evidence (audit trail)
 *  but don't drive the trade/workType/etc fields. */
export function applyEvidenceMergePatch(
  state: EstimatorState,
  facts: TaggedFact[],
  rawMessage: string,
  anchor: PatchAnchor,
): { state: EstimatorState; patch: EvidenceMergePatch } {
  const prevHash = hashEstimatorState(state);
  const accepted: TaggedFact[] = [];
  const rejected: TaggedFact[] = [];
  let next: EstimatorState = {
    ...state,
    evidence: [...state.evidence, ...facts],
    scopeText: appendScope(state.scopeText, rawMessage),
  };
  const diff: Record<string, { from: unknown; to: unknown }> = {};

  for (const fact of facts) {
    if (fact.confidence < 0.6) {
      rejected.push(fact);
      continue;
    }
    if (fact.lexicon === "trades" && fact.category && isTradeCategory(fact.category)) {
      if (next.trade !== fact.category) {
        diff.trade = { from: next.trade, to: fact.category };
        next = { ...next, trade: fact.category };
      }
      accepted.push(fact);
      continue;
    }
    if (fact.lexicon === "building-job-dimensions" && fact.category) {
      const update = parseDimensionFact(fact.category, fact.fact, next);
      if (update) {
        for (const [slot, value] of Object.entries(update)) {
          const current = (next as unknown as Record<string, unknown>)[slot];
          if (current !== value) {
            diff[slot] = { from: current, to: value };
            next = { ...next, [slot]: value };
          }
        }
        accepted.push(fact);
        continue;
      }
      rejected.push(fact); // unknown value for known dimension category
      continue;
    }
    accepted.push(fact); // accepted as evidence even if not driving a field
  }

  // Detect SurfaceClass from the rolling scopeText. Cheap keyword scan —
  // the LLM could tag this explicitly in a future extractor update but
  // this is good enough to prevent full-house exteriors from being
  // priced as 4 interior rooms.
  const detectedSurface = detectSurface(next.scopeText);
  if (detectedSurface !== next.surface) {
    diff.surface = { from: next.surface, to: detectedSurface };
    next = { ...next, surface: detectedSurface };
  }

  // Phase may advance as a result of the merge (no regress).
  const advanced = advancePhaseAfterMerge(next);
  if (advanced !== next.phase) {
    diff.phase = { from: next.phase, to: advanced };
    next = { ...next, phase: advanced };
  }

  next = { ...next, version: state.version + 1 };
  const newHash = hashEstimatorState(next);

  return {
    state: next,
    patch: {
      kind: "evidence_merge",
      prevStateHash: prevHash,
      newStateHash: newHash,
      fromVersion: state.version,
      toVersion: next.version,
      sourceMessageId: anchor.sourceMessageId,
      rawMessagePreview: anchor.rawMessagePreview,
      sourceKind: anchor.sourceKind,
      delta: { accepted, rejected, diff },
    },
  };
}

/** Rescore: deterministic estimator. Pure function of (state, policy,
 *  multipliers) → instrument. Returns both the rescore patch and the
 *  instrument_emit patch — the chat layer publishes them as a pair on
 *  each turn that actually rescores.
 *
 *  Pipeline (ordered): keyword/first-pass band → bumps → per-unit override
 *  → Paskian multipliers → policy floor clamp → emit. Every step is
 *  recorded in the rescore patch's delta so the full arithmetic is
 *  reproducible from the chain.
 *
 *  `policy` and `multipliers` default to identity (no effect) so existing
 *  callers don't need to plumb them through immediately. */
export function applyRescorePatch(
  state: EstimatorState,
  policy: PricingPolicy = DEFAULT_PRICING_POLICY,
  multipliers: PricingMultipliers = IDENTITY_MULTIPLIERS,
  anchor: PatchAnchor = EMPTY_ANCHOR,
): {
  state: EstimatorState;
  patch: RescorePatch;
  emit: InstrumentEmitPatch;
  instrument: RomInstrument;
} | null {
  if (!state.trade) return null;

  const prevHash = hashEstimatorState(state);
  const inferred = inferEffortBand(state);
  const bumps = computeBumps(state, inferred.searchText);
  const final = bumpBand(inferred.band, bumps.total);

  const range = BAND_RANGES[final as Exclude<EffortBand, "unknown">];
  if (!range) return null;

  const trade = state.trade;
  const perUnit = PER_UNIT_PRICES[trade];
  let costMin = range.costMin;
  let costMax = range.costMax;
  let hoursMin = range.hoursMin;
  let hoursMax = range.hoursMax;
  let labourOnly = trade !== "cleaning";
  let materialsNote: string | null = MATERIAL_HINTS[trade];

  // First-pass confidence widens the range to telegraph "this will
  // tighten as scope clarifies" — but ONLY on the tight-range bands
  // (quick / short / quarter_day / half_day / full_day). Multi-day and
  // mega are already wide by definition ($1500–$5500 and $4500–$12000)
  // so further widening pushes them into nonsense territory. On those
  // bands we keep the raw range and only mark the confidence class.
  let confidence: RomConfidence = "rough";
  if (inferred.source === "first_pass") {
    confidence = "first_pass";
    if (final !== "multi_day" && final !== "mega") {
      costMin = Math.round(costMin * 0.85);
      costMax = Math.round(costMax * 1.3);
    }
  } else if (state.quantity !== "unknown" && state.access !== "unknown") {
    confidence = "tight";
  }

  // Per-unit override for trades like doors_windows. When this fires,
  // per-unit pricing is authoritative — the policy clamp's hours-based
  // floor has to use hours DERIVED from the per-unit cost, not the
  // band's hours (which are for the generic band range, not this job's
  // actual scale). Otherwise the clamp inflates per-unit jobs back up
  // to the band's floor (e.g. "two doors at $300 each = $600" being
  // clamped to $85/hr × band_hoursMin = $1020).
  if (perUnit && state.quantity !== "unknown") {
    const qty = parseUnitCount(state);
    if (qty > 0) {
      costMin = qty * perUnit.min;
      costMax = qty * perUnit.max;
      labourOnly = false;
      materialsNote = perUnit.note;
      // Derive implied hours from the per-unit cost at the policy floor
      // so the clamp is a no-op on the per-unit price. 1h minimum
      // prevents degenerate zero-hours bands.
      hoursMin = Math.max(1, Math.round(costMin / policy.minHourlyRate));
      hoursMax = Math.max(
        hoursMin + 1,
        Math.round((costMax / policy.minHourlyRate) * 1.2),
      );
    }
  }

  // Paskian layer: apply rolling multipliers from completed-job outcomes.
  // If Todd's actually been charging 15% more than the estimator predicted
  // for fencing jobs, multiplier for fencing ends up at ~1.15 and future
  // estimates widen accordingly. The raw pre-multiplier numbers are
  // preserved in the patch delta for audit.
  const preMultCostMin = costMin;
  const preMultCostMax = costMax;
  const preMultHoursMin = hoursMin;
  const preMultHoursMax = hoursMax;
  costMin = Math.round(costMin * multipliers.costMultiplier);
  costMax = Math.round(costMax * multipliers.costMultiplier);
  hoursMin = Math.round(hoursMin * multipliers.hoursMultiplier * 10) / 10;
  hoursMax = Math.round(hoursMax * multipliers.hoursMultiplier * 10) / 10;

  // Policy clamp: never emit a cost range whose implied hourly rate falls
  // below Todd's floor, never emit below any per-band absolute floor, and
  // apply per-trade markup last. Clamp is AFTER multipliers — policy is
  // the ground truth, learning is an adjustment up to it.
  const preClampCostMin = costMin;
  const preClampCostMax = costMax;
  const clamp = applyPolicyClamp(
    { costMin, costMax, hoursMin, hoursMax },
    final,
    trade,
    policy,
  );
  costMin = clamp.costMin;
  costMax = clamp.costMax;

  // Amendment detection — if we've already emitted a ROM for this job AND
  // the new ROM would land differently enough to matter (different band,
  // or >20% change in midpoint cost), treat this turn as an amendment.
  // Otherwise it's a no-op rescore that happens to produce the same
  // instrument (common case: customer fills in a detail that doesn't
  // move the band).
  const prior = state.lastInstrument;
  const priorMid = prior ? (prior.costMin + prior.costMax) / 2 : null;
  const newMid = (costMin + costMax) / 2;
  const materialDifference =
    prior !== null &&
    (prior.band !== final ||
      (priorMid !== null && Math.abs(newMid - priorMid) / Math.max(priorMid, 1) > 0.20));
  const isAmendment = prior !== null && materialDifference;
  const revision = isAmendment
    ? state.amendmentCount + 2 // prior was revision (amendmentCount + 1); this is +1 again
    : prior !== null
      ? prior.revision // same ROM — reuse the prior revision number
      : 1; // first-ever ROM on this job

  const instrument: RomInstrument = {
    id: `rom:${state.version + 1}:${Date.now()}`,
    trade,
    band: final,
    costMin,
    costMax,
    hoursMin,
    hoursMax,
    labourOnly,
    materialsNote,
    confidence,
    reason: inferred.reason + (bumps.total > 0 ? ` (+${bumps.total} bumps)` : "")
      + (multipliers.sampleSize > 0 ? ` [paskian ×${multipliers.costMultiplier.toFixed(2)} over n=${multipliers.sampleSize}]` : "")
      + (clamp.clamped ? ` [policy-clamped by ${clamp.clampedBy}]` : "")
      + (isAmendment ? ` [amendment r${revision} superseding ${prior!.id}]` : ""),
    evidenceRefs: state.evidence,
    emittedAt: new Date().toISOString(),
    supersedes: isAmendment ? prior!.id : null,
    revision,
  };

  const rescored: EstimatorState = {
    ...state,
    lastInstrument: instrument,
    phase: "estimated",
    amendmentCount: isAmendment ? state.amendmentCount + 1 : state.amendmentCount,
    version: state.version + 1,
  };
  const newHash = hashEstimatorState(rescored);

  const baseHeader = {
    prevStateHash: prevHash,
    newStateHash: newHash,
    fromVersion: state.version,
    toVersion: rescored.version,
    sourceMessageId: anchor.sourceMessageId,
    rawMessagePreview: anchor.rawMessagePreview,
    sourceKind: anchor.sourceKind,
  };

  return {
    state: rescored,
    patch: {
      kind: "rescore",
      ...baseHeader,
      delta: {
        band: final,
        bandSource: inferred.source,
        bumpsApplied: bumps.applied,
        instrumentId: instrument.id,
        multipliers: {
          costMultiplier: multipliers.costMultiplier,
          hoursMultiplier: multipliers.hoursMultiplier,
          sampleSize: multipliers.sampleSize,
          preCostMin: preMultCostMin,
          preCostMax: preMultCostMax,
          preHoursMin: preMultHoursMin,
          preHoursMax: preMultHoursMax,
        },
        clamp: {
          policyVersion: policy.version,
          preCostMin: preClampCostMin,
          preCostMax: preClampCostMax,
          clamped: clamp.clamped,
          clampedBy: clamp.clampedBy,
        },
        amendment: {
          isAmendment,
          supersededInstrumentId: isAmendment ? prior!.id : null,
          priorCostMin: prior?.costMin ?? null,
          priorCostMax: prior?.costMax ?? null,
          priorBand: prior?.band ?? null,
          revision,
        },
      },
    },
    emit: {
      kind: "instrument_emit",
      ...baseHeader,
      delta: { instrument },
    },
    instrument,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PROCESS — policy clamp (min hourly, per-band floor, per-trade markup)
// ═══════════════════════════════════════════════════════════════════════════

/** Apply Todd's pricing policy as a floor on the emitted range. The clamp
 *  is idempotent — calling it on an already-clamped range is a no-op.
 *
 *  Hourly-floor invariant: `costMin ≥ minHourlyRate × hoursMin`. Using
 *  hoursMin (not hoursMax) is the right basis — the invariant is "even
 *  on the fastest possible version of this job, we still clear the floor
 *  per hour worked". Using hoursMax would say "even if it drags to the
 *  worst case, the minimum cost still covers the worst case" — which
 *  inflates every wide-ranged band to absurdity (multi_day hoursMax=28,
 *  $85×28=$2380 min cost for what might be a 12-hour job). */
function applyPolicyClamp(
  range: { costMin: number; costMax: number; hoursMin: number; hoursMax: number },
  band: EffortBand,
  trade: TradeCategory,
  policy: PricingPolicy,
): { costMin: number; costMax: number; clamped: boolean; clampedBy: string | null } {
  let costMin = range.costMin;
  let costMax = range.costMax;
  const clampReasons: string[] = [];

  // (1) Minimum hourly rate — the range's implied low end must pay at or
  //     above `policy.minHourlyRate × hoursMin`. The invariant is "on
  //     the fastest plausible version of this job, we still clear the
  //     floor per hour worked" — not "even if it drags to the worst
  //     case, we've charged for the worst case", which would inflate
  //     every wide-ranged band.
  const hoursForMinClamp = range.hoursMin;
  const hourlyFloor = policy.minHourlyRate * hoursForMinClamp;
  if (costMin < hourlyFloor) {
    costMin = Math.round(hourlyFloor);
    clampReasons.push(`min-hourly($${policy.minHourlyRate}/hr × ${hoursForMinClamp}h)`);
  }
  // `costMax < hourlyFloor` is effectively impossible once costMin ≥ floor,
  // but we keep a defensive widen for degenerate band tables.
  if (costMax < costMin) {
    costMax = Math.round(costMin * 1.3);
    clampReasons.push("max-widen-to-preserve-range");
  }

  // (2) Per-band absolute floor.
  const bandFloor = band !== "unknown" ? policy.floorPerBand[band] : undefined;
  if (bandFloor !== undefined && costMin < bandFloor) {
    costMin = bandFloor;
    clampReasons.push(`floor-per-band(${band}:$${bandFloor})`);
  }

  // (3) Per-trade markup — applied last so the floors are the true floors.
  const markup = policy.markupPerTrade[trade];
  if (markup !== undefined && markup !== 1.0) {
    costMin = Math.round(costMin * markup);
    costMax = Math.round(costMax * markup);
    clampReasons.push(`markup-per-trade(${trade}:×${markup})`);
  }

  return {
    costMin,
    costMax,
    clamped: clampReasons.length > 0,
    clampedBy: clampReasons.length > 0 ? clampReasons.join(", ") : null,
  };
}

/** Phase advance — explicit, advance-only. Reason is recorded for the
 *  audit chain. Returns null when no transition is legal. */
export function applyStateTransitionPatch(
  state: EstimatorState,
  toPhase: EstimatePhase,
  reason: string,
  anchor: PatchAnchor = EMPTY_ANCHOR,
): { state: EstimatorState; patch: StateTransitionPatch } | null {
  const fromIdx = PHASE_ORDER.indexOf(state.phase);
  const toIdx = PHASE_ORDER.indexOf(toPhase);
  if (toIdx <= fromIdx) return null; // advance-only invariant

  const prevHash = hashEstimatorState(state);
  const next: EstimatorState = {
    ...state,
    phase: toPhase,
    version: state.version + 1,
  };
  const newHash = hashEstimatorState(next);

  return {
    state: next,
    patch: {
      kind: "state_transition",
      prevStateHash: prevHash,
      newStateHash: newHash,
      fromVersion: state.version,
      toVersion: next.version,
      sourceMessageId: anchor.sourceMessageId,
      rawMessagePreview: anchor.rawMessagePreview,
      sourceKind: anchor.sourceKind,
      delta: { fromPhase: state.phase, toPhase, reason },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PROCESS — internal helpers (pure, no I/O)
// ═══════════════════════════════════════════════════════════════════════════

function appendScope(prev: string, latest: string): string {
  // Keep the rolling scope short — the keyword matcher only needs the most
  // recent few utterances. Cap at ~600 chars to avoid runaway growth.
  const joined = prev ? `${prev}\n${latest}` : latest;
  return joined.length > 600 ? joined.slice(-600) : joined;
}

/** Parse a building-job-dimensions fact into an EstimatorState slot
 *  update. The `fact` field is expected to be one of the controlled-
 *  vocabulary tokens for that category (e.g. "interior" for surface).
 *  Returns null when the value isn't recognised — the caller then
 *  treats the fact as rejected.
 *
 *  room_count is the exception: it expects an integer-string in `fact`
 *  (e.g. "8" or "12"). Invalid integers return null.
 *
 *  The parser is deliberately strict: the LLM's job is to normalise the
 *  customer's words into the controlled vocab. If the LLM emits
 *  "hallway" for surface instead of "interior", we'd rather reject and
 *  let the validator re-prompt than accept a freeform value that
 *  silently bypasses the typed slot. */
function parseDimensionFact(
  category: string,
  value: string,
  state: EstimatorState,
): Partial<EstimatorState> | null {
  const token = value.trim().toLowerCase();
  switch (category as BuildingJobDimensionsCategory) {
    case "surface":
      return (SURFACE_VALUES as readonly string[]).includes(token)
        ? { surface: token as SurfaceClass }
        : null;
    case "prep_level":
      return (PREP_LEVEL_VALUES as readonly string[]).includes(token)
        ? { prepLevel: token as PrepLevel }
        : null;
    case "dwelling_type":
      return (DWELLING_TYPE_VALUES as readonly string[]).includes(token)
        ? { dwellingType: token as DwellingType }
        : null;
    case "access":
      return (ACCESS_VALUES as readonly string[]).includes(token)
        ? { access: token as AccessClass }
        : null;
    case "material_tier":
      return (MATERIAL_TIER_VALUES as readonly string[]).includes(token)
        ? { material: token as MaterialClass }
        : null;
    case "quantity_signal":
      return (QUANTITY_SIGNAL_VALUES as readonly string[]).includes(token)
        ? { quantity: token as QuantityClass }
        : null;
    case "work_type":
      return (WORK_TYPE_VALUES as readonly string[]).includes(token)
        ? { workType: token as WorkType }
        : null;
    case "room_count": {
      const n = parseInt(token, 10);
      if (!Number.isFinite(n) || n < 0) return null;
      // room_count also implies a coarse quantity bucket — set both so
      // the bumps fire even when quantity_signal wasn't tagged separately.
      const bucket: QuantityClass =
        n <= 1 ? "single" : n <= 3 ? "small_batch" : "large_batch";
      return { roomCount: n, quantity: state.quantity === "unknown" ? bucket : state.quantity };
    }
  }
  return null;
}

function advancePhaseAfterMerge(state: EstimatorState): EstimatePhase {
  // Don't regress. Pick the highest legal phase given the current state.
  const candidates: EstimatePhase[] = [];
  if (state.trade) candidates.push("trade_known");
  if (state.scopeText.length > 20) candidates.push("scope_partial");
  if (state.scopeText.length > 80 && state.quantity !== "unknown") {
    candidates.push("scope_clear");
  }
  const currentIdx = PHASE_ORDER.indexOf(state.phase);
  for (const c of candidates.reverse()) {
    const idx = PHASE_ORDER.indexOf(c);
    if (idx > currentIdx) return c;
  }
  return state.phase;
}

interface InferredBand {
  band: EffortBand;
  source: "keyword_match" | "first_pass" | "unknown";
  reason: string;
  searchText: string;
}

function inferEffortBand(state: EstimatorState): InferredBand {
  const searchText = state.scopeText.toLowerCase();
  if (!state.trade) {
    return { band: "unknown", source: "unknown", reason: "trade not known", searchText };
  }
  const rules = KEYWORD_RULES[state.trade];
  let matched: EffortBand = "unknown";
  let matchedKw = "";
  for (const rule of rules) {
    for (const kw of rule.keywords) {
      if (searchText.includes(kw)) {
        const idx = EFFORT_BANDS.indexOf(rule.band as Exclude<EffortBand, "unknown">);
        const cur = EFFORT_BANDS.indexOf(matched as Exclude<EffortBand, "unknown">);
        if (idx > cur) {
          matched = rule.band;
          matchedKw = kw;
        }
      }
    }
  }
  if (matched !== "unknown") {
    return {
      band: matched,
      source: "keyword_match",
      reason: `matched "${matchedKw}" → ${matched}`,
      searchText,
    };
  }
  // No keyword match — fall back to first-pass bracket (always defined for
  // a known trade).
  const fp = FIRST_PASS_BAND[state.trade];
  return {
    band: fp,
    source: "first_pass",
    reason: `first-pass bracket for ${state.trade}`,
    searchText,
  };
}

function computeBumps(
  state: EstimatorState,
  searchText: string,
): { applied: ReadonlyArray<{ kind: "quantity" | "access" | "cure" | "surface" | "prep" | "dwelling"; steps: number }>; total: number } {
  const applied: Array<{ kind: "quantity" | "access" | "cure" | "surface" | "prep" | "dwelling"; steps: number }> = [];

  // Quantity bumps: only `large_batch` bumps the band, and only by 1.
  // `small_batch` is a no-op because "a few of something" is close to
  // the typical job the first-pass bracket + trade keyword rules
  // already assume. `large_batch +1` (not +2) is enough: the keyword
  // rules already encode the rough quantity scaling per trade (e.g.
  // painting: 2 rooms = half_day, 5 rooms = multi_day, whole house =
  // mega). Bumping by 2 systematically pushed lists-of-small-items
  // (Mike's 4 flatpacks, Janine's 5-item list) into multi_day when
  // full_day is the honest band.
  if (state.quantity === "large_batch") applied.push({ kind: "quantity", steps: 1 });
  // Extra bump for very large room counts (>6). Picks up the "2 bed, 2
  // bath, wc, laundry, hallway, living, kitchen" case where quantity=
  // large_batch alone underselves it — 8-room whole-house paint deserves
  // the extra lift to mega.
  if (state.roomCount !== null && state.roomCount >= 7) {
    applied.push({ kind: "quantity", steps: 1 });
  }

  if (state.access === "ladder") applied.push({ kind: "access", steps: 1 });
  if (state.access === "scaffold") applied.push({ kind: "access", steps: 2 });
  if (state.access === "difficult") applied.push({ kind: "access", steps: 1 });

  // Surface bump — only applies to trades where exterior vs interior
  // materially changes effort. Painting exterior = prep + weather windows
  // + scaffolding ≈ 1 band step. Cleaning exterior similar (pressure wash
  // + safety). Fencing is by definition outdoor, no bump.
  if (state.surface === "exterior") {
    if (state.trade === "painting") applied.push({ kind: "surface", steps: 1 });
    if (state.trade === "cleaning") applied.push({ kind: "surface", steps: 1 });
  }

  // Prep-level bumps — painting-dominated but tiling + plastering matter too.
  // clean (no-op), scuff_sand (no-op), fill_patch (+1 painting),
  // plaster_repair (+1 painting + 1 cure-time), strip_back (+2 painting).
  if (state.trade === "painting") {
    if (state.prepLevel === "fill_patch") applied.push({ kind: "prep", steps: 1 });
    if (state.prepLevel === "plaster_repair") applied.push({ kind: "prep", steps: 1 });
    if (state.prepLevel === "strip_back") applied.push({ kind: "prep", steps: 2 });
  }
  if (state.trade === "tiling" && state.prepLevel === "strip_back") {
    applied.push({ kind: "prep", steps: 1 });
  }

  // Dwelling bumps — apartments + commercial add waste removal, lift use,
  // building access rules. Houses are the baseline (no bump).
  if (state.dwellingType === "apartment") applied.push({ kind: "dwelling", steps: 1 });
  if (state.dwellingType === "commercial") applied.push({ kind: "dwelling", steps: 1 });

  // Cure-time bumps — same rules the existing effortBandService used. Kept
  // here so the rescore is genuinely self-contained.
  const cure = cureTimeBump(state.trade, searchText);
  if (cure > 0) applied.push({ kind: "cure", steps: cure });

  const total = applied.reduce((acc, b) => acc + b.steps, 0);
  return { applied, total };
}

/** Detect surface class from accumulated scope text. Conservative —
 *  "exterior" beats "interior" when both appear (the job is at least
 *  partly exterior, which dominates the effort math), and "mixed"
 *  wins when both are present explicitly. */
function detectSurface(scopeText: string): SurfaceClass {
  const text = scopeText.toLowerCase();
  const hasExterior = /\b(exterior|outdoor|outside|outdoors|out the back|outdoor painting|outside of the|exterior of the|facade|eaves|fascia|weatherboards|cladding|render outside|repaint the house|house painting|house repaint)\b/.test(text);
  const hasInterior = /\b(interior|indoor|inside|indoors|living room|bedroom|bathroom|hallway|kitchen|lounge|dining|laundry|feature wall|skirting|architrave|ceiling)\b/.test(text);
  if (hasExterior && hasInterior) return "mixed";
  if (hasExterior) return "exterior";
  if (hasInterior) return "interior";
  return "unknown";
}

function cureTimeBump(trade: TradeCategory | null, text: string): number {
  if (trade === "painting" || /\bpaint|primer|undercoat|\bcoat|stain|lacquer|varnish/.test(text)) {
    if (/two coat|2 coat|three coat|3 coat|multiple coat|second coat/.test(text)) return 2;
    return 1;
  }
  if (/concret|cement|footing|post.?hole|\bpour/.test(text)) return 1;
  if (/plaster|render|skim.?coat|gyproc|cornic|patch.*wall|filler/.test(text)) return 1;
  if (trade === "tiling" || /\btil(e|ing)|grout|adhesive/.test(text)) {
    if (/grout|full.*til|bathroom|shower|floor/.test(text)) return 1;
  }
  if (trade === "fencing" && /new post|replace post|post.*concret|set.*post/.test(text)) return 1;
  if (/epoxy|resin|gap.?fill|silicon|sealant|bog/.test(text)) return 1;
  return 0;
}

function bumpBand(band: EffortBand, steps: number): EffortBand {
  if (band === "unknown" || steps === 0) return band;
  const idx = EFFORT_BANDS.indexOf(band as Exclude<EffortBand, "unknown">);
  if (idx === -1) return band;
  const newIdx = Math.min(idx + steps, EFFORT_BANDS.length - 1);
  return EFFORT_BANDS[newIdx];
}

function parseUnitCount(state: EstimatorState): number {
  // Prefer the typed slot when the LLM (or synthesiser) has populated it.
  if (state.roomCount !== null && state.roomCount > 0) return state.roomCount;

  // Fall back to scanning scope text. Digits first, then word-numbers
  // 1-10 which the boomer vocabulary leans on ("two doors", "three
  // windows"). Anything beyond 10 and they'll either write digits or
  // the LLM should normalise it into roomCount.
  const digitMatch = state.scopeText.match(/(\d+)/);
  if (digitMatch) return parseInt(digitMatch[1], 10);

  const WORD_NUMBERS: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    single: 1, couple: 2, pair: 2, few: 3,
  };
  const text = state.scopeText.toLowerCase();
  for (const [word, n] of Object.entries(WORD_NUMBERS)) {
    // Match as a whole word to avoid false positives like "one" in "gone".
    if (new RegExp(`\\b${word}\\b`).test(text)) return n;
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// PROCESS — turn-level orchestrator
// ═══════════════════════════════════════════════════════════════════════════

/** Drive the estimator through one chat turn. Returns the updated state
 *  plus every patch generated, in application order. Callers (chatService)
 *  persist the patches into `sem_object_patches` and render the final
 *  instrument through the chat LLM.
 *
 *  Patch order per turn (when all transitions fire):
 *    1. extraction           — what the LLM produced
 *    2. evidence_merge       — what we accepted
 *    3. rescore              — deterministic band + range
 *    4. instrument_emit      — publish the RomInstrument
 *    5. state_transition     — phase advance (if any)
 */
export function runEstimatorTurn(
  priorState: EstimatorState,
  facts: TaggedFact[],
  rawMessage: string,
  opts?: {
    policy?: PricingPolicy;
    multipliers?: PricingMultipliers;
    /** Anchor for every patch produced this turn. Callers should pass
     *  `anchorForMessage(messageId, rawMessage)` so the patch chain
     *  self-references the driving utterance. Defaults to an unknown-
     *  source anchor for backward compat. */
    anchor?: PatchAnchor;
  },
): { state: EstimatorState; patches: EstimatorPatch[]; instrument: RomInstrument | null } {
  const patches: EstimatorPatch[] = [];
  const policy = opts?.policy ?? DEFAULT_PRICING_POLICY;
  const multipliers = opts?.multipliers ?? IDENTITY_MULTIPLIERS;
  const anchor = opts?.anchor ?? EMPTY_ANCHOR;

  const extraction = applyExtractionPatch(priorState, rawMessage, facts, anchor);
  patches.push(extraction.patch);

  const merged = applyEvidenceMergePatch(extraction.state, facts, rawMessage, anchor);
  patches.push(merged.patch);

  let state = merged.state;
  let instrument: RomInstrument | null = null;

  // Rescore only fires once we know the trade — before that, any number
  // would be fabricated.
  if (state.trade) {
    const rescored = applyRescorePatch(state, policy, multipliers, anchor);
    if (rescored) {
      patches.push(rescored.patch);
      patches.push(rescored.emit);
      state = rescored.state;
      instrument = rescored.instrument;
    }
  }

  return { state, patches, instrument };
}
