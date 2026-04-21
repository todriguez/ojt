/**
 * Post-extraction validator for lexicon-tagged facts.
 *
 * Pure function — NO DB, NO LLM, NO global state, NO filesystem. The
 * G5 gate test imports this module and asserts there is no top-level
 * I/O. Keep it that way.
 *
 * Contract (OJT-P6 spec Step 2):
 *   - Both lexicon + category null   → ok (explicit untag is legal)
 *   - Partial tag (one null, one not) → invalid `partial_tag`
 *   - Unknown lexicon name            → invalid `unknown_lexicon:<name>`
 *   - Category not in registry        → invalid `unknown_category:<lex>/<cat>`
 *   - confidence < 0.6                → demote to null-tagged in `ok`
 *                                         (NOT invalid — just untagged)
 *   - Fully valid                     → ok
 *
 * The re-prompt builder produces a corrective instruction that lists
 * every invalid fact alongside the valid categories for its declared
 * lexicon so the LLM has exactly the information it needs to retry.
 */
import {
  LEXICON_REGISTRY,
  type LexiconName,
  type TaggedFact,
} from "./index";

/** Confidence floor below which a fact is demoted to null-tagged. */
export const CONFIDENCE_THRESHOLD = 0.6;

export interface InvalidFact {
  fact: TaggedFact;
  reason: string;
}

export interface ValidationResult {
  /** Facts that passed (possibly with lexicon/category nulled out by demotion). */
  ok: TaggedFact[];
  /** Facts that failed — caller should re-prompt or drop. */
  invalid: InvalidFact[];
}

function isKnownLexicon(name: string): name is LexiconName {
  return Object.prototype.hasOwnProperty.call(LEXICON_REGISTRY, name);
}

/**
 * Validate an array of tagged facts against the lexicon registry.
 * Returns every fact either in `ok` (possibly demoted to null-tagged
 * when confidence is low) or in `invalid` with a machine-readable
 * reason code.
 */
export function validateAgainstLexicon(
  facts: TaggedFact[],
): ValidationResult {
  const ok: TaggedFact[] = [];
  const invalid: InvalidFact[] = [];

  for (const fact of facts) {
    const { lexicon, category } = fact;

    // (1) Explicit untag — both null. Legal, passes through as-is.
    if (lexicon === null && category === null) {
      ok.push(fact);
      continue;
    }

    // (2) Partial tag — exactly one field null.
    if (lexicon === null || category === null) {
      invalid.push({ fact, reason: "partial_tag" });
      continue;
    }

    // (3) Unknown lexicon name.
    if (!isKnownLexicon(lexicon)) {
      invalid.push({
        fact,
        reason: `unknown_lexicon:${lexicon}`,
      });
      continue;
    }

    // (4) Category not in the declared lexicon's registry.
    const allowed = LEXICON_REGISTRY[lexicon];
    if (!allowed.includes(category)) {
      invalid.push({
        fact,
        reason: `unknown_category:${lexicon}/${category}`,
      });
      continue;
    }

    // (5) Low confidence — demote to null-tagged rather than drop.
    if (fact.confidence < CONFIDENCE_THRESHOLD) {
      ok.push({ ...fact, lexicon: null, category: null });
      continue;
    }

    // (6) Fully valid.
    ok.push(fact);
  }

  return { ok, invalid };
}

/**
 * Build a corrective re-prompt listing every invalid fact with the
 * allowed categories for its declared lexicon (when the lexicon name
 * is recognised). Returns an empty string for an empty invalid list so
 * callers can short-circuit.
 */
export function buildRePromptForInvalid(invalid: InvalidFact[]): string {
  if (invalid.length === 0) return "";

  const lines: string[] = [];
  lines.push(
    "Your previous response contained invalid lexicon tags. Re-emit the taggedFacts array with corrections:",
  );
  lines.push("");

  for (let i = 0; i < invalid.length; i++) {
    const { fact, reason } = invalid[i];
    lines.push(`${i + 1}. Fact: ${JSON.stringify(fact.fact)}`);
    lines.push(`   Declared: lexicon=${JSON.stringify(fact.lexicon)}, category=${JSON.stringify(fact.category)}`);
    lines.push(`   Reason: ${reason}`);

    // If the lexicon name is recognised, show the valid categories to
    // help the LLM pick one. Unknown lexicons get a different nudge.
    if (fact.lexicon !== null && isKnownLexicon(fact.lexicon)) {
      const allowed = LEXICON_REGISTRY[fact.lexicon];
      lines.push(
        `   Valid categories for '${fact.lexicon}': ${allowed.join(", ")}`,
      );
    } else if (fact.lexicon !== null) {
      lines.push(
        `   Unknown lexicon. Use one of: ${Object.keys(LEXICON_REGISTRY).join(", ")}, or set both lexicon and category to null.`,
      );
    } else {
      lines.push(
        "   Partial tag — either set both lexicon AND category, or set both to null.",
      );
    }
    lines.push("");
  }

  lines.push(
    "Rules: if a fact does not clearly fit a known (lexicon, category) pair, set BOTH lexicon and category to null. NEVER guess. Confidence below 0.6 will be demoted to null-tagged.",
  );

  return lines.join("\n");
}
