/**
 * TradesLexicon — handyman / building-trades vocabulary.
 *
 * UPSTREAM STATUS: the Lean injectivity proof exists at
 * `proofs/lean/Semantos/Lexicons/Trades.lean`, but the TS upstream lift
 * was rolled back — `@semantos/semantos-sir` does not currently carry a
 * TradesLexicon export. Status TBD pending vertical-extension structure
 * upstream. When/if a future package version carries it, this file
 * collapses to:
 *
 *   export {
 *     TradesLexicon,
 *     type TradesCategory as TradeCategory,
 *   } from "@semantos/semantos-sir";
 *   export function isTradeCategory(v: string): v is TradesCategory { … }
 *
 * Until then the Lexicon<Cat> contract is upheld locally so callers (the
 * estimator, validator, chat prompts) can treat it identically to a
 * registered upstream lexicon.
 *
 * Design constraint (G6): NO inlined category strings anywhere downstream.
 * The estimator's keyword rules, band tables, material hints, etc. all key
 * off `TradeCategory` and import from this module. Adding a new trade
 * happens upstream first.
 */
import type { Lexicon } from "@semantos/semantos-sir";

export type TradeCategory =
  | "carpentry"
  | "plumbing"
  | "electrical"
  | "painting"
  | "general"
  | "fencing"
  | "tiling"
  | "roofing"
  | "doors_windows"
  | "gardening"
  | "cleaning"
  | "other";

export const TradesLexicon: Lexicon<TradeCategory> = {
  name: "trades",
  categories: [
    "carpentry",
    "plumbing",
    "electrical",
    "painting",
    "general",
    "fencing",
    "tiling",
    "roofing",
    "doors_windows",
    "gardening",
    "cleaning",
    "other",
  ] as const,
  // Headers must be injective on distinct categories. `doors_windows`
  // collapses to `DOORS_WINDOWS`; every other category capitalises cleanly.
  // The Lean proof obligation discharges this once lifted upstream.
  header: (c) => c.toUpperCase().replace("_", "_"),
};

/** Membership predicate — same shape as `isBRAPCategory` in semantos-sir. */
export function isTradeCategory(value: string): value is TradeCategory {
  return (TradesLexicon.categories as readonly string[]).includes(value);
}
