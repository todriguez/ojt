/**
 * Estimate Wording Service
 *
 * Generates customer-facing ROM estimate wording.
 * Uses patterns from the PRD — natural, tradie-speak, never shows hourly rate.
 *
 * Pattern A: Repair/replace (most common)
 * Pattern B: Install/build
 * Pattern C: Unknown scope — wider range
 * Pattern D: Materials-heavy jobs
 * Pattern E: Quick jobs
 */

import type { RomEstimate } from "./estimateService";
import { friendlyCost } from "./estimateService";
import type { RomInstrument } from "./sppEstimator";

export interface EstimateWording {
  /** The main estimate line presented to the customer */
  customerFacing: string;
  /** The expectation-check follow-up question */
  expectationCheck: string;
  /** Internal note for Todd's review */
  internalNote: string;
}

interface WordingInput {
  estimate: RomEstimate;
  jobType: string | null;
  scopeDescription?: string | null;
  quantity?: string | null;
  materials?: string | null;
}

/**
 * Generate customer-facing estimate wording.
 */
export function generateEstimateWording(input: WordingInput): EstimateWording {
  const { estimate, jobType } = input;
  const { effortBand, costMin, costMax, materialsNote, labourOnly } = estimate;

  if (effortBand === "unknown") {
    return {
      customerFacing: "I'd need a bit more detail about what's involved before I can give you a rough idea on price. Can you tell me more about the job?",
      expectationCheck: "",
      internalNote: "Insufficient scope for ROM — need more details",
    };
  }

  const min = friendlyCost(costMin);
  const max = friendlyCost(costMax);
  const bandLabel = BAND_LABELS[effortBand];

  // Choose pattern based on job characteristics
  const pattern = choosePattern(input);
  const customerFacing = formatPattern(pattern, { min, max, bandLabel, materialsNote, labourOnly, jobType });
  const expectationCheck = pickExpectationCheck(effortBand);

  return {
    customerFacing,
    expectationCheck,
    internalNote: `ROM: $${min}–$${max} labour (${effortBand}). ${materialsNote || "No materials note"}.`,
  };
}

// ── Helpers ──────────────────────────────────

const BAND_LABELS: Record<string, string> = {
  quick: "quick job",
  short: "couple-hour job",
  quarter_day: "couple-hour job",
  half_day: "half-day type job",
  full_day: "full day",
  multi_day: "multi-day job",
};

type Pattern = "repair" | "install" | "wide_range" | "materials_heavy" | "quick";

function choosePattern(input: WordingInput): Pattern {
  const { estimate, scopeDescription, materials } = input;
  const desc = (scopeDescription || "").toLowerCase();

  if (estimate.effortBand === "quick" || estimate.effortBand === "short") {
    return "quick";
  }

  if (estimate.effortBand === "multi_day") {
    return "wide_range";
  }

  // Materials-heavy: when materials cost likely exceeds labour
  const materialHeavyKeywords = ["door", "fence", "paling", "tile", "cabinet", "cupboard"];
  if (materials || materialHeavyKeywords.some(kw => desc.includes(kw))) {
    return "materials_heavy";
  }

  // Install vs repair
  const installKeywords = ["install", "build", "mount", "hang", "new", "add"];
  const repairKeywords = ["repair", "fix", "replace", "patch", "broken", "cracked", "rotten"];

  if (installKeywords.some(kw => desc.includes(kw))) return "install";
  if (repairKeywords.some(kw => desc.includes(kw))) return "repair";

  return "repair"; // default
}

interface FormatParams {
  min: number;
  max: number;
  bandLabel: string;
  materialsNote: string | null;
  labourOnly: boolean;
  jobType: string | null;
}

function formatPattern(pattern: Pattern, p: FormatParams): string {
  const matSuffix = p.labourOnly && p.materialsNote
    ? ` ${p.materialsNote.charAt(0).toLowerCase()}${p.materialsNote.slice(1)}.`
    : "";

  switch (pattern) {
    case "quick":
      return `That sounds like a ${p.bandLabel} — usually around $${p.min}–$${p.max} for the labour.${matSuffix}`;

    case "repair":
      return `For that kind of work, you're usually looking at roughly $${p.min}–$${p.max} for the labour — it's a ${p.bandLabel}.${matSuffix}`;

    case "install":
      return `Install jobs like that typically run $${p.min}–$${p.max} for the labour side — ${p.bandLabel}.${matSuffix}`;

    case "wide_range":
      return `Hard to be exact without seeing it, but that kind of job usually runs $${p.min}–$${p.max} for the labour. It's a ${p.bandLabel}, so depends what shows up once we get into it.${matSuffix}`;

    case "materials_heavy":
      if (!p.labourOnly) {
        // All-in pricing (e.g. per-unit door pricing)
        return `For that kind of job, you're usually looking at roughly $${p.min}–$${p.max} all up — that covers supply and fitting. ${p.materialsNote || ""}`;
      }
      return `The labour on that is usually around $${p.min}–$${p.max} — ${p.bandLabel}. The materials are on top of that. ${p.materialsNote || ""}`;

    default:
      return `Roughly $${p.min}–$${p.max} for the labour — ${p.bandLabel}.${matSuffix}`;
  }
}

