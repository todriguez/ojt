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
  doors_windows: "Plus doors — typically $80–200 each for standard hollow-core, more for solid or custom",
  carpentry: "Plus timber and hardware",
  fencing: "Plus posts, rails, and palings — typically $40–60 per metre for standard timber",
  painting: "Plus paint and prep materials — roughly $50–100 per room",
  plumbing: "Plus parts and fittings",
  tiling: "Plus tiles, adhesive, and grout",
  roofing: "Plus tiles/sheets and flashing",
  electrical: "Plus fittings and cable",
  general: "Plus any materials needed",
  gardening: "Plus plants, mulch, or soil if needed",
  cleaning: "Cleaning products included",
};

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

  // Build materials note
  const jt = jobType || "general";
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
