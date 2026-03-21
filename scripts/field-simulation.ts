/**
 * Field Simulation Test Pack
 *
 * 10 realistic customer conversations run through the full pipeline.
 * Each scenario has expected outcomes so we can measure extraction quality.
 *
 * Usage: npx tsx scripts/field-simulation.ts
 */

// Set env BEFORE any module imports
process.env.PGLITE_DATA_DIR = "memory://";

import fs from "fs";
const envContent = fs.readFileSync(".env.local", "utf-8");
for (const line of envContent.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

interface Scenario {
  name: string;
  messages: string[];
  expected: {
    jobType: string;
    suburb: string | null;
    effortBand: string;
    estimatePresented: boolean;
    customerFitLabel: string;       // expected range: "poor_fit" | "risky" | "mixed" | "good_fit" | "strong_fit"
    quoteWorthinessLabel: string;   // expected range
    recommendation: string;         // expected range
  };
}

const SCENARIOS: Scenario[] = [
  // 1. Nearby half-day deck repair, good customer, accepts range
  {
    name: "1. Deck repair — Cooroy, good customer",
    messages: [
      "Hi, I've got a raised timber deck out the back, about 4x5m. A few of the boards have gone soft and one's cracked right through. It's in Cooroy.",
      "Yeah it's merbau, about 15 years old. The frame seems fine, it's just the decking boards on top. Maybe 6 or 7 boards need doing.",
      "Ground level access from the yard, no issues there. Would love to get it sorted in the next couple of weeks.",
    ],
    expected: {
      jobType: "carpentry",
      suburb: "Cooroy",
      effortBand: "half_day",
      estimatePresented: true,
      customerFitLabel: "good_fit",
      quoteWorthinessLabel: "worth_quoting",
      recommendation: "worth_quoting",
    },
  },
  // 2. Tiny far-away fix, urgent, likely rejects
  {
    name: "2. Curtain rod — Caboolture, impatient",
    messages: [
      "My curtain rod fell off the wall can someone come fix it today? I'm in Caboolture",
      "It's just one rod, plasterboard wall. The anchor pulled out.",
      "How much? I was hoping like $50 or something, it's literally just screwing something back in",
    ],
    expected: {
      jobType: "general",
      suburb: "Caboolture",
      effortBand: "quick",
      estimatePresented: true,
      customerFitLabel: "risky",
      quoteWorthinessLabel: "ignore",
      recommendation: "ignore",
    },
  },
  // 3. Sliding door — Peregian Beach, clear with photos, bookable
  {
    name: "3. Sliding door — Peregian Beach, clear scope",
    messages: [
      "Hey, the track on my sliding glass door is busted. Door won't close properly anymore. I'm at Peregian Beach.",
      "It's the main living room slider, about 2.4m wide. The bottom track is bent. I can send photos if that helps.",
      "No rush, whenever you've got a gap in the next few weeks is fine. It still closes, just takes a shove.",
    ],
    expected: {
      jobType: "doors_windows",
      suburb: "Peregian Beach",
      effortBand: "short",
      estimatePresented: true,
      customerFitLabel: "good_fit",
      quoteWorthinessLabel: "worth_quoting",
      recommendation: "worth_quoting",
    },
  },
  // 4. Rotten verandah — Doonan, vague, needs site visit
  {
    name: "4. Rotten verandah — Doonan, vague scope",
    messages: [
      "G'day, got some rotten timber on the front verandah. Not sure how bad it is but it's getting worse. We're out at Doonan.",
      "It's an old Queenslander, the verandah wraps around. Could be termites I dunno. The boards are spongy in a few spots and one of the posts feels a bit dodgy.",
      "I'm not in a rush, just want someone to have a look and tell me what needs doing before it gets worse.",
    ],
    expected: {
      jobType: "carpentry",
      suburb: "Doonan",
      effortBand: "unknown",
      estimatePresented: false,
      customerFitLabel: "mixed",
      quoteWorthinessLabel: "maybe_quote",
      recommendation: "needs_site_visit",
    },
  },
  // 5. Hourly rate seeker — immediately price focused
  {
    name: "5. Hourly rate seeker — price focused",
    messages: [
      "What's your hourly rate?",
      "I just need someone for a few hours to do some odd jobs around the house. Noosaville. Want to know what you charge per hour before we go further.",
      "Look I've had quotes from other guys for $45/hr, can you match that?",
    ],
    expected: {
      jobType: "general",
      suburb: "Noosaville",
      effortBand: "unknown",
      estimatePresented: false,
      customerFitLabel: "poor_fit",
      quoteWorthinessLabel: "ignore",
      recommendation: "not_a_fit",
    },
  },
  // 6. 3 internal doors — Noosa Heads (the classic)
  {
    name: "6. 3 doors — Noosa Heads, textbook lead",
    messages: [
      "Hey, I've got 3 internal doors that need replacing. They're all standard hollow core, nothing fancy. House is in Noosa Heads.",
      "All ground floor, easy access. Frames are fine, just the doors themselves. Would like it done in the next couple of weeks.",
      "Yeah that sounds about right, go ahead. My name's Sarah, 0423 456 789.",
    ],
    expected: {
      jobType: "doors_windows",
      suburb: "Noosa Heads",
      effortBand: "half_day",
      estimatePresented: true,
      customerFitLabel: "strong_fit",
      quoteWorthinessLabel: "priority",
      recommendation: "priority_lead",
    },
  },
  // 7. Fence — Tewantin, side boundary, decent scope
  {
    name: "7. Fence — Tewantin, side boundary",
    messages: [
      "Need a side fence replaced. About 12 metres, timber palings. The posts have rotted through. In Tewantin.",
      "It's a flat block, easy access both sides. Neighbour's happy to go halves. Standard 1.8m height colorbond would be fine actually.",
      "Whenever suits in the next month or so. Can you give me a rough idea on cost?",
    ],
    expected: {
      jobType: "fencing",
      suburb: "Tewantin",
      effortBand: "full_day",
      estimatePresented: true,
      customerFitLabel: "good_fit",
      quoteWorthinessLabel: "worth_quoting",
      recommendation: "worth_quoting",
    },
  },
  // 8. Painting — 2 rooms, Sunshine Beach, straightforward
  {
    name: "8. Painting — Sunshine Beach, 2 rooms",
    messages: [
      "Hi, I need two bedrooms repainted. Standard size rooms, white walls. We're in Sunshine Beach.",
      "Ceilings are fine, just the walls. No wallpaper or anything weird. Probably need a bit of patch filling in one room where we had shelves.",
      "Flexible on timing, just whenever you have a gap. How much roughly?",
    ],
    expected: {
      jobType: "painting",
      suburb: "Sunshine Beach",
      effortBand: "half_day",
      estimatePresented: true,
      customerFitLabel: "good_fit",
      quoteWorthinessLabel: "worth_quoting",
      recommendation: "worth_quoting",
    },
  },
  // 9. Cheapest-patch customer — wants minimum effort
  {
    name: "9. Cheapest patch — deck, Noosaville",
    messages: [
      "Deck's got some soft spots. Just want the cheapest fix possible, don't need it perfect. Noosaville.",
      "Can you just screw some new boards over the top of the old ones? I don't want to spend much on it. It's a rental.",
      "What's the absolute cheapest you can do it for? I've got a tenant moving in next week.",
    ],
    expected: {
      jobType: "carpentry",
      suburb: "Noosaville",
      effortBand: "quarter_day",
      estimatePresented: true,
      customerFitLabel: "risky",
      quoteWorthinessLabel: "only_if_convenient",
      recommendation: "only_if_nearby",
    },
  },
  // 10. Plumbing — Eumundi, hot water, clear and practical
  {
    name: "10. Hot water — Eumundi, practical customer",
    messages: [
      "Hot water system is on the blink. Takes ages to heat up and the pressure's dropped. We're in Eumundi.",
      "It's electric, maybe 12 years old. Mounted on the outside wall, easy to get to. No leaks that I can see.",
      "Happy to get it looked at whenever you're free this week or next. If it needs replacing I'd rather know upfront.",
    ],
    expected: {
      jobType: "plumbing",
      suburb: "Eumundi",
      effortBand: "quarter_day",
      estimatePresented: true,
      customerFitLabel: "good_fit",
      quoteWorthinessLabel: "worth_quoting",
      recommendation: "worth_quoting",
    },
  },
];

async function main() {
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const { eq } = await import("drizzle-orm");
  const path = await import("path");
  const { getDb } = await import("../src/lib/db/client");
  const schema = await import("../src/lib/db/schema");
  const { processCustomerMessage } = await import("../src/lib/services/chatService");

  console.log("🔧 Setting up database...\n");
  const db = await getDb();
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });

  const [org] = await db
    .insert(schema.organisations)
    .values({ name: "Odd Job Todd", type: "sole_trader" })
    .returning();

  const results: Array<{
    name: string;
    extractedFields: Record<string, unknown>;
    scores: Record<string, unknown>;
    matches: string[];
    misses: string[];
  }> = [];

  for (const scenario of SCENARIOS) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`📋 ${scenario.name}`);
    console.log(`${"─".repeat(60)}`);

    // Create a fresh job for each scenario
    const [job] = await db
      .insert(schema.jobs)
      .values({ organisationId: org.id, leadSource: "website_chat", status: "new_lead" })
      .returning();

    await db.insert(schema.jobStateEvents).values({
      jobId: job.id, fromState: "new_lead", toState: "new_lead", actorType: "system", reason: "Sim start",
    });

    let lastResult: any = null;

    for (let i = 0; i < scenario.messages.length; i++) {
      const msg = scenario.messages[i];
      console.log(`\n  💬 Customer: "${msg.substring(0, 80)}${msg.length > 80 ? "..." : ""}"`);

      try {
        lastResult = await processCustomerMessage({
          jobId: job.id,
          customerId: "",
          message: msg,
        });

        console.log(`  🤖 AI: "${lastResult.reply.substring(0, 100)}${lastResult.reply.length > 100 ? "..." : ""}"`);
        console.log(`     Phase: ${lastResult.conversationPhase} | Complete: ${lastResult.completenessScore} | Est: ${lastResult.estimatePresented}`);
        console.log(`     Fit: ${lastResult.customerFitScore} (${lastResult.customerFitLabel}) | Worth: ${lastResult.quoteWorthinessScore} (${lastResult.quoteWorthinessLabel})`);
        console.log(`     Rec: ${lastResult.recommendation} | Ack: ${lastResult.estimateAckStatus}`);
      } catch (err: any) {
        console.error(`  ✗ Error: ${err.message}`);
        break;
      }
    }

    if (!lastResult) continue;

    // Check final state against expectations
    const [finalJob] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    const meta = (finalJob.metadata && typeof finalJob.metadata === "object")
      ? finalJob.metadata as Record<string, unknown>
      : {};

    const matches: string[] = [];
    const misses: string[] = [];
    const exp = scenario.expected;

    // Job type
    const gotJobType = meta.jobType || finalJob.jobType;
    if (gotJobType === exp.jobType) matches.push(`jobType: ${gotJobType}`);
    else misses.push(`jobType: expected ${exp.jobType}, got ${gotJobType}`);

    // Suburb
    const gotSuburb = meta.suburb as string | null;
    if (gotSuburb?.toLowerCase() === exp.suburb?.toLowerCase()) matches.push(`suburb: ${gotSuburb}`);
    else if (!exp.suburb && !gotSuburb) matches.push("suburb: null (correct)");
    else misses.push(`suburb: expected ${exp.suburb}, got ${gotSuburb}`);

    // Estimate presented
    if (lastResult.estimatePresented === exp.estimatePresented) matches.push(`estimatePresented: ${lastResult.estimatePresented}`);
    else misses.push(`estimatePresented: expected ${exp.estimatePresented}, got ${lastResult.estimatePresented}`);

    // Customer fit (accept a range: exact or adjacent)
    const fitLabels = ["poor_fit", "risky", "mixed", "good_fit", "strong_fit"];
    const expFitIdx = fitLabels.indexOf(exp.customerFitLabel);
    const gotFitIdx = fitLabels.indexOf(lastResult.customerFitLabel || "");
    if (Math.abs(expFitIdx - gotFitIdx) <= 1) matches.push(`customerFit: ${lastResult.customerFitLabel} (expected ${exp.customerFitLabel})`);
    else misses.push(`customerFit: expected ${exp.customerFitLabel}, got ${lastResult.customerFitLabel} (${lastResult.customerFitScore})`);

    // Quote worthiness (accept adjacent)
    const worthLabels = ["ignore", "only_if_convenient", "maybe_quote", "worth_quoting", "priority"];
    const expWorthIdx = worthLabels.indexOf(exp.quoteWorthinessLabel);
    const gotWorthIdx = worthLabels.indexOf(lastResult.quoteWorthinessLabel || "");
    if (Math.abs(expWorthIdx - gotWorthIdx) <= 1) matches.push(`worthiness: ${lastResult.quoteWorthinessLabel} (expected ${exp.quoteWorthinessLabel})`);
    else misses.push(`worthiness: expected ${exp.quoteWorthinessLabel}, got ${lastResult.quoteWorthinessLabel} (${lastResult.quoteWorthinessScore})`);

    // Recommendation (accept a few related values)
    const recMatches: Record<string, string[]> = {
      priority_lead: ["priority_lead", "probably_bookable", "worth_quoting"],
      probably_bookable: ["priority_lead", "probably_bookable", "worth_quoting"],
      worth_quoting: ["priority_lead", "probably_bookable", "worth_quoting", "maybe_quote"],
      needs_site_visit: ["needs_site_visit", "worth_quoting"],
      not_a_fit: ["not_a_fit", "ignore", "not_price_aligned"],
      not_price_aligned: ["not_price_aligned", "not_a_fit", "ignore"],
      ignore: ["ignore", "only_if_nearby", "not_a_fit"],
      only_if_nearby: ["only_if_nearby", "ignore", "maybe_quote"],
      maybe_quote: ["maybe_quote", "worth_quoting", "only_if_nearby"],
    };
    const acceptable = recMatches[exp.recommendation] || [exp.recommendation];
    if (acceptable.includes(lastResult.recommendation)) matches.push(`rec: ${lastResult.recommendation} (expected ${exp.recommendation})`);
    else misses.push(`rec: expected ${exp.recommendation}, got ${lastResult.recommendation}`);

    results.push({
      name: scenario.name,
      extractedFields: {
        jobType: gotJobType,
        suburb: gotSuburb,
        effortBand: finalJob.effortBand,
        urgency: meta.urgency,
        scopeDescription: meta.scopeDescription,
        quantity: meta.quantity,
        materials: meta.materials,
        repairReplaceSignal: meta.repairReplaceSignal,
        customerToneSignal: meta.customerToneSignal,
        clarityScore: meta.clarityScore,
      },
      scores: {
        completeness: lastResult.completenessScore,
        customerFit: `${lastResult.customerFitScore} (${lastResult.customerFitLabel})`,
        quoteWorthiness: `${lastResult.quoteWorthinessScore} (${lastResult.quoteWorthinessLabel})`,
        recommendation: lastResult.recommendation,
        estimatePresented: lastResult.estimatePresented,
        estimateAck: lastResult.estimateAckStatus,
      },
      matches,
      misses,
    });

    console.log(`\n  ✅ Matches: ${matches.length}`);
    for (const m of matches) console.log(`     ✓ ${m}`);
    if (misses.length > 0) {
      console.log(`  ⚠ Misses: ${misses.length}`);
      for (const m of misses) console.log(`     ✗ ${m}`);
    }
  }

  // ═══════════════════════════════════════════════
  // Summary Report
  // ═══════════════════════════════════════════════
  console.log(`\n${"═".repeat(60)}`);
  console.log("FIELD SIMULATION SUMMARY");
  console.log(`${"═".repeat(60)}\n`);

  let totalMatches = 0;
  let totalMisses = 0;
  const missDetails: string[] = [];

  for (const r of results) {
    totalMatches += r.matches.length;
    totalMisses += r.misses.length;
    const status = r.misses.length === 0 ? "✅" : `⚠ (${r.misses.length} miss)`;
    console.log(`${status}  ${r.name}`);
    if (r.misses.length > 0) {
      for (const m of r.misses) {
        console.log(`      ✗ ${m}`);
        missDetails.push(`${r.name}: ${m}`);
      }
    }
  }

  const total = totalMatches + totalMisses;
  const pct = Math.round((totalMatches / total) * 100);
  console.log(`\nOverall: ${totalMatches}/${total} checks passed (${pct}%)`);

  if (missDetails.length > 0) {
    console.log(`\n--- Top extraction gaps ---`);
    for (const d of missDetails) console.log(`  • ${d}`);
  }

  console.log(`\n--- Extraction field coverage ---`);
  let filledCount = 0;
  let emptyCount = 0;
  for (const r of results) {
    for (const [key, val] of Object.entries(r.extractedFields)) {
      if (val) filledCount++;
      else emptyCount++;
    }
  }
  console.log(`  Filled: ${filledCount}, Empty: ${emptyCount} (${Math.round((filledCount / (filledCount + emptyCount)) * 100)}% fill rate)`);

  process.exit(totalMisses > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
