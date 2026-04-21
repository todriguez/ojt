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

/** Readonly arrays sourced from the canonical lexicons. */
export const JURAL_CATEGORIES = JuralLexicon.categories;
export const PM_CATEGORIES = PropertyManagementLexicon.categories;

/** The two lexicon names OJT understands. */
export type LexiconName = "jural" | "property-management";

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
};
