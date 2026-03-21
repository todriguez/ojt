/**
 * Conversation State Manager
 *
 * Sprint 3: Uses sub-scores for smarter stop conditions.
 * Avoids over-questioning once a decision can be made.
 */

import type { AccumulatedJobState } from "../../ai/extractors/extractionSchema";
import { inferEffortBand } from "../estimates/effortBandService";
import { generateRomEstimate } from "../estimates/estimateService";
import { generateEstimateWording } from "../estimates/estimateWordingService";

export type ConversationAction =
  | { type: "continue" }
  | { type: "present_estimate"; wording: string; expectationCheck: string }
  | { type: "ask_contact" }
  | { type: "summarise_and_close"; summary: string }
  | { type: "needs_more_info"; hint: string }
  | { type: "not_worth_pursuing"; reason: string }
  | { type: "needs_site_visit"; reason: string };

/**
 * Evaluate the current state and decide the next conversation action.
 *
 * Decision logic uses sub-scores rather than a single blunt threshold.
 */
export function evaluateConversationState(state: AccumulatedJobState): ConversationAction {
  // If already confirmed/disengaged, just continue
  if (state.conversationPhase === "confirmed" || state.conversationPhase === "disengaged") {
    return { type: "continue" };
  }

  // ── Early exit: not worth pursuing ──
  if (state.customerFitScore !== null && state.customerFitScore <= 15 && state.estimatePresented) {
    return {
      type: "not_worth_pursuing",
      reason: "Customer fit score very low and estimate already presented.",
    };
  }

  if (state.estimateAckStatus === "rejected") {
    return {
      type: "not_worth_pursuing",
      reason: "Customer rejected the ROM estimate.",
    };
  }

  // ── Site visit needed — check BEFORE presenting estimate ──
  const siteVisitReason = detectNeedsSiteVisit(state);
  if (siteVisitReason) {
    return { type: "needs_site_visit", reason: siteVisitReason };
  }

  // ── Ready to close ──
  if (
    state.decisionReadiness >= 70 &&
    state.estimatePresented &&
    state.estimateAcknowledged &&
    (state.customerName || state.customerPhone || state.customerEmail)
  ) {
    return {
      type: "summarise_and_close",
      summary: buildSummary(state),
    };
  }

  // ── Need contact details ──
  if (
    state.estimatePresented &&
    state.estimateAcknowledged &&
    !state.customerPhone &&
    !state.customerEmail &&
    state.estimateAckStatus !== "pushback"
  ) {
    return { type: "ask_contact" };
  }

  // ── Present estimate ──
  // Use estimateReadiness sub-score instead of blunt completeness
  // But DON'T present if customer is just asking for hourly rates with no real scope
  const hasNoRealScope = !state.scopeDescription || state.scopeDescription.length < 40;
  const isPriceFocused = state.customerToneSignal === "price_focused" ||
    state.budgetReaction === "wants_hourly" ||
    state.estimateReaction === "wants_exact_price" ||
    state.estimateReaction === "rate_shopping";
  const isVagueHourlySeeker =
    isPriceFocused && (hasNoRealScope || state.clarityScore === "vague");

  if (
    !state.estimatePresented &&
    !isVagueHourlySeeker &&
    state.estimateReadiness >= 50 &&
    state.scopeDescription &&
    (state.suburb || state.locationClue)
  ) {
    const effortResult = inferEffortBand({
      jobType: state.jobType,
      subcategory: state.jobSubcategory,
      quantity: state.quantity,
      scopeDescription: state.scopeDescription,
      materials: state.materials,
      accessDifficulty: state.accessDifficulty,
    });

    if (effortResult.band === "unknown") {
      // Only ask for more detail if scope clarity is truly low
      if (state.scopeClarity < 30) {
        return {
          type: "needs_more_info",
          hint: "I've got a rough idea of the job but need a bit more detail on the scope to give you a ballpark — can you tell me more about what's involved?",
        };
      }
      // If we have reasonable scope but can't classify the band, default to presenting anyway
      // with a wider range — better to give a rough number than keep asking
    }

    if (effortResult.band !== "unknown") {
      const romEstimate = generateRomEstimate({
        effortBand: effortResult.band,
        jobType: state.jobType,
        materials: state.materials,
        quantity: state.quantity,
      });

      const wording = generateEstimateWording({
        estimate: romEstimate,
        jobType: state.jobType,
        scopeDescription: state.scopeDescription,
        quantity: state.quantity,
        materials: state.materials,
      });

      return {
        type: "present_estimate",
        wording: wording.customerFacing,
        expectationCheck: wording.expectationCheck,
      };
    }
  }

  // ── Still gathering — but don't over-question ──
  // If we've been going back and forth and scope clarity is reasonable,
  // just present what we have (unless vague hourly seeker)
  if (
    !state.estimatePresented &&
    !isVagueHourlySeeker &&
    state.scopeClarity >= 35 &&
    state.scopeDescription &&
    state.suburb
  ) {
    // Force an estimate even if estimateReadiness is borderline
    const effortResult = inferEffortBand({
      jobType: state.jobType || "general",
      subcategory: state.jobSubcategory,
      quantity: state.quantity,
      scopeDescription: state.scopeDescription,
      materials: state.materials,
      accessDifficulty: state.accessDifficulty,
    });

    if (effortResult.band !== "unknown") {
      const romEstimate = generateRomEstimate({
        effortBand: effortResult.band,
        jobType: state.jobType,
        materials: state.materials,
        quantity: state.quantity,
      });

      const wording = generateEstimateWording({
        estimate: romEstimate,
        jobType: state.jobType,
        scopeDescription: state.scopeDescription,
        quantity: state.quantity,
        materials: state.materials,
      });

      return {
        type: "present_estimate",
        wording: wording.customerFacing,
        expectationCheck: wording.expectationCheck,
      };
    }
  }

  return { type: "continue" };
}

