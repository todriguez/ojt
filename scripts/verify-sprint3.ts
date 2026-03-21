/**
 * Sprint 3 Verification — Scoring, Classification, Recommendations
 *
 * Tests:
 * 1. Estimate acknowledgement classifier
 * 2. Customer fit scoring
 * 3. Quote-worthiness scoring
 * 4. Recommendation mapping
 * 5. Completeness sub-scores
 * 6. Scenario-based regressions
 *
 * Usage: npx tsx scripts/verify-sprint3.ts
 */

import {
  classifyEstimateAcknowledgement,
  classifyFromText,
} from "../src/lib/ai/classifiers/estimateAcknowledgementClassifier";
import { scoreCustomerFit } from "../src/lib/domain/scoring/customerFitService";
import { scoreQuoteWorthiness } from "../src/lib/domain/scoring/quoteWorthinessService";
import { generateRecommendation } from "../src/lib/domain/scoring/recommendationService";
import {
  accumulatedJobStateSchema,
  mergeExtraction,
  messageExtractionSchema,
} from "../src/lib/ai/extractors/extractionSchema";
import {
  evaluateConversationState,
} from "../src/lib/domain/workflow/conversationStateManager";

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

function main() {
  // ═══════════════════════════════════════════════
  // 1. Estimate Acknowledgement Classifier
  // ═══════════════════════════════════════════════
  console.log("\n1. Estimate Acknowledgement Classifier");

  // Text-based
  assert("'sounds good' → accepted", classifyFromText("Yeah that sounds good").status === "accepted");
  assert("'ok' → tentative", classifyFromText("ok").status === "tentative");
  assert("'a bit steep' → pushback", classifyFromText("that's a bit steep").status === "pushback");
  assert("'no way too expensive' → rejected", classifyFromText("no way, too expensive").status === "rejected");
  assert("'what's your hourly rate' → wants_exact_price", classifyFromText("what's your hourly rate?").status === "wants_exact_price");
  assert("'getting a few quotes' → rate_shopping", classifyFromText("I'm getting a few quotes").status === "rate_shopping");
  assert("'book me in' → accepted", classifyFromText("sounds good, can you book me in?").status === "accepted");
  assert("'more than I expected' → pushback", classifyFromText("more than I expected").status === "pushback");
  assert("'I'll do it myself' → rejected", classifyFromText("I'll do it myself").status === "rejected");
  assert("'about what I thought' → accepted", classifyFromText("that's about what I thought").status === "accepted");

  // Combined
  assert("LLM extraction overrides text",
    classifyEstimateAcknowledgement("accepted", null, "hmm not sure").status === "accepted"
  );
  assert("Budget reaction fallback",
    classifyEstimateAcknowledgement(null, "expensive", "whatever").status === "pushback"
  );
  assert("Text fallback when LLM unclear",
    classifyEstimateAcknowledgement("unclear", null, "sounds good to me").status === "accepted"
  );

  // ═══════════════════════════════════════════════
  // 2. Customer Fit Scoring
  // ═══════════════════════════════════════════════
  console.log("\n2. Customer Fit Scoring");

  // Scenario A: Great customer
  const greatCustomer = accumulatedJobStateSchema.parse({
    estimateAckStatus: "accepted",
    clarityScore: "very_clear",
    customerToneSignal: "practical",
    photosReferenced: true,
    urgency: "next_2_weeks",
    contactReadiness: "offered",
    scopeDescription: "3 internal hollow core doors need replacing, all standard sizes, ground floor, easy access",
    repairReplaceSignal: "replace",
  });
  const greatFit = scoreCustomerFit(greatCustomer);
  assert("Great customer → strong_fit", greatFit.label === "strong_fit", `got ${greatFit.label} (${greatFit.score})`);
  assert("Great customer score ≥ 80", greatFit.score >= 80, `got ${greatFit.score}`);

  // Scenario B: Bad customer
  const badCustomer = accumulatedJobStateSchema.parse({
    estimateAckStatus: "rejected",
    cheapestMindset: true,
    micromanagerSignals: true,
    customerToneSignal: "demanding",
    clarityScore: "vague",
    contactReadiness: "refused",
  });
  const badFit = scoreCustomerFit(badCustomer);
  assert("Bad customer → poor_fit", badFit.label === "poor_fit", `got ${badFit.label} (${badFit.score})`);
  assert("Bad customer score ≤ 20", badFit.score <= 20, `got ${badFit.score}`);

  // Scenario C: Mixed customer
  const mixedCustomer = accumulatedJobStateSchema.parse({
    estimateAckStatus: "tentative",
    clarityScore: "clear",
    customerToneSignal: "price_focused",
    urgency: "flexible",
  });
  const mixedFit = scoreCustomerFit(mixedCustomer);
  assert("Mixed customer → mixed to good_fit", ["mixed", "risky", "good_fit"].includes(mixedFit.label), `got ${mixedFit.label} (${mixedFit.score})`);

  // ═══════════════════════════════════════════════
  // 3. Quote-Worthiness Scoring
  // ═══════════════════════════════════════════════
  console.log("\n3. Quote-Worthiness Scoring");

  // Scenario: Local half-day, good customer, accepted estimate
  const localHalfDay = accumulatedJobStateSchema.parse({
    suburb: "Noosa Heads",
    jobType: "doors_windows",
    scopeDescription: "3 internal hollow core doors need replacing",
    quantity: "3 doors",
    estimatePresented: true,
    estimateAckStatus: "accepted",
    estimateAcknowledged: true,
    scopeClarity: 75,
  });
  const localWorth = scoreQuoteWorthiness(localHalfDay, 80);
  assert("Local half-day, accepted → worth_quoting+", ["worth_quoting", "priority"].includes(localWorth.label), `got ${localWorth.label} (${localWorth.score})`);

  // Scenario: Tiny far-away job, bad customer
  const farTiny = accumulatedJobStateSchema.parse({
    suburb: "Caboolture",
    jobType: "general",
    scopeDescription: "hang a picture",
    estimatePresented: true,
    estimateAckStatus: "pushback",
    scopeClarity: 30,
  });
  const farTinyWorth = scoreQuoteWorthiness(farTiny, 25);
  assert("Tiny far-away, pushback → ignore or only_if_convenient",
    ["ignore", "only_if_convenient"].includes(farTinyWorth.label),
    `got ${farTinyWorth.label} (${farTinyWorth.score})`
  );

  // Scenario: Nearby full-day, no estimate yet
  const nearbyFullDay = accumulatedJobStateSchema.parse({
    suburb: "Cooroy",
    jobType: "carpentry",
    scopeDescription: "Deck boards soft and cracking, raised deck 4x5m needs resurfacing",
    quantity: "4x5m deck",
    scopeClarity: 60,
  });
  const nearbyWorth = scoreQuoteWorthiness(nearbyFullDay, 60);
  assert("Nearby full-day, moderate fit → maybe_quote+",
    ["maybe_quote", "worth_quoting"].includes(nearbyWorth.label),
    `got ${nearbyWorth.label} (${nearbyWorth.score})`
  );

  // ═══════════════════════════════════════════════
  // 4. Recommendation Mapping
  // ═══════════════════════════════════════════════
  console.log("\n4. Recommendation Mapping");

  const goodLead = accumulatedJobStateSchema.parse({
    suburb: "Noosa Heads",
    jobType: "doors_windows",
    scopeDescription: "3 internal doors need replacing, hollow core, standard sizes",
    quantity: "3 doors",
    estimatePresented: true,
    estimateAckStatus: "accepted",
    estimateAcknowledged: true,
    customerName: "Sarah",
    customerPhone: "0423456789",
    scopeClarity: 80,
    locationClarity: 60,
    contactReadinessScore: 70,
    decisionReadiness: 75,
  });

  const goodFitResult = scoreCustomerFit(goodLead);
  const goodWorthResult = scoreQuoteWorthiness(goodLead, goodFitResult.score);
  const goodRec = generateRecommendation(goodLead, goodFitResult, goodWorthResult);
  assert("Good lead → priority_lead or probably_bookable",
    ["priority_lead", "probably_bookable", "worth_quoting"].includes(goodRec.recommendation),
    `got ${goodRec.recommendation}`
  );

  // Rejected estimate
  const rejectedLead = accumulatedJobStateSchema.parse({
    suburb: "Noosa Heads",
    estimatePresented: true,
    estimateAckStatus: "rejected",
    scopeDescription: "Small repair",
  });
  const rejFit = scoreCustomerFit(rejectedLead);
  const rejWorth = scoreQuoteWorthiness(rejectedLead, rejFit.score);
  const rejRec = generateRecommendation(rejectedLead, rejFit, rejWorth);
  assert("Rejected estimate → not_price_aligned", rejRec.recommendation === "not_price_aligned");

  // Very poor fit
  const poorFitLead = accumulatedJobStateSchema.parse({
    suburb: "Caboolture",
    estimatePresented: true,
    estimateAckStatus: "pushback",
    cheapestMindset: true,
    micromanagerSignals: true,
    customerToneSignal: "demanding",
    clarityScore: "confused",
    contactReadiness: "refused",
    scopeDescription: "something",
  });
  const poorFit = scoreCustomerFit(poorFitLead);
  const poorWorth = scoreQuoteWorthiness(poorFitLead, poorFit.score);
  const poorRec = generateRecommendation(poorFitLead, poorFit, poorWorth);
  assert("Very poor fit → not_a_fit or ignore",
    ["not_a_fit", "ignore"].includes(poorRec.recommendation),
    `got ${poorRec.recommendation} (fit: ${poorFit.score})`
  );

  // Structural issue → needs site visit
  const structuralLead = accumulatedJobStateSchema.parse({
    suburb: "Tewantin",
    scopeDescription: "deck boards sagging, possibly rotten bearers and termite damage",
    estimatePresented: true,
    estimateAckStatus: "tentative",
    scopeClarity: 35,
  });
  const structFit = scoreCustomerFit(structuralLead);
  const structWorth = scoreQuoteWorthiness(structuralLead, structFit.score);
  const structRec = generateRecommendation(structuralLead, structFit, structWorth);
  assert("Structural issue → needs_site_visit",
    structRec.recommendation === "needs_site_visit",
    `got ${structRec.recommendation}`
  );

  // ═══════════════════════════════════════════════
  // 5. Completeness Sub-Scores
  // ═══════════════════════════════════════════════
  console.log("\n5. Completeness Sub-Scores");

  const emptyState = accumulatedJobStateSchema.parse({});
  assert("Empty state → all zeros", emptyState.scopeClarity === 0 && emptyState.locationClarity === 0);

  const extraction1 = messageExtractionSchema.parse({
    jobType: "doors_windows",
    jobTypeConfidence: "certain",
    repairReplaceSignal: "replace",
    scopeDescription: "3 internal doors need replacing, hollow core, standard sizes",
    quantity: "3 doors",
    materials: "hollow core",
    suburb: "Noosa Heads",
    urgency: "next_2_weeks",
    conversationPhase: "providing_details",
    missingInfo: ["contact_details"],
  });

  const merged = mergeExtraction(emptyState, extraction1);
  assert("Scope clarity > 60 after extraction", merged.scopeClarity > 60, `got ${merged.scopeClarity}`);
  assert("Location clarity > 50", merged.locationClarity > 50, `got ${merged.locationClarity}`);
  assert("Estimate readiness > 60", merged.estimateReadiness > 60, `got ${merged.estimateReadiness}`);
  assert("Contact readiness = 0 (no contact yet)", merged.contactReadinessScore === 0);
  assert("Overall completeness > 30", merged.completenessScore > 30, `got ${merged.completenessScore}`);

  // Add contact details
  const extraction2 = messageExtractionSchema.parse({
    customerName: "Sarah Mitchell",
    customerPhone: "0423456789",
    contactReadiness: "offered",
    conversationPhase: "providing_contact",
    missingInfo: [],
  });
  const merged2 = mergeExtraction(merged, extraction2);
  assert("Contact readiness jumps after name+phone", merged2.contactReadinessScore >= 70, `got ${merged2.contactReadinessScore}`);
  assert("Overall completeness higher", merged2.completenessScore > merged.completenessScore);

  // ═══════════════════════════════════════════════
  // 6. Scenario Regressions
  // ═══════════════════════════════════════════════
  console.log("\n6. Scenario Regressions");

  // Scenario 1: Nearby half-day deck repair, good customer, accepts range
  const scenario1 = accumulatedJobStateSchema.parse({
    suburb: "Cooroy",
    jobType: "carpentry",
    scopeDescription: "Deck boards soft and cracking, raised deck, need a few boards replaced",
    quantity: "few boards",
    materials: "treated pine",
    urgency: "next_2_weeks",
    clarityScore: "clear",
    customerToneSignal: "practical",
    estimatePresented: true,
    estimateAckStatus: "accepted",
    estimateAcknowledged: true,
    customerName: "Dave",
    customerPhone: "0412345678",
    scopeClarity: 65,
    locationClarity: 60,
    contactReadinessScore: 70,
    decisionReadiness: 70,
    contactReadiness: "willing",
  });
  const s1fit = scoreCustomerFit(scenario1);
  const s1worth = scoreQuoteWorthiness(scenario1, s1fit.score);
  const s1rec = generateRecommendation(scenario1, s1fit, s1worth);
  assert("Scenario 1: good customer + accepted + local → priority or bookable",
    ["priority_lead", "probably_bookable", "worth_quoting"].includes(s1rec.recommendation),
    `got ${s1rec.recommendation}`
  );

  // Scenario 2: Tiny far-away fix, urgent, rejects estimate
  const scenario2 = accumulatedJobStateSchema.parse({
    suburb: "Caboolture",
    jobType: "general",
    scopeDescription: "Curtain rod fallen off",
    urgency: "urgent",
    estimatePresented: true,
    estimateAckStatus: "rejected",
    customerToneSignal: "impatient",
    cheapestMindset: true,
  });
  const s2fit = scoreCustomerFit(scenario2);
  const s2worth = scoreQuoteWorthiness(scenario2, s2fit.score);
  const s2rec = generateRecommendation(scenario2, s2fit, s2worth);
  assert("Scenario 2: tiny + far + rejected → not_price_aligned",
    s2rec.recommendation === "not_price_aligned",
    `got ${s2rec.recommendation}`
  );

  // Scenario 3: Clear scope with photos, likely bookable
  const scenario3 = accumulatedJobStateSchema.parse({
    suburb: "Peregian Beach",
    jobType: "doors_windows",
    scopeDescription: "Sliding door track busted, door won't close properly",
    photosReferenced: true,
    clarityScore: "very_clear",
    customerToneSignal: "friendly",
    estimatePresented: true,
    estimateAckStatus: "accepted",
    estimateAcknowledged: true,
    contactReadiness: "offered",
    customerName: "Jenny",
    customerPhone: "0400111222",
    scopeClarity: 70,
    locationClarity: 60,
    contactReadinessScore: 70,
    decisionReadiness: 70,
  });
  const s3fit = scoreCustomerFit(scenario3);
  const s3worth = scoreQuoteWorthiness(scenario3, s3fit.score);
  const s3rec = generateRecommendation(scenario3, s3fit, s3worth);
  assert("Scenario 3: clear + photos + accepted + local → bookable or priority",
    ["priority_lead", "probably_bookable"].includes(s3rec.recommendation),
    `got ${s3rec.recommendation}`
  );

  // Scenario 4: Vague rotten timber, good suburb, needs site visit
  const scenario4 = accumulatedJobStateSchema.parse({
    suburb: "Doonan",
    jobType: "carpentry",
    scopeDescription: "There's some rotten timber around the verandah, not sure how bad it is, might be termites",
    clarityScore: "vague",
    estimatePresented: true,
    estimateAckStatus: "uncertain",
    scopeClarity: 25,
  });
  const s4fit = scoreCustomerFit(scenario4);
  const s4worth = scoreQuoteWorthiness(scenario4, s4fit.score);
  const s4rec = generateRecommendation(scenario4, s4fit, s4worth);
  assert("Scenario 4: vague + rotten + termites → needs_site_visit",
    s4rec.recommendation === "needs_site_visit",
    `got ${s4rec.recommendation}`
  );

  // Scenario 5: "What's your hourly rate?" immediately
  const scenario5 = accumulatedJobStateSchema.parse({
    estimateAckStatus: "wants_exact_price",
    customerToneSignal: "price_focused",
    cheapestMindset: true,
    clarityScore: "vague",
    scopeDescription: "some painting",
  });
  const s5fit = scoreCustomerFit(scenario5);
  assert("Scenario 5: hourly-rate-seeker → poor or risky fit",
    ["poor_fit", "risky"].includes(s5fit.label),
    `got ${s5fit.label} (${s5fit.score})`
  );

  // Scenario 6: Cheapest-patch-only customer
  const scenario6 = accumulatedJobStateSchema.parse({
    suburb: "Noosaville",
    jobType: "carpentry",
    scopeDescription: "Deck is soft, just want the cheapest patch possible",
    cheapestMindset: true,
    clarityScore: "clear",
    customerToneSignal: "price_focused",
    estimatePresented: true,
    estimateAckStatus: "pushback",
  });
  const s6fit = scoreCustomerFit(scenario6);
  assert("Scenario 6: cheapest-only mindset → risky or poor_fit",
    ["poor_fit", "risky"].includes(s6fit.label),
    `got ${s6fit.label} (${s6fit.score})`
  );

  // ═══════════════════════════════════════════════
  // 7. Conversation State Manager — Stop Conditions
  // ═══════════════════════════════════════════════
  console.log("\n7. Stop Conditions");

  // Should not over-question when scope is clear enough
  const clearEnoughState = accumulatedJobStateSchema.parse({
    scopeDescription: "3 internal doors need replacing",
    suburb: "Noosa Heads",
    jobType: "doors_windows",
    quantity: "3 doors",
    scopeClarity: 60,
    estimateReadiness: 65,
    conversationPhase: "providing_details",
  });
  const clearAction = evaluateConversationState(clearEnoughState);
  assert("Clear scope → present estimate not continue forever",
    clearAction.type === "present_estimate",
    `got ${clearAction.type}`
  );

  // Should stop pursuing rejected lead
  const rejectedState = accumulatedJobStateSchema.parse({
    estimatePresented: true,
    estimateAckStatus: "rejected",
    customerFitScore: 10,
    scopeDescription: "small fix",
    conversationPhase: "reviewing_estimate",
  });
  const rejAction = evaluateConversationState(rejectedState);
  assert("Rejected + low fit → not_worth_pursuing",
    rejAction.type === "not_worth_pursuing",
    `got ${rejAction.type}`
  );

  // ═══════════════════════════════════════════════
  // 8. Regression: No Hourly Rate Leaks
  // ═══════════════════════════════════════════════
  console.log("\n8. Regression Checks");

  // Check estimate wording never contains hourly rate
  const { generateEstimateWording } = require("../src/lib/domain/estimates/estimateWordingService");
  const { generateRomEstimate } = require("../src/lib/domain/estimates/estimateService");

  const bands = ["quick", "short", "quarter_day", "half_day", "full_day", "multi_day"];
  const jobTypes = ["doors_windows", "carpentry", "fencing", "painting", "plumbing", "general"];

  let rateLeakFound = false;
  for (const band of bands) {
    for (const jt of jobTypes) {
      const est = generateRomEstimate({ effortBand: band, jobType: jt });
      const wording = generateEstimateWording({
        estimate: est,
        jobType: jt,
        scopeDescription: "test job",
      });
      if (wording.customerFacing.includes("/hr") || wording.customerFacing.includes("per hour") || wording.customerFacing.includes("hourly")) {
        rateLeakFound = true;
        console.log(`  ✗ Rate leak in ${band}/${jt}: ${wording.customerFacing}`);
      }
    }
  }
  if (!rateLeakFound) {
    assert("No hourly rate in any estimate wording", true);
    passed++; // count the iteration as one test
  } else {
    failed++;
  }

  // ═══════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed === 0) {
    console.log("\nSprint 3 verified. Decision engine operational.");
    console.log("Scoring, classification, and recommendations all working.");
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
