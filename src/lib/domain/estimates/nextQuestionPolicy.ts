/**
 * Next-question policy — Process pillar for conversational elicitation.
 *
 * Given the current EstimatorState, returns the single highest-value
 * dimension still missing for the trade in question. The chat layer then
 * relays a phrasing of that question to the customer. This replaces
 * "the LLM picks whatever feels natural" with explicit dimension-driven
 * elicitation that's debuggable ("why did the bot ask about access?
 * because the policy returned `next: access` based on missing-dimensions
 * ordering for painting after surface + prep_level were filled").
 *
 * Per-trade ordering captures the load-bearing-question hierarchy:
 *   painting:   surface > prep_level > room_count > access > dwelling
 *   fencing:    quantity_signal > work_type > access
 *   carpentry:  work_type > quantity_signal > access > prep_level
 *   plumbing:   work_type > access
 *   electrical: work_type > access > dwelling
 *   roofing:    surface > access > work_type
 *   tiling:     work_type > prep_level > room_count > access
 *   ...
 *
 * The policy returns the FIRST dimension in the trade's ordering that's
 * still `unknown`/`null`. Returns `null` when every load-bearing slot
 * is filled — the caller should present the estimate.
 *
 * The policy carries a phrasing hint for each dimension (the question
 * the chat LLM should ask). The chat layer is free to rephrase but the
 * dimension is what gets asked about.
 */
import type { EstimatorState } from "./sppEstimator";
import type { TradeCategory } from "../../lexicons/trades";

/** Slot keys used by the policy. Subset of EstimatorState fields. */
type DimensionSlot =
  | "surface"
  | "prep_level"
  | "room_count"
  | "dwelling_type"
  | "access"
  | "material_tier"
  | "quantity_signal"
  | "work_type";

interface DimensionQuestion {
  slot: DimensionSlot;
  /** A short phrasing the chat LLM can use verbatim or rephrase. */
  question: string;
  /** Why this slot matters — debug context. */
  rationale: string;
}

/** Per-trade ordered list of dimensions to ask about. The first
 *  unfilled one wins. Trades not in the table fall back to a generic
 *  ordering (work_type → quantity_signal → access). */
