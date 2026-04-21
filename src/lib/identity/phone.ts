/**
 * Phone normalization + deterministic certId derivation.
 *
 * Every phone-derived identity flows through `normalizePhone` first so
 * that multiple surface forms of the same number (local, international,
 * with/without spaces) collapse to a single E.164 string before it's
 * hashed. The certId is `sha256("ojt:${role}:${normalizedPhone}")` as
 * lowercase hex — 64 chars.
 */

import { parsePhoneNumberFromString } from "libphonenumber-js/core";
// Load metadata via namespace import + default/namespace fallback. We used
// to use `import metadata from "libphonenumber-js/metadata.min.json" with
// { type: "json" }` but Bun 1.2 resolves the exports map to the packaged
// `metadata.min.json.js` wrapper and then tries to re-parse *that* file as
// JSON — crashing with a "JSON Parse error: Unrecognized token '/'" before
// a single line of test code runs. Using a namespace import (no JSON
// assert) lets both tsx/Node and Bun agree: the resolver picks the `.js`
// wrapper, ESM gives us either a default export or the namespace itself,
// and we coalesce. Next's webpack/turbopack handles both forms.
import * as _metadataNs from "libphonenumber-js/min/metadata";
const metadata = ((_metadataNs as unknown as { default?: unknown }).default ??
  _metadataNs) as Parameters<typeof parsePhoneNumberFromString>[2];
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export type OjtRole = "tenant" | "rea";

/**
 * Normalize a raw phone input to canonical E.164. Accepts already-E.164
 * strings, local numbers (when `defaultCountry` is provided), or common
 * variants with spaces / dashes / parentheses.
 *
 * Throws when the input cannot be parsed to a valid phone number — the
 * alternative (returning the raw string) would silently bake a
 * different certId into the store per spelling.
 */
export function normalizePhone(
  raw: string,
  defaultCountry: "AU" | string = "AU",
): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("normalizePhone: empty input");
  }
  // libphonenumber-js treats `undefined` as "no default country" — required
  // for already-E.164 inputs. Passing the AU default for such inputs is
  // harmless, but we only supply a default for non-E.164 strings to avoid
  // an internal ReferenceError on some builds.
  const trimmed = raw.trim();
  const looksInternational = trimmed.startsWith("+");
  // libphonenumber-js ignores `defaultCountry` when the input is already
  // in E.164. For E.164 inputs pass an empty options object so we don't
  // accidentally validate the parse against an unrelated country.
  const parsed = parsePhoneNumberFromString(
    trimmed,
    looksInternational
      ? {}
      : (defaultCountry as Parameters<typeof parsePhoneNumberFromString>[1]),
    metadata,
  );
  if (!parsed || !parsed.isValid()) {
    throw new Error(`normalizePhone: invalid phone number: ${raw}`);
  }
  return parsed.number; // E.164 form, e.g. "+61412345678"
}

/**
 * Derive the stable certId for a phone + role pair. Deterministic and
 * independent of the master derivation seed — the certId exists so that
 * peers can reference each other without holding pubkeys yet.
 */
export function certIdFromPhone(phone: string, role: OjtRole): string {
  const normalized = normalizePhone(phone);
  const preimage = `ojt:${role}:${normalized}`;
  const digest = sha256(new TextEncoder().encode(preimage));
  return bytesToHex(digest);
}
