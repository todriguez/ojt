/**
 * Repeat Customer Detection Service
 *
 * Detects if a new lead matches an existing customer by:
 * - Same phone number (normalized)
 * - Same email (lowercased)
 * - Same address (fuzzy: same suburb + similar address_line_1)
 *
 * Returns repeat status + previous job count for:
 * - 🔁 badge on lead cards
 * - context.isRepeatCustomer for scoring
 * - repeat customer bonus in policy weights
 */

import type { AccumulatedJobState } from "../../ai/extractors/extractionSchema";

export interface RepeatCustomerResult {
  isRepeat: boolean;
  previousJobCount: number;
  matchedOn: string[];    // what matched: "phone", "email", "address"
  lastOutcome: string | null;  // from most recent previous job_outcomes
}

/**
 * Normalize phone number for matching.
 * Strips spaces, dashes, parens, leading country codes.
 */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  // Strip everything except digits
  let digits = phone.replace(/[^\d]/g, "");
  // Australian mobile: convert 61XXXXXXXXX to 0XXXXXXXXX
  if (digits.startsWith("61") && digits.length === 11) {
    digits = "0" + digits.slice(2);
  }
  // Must be at least 8 digits to be a real number
  return digits.length >= 8 ? digits : null;
}

/**
 * Normalize email for matching.
 */
export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.toLowerCase().trim();
  return trimmed.includes("@") ? trimmed : null;
}

/**
 * Simple address similarity check for fuzzy suburb + street matching.
 * Returns true if suburb matches and first significant word of address matches.
 */
export function addressMatches(
  suburb1: string | null | undefined,
  address1: string | null | undefined,
  suburb2: string | null | undefined,
  address2: string | null | undefined
): boolean {
  if (!suburb1 || !suburb2) return false;

  const s1 = suburb1.toLowerCase().trim();
  const s2 = suburb2.toLowerCase().trim();
  if (s1 !== s2) return false;

  // If both have addresses, check first significant word
  if (address1 && address2) {
    const words1 = address1.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(w => w.length > 2);
    const words2 = address2.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(w => w.length > 2);
    // Check if any significant words overlap (street name)
    return words1.some(w => words2.includes(w));
  }

  // Same suburb alone is not enough for address match
  return false;
}

/**
 * Check repeat customer from accumulated state against a list of previous leads.
 *
 * In production, this will query the database. For now, it takes a list of
 * previous lead states to compare against.
 */
export function detectRepeatCustomer(
  currentState: AccumulatedJobState,
  previousLeads: Array<{
    phone?: string | null;
    email?: string | null;
    suburb?: string | null;
    address?: string | null;
    outcome?: string | null;
  }>
): RepeatCustomerResult {
  if (previousLeads.length === 0) {
    return { isRepeat: false, previousJobCount: 0, matchedOn: [], lastOutcome: null };
  }

  const currentPhone = normalizePhone(currentState.customerPhone);
  const currentEmail = normalizeEmail(currentState.customerEmail);
  const matchedOn = new Set<string>();
  let matchCount = 0;
  let lastOutcome: string | null = null;

  for (const lead of previousLeads) {
    let matched = false;

    // Phone match
    if (currentPhone && normalizePhone(lead.phone) === currentPhone) {
      matchedOn.add("phone");
      matched = true;
    }

    // Email match
    if (currentEmail && normalizeEmail(lead.email) === currentEmail) {
      matchedOn.add("email");
      matched = true;
    }

    // Address match (fuzzy)
    if (addressMatches(currentState.suburb, currentState.address, lead.suburb, lead.address)) {
      matchedOn.add("address");
      matched = true;
    }

    if (matched) {
      matchCount++;
      if (lead.outcome) {
        lastOutcome = lead.outcome; // latest match's outcome
      }
    }
  }

  return {
    isRepeat: matchCount > 0,
    previousJobCount: matchCount,
    matchedOn: Array.from(matchedOn),
    lastOutcome,
  };
}
