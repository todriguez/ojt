# Prompt Changelog

Human-readable log of material changes to OJT's LLM prompts. Keep entries
terse — the diff is the source of truth; this file is a signpost so the
next engineer can locate the phase that introduced a given behaviour.

## 2026-04-21 — P6

- extractionPrompt: added TAGGED FACTS section (Jural + PM vocabularies)
- extractionPrompt: added 14 few-shot examples (one per Jural + PM category)
- systemPrompt: added verb-aware elicitation section
- validator: created validateAgainstLexicon + buildRePromptForInvalid

## 2026-04 — P5

- systemPrompt: added optional `historyBlock` context slot (prefixes the
  prompt with a federated patch-chain summary when the caller supplies
  one via `buildSystemPrompt({historyBlock})`)
