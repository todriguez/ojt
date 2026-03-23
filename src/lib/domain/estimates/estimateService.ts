/**
 * ROM Estimate Service
 *
 * Generates rough order of magnitude cost ranges based on effort band.
 * Labour-only with materials called out separately.
 *
 * Pricing calibrated for Sunshine Coast handyman rates (2024-25).
 * Todd's effective rate: ~$70–90/hr but we never show hourly rate.
 */

import type { EffortBand } from "./effortBandService";

export interface RomEstimate {
  effortBand: EffortBand;
  costMin: number;
  costMax: number;
  labourOnly: boolean;
  materialsNote: string | null;
  hoursMin: number;
  hoursMax: number;
  confidenceNote: string;
}

/**
 * Base cost ranges per effort band.
 * These are labour-only; materials are always extra.
 */
const BAND_RANGES: Record<EffortBand, { costMin: number; costMax: number; hoursMin: number; hoursMax: number }> = {
  quick:       { costMin: 80,   costMax: 150,  hoursMin: 0.5, hoursMax: 1 },
  short:       { costMin: 150,  costMax: 280,  hoursMin: 1,   hoursMax: 2 },
  quarter_day: { costMin: 250,  costMax: 400,  hoursMin: 2,   hoursMax: 3 },
  half_day:    { costMin: 350,  costMax: 600,  hoursMin: 3,   hoursMax: 5 },
  full_day:    { costMin: 550,  costMax: 900,  hoursMin: 5,   hoursMax: 8 },
  multi_day:   { costMin: 900,  costMax: 2500, hoursMin: 8,   hoursMax: 24 },
  unknown:     { costMin: 0,    costMax: 0,    hoursMin: 0,   hoursMax: 0 },
};

/**
 * Material cost hints by job type.
 * Used to generate the "plus materials" note.
 */
const MATERIAL_HINTS: Record<string, string> = {
  doors_windows: "Plus hardware if needed — handles, hinges, locks etc.",
  carpentry: "Plus timber and hardware",
  fencing: "Plus materials: posts ($30–50 each), concrete, rails, palings — roughly $50–80 per metre for standard timber depending on what needs replacing",
  painting: "Plus paint and prep materials — roughly $50–100 per room",
  plumbing: "Plus parts and fittings",
  tiling: "Plus tiles, adhesive, and grout",
  roofing: "Plus tiles/sheets and flashing",
  electrical: "Plus fittings and cable",
  general: "Plus any materials needed",
  gardening: "Plus plants, mulch, or soil if needed",
  cleaning: "Cleaning products included",
};

/**
 * Per-unit all-in pricing for job types where "per item supplied and fitted"
 * is a better model than labour + materials separately.
 */
const PER_UNIT_PRICES: Record<string, { min: number; max: number; note: string }> = {
  doors_windows: {
    min: 300,
    max: 400,
    note: "Standard interior hollow-core doors supplied and fitted. Solid or custom doors cost more. Painting extra if needed.",
  },
};

/**
 * Extract a numeric quantity from a string like "3 doors" or "3".
 */
function parseQuantity(quantity: string | null | undefined): number {
  if (!quantity) return 0;
  const match = quantity.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

interface EstimateInput {
  effortBand: EffortBand;
  jobType: string | null;
  materials?: string | null;
  quantity?: string | null;
}

/**
 * Generate a ROM estimate from effort band + job context.
 */
export function generateRomEstimate(input: EstimateInput): RomEstimate {
  const { effortBand, jobType } = input;

  if (effortBand === "unknown") {
    return {
      effortBand,
      costMin: 0,
      costMax: 0,
      labourOnly: true,
      materialsNote: null,
      hoursMin: 0,
      hoursMax: 0,
      confidenceNote: "Need more details to estimate",
    };
  }

  const range = BAND_RANGES[effortBand];
  const jt = jobType || "general";

  // ── Per-unit pricing for job types where all-in-one pricing makes more sense ──
  const perUnitPrice = PER_UNIT_PRICES[jt];
  if (perUnitPrice) {
    const qty = parseQuantity(input.quantity);
    if (qty > 0) {
      const totalMin = qty * perUnitPrice.min;
      const totalMax = qty * perUnitPrice.max;
      return {
        effortBand,
        costMin: totalMin,
        costMax: totalMax,
        labourOnly: false, // all-in price
        materialsNote: perUnitPrice.note,
        hoursMin: range.hoursMin,
        hoursMax: range.hoursMax,
        confidenceNote: `Based on ${qty} × $${perUnitPrice.min}–$${perUnitPrice.max} each (supplied and fitted)`,
      };
    }
  }

  // ── Standard labour-only estimate ──
  let materialsNote = MATERIAL_HINTS[jt] || "Plus any materials needed";

  // If specific materials were mentioned, use those
  if (input.materials) {
    materialsNote = `Plus ${input.materials}`;
  }

  // Confidence note based on how much info we have
  let confidenceNote = "Rough idea based on what you've described";
  if (effortBand === "multi_day") {
    confidenceNote = "Broad range — would need to see it to narrow down";
  }

  return {
    effortBand,
    costMin: range.costMin,
    costMax: range.costMax,
    labourOnly: jt !== "cleaning", // cleaning includes products
    materialsNote,
    hoursMin: range.hoursMin,
    hoursMax: range.hoursMax,
    confidenceNote,
  };
}

/**
 * Round cost to friendly numbers (nearest $50).
 */
export function friendlyCost(amount: number): number {
  return Math.round(amount / 50) * 50;
}
