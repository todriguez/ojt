#!/usr/bin/env npx tsx
/**
 * verify-semantic-pipeline.ts
 *
 * Exercises the semantic runtime adapter directly against the live Neon DB
 * to verify the dual-write pipeline works end-to-end.
 *
 * Steps:
 *   1. Create a SemanticObject for a test job
 *   2. Record a state snapshot (simulating extraction merge)
 *   3. Record scores
 *   4. Record an evidence item (customer message)
 *   5. Record an instrument (ROM quote)
 *   6. Query back all sem_* tables and verify data
 *   7. Clean up test data
 *
 * Usage: npx tsx scripts/verify-semantic-pipeline.ts
 */

import "dotenv/config";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/lib/db/schema";
import * as sem from "../src/lib/db/schema.universal";
import {
  ensureSemanticObject,
  recordStateSnapshot,
  recordScores,
  recordEvidence,
  recordInstrument,
} from "../src/lib/domain/bridge/semanticRuntimeAdapter";
import { accumulatedJobStateSchema, mergeExtraction, type AccumulatedJobState } from "../src/lib/ai/extractors/extractionSchema";

const allSchema = { ...schema, ...sem };

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema: allSchema }) as any;

let passCount = 0;
let failCount = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    passCount++;
    console.log(`  ✅ ${label}`);
  } else {
    failCount++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const TEST_JOB_ID = `test-verify-${Date.now()}`;

async function run() {
  console.log("\n═══ Semantic Pipeline — Live DB Verification ═══\n");

  // ── Step 1: Create SemanticObject ──
  console.log("Step 1: ensureSemanticObject\n");
  const ctx1 = await ensureSemanticObject(db, TEST_JOB_ID, "carpentry");
  check("SemanticObject created", ctx1.semanticObjectId !== "");
  check("Initial version is 0", ctx1.version === 0);

  // Verify in DB
  const objs = await db.select().from(sem.semanticObjects).where(eq(sem.semanticObjects.id, ctx1.semanticObjectId));
  check("sem_objects row exists", objs.length === 1);
  check("vertical = 'trades'", objs[0]?.vertical === "trades");
  check("objectKind = 'job'", objs[0]?.objectKind === "job");

  const projections = await db.select().from(sem.tradesJobs).where(eq(sem.tradesJobs.objectId, ctx1.semanticObjectId));
  check("sem_trades_jobs projection exists", projections.length === 1);
  check("legacyJobId matches", projections[0]?.legacyJobId === TEST_JOB_ID);

  // ── Step 2: Record state snapshot ──
  console.log("\nStep 2: recordStateSnapshot (extraction merge)\n");

  const initialState = accumulatedJobStateSchema.parse({
    jobType: "carpentry",
    scopeDescription: "Replace rotting deck boards, about 12 boards",
    suburb: "Paddington",
    urgency: "next_2_weeks",
    completenessScore: 45,
    scopeClarity: 50,
    conversationPhase: "describing_job",
  });

  const extraction = {
    customerName: "Test Customer",
    customerPhone: "0400 000 000",
    customerEmail: null,
    suburb: null,
    locationClue: null,
    address: null,
    postcode: null,
    accessNotes: null,
    jobType: null,
    jobTypeConfidence: null,
    jobSubcategory: null,
    repairReplaceSignal: null,
    scopeDescription: null,
    quantity: "12 boards",
    materials: "hardwood",
    materialCondition: null,
    accessDifficulty: null,
    photosReferenced: null,
    urgency: null,
    estimateReaction: null,
    budgetReaction: null,
    customerToneSignal: null,
    micromanagerSignals: null,
    cheapestMindset: null,
    clarityScore: null,
    contactReadiness: null,
    isComplete: false,
    missingInfo: [],
    conversationPhase: "providing_details" as const,
  };

  const mergeResult = mergeExtraction(initialState, extraction);
  const ctx2 = await recordStateSnapshot(db, ctx1, mergeResult, mergeResult.state as AccumulatedJobState, "test:verification");

  check("Version bumped to 1", ctx2.version === 1);
  check("stateHash is set", ctx2.stateHash.length === 64);

  // Verify ObjectState in DB
  const states = await db.select().from(sem.objectStates).where(eq(sem.objectStates.objectId, ctx1.semanticObjectId));
  check("sem_object_states row exists", states.length === 1);
  check("state version = 1", states[0]?.version === 1);

  // Verify ObjectPatch
  const patches = await db.select().from(sem.objectPatches).where(eq(sem.objectPatches.objectId, ctx1.semanticObjectId));
  check("sem_object_patches row exists", patches.length >= 1);
  check("patch kind = extraction", patches[0]?.patchKind === "extraction");
  check("patch is consumed", patches[0]?.consumed === true);

  // ── Step 3: Record scores ──
  console.log("\nStep 3: recordScores\n");
  await recordScores(db, ctx2, {
    customerFitScore: 72,
    customerFitLabel: "good_fit",
    quoteWorthinessScore: 68,
    quoteWorthinessLabel: "worth_quoting",
    completenessScore: 55,
  });

  const scores = await db.select().from(sem.objectScores).where(eq(sem.objectScores.objectId, ctx1.semanticObjectId));
  check("sem_object_scores rows exist", scores.length >= 2);
  const fitScore = scores.find(s => s.scoreKind === "trades-fit");
  check("trades-fit score recorded", fitScore !== undefined);
  const worthinessScore = scores.find(s => s.scoreKind === "trades-worthiness");
  check("trades-worthiness score recorded", worthinessScore !== undefined);

  // ── Step 4: Record evidence ──
  console.log("\nStep 4: recordEvidence (message)\n");
  await recordEvidence(db, ctx2, "msg-test-001", "I need my deck boards replaced, about 12 of them", "customer");

  const evidence = await db.select().from(sem.evidenceItems).where(eq(sem.evidenceItems.objectId, ctx1.semanticObjectId));
  check("sem_evidence_items row exists", evidence.length >= 1);
  check("evidence kind = message", evidence[0]?.evidenceKind === "message");

  // ── Step 5: Record instrument ──
  console.log("\nStep 5: recordInstrument (ROM quote)\n");
  await recordInstrument(db, ctx2, {
    effortBand: "half_day",
    costMin: 350,
    costMax: 650,
    hoursMin: 3,
    hoursMax: 5,
    labourOnly: false,
    materialsNote: "Hardwood boards — customer to supply or we source",
  });

  const instruments = await db.select().from(sem.semInstruments).where(eq(sem.semInstruments.objectId, ctx1.semanticObjectId));
  check("sem_instruments row exists", instruments.length >= 1);
  check("instrument type = rom-quote", instruments[0]?.instrumentType === "rom-quote");
  check("instrument linearity = RELEVANT", instruments[0]?.linearity === "RELEVANT");
  check("instrument status = presented", instruments[0]?.status === "presented");

  // ── Step 6: Verify trades projection updated ──
  console.log("\nStep 6: Verify trades projection denormalization\n");
  const updated = await db.select().from(sem.tradesJobs).where(eq(sem.tradesJobs.objectId, ctx1.semanticObjectId));
  check("customerName denormalized", updated[0]?.customerName === "Test Customer");
  check("suburb denormalized", updated[0]?.suburb === "Paddington");

  // ── Cleanup ──
  console.log("\nCleaning up test data...\n");
  await db.delete(sem.semInstruments).where(eq(sem.semInstruments.objectId, ctx1.semanticObjectId));
  await db.delete(sem.objectScores).where(eq(sem.objectScores.objectId, ctx1.semanticObjectId));
  await db.delete(sem.evidenceItems).where(eq(sem.evidenceItems.objectId, ctx1.semanticObjectId));
  await db.delete(sem.objectPatches).where(eq(sem.objectPatches.objectId, ctx1.semanticObjectId));
  await db.delete(sem.objectStates).where(eq(sem.objectStates.objectId, ctx1.semanticObjectId));
  await db.delete(sem.tradesJobs).where(eq(sem.tradesJobs.objectId, ctx1.semanticObjectId));
  await db.delete(sem.semanticObjects).where(eq(sem.semanticObjects.id, ctx1.semanticObjectId));

  // ── Summary ──
  console.log("═══ Summary ═══\n");
  console.log(`  Checks: ${passCount} passed, ${failCount} failed, ${passCount + failCount} total`);
  console.log(`  Pipeline: ${failCount === 0 ? "✅ ALL WRITES HIT LIVE NEON DB" : "❌ SOME WRITES FAILED"}`);
  console.log();

  await pool.end();
  if (failCount > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Verification failed:", err);
  pool.end();
  process.exit(1);
});
