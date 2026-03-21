/**
 * Suburb Group Classification
 *
 * Classifies suburbs into core / extended / outside / unknown groups
 * for fast queue filtering and location-aware scoring.
 *
 * Uses the same suburb sets as quoteWorthinessService but provides
 * a standalone utility for denormalization and UI badges.
 */

export type SuburbGroup = "core" | "extended" | "outside" | "unknown";

/**
 * Known suburbs in Todd's core service area (Noosa/Sunshine Coast).
 */
const CORE_AREA_SUBURBS = new Set([
  "noosa heads", "noosaville", "sunshine beach", "sunrise beach",
  "peregian beach", "peregian springs", "marcus beach", "castaways beach",
  "tewantin", "cooroy", "pomona", "cooran", "doonan", "verrierdale",
  "eumundi", "yandina", "nambour", "weyba downs",
  "coolum beach", "coolum", "yaroomba", "mount coolum",
  "bli bli", "pacific paradise", "mudjimba", "marcoola",
]);

const EXTENDED_AREA_SUBURBS = new Set([
  "maroochydore", "mooloolaba", "alexandra headland", "buderim",
  "sippy downs", "forest glen", "palmwoods", "montville",
  "maleny", "mapleton", "flaxton", "kenilworth",
  "caloundra", "kawana", "minyama", "parrearra",
  "noosa north shore", "boreen point", "lake cootharaba",
  "gympie", "tin can bay", "rainbow beach",
]);

/**
 * Classify a suburb string into a group.
 */
export function classifySuburb(suburb: string | null | undefined, locationClue?: string | null): SuburbGroup {
  const normalized = (suburb || "").toLowerCase().trim();

  if (!normalized && !locationClue) {
    return "unknown";
  }

  if (CORE_AREA_SUBURBS.has(normalized)) {
    return "core";
  }

  if (EXTENDED_AREA_SUBURBS.has(normalized)) {
    return "extended";
  }

  // Check if location clue hints at service area
  const clue = (locationClue || "").toLowerCase();
  if (clue.includes("noosa") || clue.includes("sunshine coast")) {
    return "extended"; // clue suggests service area but not confirmed core
  }

  if (normalized) {
    return "outside"; // has a suburb but it's not in our lists
  }

  return "unknown";
}

/**
 * Check if a suburb is in the core service area.
 */
export function isCoreSuburb(suburb: string | null | undefined): boolean {
  return classifySuburb(suburb) === "core";
}

/**
 * Check if a suburb is in any service area (core or extended).
 */
export function isServiceArea(suburb: string | null | undefined, locationClue?: string | null): boolean {
  const group = classifySuburb(suburb, locationClue);
  return group === "core" || group === "extended";
}