const TRADE_QUESTION_ORDER: Partial<Record<TradeCategory, DimensionQuestion[]>> = {
  painting: [
    {
      slot: "surface",
      question: "Is this interior, exterior, or both?",
      rationale: "Exterior painting is roughly 1.8x interior — biggest single driver",
    },
    {
      slot: "prep_level",
      question: "What's the wall condition like — any holes, cracks, or plaster work needed?",
      rationale: "Prep level (clean vs fill_patch vs plaster_repair) shifts the band materially",
    },
    {
      slot: "room_count",
      question: "How many rooms or areas are involved?",
      rationale: "Room count is the second-largest cost driver after surface",
    },
    {
      slot: "dwelling_type",
      question: "Is this an apartment, house, townhouse, or commercial space?",
      rationale: "Apartments add waste removal + lift use + building access rules",
    },
    {
      slot: "access",
      question: "Anything about access — multi-storey, scaffolding, or ground-level?",
      rationale: "Two-storey or scaffolded work bumps a band-step",
    },
  ],
  fencing: [
    {
      slot: "quantity_signal",
      question: "Roughly how many metres of fence — and how many posts?",
      rationale: "Length + post count are the dominant fencing drivers",
    },
    {
      slot: "work_type",
      question: "Is it a repair on existing posts, or are we replacing the whole thing?",
      rationale: "Post replacement = digging concrete = much more work",
    },
    {
      slot: "access",
      question: "Easy access for a ute and tools, or anything tricky?",
      rationale: "Backyard vs side-access vs steep slope changes effort",
    },
  ],
  carpentry: [
    {
      slot: "work_type",
      question: "Is this a repair, a replacement, or building something new?",
      rationale: "Build-from-scratch is a different effort regime to repair",
    },
    {
      slot: "quantity_signal",
      question: "How big — a single shelf, a few items, or a whole kitchen?",
      rationale: "Quantity bucket drives band selection",
    },
    {
      slot: "access",
      question: "Any access constraints — small space, second floor, anything tricky?",
      rationale: "Confined-space work + heavy-lift access shift effort",
    },
    {
      slot: "prep_level",
      question: "Are we starting clean or is there demo / removal first?",
      rationale: "Demo bumps the band before any new work starts",
    },
  ],
  plumbing: [
    {
      slot: "work_type",
      question: "Is this a fix on what's there, or installing something new?",
      rationale: "Repair vs install changes the part + time mix",
    },
    {
      slot: "access",
      question: "Easy to get to — under a sink, in a wall, in the slab?",
      rationale: "In-slab vs accessible pipework is a major effort shift",
    },
  ],
  electrical: [
    {
      slot: "work_type",
      question: "Repair, replacement, or new install?",
      rationale: "Drives whether circuit work / certification is needed",
    },
    {
      slot: "access",
      question: "Any access challenges — ceiling cavity, switchboard, multi-storey?",
      rationale: "Switchboard + ceiling work bump the band",
    },
    {
      slot: "dwelling_type",
      question: "Is it a house, apartment, or commercial?",
      rationale: "Commercial / strata add code requirements",
    },
  ],
  roofing: [
    {
      slot: "surface",
      question: "What part of the roof — small section or full surface?",
      rationale: "Sectional repair vs whole-roof = different bands",
    },
    {
      slot: "access",
      question: "Single-storey, two-storey, or higher?",
      rationale: "Roof access is the dominant safety + effort driver",
    },
    {
      slot: "work_type",
      question: "Patch up, replace tiles, or full re-roof?",
      rationale: "Determines whether materials dwarf labour",
    },
  ],
  tiling: [
    {
      slot: "work_type",
      question: "New tiling, replacement, or repair?",
      rationale: "New install vs repair = different effort entirely",
    },
    {
      slot: "prep_level",
      question: "What's underneath — existing tiles to remove, or clean substrate?",
      rationale: "Removal + substrate prep is half the job for retiles",
    },
    {
      slot: "room_count",
      question: "How big is the area — splashback, single room, or larger?",
      rationale: "Square-metres is the dominant cost driver",
    },
    {
      slot: "access",
      question: "Standard access, or anything tricky?",
      rationale: "Wet area vs floor vs splashback affects setup",
    },
  ],
  general: [
    {
      slot: "quantity_signal",
      question: "Is it one thing, a few things, or a list of jobs?",
      rationale: "Single-item vs list = different time blocks",
    },
    {
      slot: "work_type",
      question: "Is this assembly, mounting, repair, or installing something?",
      rationale: "Determines tool / part requirements",
    },
    {
      slot: "access",
      question: "Anything about access — small space, height, anything awkward?",
      rationale: "Hard-access work bumps even small jobs",
    },
  ],
  gardening: [
    {
      slot: "quantity_signal",
      question: "How big — a small patch, a yard, or a full property?",
      rationale: "Area is the dominant driver",
    },
    {
      slot: "work_type",
      question: "Tidy-up, planting, structural (retaining walls etc)?",
      rationale: "Determines whether materials matter",
    },
    {
      slot: "access",
      question: "Easy access for green-waste removal?",
      rationale: "Removal logistics drive a chunk of cost",
    },
  ],
  cleaning: [
    {
      slot: "surface",
      question: "Interior clean, exterior pressure-wash, or both?",
      rationale: "Different equipment and time entirely",
    },
    {
      slot: "quantity_signal",
      question: "How big is the area?",
      rationale: "Square-metres drives time",
    },
    {
      slot: "access",
      question: "Single-storey, multi-storey, gutter access?",
      rationale: "Gutter / second-storey = ladder + safety bumps",
    },
  ],
};

/** Generic fallback ordering for trades not in the table. */
const GENERIC_ORDER: DimensionQuestion[] = [
  {
    slot: "work_type",
    question: "Is this a repair, replacement, or new install?",
    rationale: "Generic fallback — work type always matters",
  },
  {
    slot: "quantity_signal",
    question: "Roughly how big — one thing, a few, or a lot?",
    rationale: "Coarse quantity always informs the band",
  },
  {
    slot: "access",
    question: "Any access constraints?",
    rationale: "Access shifts effort across all trades",
  },
];

/** Decide the next question given the current state. Returns null when
 *  every load-bearing slot is filled — caller should present the estimate
 *  rather than ask another question. */
export function pickNextQuestion(state: EstimatorState): DimensionQuestion | null {
  if (!state.trade) {
    // Trade not yet known — that's the first question, full stop.
    return {
      slot: "work_type",
      question: "What needs doing? You can describe it, send a photo, or talk me through it.",
      rationale: "Trade is the gating dimension — nothing else can be inferred without it",
    };
  }

  const order = TRADE_QUESTION_ORDER[state.trade] ?? GENERIC_ORDER;
  for (const q of order) {
    if (isSlotFilled(state, q.slot)) continue;
    return q;
  }
  return null;
}

function isSlotFilled(state: EstimatorState, slot: DimensionSlot): boolean {
  switch (slot) {
    case "surface":         return state.surface !== "unknown";
    case "prep_level":      return state.prepLevel !== "unknown";
    case "room_count":      return state.roomCount !== null;
    case "dwelling_type":   return state.dwellingType !== "unknown";
    case "access":          return state.access !== "unknown";
    case "material_tier":   return state.material !== "unknown";
    case "quantity_signal": return state.quantity !== "unknown";
    case "work_type":       return state.workType !== "unclear";
  }
}
