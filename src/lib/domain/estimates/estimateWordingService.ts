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
      return `The labour on that is usually around $${p.min}–$${p.max} — ${p.bandLabel}. The materials are on top of that. ${p.materialsNote || ""}`;

    default:
      return `Roughly $${p.min}–$${p.max} for the labour — ${p.bandLabel}.${matSuffix}`;
  }
}

function pickExpectationCheck(band: string): string {
  const checks: Record<string, string> = {
    quick: "Does that sound about right for what you're after?",
    short: "Does that sound roughly in the ballpark?",
    quarter_day: "Does that sound roughly in the ballpark?",
    half_day: "Just checking that sounds roughly in the ballpark before going further.",
    full_day: "Just checking that sits roughly where you expected before we go further.",
    multi_day: "That's a broad range I know — does it sit roughly where you expected? Would need to see it to narrow it down.",
  };
  return checks[band] || "Does that sound roughly in the ballpark?";
}
