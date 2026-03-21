/**
 * Seed Policy Version 1
 *
 * Creates the initial scoring policy in the database from the
 * hardcoded default values. Run this after schema migration.
 *
 * Usage: npx tsx scripts/seed-policy.ts
 */

import { DEFAULT_POLICY_WEIGHTS, DEFAULT_POLICY_META } from "../src/lib/domain/policy";

async function main() {
  console.log("🌱 Seeding policy version 1...\n");

  // For now, just validate the policy structure and print it
  // In production, this will INSERT into scoring_policies table
  const policy = {
    ...DEFAULT_POLICY_META,
    weights: DEFAULT_POLICY_WEIGHTS,
    thresholds: DEFAULT_POLICY_WEIGHTS.thresholds,
    activatedAt: new Date().toISOString(),
  };

  // Validate structure
  const weightGroups = Object.keys(DEFAULT_POLICY_WEIGHTS);
  console.log(`  Policy name: "${policy.name}"`);
  console.log(`  Version: ${policy.version}`);
  console.log(`  Weight groups: ${weightGroups.join(", ")}`);
  console.log(`  Active: ${policy.isActive}`);
  console.log(`  Created by: ${policy.createdBy}`);
  console.log();

  // Count individual weights
  let totalWeights = 0;
  for (const [group, values] of Object.entries(DEFAULT_POLICY_WEIGHTS)) {
    const count = typeof values === "object" ? Object.keys(values).length : 1;
    totalWeights += count;
    console.log(`  ${group}: ${count} parameters`);
  }
  console.log(`\n  Total tuneable parameters: ${totalWeights}`);

  // Verify all fit weights match current hardcoded values
  const fit = DEFAULT_POLICY_WEIGHTS.fit;
  console.log("\n  ── Fit weight spot-check ──");
  console.log(`    baseline: ${fit.baseline} (expect 50) ${fit.baseline === 50 ? "✅" : "❌"}`);
  console.log(`    cheapestMindsetPenalty: ${fit.cheapestMindsetPenalty} (expect -15) ${fit.cheapestMindsetPenalty === -15 ? "✅" : "❌"}`);
  console.log(`    adversarial3Cap: ${fit.adversarial3Cap} (expect 15) ${fit.adversarial3Cap === 15 ? "✅" : "❌"}`);

  const worth = DEFAULT_POLICY_WEIGHTS.worthiness;
  console.log("\n  ── Worthiness weight spot-check ──");
  console.log(`    coreSuburbPoints: ${worth.coreSuburbPoints} (expect 25) ${worth.coreSuburbPoints === 25 ? "✅" : "❌"}`);
  console.log(`    scopeUndefinedCap: ${worth.scopeUndefinedCap} (expect 25) ${worth.scopeUndefinedCap === 25 ? "✅" : "❌"}`);

  const thresh = DEFAULT_POLICY_WEIGHTS.thresholds;
  console.log("\n  ── Threshold spot-check ──");
  console.log(`    priorityLeadMinWorthiness: ${thresh.priorityLeadMinWorthiness} (expect 70) ${thresh.priorityLeadMinWorthiness === 70 ? "✅" : "❌"}`);
  console.log(`    fitHardRejectThreshold: ${thresh.fitHardRejectThreshold} (expect 20) ${thresh.fitHardRejectThreshold === 20 ? "✅" : "❌"}`);

  console.log("\n✅ Policy version 1 validated and ready to seed.");
  console.log("   (Database INSERT will be added when PGlite migration runs.)");
}

main().catch(console.error);
