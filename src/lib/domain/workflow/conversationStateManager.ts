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
  | {
      /** Post-ROM: customer's ballpark-accepted; get contact + frame the
       *  next step as "Todd comes out for a free quote", not "we've
       *  booked the work". Gated by quote-worthiness so we don't offer
       *  a site visit for jobs that shouldn't get one. */
      type: "offer_free_quote_visit";
      reason: string;
    }
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

  // ── Estimate pushback — address concern before moving on ──
  if (
    state.estimatePresented &&
    (state.estimateAckStatus === "pushback" ||
     state.estimateAckStatus === "wants_exact_price" ||
     state.estimateAckStatus === "uncertain")
  ) {
    // Don't ask for contact or close — let the bot address the concern
    return { type: "continue" };
  }

  // ── Post-ROM flow: offer a free site quote ──
  // When the customer has acknowledged the ROM in a way that suggests
  // they're interested (accepted / tentative), and the job looks worth
  // Todd's time to visit, pivot explicitly to "Todd would come out for a
  // free quote" rather than silently asking for contact details as if
  // we've already agreed to the job. This is the whole pre-qualification
  // mechanic: the ROM gates the site-visit, the site-visit produces the
  // real quote.
  if (
    state.estimatePresented &&
    state.estimateAcknowledged &&
    (state.estimateAckStatus === "accepted" || state.estimateAckStatus === "tentative") &&
    !state.customerPhone &&
    !state.customerEmail
  ) {
    // Worthiness guard — if the job is clearly not worth a site visit
    // (low worthiness score, very low fit), we fall through to
    // not_worth_pursuing below rather than inviting Todd out.
    const worthy =
      (state.quoteWorthinessScore ?? 50) >= 35 &&
      (state.customerFitScore ?? 50) >= 25;
    if (worthy) {
      return {
        type: "offer_free_quote_visit",
        reason: "ROM accepted/tentative + job passes worthiness threshold — invite Todd for a free quote",
      };
    }
    // Low-worthiness with accepted ROM is a polite decline path.
    return {
      type: "not_worth_pursuing",
      reason: "ROM accepted but worthiness/fit scores too low to justify a site visit.",
    };
  }

  // ── Need contact details (fallback path for non-accepted states) ──
  if (
    state.estimatePresented &&
    state.estimateAcknowledged &&
    !state.customerPhone &&
    !state.customerEmail
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
      // If we know the trade, present the first-pass bracket instead of
      // grilling the customer. generateRomEstimate now widens the range
      // and labels it "first-pass bracket" — deterministic, gentle, and
      // tightens on the next turn as scope clarifies.
      if (state.jobType) {
        const romEstimate = generateRomEstimate({
          effortBand: "unknown",
          jobType: state.jobType,
          materials: state.materials,
          quantity: state.quantity,
        });
        if (romEstimate.costMax > 0) {
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
      // Only ask for more detail if we don't even know the trade
      if (state.scopeClarity < 30 || !state.jobType) {
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
      return `[SYSTEM: Present this ROUGH ORDER OF MAGNITUDE to the customer. The words below are already framed as ROM-not-quote — use them or lightly rephrase. Do NOT invent any number; the range below is the only range you're allowed to quote this turn. After the range, ask the expectation-check question so the customer self-qualifies on the ballpark.]\n\nROM: ${action.wording}\n\nThen ask: ${action.expectationCheck}`;

    case "ask_contact":
      return `[SYSTEM: The customer has acknowledged the ROM. The next step is a free on-site quote — not the job itself. Ask for contact details naturally, framed as "so Todd can get in touch to arrange a free on-site quote". Don't make it sound like we've booked the work.]`;

    case "offer_free_quote_visit":
      return `[SYSTEM: The customer's accepted the ROM as a workable ballpark. Todd's prepared to come out for a free on-site quote to turn that ballpark into a real number. Ask naturally for their name + phone/email so he can line up a time. Make clear the on-site quote is free and doesn't commit them to anything. Reason logged: ${action.reason}]`;

    case "summarise_and_close":
      return `[SYSTEM: Intake is complete. Summarise what's been logged and let the customer know Todd will review and reach out about a free on-site quote. Keep it brief and warm — no promises about dates, just that he'll be in touch.]\n\nSummary:\n${action.summary}`;

    case "needs_more_info":
      return `[SYSTEM: ${action.hint}]`;

    case "not_worth_pursuing":
      return `[SYSTEM: This lead isn't a strong fit for a free on-site quote visit. Wrap up politely — thank them for reaching out, say the job might not be the best fit for Todd's schedule right now, and wish them well finding someone. Do NOT offer a site visit. Do NOT ask for contact details.]`;

    case "needs_site_visit":
      return `[SYSTEM: This job needs a site visit before any ballpark — too many unknowns to quote even a ROM honestly. Let the customer know that given what's described, Todd would want to take a quick look before giving even a rough range. Ask if they'd be happy for him to pop round (this visit is free).]`;

    case "continue":
      return null;
  }
}
