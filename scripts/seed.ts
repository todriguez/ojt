/**
 * Seed database with realistic sample data.
 *
 * Usage: npx tsx scripts/seed.ts
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../src/lib/db/schema";

const DATA_DIR = process.env.PGLITE_DATA_DIR || "./pglite-data";

async function main() {
  console.log("Connecting...");
  const client = new PGlite(DATA_DIR);
  await client.waitReady;
  const db = drizzle(client, { schema });

  // ── Organisation ──────────────────────────
  const [org] = await db
    .insert(schema.organisations)
    .values({
      name: "Odd Job Todd",
      type: "sole_trader",
    })
    .returning();
  console.log("Created org:", org.name);

  // ── Operator (Todd) ───────────────────────
  const [todd] = await db
    .insert(schema.operators)
    .values({
      organisationId: org.id,
      name: "Todd",
      email: "todd@oddjobtodd.info",
      phone: "0412345678",
      status: "active",
      capabilityTags: ["carpentry", "doors_windows", "fencing", "painting", "general"],
    })
    .returning();
  console.log("Created operator:", todd.name);

  // ── Customers ─────────────────────────────
  const customerData = [
    { name: "Sarah Mitchell", mobile: "0423456789", email: "sarah.m@email.com", notes: "Repeat customer, very clear communicator" },
    { name: "Dave Cooper", mobile: "0434567890", email: "dave.cooper@email.com", notes: "Referred by Sarah" },
    { name: "Jenny Pham", mobile: "0445678901", email: "jenny.p@email.com", notes: "Tends to be price-sensitive" },
    { name: "Mark Thompson", mobile: "0456789012", email: null, notes: "Prefers phone calls, hard to reach by text" },
    { name: "Unknown Customer", mobile: "0467890123", email: null, notes: "Dropped off mid-conversation" },
  ];

  const customers = await db
    .insert(schema.customers)
    .values(customerData.map((c) => ({ ...c, organisationId: org.id })))
    .returning();
  console.log(`Created ${customers.length} customers`);

  // ── Sites ─────────────────────────────────
  const siteData = [
    { customerId: customers[0].id, suburb: "Noosa Heads", postcode: "4567", lat: "-26.3955", lng: "153.0937", accessNotes: "Park on street, side gate unlocked" },
    { customerId: customers[1].id, suburb: "Cooroy", postcode: "4563", lat: "-26.4174", lng: "152.9159", accessNotes: "Long driveway, dogs in yard — call before arriving" },
    { customerId: customers[2].id, suburb: "Peregian Beach", postcode: "4573", lat: "-26.4833", lng: "153.0833", accessNotes: "Unit 3, buzzer at front" },
    { customerId: customers[3].id, suburb: "Doonan", postcode: "4562", lat: "-26.4033", lng: "153.0631", accessNotes: "Acreage property, 4WD recommended in wet" },
    { customerId: customers[0].id, suburb: "Tewantin", postcode: "4565", lat: "-26.3889", lng: "153.0394", accessNotes: "Rental property, tenant aware" },
  ];

  const sites = await db.insert(schema.sites).values(siteData).returning();
  console.log(`Created ${sites.length} sites`);

  // ── Jobs ───────────────────────────────────
  const jobData = [
    {
      organisationId: org.id,
      customerId: customers[0].id,
      siteId: sites[0].id,
      assignedOperatorId: todd.id,
      leadSource: "website_chat" as const,
      jobType: "doors_windows" as const,
      subcategory: "door_replacement",
      descriptionRaw: "3 internal hollow core doors need replacing. Standard sizes. Ground floor, easy access. Doors are from the 70s and don't close properly anymore.",
      descriptionSummary: "Replace 3 internal doors — standard hollow core, ground floor, easy access",
      status: "ready_for_review" as const,
      urgency: "flexible" as const,
      effortBand: "half_day" as const,
      estimatedHoursMin: "3",
      estimatedHoursMax: "5",
      estimatedCostMin: 500,
      estimatedCostMax: 700,
      customerFitScore: 85,
      quoteWorthinessScore: 78,
      completenessScore: 90,
      serviceAreaOk: true,
    },
    {
      organisationId: org.id,
      customerId: customers[1].id,
      siteId: sites[1].id,
      leadSource: "referral" as const,
      jobType: "carpentry" as const,
      subcategory: "deck_repair",
      descriptionRaw: "Deck boards are soft and some are cracking. About 4x5 metres raised deck. Not sure if bearers are ok or just the boards.",
      descriptionSummary: "Deck repair — soft/cracking boards, 4x5m raised, bearers unknown",
      status: "needs_site_visit" as const,
      urgency: "next_2_weeks" as const,
      effortBand: "full_day" as const,
      estimatedHoursMin: "6",
      estimatedHoursMax: "10",
      estimatedCostMin: 800,
      estimatedCostMax: 1400,
      customerFitScore: 72,
      quoteWorthinessScore: 65,
      completenessScore: 60,
      requiresSiteVisit: true,
      serviceAreaOk: true,
    },
    {
      organisationId: org.id,
      customerId: customers[2].id,
      siteId: sites[2].id,
      leadSource: "facebook" as const,
      jobType: "carpentry" as const,
      subcategory: "cabinet_installation",
      descriptionRaw: "8 kitchen wall cupboards need mounting. Bought from IKEA. Plasterboard walls.",
      descriptionSummary: "Mount 8 IKEA wall cupboards — plasterboard walls",
      status: "estimate_presented" as const,
      urgency: "next_week" as const,
      effortBand: "full_day" as const,
      estimatedHoursMin: "6",
      estimatedHoursMax: "10",
      estimatedCostMin: 700,
      estimatedCostMax: 1200,
      customerFitScore: 55,
      quoteWorthinessScore: 60,
      completenessScore: 85,
      serviceAreaOk: true,
    },
    {
      organisationId: org.id,
      customerId: customers[3].id,
      siteId: sites[3].id,
      leadSource: "phone" as const,
      jobType: "fencing" as const,
      subcategory: "fence_repair",
      descriptionRaw: "Section of fence blown down in storm. About 6 metres. Hardwood posts, one snapped at ground level.",
      descriptionSummary: "Storm damage — 6m fence section down, snapped hardwood post",
      status: "new_lead" as const,
      urgency: "urgent" as const,
      effortBand: "half_day" as const,
      estimatedHoursMin: "3",
      estimatedHoursMax: "5",
      estimatedCostMin: 400,
      estimatedCostMax: 700,
      customerFitScore: 70,
      quoteWorthinessScore: 75,
      completenessScore: 70,
      serviceAreaOk: true,
    },
    {
      organisationId: org.id,
      customerId: customers[4].id,
      leadSource: "website_chat" as const,
      jobType: "general" as const,
      descriptionRaw: "need some stuff done at my place",
      status: "partial_intake" as const,
      urgency: "unspecified" as const,
      effortBand: "unknown" as const,
      customerFitScore: 20,
      quoteWorthinessScore: 10,
      completenessScore: 10,
    },
  ];

  const jobs = await db.insert(schema.jobs).values(jobData).returning();
  console.log(`Created ${jobs.length} jobs`);

  // ── Messages (sample conversation for door job) ─────
  const messageData = [
    { jobId: jobs[0].id, customerId: customers[0].id, senderType: "ai" as const, messageType: "text" as const, rawContent: "Hi! I'm Todd's job assistant. What do you need help with? You can type, send photos, or press the mic and talk me through it." },
    { jobId: jobs[0].id, customerId: customers[0].id, senderType: "customer" as const, messageType: "text" as const, rawContent: "Hi, I need 3 internal doors replaced. They're the old hollow core ones from the 70s and they don't close properly anymore." },
    { jobId: jobs[0].id, customerId: customers[0].id, senderType: "ai" as const, messageType: "text" as const, rawContent: "No worries — 3 internal doors, hollow core from the 70s. Are they standard sizes or anything unusual about the frames?" },
    { jobId: jobs[0].id, customerId: customers[0].id, senderType: "customer" as const, messageType: "text" as const, rawContent: "Standard sizes I think. The frames look fine, just the doors themselves are shot. Ground floor, easy to get to." },
    { jobId: jobs[0].id, customerId: customers[0].id, senderType: "ai" as const, messageType: "text" as const, rawContent: "That helps me picture it. What suburb is the job in?" },
    { jobId: jobs[0].id, customerId: customers[0].id, senderType: "customer" as const, messageType: "text" as const, rawContent: "Noosa Heads" },
    { jobId: jobs[0].id, customerId: customers[0].id, senderType: "ai" as const, messageType: "text" as const, rawContent: "This is usually a half-day type job depending what shows up once the old doors come off. Most jobs like this end up around $500–700 in labour, plus the cost of the doors themselves depending what you want to use. Just checking that sounds roughly in the ballpark before going further." },
    { jobId: jobs[0].id, customerId: customers[0].id, senderType: "customer" as const, messageType: "text" as const, rawContent: "Yeah that sounds about right. My name is Sarah Mitchell, 0423456789, sarah.m@email.com" },
    // Partial conversation for dropped-off job
    { jobId: jobs[4].id, customerId: customers[4].id, senderType: "ai" as const, messageType: "text" as const, rawContent: "Hi! I'm Todd's job assistant. What do you need help with?" },
    { jobId: jobs[4].id, customerId: customers[4].id, senderType: "customer" as const, messageType: "text" as const, rawContent: "need some stuff done at my place" },
    { jobId: jobs[4].id, customerId: customers[4].id, senderType: "ai" as const, messageType: "text" as const, rawContent: "No worries — can you give me a bit more detail about what needs doing? Happy to hear it however suits you." },
  ];

  const msgs = await db.insert(schema.messages).values(messageData).returning();
  console.log(`Created ${msgs.length} messages`);

  // ── Estimates ──────────────────────────────
  const estimateData = [
    {
      jobId: jobs[0].id,
      estimateType: "auto_rom" as const,
      effortBand: "half_day" as const,
      hoursMin: "3",
      hoursMax: "5",
      costMin: 500,
      costMax: 700,
      labourOnly: true,
      materialsNote: "Plus cost of 3 hollow core doors — customer to choose style",
      assumptionNotes: "Standard sizes, frames in good condition, ground floor easy access",
      customerAcknowledgedEstimate: true,
      acknowledgedAt: new Date(),
    },
    {
      jobId: jobs[2].id,
      estimateType: "auto_rom" as const,
      effortBand: "full_day" as const,
      hoursMin: "6",
      hoursMax: "10",
      costMin: 700,
      costMax: 1200,
      labourOnly: true,
      materialsNote: "Customer supplying IKEA cupboards. May need wall anchors for plasterboard — roughly $50-80 in fixings.",
      assumptionNotes: "8 wall units, plasterboard walls, need to find studs or use heavy-duty anchors",
    },
  ];

  await db.insert(schema.estimates).values(estimateData);
  console.log(`Created ${estimateData.length} estimates`);

  // ── State events ──────────────────────────
  const stateEvents = [
    { jobId: jobs[0].id, fromState: "new_lead" as const, toState: "partial_intake" as const, actorType: "system" as const, reason: "Customer started conversation" },
    { jobId: jobs[0].id, fromState: "partial_intake" as const, toState: "ready_for_review" as const, actorType: "system" as const, reason: "Intake complete — customer provided contact details and acknowledged ROM" },
    { jobId: jobs[1].id, fromState: "new_lead" as const, toState: "needs_site_visit" as const, actorType: "operator" as const, actorId: todd.id, reason: "Deck condition unclear, need to inspect bearers" },
    { jobId: jobs[2].id, fromState: "new_lead" as const, toState: "estimate_presented" as const, actorType: "system" as const, reason: "Auto ROM presented during intake" },
  ];

  await db.insert(schema.jobStateEvents).values(stateEvents);
  console.log(`Created ${stateEvents.length} state events`);

  console.log("\nSeed complete!");
  await client.close();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
