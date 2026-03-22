/**
 * Combined migrate + seed script.
 * Uses a fresh PGlite data dir each time.
 *
 * Usage: npx tsx scripts/setup-db.ts
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../src/lib/db/schema";
import {
  getAllCategories,
  TRANSACTION_TYPES,
  INSTRUMENT_TYPES,
} from "../src/lib/domain/categories/categoryTree";
import { sql } from "drizzle-orm";
import * as fs from "fs";
import * as path from "path";

const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(process.cwd(), "pglite-data-v2");

async function main() {
  // Clean start if data dir exists
  if (fs.existsSync(DATA_DIR)) {
    console.log("Removing existing data dir...");
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log("Initializing PGlite at", DATA_DIR);
  const client = new PGlite(DATA_DIR);
  await client.waitReady;
  const db = drizzle(client, { schema });

  // ── Migrate ─────────────────────────────
  console.log("Running migrations...");
  await migrate(db, { migrationsFolder: "./drizzle" });

  const tables = await client.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
  );
  console.log("Tables:", tables.rows.map((r: any) => r.table_name).join(", "));

  // ── Seed ────────────────────────────────
  console.log("\nSeeding data...");

  // Organisation
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: "Odd Job Todd", type: "sole_trader" })
    .returning();
  console.log("  org:", org.name);

  // Operator
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
  console.log("  operator:", todd.name);

  // Customers
  const customers = await db
    .insert(schema.customers)
    .values([
      { organisationId: org.id, name: "Sarah Mitchell", mobile: "0423456789", email: "sarah.m@email.com", notes: "Repeat customer, very clear communicator" },
      { organisationId: org.id, name: "Dave Cooper", mobile: "0434567890", email: "dave.cooper@email.com", notes: "Referred by Sarah" },
      { organisationId: org.id, name: "Jenny Pham", mobile: "0445678901", email: "jenny.p@email.com", notes: "Tends to be price-sensitive" },
      { organisationId: org.id, name: "Mark Thompson", mobile: "0456789012", notes: "Prefers phone calls" },
      { organisationId: org.id, name: "Unknown Customer", mobile: "0467890123", notes: "Dropped off mid-conversation" },
    ])
    .returning();
  console.log(`  ${customers.length} customers`);

  // Sites
  const sites = await db
    .insert(schema.sites)
    .values([
      { customerId: customers[0].id, suburb: "Noosa Heads", postcode: "4567", lat: "-26.3955", lng: "153.0937", accessNotes: "Park on street, side gate unlocked" },
      { customerId: customers[1].id, suburb: "Cooroy", postcode: "4563", lat: "-26.4174", lng: "152.9159", accessNotes: "Long driveway, dogs in yard — call before arriving" },
      { customerId: customers[2].id, suburb: "Peregian Beach", postcode: "4573", lat: "-26.4833", lng: "153.0833", accessNotes: "Unit 3, buzzer at front" },
      { customerId: customers[3].id, suburb: "Doonan", postcode: "4562", lat: "-26.4033", lng: "153.0631", accessNotes: "Acreage property, 4WD recommended in wet" },
      { customerId: customers[0].id, suburb: "Tewantin", postcode: "4565", lat: "-26.3889", lng: "153.0394", accessNotes: "Rental property, tenant aware" },
    ])
    .returning();
  console.log(`  ${sites.length} sites`);

  // Jobs
  const jobs = await db
    .insert(schema.jobs)
    .values([
      {
        organisationId: org.id, customerId: customers[0].id, siteId: sites[0].id,
        assignedOperatorId: todd.id, leadSource: "website_chat", jobType: "doors_windows",
        subcategory: "door_replacement",
        descriptionRaw: "3 internal hollow core doors need replacing. Standard sizes. Ground floor, easy access. Doors are from the 70s and don't close properly anymore.",
        descriptionSummary: "Replace 3 internal doors — standard hollow core, ground floor, easy access",
        status: "ready_for_review", urgency: "flexible", effortBand: "half_day",
        estimatedHoursMin: "3", estimatedHoursMax: "5", estimatedCostMin: 500, estimatedCostMax: 700,
        customerFitScore: 85, quoteWorthinessScore: 78, completenessScore: 90, serviceAreaOk: true,
      },
      {
        organisationId: org.id, customerId: customers[1].id, siteId: sites[1].id,
        leadSource: "referral", jobType: "carpentry", subcategory: "deck_repair",
        descriptionRaw: "Deck boards are soft and some are cracking. About 4x5 metres raised deck. Not sure if bearers are ok or just the boards.",
        descriptionSummary: "Deck repair — soft/cracking boards, 4x5m raised, bearers unknown",
        status: "needs_site_visit", urgency: "next_2_weeks", effortBand: "full_day",
        estimatedHoursMin: "6", estimatedHoursMax: "10", estimatedCostMin: 800, estimatedCostMax: 1400,
        customerFitScore: 72, quoteWorthinessScore: 65, completenessScore: 60,
        requiresSiteVisit: true, serviceAreaOk: true,
      },
      {
        organisationId: org.id, customerId: customers[2].id, siteId: sites[2].id,
        leadSource: "facebook", jobType: "carpentry", subcategory: "cabinet_installation",
        descriptionRaw: "8 kitchen wall cupboards need mounting. Bought from IKEA. Plasterboard walls.",
        descriptionSummary: "Mount 8 IKEA wall cupboards — plasterboard walls",
        status: "estimate_presented", urgency: "next_week", effortBand: "full_day",
        estimatedHoursMin: "6", estimatedHoursMax: "10", estimatedCostMin: 700, estimatedCostMax: 1200,
        customerFitScore: 55, quoteWorthinessScore: 60, completenessScore: 85, serviceAreaOk: true,
      },
      {
        organisationId: org.id, customerId: customers[3].id, siteId: sites[3].id,
        leadSource: "phone", jobType: "fencing", subcategory: "fence_repair",
        descriptionRaw: "Section of fence blown down in storm. About 6 metres. Hardwood posts, one snapped at ground level.",
        descriptionSummary: "Storm damage — 6m fence section down, snapped hardwood post",
        status: "new_lead", urgency: "urgent", effortBand: "half_day",
        estimatedHoursMin: "3", estimatedHoursMax: "5", estimatedCostMin: 400, estimatedCostMax: 700,
        customerFitScore: 70, quoteWorthinessScore: 75, completenessScore: 70, serviceAreaOk: true,
      },
      {
        organisationId: org.id, customerId: customers[4].id,
        leadSource: "website_chat", jobType: "general",
        descriptionRaw: "need some stuff done at my place",
        status: "partial_intake", urgency: "unspecified", effortBand: "unknown",
        customerFitScore: 20, quoteWorthinessScore: 10, completenessScore: 10,
      },
    ])
    .returning();
  console.log(`  ${jobs.length} jobs`);

  // Messages
  const msgs = await db
    .insert(schema.messages)
    .values([
      { jobId: jobs[0].id, customerId: customers[0].id, senderType: "ai", messageType: "text", rawContent: "Hi! I'm Todd's job assistant. What do you need help with? You can type, send photos, or press the mic and talk me through it." },
      { jobId: jobs[0].id, customerId: customers[0].id, senderType: "customer", messageType: "text", rawContent: "Hi, I need 3 internal doors replaced. They're the old hollow core ones from the 70s and they don't close properly anymore." },
      { jobId: jobs[0].id, customerId: customers[0].id, senderType: "ai", messageType: "text", rawContent: "No worries — 3 internal doors, hollow core from the 70s. Are they standard sizes or anything unusual about the frames?" },
      { jobId: jobs[0].id, customerId: customers[0].id, senderType: "customer", messageType: "text", rawContent: "Standard sizes I think. The frames look fine, just the doors themselves are shot. Ground floor, easy to get to." },
      { jobId: jobs[0].id, customerId: customers[0].id, senderType: "ai", messageType: "text", rawContent: "That helps me picture it. What suburb is the job in?" },
      { jobId: jobs[0].id, customerId: customers[0].id, senderType: "customer", messageType: "text", rawContent: "Noosa Heads" },
      { jobId: jobs[0].id, customerId: customers[0].id, senderType: "ai", messageType: "text", rawContent: "This is usually a half-day type job depending what shows up once the old doors come off. Most jobs like this end up around $500–700 in labour, plus the cost of the doors themselves depending what you want to use. Just checking that sounds roughly in the ballpark before going further." },
      { jobId: jobs[0].id, customerId: customers[0].id, senderType: "customer", messageType: "text", rawContent: "Yeah that sounds about right. My name is Sarah Mitchell, 0423456789, sarah.m@email.com" },
      { jobId: jobs[4].id, customerId: customers[4].id, senderType: "ai", messageType: "text", rawContent: "Hi! I'm Todd's job assistant. What do you need help with?" },
      { jobId: jobs[4].id, customerId: customers[4].id, senderType: "customer", messageType: "text", rawContent: "need some stuff done at my place" },
      { jobId: jobs[4].id, customerId: customers[4].id, senderType: "ai", messageType: "text", rawContent: "No worries — can you give me a bit more detail about what needs doing? Happy to hear it however suits you." },
    ])
    .returning();
  console.log(`  ${msgs.length} messages`);

  // Estimates
  await db.insert(schema.estimates).values([
    {
      jobId: jobs[0].id, estimateType: "auto_rom", effortBand: "half_day",
      hoursMin: "3", hoursMax: "5", costMin: 500, costMax: 700, labourOnly: true,
      materialsNote: "Plus cost of 3 hollow core doors — customer to choose style",
      assumptionNotes: "Standard sizes, frames in good condition, ground floor easy access",
      customerAcknowledgedEstimate: true, acknowledgedAt: new Date(),
    },
    {
      jobId: jobs[2].id, estimateType: "auto_rom", effortBand: "full_day",
      hoursMin: "6", hoursMax: "10", costMin: 700, costMax: 1200, labourOnly: true,
      materialsNote: "Customer supplying IKEA cupboards. May need wall anchors for plasterboard — roughly $50-80 in fixings.",
      assumptionNotes: "8 wall units, plasterboard walls, need to find studs or use heavy-duty anchors",
    },
  ]);
  console.log("  2 estimates");

  // State events
  await db.insert(schema.jobStateEvents).values([
    { jobId: jobs[0].id, fromState: "new_lead", toState: "partial_intake", actorType: "system", reason: "Customer started conversation" },
    { jobId: jobs[0].id, fromState: "partial_intake", toState: "ready_for_review", actorType: "system", reason: "Intake complete — customer provided contact details and acknowledged ROM" },
    { jobId: jobs[1].id, fromState: "new_lead", toState: "needs_site_visit", actorType: "operator", actorId: todd.id, reason: "Deck condition unclear, need to inspect bearers" },
    { jobId: jobs[2].id, fromState: "new_lead", toState: "estimate_presented", actorType: "system", reason: "Auto ROM presented during intake" },
  ]);
  console.log("  4 state events");

  // ── Seed Categories (Universal Taxonomy) ────
  console.log("\nSeeding categories...");

  const categoryRows: any[] = [];

  // WHAT dimension
  const whatNodes = getAllCategories();
  for (const node of whatNodes) {
    categoryRows.push({
      path: node.path,
      dimension: "what" as const,
      name: node.name,
      slug: node.slug,
      level: node.level,
      parentPath: node.parent,
      description: node.description,
      keywords: node.keywords,
      attributes: node.attributes,
      valueMultiplier: node.valueMultiplier.toFixed(2),
      siteVisitLikely: node.siteVisitLikely,
      licensedTrade: node.licensedTrade,
      validTxTypes: node.validTxTypes,
      modalTemplate: node.modalTemplate || null,
      embeddingText: node.embeddingText || null,
    });
  }

  // HOW dimension (transaction types)
  for (const tx of TRANSACTION_TYPES) {
    categoryRows.push({
      path: tx.path,
      dimension: "how" as const,
      name: tx.name,
      slug: tx.slug,
      level: 0,
      parentPath: null,
      description: `${tx.description}. Settlement: ${tx.settlementPattern}`,
      keywords: tx.keywords,
      attributes: [],
      valueMultiplier: "1.00",
      siteVisitLikely: false,
      licensedTrade: false,
      validTxTypes: [],
      modalTemplate: null,
      embeddingText: `transaction ${tx.name} — ${tx.description}. Keywords: ${tx.keywords.join(", ")}`,
    });
  }

  // INSTRUMENT dimension
  for (const inst of INSTRUMENT_TYPES) {
    categoryRows.push({
      path: inst.path,
      dimension: "instrument" as const,
      name: inst.name,
      slug: inst.slug,
      level: 0,
      parentPath: null,
      description: inst.description,
      keywords: [],
      attributes: [],
      valueMultiplier: "1.00",
      siteVisitLikely: false,
      licensedTrade: false,
      validTxTypes: [],
      modalTemplate: null,
      embeddingText: `instrument ${inst.name} — ${inst.description}`,
    });
    for (const sub of inst.subtypes) {
      categoryRows.push({
        path: sub.path,
        dimension: "instrument" as const,
        name: sub.name,
        slug: sub.slug,
        level: 1,
        parentPath: inst.path,
        description: `${sub.name} (subtype of ${inst.name})`,
        keywords: [],
        attributes: [],
        valueMultiplier: "1.00",
        siteVisitLikely: false,
        licensedTrade: false,
        validTxTypes: [],
        modalTemplate: null,
        embeddingText: `instrument ${sub.name} — subtype of ${inst.name}`,
      });
    }
  }

  // Insert in batches
  const BATCH_SIZE = 20;
  for (let i = 0; i < categoryRows.length; i += BATCH_SIZE) {
    await db.insert(schema.categories).values(categoryRows.slice(i, i + BATCH_SIZE));
  }
  console.log(`  ${categoryRows.length} categories (WHAT: ${whatNodes.length}, HOW: ${TRANSACTION_TYPES.length}, INSTRUMENT: ${categoryRows.length - whatNodes.length - TRANSACTION_TYPES.length})`);

  console.log("\nSetup complete! Database ready at", DATA_DIR);
  await client.close();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