/**
 * Detect if a site visit is needed.
 */
function detectNeedsSiteVisit(state: AccumulatedJobState): string | null {
  const desc = (state.scopeDescription || "").toLowerCase();
  const condition = (state.materialCondition || "").toLowerCase();

  // Tier 1: Definitely hazardous — always flag
  const hazardousKeywords = /asbestos|termit|subsid|structur(?:al|e)\s+(?:damage|issue|problem|fail)/;
  if (hazardousKeywords.test(desc) || hazardousKeywords.test(condition)) {
    return "Possible hazardous or structural issue — need to inspect before pricing.";
  }

  // Tier 2: Concerning but only if multiple signals present
  // "rotten", "sagging", "leaning" alone might just be normal wear.
  // Require at least 2 concerning words OR 1 concerning word + bad condition.
  const concerningWords = ["rotten", "sagg", "lean", "mould", "collaps", "buckl", "cave"];
  const matchCount = concerningWords.filter((w) => desc.includes(w) || condition.includes(w)).length;

  if (matchCount >= 2) {
    return "Multiple concerning indicators — should inspect before committing to a price.";
  }

  if (matchCount === 1 && condition && /rot|decay|water.?damage|soft.*through|crumbl/.test(condition)) {
    return "Material condition suggests possible hidden damage — worth inspecting.";
  }

  // Scope still very unclear after estimate presented
  if (state.scopeClarity < 25 && state.estimatePresented) {
    return "Scope still unclear after estimate presented — might need a look in person.";
  }

  return null;
}

/**
 * Build a closing summary for the customer.
 */
function buildSummary(state: AccumulatedJobState): string {
  const parts: string[] = [];

  if (state.scopeDescription) parts.push(`Job: ${state.scopeDescription}`);
  if (state.suburb) parts.push(`Location: ${state.suburb}`);
  if (state.urgency && state.urgency !== "unspecified") {
    const urgencyLabels: Record<string, string> = {
      emergency: "ASAP",
      urgent: "Urgent — next few days",
      next_week: "Next week",
      next_2_weeks: "Within a couple of weeks",
      flexible: "Flexible timing",
      when_convenient: "Whenever suits",
    };
    parts.push(`Timing: ${urgencyLabels[state.urgency] || state.urgency}`);
  }
  if (state.customerName) parts.push(`Name: ${state.customerName}`);
  if (state.customerPhone) parts.push(`Phone: ${state.customerPhone}`);
  if (state.customerEmail) parts.push(`Email: ${state.customerEmail}`);

  return parts.join("\n");
}

/**
 * Generate system injection text for the chat model.
 */
export function generateSystemInjection(action: ConversationAction): string | null {
  switch (action.type) {
    case "present_estimate":
      return `[SYSTEM: Present this ROM estimate to the customer naturally. Use these words but adjust to flow with the conversation.]\n\nEstimate: ${action.wording}\n\nThen ask: ${action.expectationCheck}`;

    case "ask_contact":
      return `[SYSTEM: The customer has acknowledged the estimate. Now naturally ask for their contact details so Todd can follow up. Don't make it feel like a form — keep it conversational.]`;

    case "summarise_and_close":
      return `[SYSTEM: Intake is complete. Summarise what's been logged and let the customer know Todd will review and decide next steps. Keep it brief and warm.]\n\nSummary:\n${action.summary}`;

    case "needs_more_info":
      return `[SYSTEM: ${action.hint}]`;

    case "not_worth_pursuing":
      return `[SYSTEM: This lead is unlikely to convert. Wrap up politely — thank them for reaching out, say the job might not be the best fit for our schedule right now, and wish them well finding someone.]`;

    case "needs_site_visit":
      return `[SYSTEM: This job needs a site visit before pricing. Let the customer know that given what's described, Todd would want to take a quick look before committing to a price. Ask if they'd be happy for Todd to pop round for a look.]`;

    case "continue":
      return null;
  }
}