function pickExpectationCheck(band: string): string {
  // All checks pivot explicitly to "does this ballpark work? if yes,
  // Todd comes out for a free quote" — so the customer self-qualifies
  // and we don't burn Todd's time on visits where the ballpark's already
  // too high or too low.
  const checks: Record<string, string> = {
    quick:       "Does that range work for you? Happy to line up a time if so.",
    short:       "Does that range work as a starting point? If yes, Todd can come out for a proper quote.",
    quarter_day: "Does that range sit roughly where you were expecting? If yes, Todd would come take a look and firm up the number.",
    half_day:    "Is that range in the right ballpark for you? If it works, Todd would come out for a free quote on site.",
    full_day:    "Is that range workable for you? Assuming yes, Todd would come out, take a proper look, and give you a real quote at no charge.",
    multi_day:   "Big range, I know — a real quote needs a proper look. Is that range roughly in the zone for you? If yes, Todd would come out for a free on-site quote.",
    mega:        "That's a wide range because jobs at that scale vary a lot — a real quote needs a site visit. Does that ballpark sit roughly where you were thinking? If yes, Todd would come out for a free on-site quote.",
  };
  return checks[band] || "Does that range work roughly as a starting point? If yes, Todd would come out for a free on-site quote.";
}

// ── Instrument-first wording ─────────────────────────────────────────────
// The preferred path: consume a typed RomInstrument emitted by sppEstimator
// and produce the same EstimateWording shape. Numbers pass through verbatim
// — this function never computes or rounds pricing, it only formats the
// canonical figures the instrument carries. Confidence class drives a
// small preamble on the customer-facing string ("rough first-pass" vs
// "on the money for a job like this") so we never lie about how tight
// the number is.

export function generateEstimateWordingFromInstrument(
  instrument: RomInstrument,
  /** When the new instrument supersedes a prior one (amendment path),
   *  pass the prior here so the wording can frame the change explicitly
   *  ("previously $A–$B, now $X–$Y because [reason]"). Pass null on the
   *  first-ROM-for-the-job path and the wording stays non-amendment. */
  prior: RomInstrument | null = null,
): EstimateWording {
  const { band, costMin, costMax, materialsNote, labourOnly, confidence, trade } = instrument;
  // Instrument costs are authoritative — friendlyCost is purely cosmetic
  // rounding here (nearest $50). Callers who want exact figures should
  // read the instrument directly.
  const min = friendlyCost(costMin);
  const max = friendlyCost(costMax);
  const bandLabel = BAND_LABELS[band] ?? "job";
  const confidencePreamble =
    confidence === "first_pass"
      ? "Very rough ballpark — "
      : confidence === "rough"
        ? "Ballpark-wise, "
        : "Based on what you've described, ";

  const matSuffix = labourOnly && materialsNote
    ? ` ${materialsNote.charAt(0).toLowerCase()}${materialsNote.slice(1)}.`
    : "";

  const isAmendment = prior !== null && instrument.supersedes === prior.id;

  let body: string;
  let disclaimer: string;

  if (isAmendment) {
    // Amendment — explicitly compare old and new ranges so the customer
    // sees WHY the number moved, not just that it did. The "revision"
    // number lives on the instrument in case the chat LLM wants to drop
    // it into the phrasing ("revised ROM v2"), but by default we keep it
    // human.
    const priorMin = friendlyCost(prior!.costMin);
    const priorMax = friendlyCost(prior!.costMax);
    const direction =
      instrument.costMax > prior!.costMax
        ? "higher"
        : instrument.costMin < prior!.costMin
          ? "lower"
          : "shifted";
    body = labourOnly
      ? `Given what's changed, the ROM for this one's shifted ${direction}. Previously it was sitting around $${priorMin}–$${priorMax}; with the updated scope, it's now looking more like $${min}–$${max} for labour on a ${bandLabel}.${matSuffix}`
      : `Given what's changed, the ROM for this one's shifted ${direction}. Previously $${priorMin}–$${priorMax}; with the updated scope it's more like $${min}–$${max} all up — ${bandLabel} work, supplied and fitted. ${materialsNote ?? ""}`;
    disclaimer =
      "Still a rough order-of-magnitude — not a quote. If the updated ballpark still works, Todd would come out for a proper on-site quote at no charge.";
  } else {
    // ROM wording — three explicit framing moves:
    //   1. Preamble signals ROM confidence (very rough / rough / dialled in).
    //   2. Body carries the range with "usually" / "tends to land" framing.
    //   3. Disclaimer makes clear this is indicative, not a quote.
    body = labourOnly
      ? `${confidencePreamble}for ${trade} work at that kind of scope, jobs like this tend to land somewhere in the $${min}–$${max} range for labour on a ${bandLabel}.${matSuffix}`
      : `${confidencePreamble}jobs like this tend to land somewhere in the $${min}–$${max} range all up — that's ${bandLabel} work, supplied and fitted. ${materialsNote ?? ""}`;
    disclaimer =
      "That's a rough order-of-magnitude from what you've told me — not a quote. If the ballpark works for you, Todd would come out and give you a proper quote on site at no charge.";
  }

  return {
    customerFacing: `${body}\n\n${disclaimer}`,
    expectationCheck: isAmendment
      ? `Does the updated range still work for you? If yes, Todd will reflect the change in the on-site quote.`
      : pickExpectationCheck(band),
    internalNote: `${isAmendment ? `Amended ROM r${instrument.revision}` : "ROM"} from instrument ${instrument.id}: $${min}–$${max} ${labourOnly ? "labour" : "all-in"} (${band}, ${confidence})${isAmendment ? ` supersedes ${prior!.id}` : ""}. ${materialsNote ?? ""}`,
  };
}
