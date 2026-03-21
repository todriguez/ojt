/**
 * Full end-to-end verification: migrate → seed → query tests.
 * Uses a fresh PGlite instance each time.
 *
 * Usage: npx tsx scripts/verify-db.ts
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, desc, sql, inArray } from "drizzle-orm";
import * as schema from "../src/lib/db/schema";
import * as fs from "fs";
import * as path from "path";

const DATA_DIR = path.join("/tmp", "pglite-verify-tmp");

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

async function main() {
  // Clean start
  if (fs.existsSync(DATA_DIR)) {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  const client = new PGlite(DATA_DIR);
  await client.waitReady;
  const db = drizzle(client, { schema });

  // ── Migrate ─────────────────────────
  await migrate(db, { migrationsFolder: "./drizzle" });

  // ── Verify tables ───────────────────
  console.log("\n1. Table verification");
  const tables = await client.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
  );
  const tableNames = tables.rows.map((r: any) => r.table_name);
  const expected = [
    "customers", "estimates", "invoices", "job_state_events", "jobs",
    "messages", "operators", "organisations", "sites", "uploads", "visits",
  ];
  for (const t of expected) {
    assert(`Table '${t}' exists`, tableNames.includes(t));
  }

  // ── Seed ────────────────────────────
  console.log("\n2. Seed & data integrity");

  const [org] = await db.insert(schema.organisations).values({ name: "Odd Job Todd", type: "sole_trader" }).returning();
  assert("Created organisation", !!org.id);

  const [todd] = await db.insert(schema.operators).values({
    organisationId: org.id, name: "Todd", email: "todd@oddjobtodd.info", phone: "0412345678",
    status: "active", capabilityTags: ["carpentry", "doors_windows", "fencing", "painting", "general"],
  }).returning();
  assert("Created operator", todd.name === "Todd");

  const customers = await db.insert(schema.customers).values([
    { organisationId: org.id, name: "Sarah Mitchell", mobile: "0423456789", email: "sarah.m@email.com" },
    { organisationId: org.id, name: "Dave Cooper", mobile: "0434567890", email: "dave.cooper@email.com" },
    { organisationId: org.id, name: "Jenny Pham", mobile: "0445678901", email: "jenny.p@email.com" },
    { organisationId: org.id, name: "Mark Thompson", mobile: "0456789012" },
    { organisationId: org.id, name: "Unknown Customer", mobile: "0467890123" },
  ]).returning();
  assert("Created 5 customers", customers.length === 5);

  const sites = await db.insert(schema.sites).values([
    { customerId: customers[0].id, suburb: "Noosa Heads", postcode: "4567", lat: "-26.3955", lng: "153.0937", accessNotes: "Park on street" },
    { customerId: customers[1].id, suburb: "Cooroy", postcode: "4563", lat: "-26.4174", lng: "152.9159" },
    { customerId: customers[2].id, suburb: "Peregian Beach", postcode: "4573", lat: "-26.4833", lng: "153.0833" },
    { customerId: customers[3].id, suburb: "Doonan", postcode: "4562", lat: "-26.4033", lng: "153.0631" },
    { customerId: customers[0].id, suburb: "Tewantin", postcode: "4565", lat: "-26.3889", lng: "153.0394" },
  ]).returning();
  assert("Created 5 sites", sites.length === 5);

  const allJobs = await db.insert(schema.jobs).values([
    {
      organisationId: org.id, customerId: customers[0].id, siteId: sites[0].id,
      assignedOperatorId: todd.id, leadSource: "website_chat", jobType: "doors_windows",
      subcategory: "door_replacement",
      descriptionRaw: "3 internal hollow core doors need replacing",
      descriptionSummary: "Replace 3 internal doors",
      status: "ready_for_review", urgency: "flexible", effortBand: "half_day",
      estimatedHoursMin: "3", estimatedHoursMax: "5", estimatedCostMin: 500, estimatedCostMax: 700,
      customerFitScore: 85, quoteWorthinessScore: 78, completenessScore: 90, serviceAreaOk: true,
    },
    {
      organisationId: org.id, customerId: customers[1].id, siteId: sites[1].id,
      leadSource: "referral", jobType: "carpentry", subcategory: "deck_repair",
      descriptionRaw: "Deck boards soft and cracking, 4x5m raised",
      status: "needs_site_visit", urgency: "next_2_weeks", effortBand: "full_day",
      estimatedCostMin: 800, estimatedCostMax: 1400,
      customerFitScore: 72, quoteWorthinessScore: 65, requiresSiteVisit: true,
    },
    {
      organisationId: org.id, customerId: customers[2].id, siteId: sites[2].id,
      leadSource: "facebook", jobType: "carpentry", subcategory: "cabinet_installation",
      descriptionRaw: "8 IKEA kitchen cupboards to mount on plasterboard",
      status: "estimate_presented", urgency: "next_week", effortBand: "full_day",
      customerFitScore: 55, quoteWorthinessScore: 60,
    },
    {
      organisationId: org.id, customerId: customers[3].id, siteId: sites[3].id,
      leadSource: "phone", jobType: "fencing", subcategory: "fence_repair",
      descriptionRaw: "6m fence section blown down in storm, snapped post",
      status: "new_lead", urgency: "urgent", effortBand: "half_day",
      customerFitScore: 70, quoteWorthinessScore: 75,
    },
    {
      organisationId: org.id, customerId: customers[4].id,
      leadSource: "website_chat", jobType: "general",
      descriptionRaw: "need some stuff done at my place",
      status: "partial_intake", urgency: "unspecified", effortBand: "unknown",
      customerFitScore: 20, quoteWorthinessScore: 10,
    },
  ]).returning();
  assert("Created 5 jobs", allJobs.length === 5);

  const msgs = await db.insert(schema.messages).values([
    { jobId: allJobs[0].id, customerId: customers[0].id, senderType: "ai", messageType: "text", rawContent: "Hi! What do you need help with?" },
    { jobId: allJobs[0].id, customerId: customers[0].id, senderType: "customer", messageType: "text", rawContent: "3 internal doors need replacing" },
    { jobId: allJobs[0].id, customerId: customers[0].id, senderType: "ai", messageType: "text", rawContent: "Standard sizes or anything unusual?" },
    { jobId: allJobs[0].id, customerId: customers[0].id, senderType: "customer", messageType: "text", rawContent: "Standard sizes, ground floor" },
    { jobId: allJobs[4].id, customerId: customers[4].id, senderType: "customer", messageType: "text", rawContent: "need some stuff done" },
  ]).returning();
  assert("Created 5 messages", msgs.length === 5);

  const ests = await db.insert(schema.estimates).values([
    { jobId: allJobs[0].id, estimateType: "auto_rom", effortBand: "half_day", costMin: 500, costMax: 700, labourOnly: true, materialsNote: "Plus 3 doors", customerAcknowledgedEstimate: true },
  ]).returning();
  assert("Created 1 estimate", ests.length === 1);

  const events = await db.insert(schema.jobStateEvents).values([
    { jobId: allJobs[0].id, fromState: "new_lead", toState: "partial_intake", actorType: "system", reason: "Conversation started" },
    { jobId: allJobs[0].id, fromState: "partial_intake", toState: "ready_for_review", actorType: "system", reason: "Intake complete" },
  ]).returning();
  assert("Created 2 state events", events.length === 2);

  // ── Query tests ─────────────────────
  console.log("\n3. Query verification");

  // Jobs by status
  const reviewJobs = await db.select().from(schema.jobs).where(eq(schema.jobs.status, "ready_for_review"));
  assert("Filter: ready_for_review jobs", reviewJobs.length === 1);

  // Jobs with customer join
  const joinResult = await db
    .select({ jobId: schema.jobs.id, customerName: schema.customers.name, suburb: schema.sites.suburb })
    .from(schema.jobs)
    .leftJoin(schema.customers, eq(schema.jobs.customerId, schema.customers.id))
    .leftJoin(schema.sites, eq(schema.jobs.siteId, schema.sites.id))
    .orderBy(desc(schema.jobs.createdAt));
  assert("Join: jobs + customers + sites", joinResult.length === 5);
  assert("Join: Sarah Mitchell present", joinResult.some(j => j.customerName === "Sarah Mitchell"));

  // Messages for job
  const jobMsgs = await db.select().from(schema.messages).where(eq(schema.messages.jobId, allJobs[0].id));
  assert("Filter: messages for door job", jobMsgs.length === 4);

  // Effort band
  const halfDay = await db.select().from(schema.jobs).where(eq(schema.jobs.effortBand, "half_day"));
  assert("Filter: half_day jobs", halfDay.length === 2);

  // Score filter
  const worth70 = await db.select().from(schema.jobs).where(sql`${schema.jobs.quoteWorthinessScore} >= 70`);
  assert("Filter: quote_worthiness >= 70", worth70.length === 2);

  // State history
  const history = await db.select().from(schema.jobStateEvents).where(eq(schema.jobStateEvents.jobId, allJobs[0].id)).orderBy(schema.jobStateEvents.createdAt);
  assert("State history: 2 transitions", history.length === 2);
  assert("State flow: new_lead → partial_intake → ready_for_review",
    history[0].fromState === "new_lead" && history[1].toState === "ready_for_review");

  // Multi-status (admin pipeline view)
  const pipeline = await db.select().from(schema.jobs).where(
    inArray(schema.jobs.status, ["new_lead", "partial_intake", "ready_for_review", "needs_site_visit", "estimate_presented"])
  );
  assert("Filter: active pipeline", pipeline.length === 5);

  // ── Enum check ──────────────────────
  console.log("\n4. Enum verification");
  const enums = await client.query(`SELECT typname FROM pg_type WHERE typcategory = 'E' ORDER BY typname`);
  const enumNames = enums.rows.map((r: any) => r.typname);
  assert("job_status enum", enumNames.includes("job_status"));
  assert("effort_band enum", enumNames.includes("effort_band"));
  assert("urgency enum", enumNames.includes("urgency"));
  assert("job_category enum", enumNames.includes("job_category"));

  // ── Summary ─────────────────────────
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nSprint 1 complete. Database is ready for Sprint 2.");
    console.log("Next: rebuild /api/chat with incremental save + server-side extraction.");
  }

  // Cleanup
  await client.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
