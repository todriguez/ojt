/**
 * Estimate Acknowledgement Classifier
 *
 * Classifies the customer's response after a ROM estimate is presented.
 * Uses the extraction's estimateReaction field but also has rule-based
 * fallback for common patterns.
 *
 * This is the bridge between Sprint 2's estimate engine and Sprint 3's scoring.
 */

export type EstimateAckStatus =
  | "accepted"
  | "tentative"
  | "uncertain"
  | "pushback"
  | "rejected"
  | "wants_exact_price"
  | "rate_shopping"
  | "unclear"
  | "pending";

export interface EstimateAckResult {
  status: EstimateAckStatus;
  confidence: "high" | "medium" | "low";
  reason: string;
}

/**
 * Classify from extraction output.
 */
export function classifyFromExtraction(
  estimateReaction: string | null,
  budgetReaction: string | null
): EstimateAckResult {
  // Direct estimate reaction takes priority
  if (estimateReaction && estimateReaction !== "unclear") {
    return {
      status: estimateReaction as EstimateAckStatus,
      confidence: "high",
      reason: `LLM classified as: ${estimateReaction}`,
    };
  }

  // Fall back to budget reaction mapping
  if (budgetReaction) {
    const mapping: Record<string, EstimateAckStatus> = {
      accepted: "accepted",
      ok: "tentative",
      unsure: "uncertain",
      expensive: "pushback",
      cheap: "pushback",
      wants_hourly: "wants_exact_price",
      wants_guarantee: "wants_exact_price",
    };
    const mapped = mapping[budgetReaction];
    if (mapped) {
      return {
        status: mapped,
        confidence: "medium",
        reason: `Mapped from budgetReaction: ${budgetReaction}`,
      };
    }
  }

  return {
    status: "unclear",
    confidence: "low",
    reason: "No clear reaction detected",
  };
}

/**
 * Rule-based fallback classifier for raw message text.
 * Used when LLM extraction doesn't pick up a clear signal.
 */
export function classifyFromText(messageText: string): EstimateAckResult {
  const text = messageText.toLowerCase().trim();

  // Strong acceptance
  const acceptPatterns = [
    /sounds? (good|fine|fair|reasonable|about right)/,
    /that('s| is) (fine|ok|good|fair)/,
    /yeah.*(fine|good|ok|right|expected)/,
    /no worries/,
    /let'?s? (go|do it|proceed)/,
    /when can you/,
    /book (it|me) in/,
    /about what i (thought|expected)/,
  ];
  for (const p of acceptPatterns) {
    if (p.test(text)) {
      return { status: "accepted", confidence: "high", reason: `Matched: ${p.source}` };
    }
  }

  // Tentative acceptance
  const tentativePatterns = [
    /^ok$/,
    /^yeah$/,
    /^sure$/,
    /i (guess|suppose)/,
    /not (too )?bad/,
    /could be worse/,
    /i('ll| will) think about it/,
  ];
  for (const p of tentativePatterns) {
    if (p.test(text)) {
      return { status: "tentative", confidence: "medium", reason: `Matched: ${p.source}` };
    }
  }

  // Pushback
  const pushbackPatterns = [
    /that('s| is) (a lot|expensive|steep|much|pricey)/,
    /more than i (thought|expected)/,
    /i was (hoping|thinking|expecting).*(less|cheaper|lower)/,
    /bit (much|steep|high)/,
    /can you do (it )?(cheaper|for less)/,
    /any (way|chance).*(cheaper|discount|less)/,
  ];
  for (const p of pushbackPatterns) {
    if (p.test(text)) {
      return { status: "pushback", confidence: "high", reason: `Matched: ${p.source}` };
    }
  }

  // Rejected
  const rejectedPatterns = [
    /no (thanks|way)/,
    /too (expensive|much)/,
    /forget it/,
    /i('ll| will) (find|get) someone (else|cheaper)/,
    /can('t| not) afford/,
    /not worth it/,
    /i('ll| will) do it myself/,
  ];
  for (const p of rejectedPatterns) {
    if (p.test(text)) {
      return { status: "rejected", confidence: "high", reason: `Matched: ${p.source}` };
    }
  }

  // Wants exact price
  const exactPricePatterns = [
    /what('s| is) your (hourly|hour|rate)/,
    /how much (exactly|per hour)/,
    /exact (price|cost|figure)/,
    /can you give me an? exact/,
    /fixed price/,
    /guaranteed price/,
  ];
  for (const p of exactPricePatterns) {
    if (p.test(text)) {
      return { status: "wants_exact_price", confidence: "high", reason: `Matched: ${p.source}` };
    }
  }

  // Rate shopping
  const rateShoppingPatterns = [
    /getting (a few|some|other) quotes/,
    /what do (others|other tradies) charge/,
    /shopping around/,
    /comparing (prices|quotes)/,
  ];
  for (const p of rateShoppingPatterns) {
    if (p.test(text)) {
      return { status: "rate_shopping", confidence: "medium", reason: `Matched: ${p.source}` };
    }
  }

  return { status: "unclear", confidence: "low", reason: "No pattern matched" };
}

/**
 * Combined classifier — uses LLM extraction first, falls back to text matching.
 */
export function classifyEstimateAcknowledgement(
  estimateReaction: string | null,
  budgetReaction: string | null,
  messageText: string
): EstimateAckResult {
  // Try extraction-based first
  const fromExtraction = classifyFromExtraction(estimateReaction, budgetReaction);
  if (fromExtraction.status !== "unclear") {
    return fromExtraction;
  }

  // Fall back to text patterns
  return classifyFromText(messageText);
}
