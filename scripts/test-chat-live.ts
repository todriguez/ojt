/**
 * Live Chat Integration Test
 *
 * Tests the full pipeline with a real Anthropic API call.
 *
 * Usage: npx tsx scripts/test-chat-live.ts
 */

// Set env BEFORE any module imports
process.env.PGLITE_DATA_DIR = "memory://";

// Load .env.local for ANTHROPIC_API_KEY
import fs from "fs";
const envContent = fs.readFileSync(".env.local", "utf-8");
for (const line of envContent.split("\n")) {
  const match = line.match(/^([A-Z_]+)=(.+)$/);
  if (match && !process.env[match[1]]) {
    process.env[match[1]] = match[2];
  }
}

async function main() {
  // Dynamic imports so PGLITE_DATA_DIR is set first
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const { eq } = await import("drizzle-orm");
  const path = await import("path");
  const { getDb } = await import("../src/lib/db/client");
  const schema = await import("../src/lib/db/schema");
  const { processCustomerMessage } = await import("../src/lib/services/chatService");

  console.log("🔧 Setting up test database...");
  const db = await getDb();

  // Run migrations
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  console.log("  ✓ Migrations applied");

  // Seed minimal data
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: "Odd Job Todd", type: "sole_trader" })
    .returning();

  const [operator] = await db
    .insert(schema.operators)
    .values({
      organisationId: org.id,
      name: "Todd Price",
      email: "todd@oddjobtodd.info",
      phone: "0400000000",
    })
    .returning();

  console.log(`  ✓ Created org: ${org.id}`);

  // Create a job
  const [job] = await db
    .insert(schema.jobs)
    .values({
      organisationId: org.id,
      leadSource: "website_chat",
      status: "new_lead",
    })
    .returning();

  await db.insert(schema.jobStateEvents).values({
    jobId: job.id,
    fromState: "new_lead",
    toState: "new_lead",
    actorType: "system",
    reason: "Test conversation started",
  });

  console.log(`  ✓ Created job: ${job.id}`);

  // ── Message 1 ──
  console.log("\n📨 Message 1: Job description...");
  try {
    const result1 = await processCustomerMessage({
      jobId: job.id,
      customerId: "",
      message:
        "Hey, I've got 3 internal doors that need replacing. They're all standard hollow core, nothing fancy. House is in Noosa Heads.",
    });

    console.log(`  ✓ Reply (${result1.reply.length} chars)`);
    console.log(`  ✓ Phase: ${result1.conversationPhase}`);
    console.log(`  ✓ Completeness: ${result1.completenessScore}`);
    console.log(`  ✓ Estimate presented: ${result1.estimatePresented}`);
    console.log(`  ✓ Fit: ${result1.customerFitScore} (${result1.customerFitLabel})`);
    console.log(`  ✓ Worth: ${result1.quoteWorthinessScore} (${result1.quoteWorthinessLabel})`);
    console.log(`  ✓ Rec: ${result1.recommendation}`);
    console.log(`  📝 "${result1.reply.substring(0, 150)}..."`);
  } catch (err: any) {
    console.error(`  ✗ ${err.message}`);
    process.exit(1);
  }

  // ── Message 2 ──
  console.log("\n📨 Message 2: Details + urgency...");
  try {
    const result2 = await processCustomerMessage({
      jobId: job.id,
      customerId: "",
      message:
        "Yeah they're all ground floor, easy access. Would like to get it done in the next couple of weeks if possible.",
    });

    console.log(`  ✓ Reply (${result2.reply.length} chars)`);
    console.log(`  ✓ Phase: ${result2.conversationPhase}`);
    console.log(`  ✓ Completeness: ${result2.completenessScore}`);
    console.log(`  ✓ Estimate presented: ${result2.estimatePresented}`);
    console.log(`  ✓ Fit: ${result2.customerFitScore} (${result2.customerFitLabel})`);
    console.log(`  ✓ Worth: ${result2.quoteWorthinessScore} (${result2.quoteWorthinessLabel})`);
    console.log(`  ✓ Rec: ${result2.recommendation}`);
    console.log(`  ✓ Ack: ${result2.estimateAckStatus}`);
    console.log(`  📝 "${result2.reply.substring(0, 150)}..."`);
  } catch (err: any) {
    console.error(`  ✗ ${err.message}`);
  }

  // ── DB verification ──
  console.log("\n🔍 Database state:");

  const messages = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.jobId, job.id))
    .orderBy(schema.messages.createdAt);

  console.log(`  ${messages.length} messages:`);
  for (const m of messages) {
    console.log(`    ${m.senderType}: "${(m.rawContent || "").substring(0, 80)}..."`);
  }

  const [updatedJob] = await db
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.id, job.id));

  console.log(`  Status: ${updatedJob.status}`);
  console.log(`  Type: ${updatedJob.jobType}`);
  console.log(`  Effort band: ${updatedJob.effortBand}`);
  console.log(`  Completeness: ${updatedJob.completenessScore}`);

  const estimates = await db
    .select()
    .from(schema.estimates)
    .where(eq(schema.estimates.jobId, job.id));

  console.log(`  Estimates: ${estimates.length}`);
  if (estimates.length > 0) {
    console.log(`    ROM: $${estimates[0].costMin}–$${estimates[0].costMax} (${estimates[0].effortBand})`);
  }

  console.log("\n✅ Live integration test complete!");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
