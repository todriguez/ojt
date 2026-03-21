/**
 * Policy Service
 *
 * Single source of truth for the active scoring policy.
 * Loads from database, caches in memory, invalidates on change.
 *
 * Usage:
 *   const policy = await getActivePolicy(db);
 *   // policy.weights, policy.thresholds, policy.version
 *
 * When no database row exists (tests, first boot), falls back
 * to DEFAULT_POLICY_WEIGHTS.
 */

import { eq } from "drizzle-orm";
import type { Database } from "../../db/client";
import { scoringPolicies } from "../../db/schema";
import { DEFAULT_POLICY_WEIGHTS, DEFAULT_POLICY_META } from "./defaultPolicy";
import type { PolicyWeights } from "./policyTypes";

export interface ActivePolicy {
  version: number;
  name: string;
  weights: PolicyWeights;
  thresholds: PolicyWeights["thresholds"];
  tuningLocked: boolean;
  tunedFromVersion: number | null;
  createdBy: string;
}

// ── In-memory cache ─────────────────────────

let _cached: ActivePolicy | null = null;
let _cachedAt: number = 0;
const CACHE_TTL_MS = 60_000; // 1 minute — short enough for tuning, long enough for scoring bursts

/**
 * Get the currently active scoring policy.
 * Cached in memory; refreshes after CACHE_TTL_MS or on explicit invalidation.
 */
export async function getActivePolicy(db: Database): Promise<ActivePolicy> {
  const now = Date.now();
  if (_cached && (now - _cachedAt) < CACHE_TTL_MS) {
    return _cached;
  }

  try {
    const rows = await db
      .select()
      .from(scoringPolicies)
      .where(eq(scoringPolicies.isActive, true))
      .limit(1);

    if (rows.length > 0) {
      const row = rows[0];
      _cached = {
        version: row.version,
        name: row.name,
        weights: row.weights as PolicyWeights,
        thresholds: (row.weights as PolicyWeights).thresholds,
        tuningLocked: row.tuningLocked,
        tunedFromVersion: row.tunedFromVersion,
        createdBy: row.createdBy,
      };
      _cachedAt = now;
      return _cached;
    }
  } catch {
    // Database not available (e.g. tests without migration) — fall through to default
  }

  // No active policy in DB — use defaults
  return getDefaultPolicy();
}

/**
 * Get the default policy without database access.
 * Used by tests and as fallback.
 */
export function getDefaultPolicy(): ActivePolicy {
  return {
    version: DEFAULT_POLICY_META.version,
    name: DEFAULT_POLICY_META.name,
    weights: DEFAULT_POLICY_WEIGHTS,
    thresholds: DEFAULT_POLICY_WEIGHTS.thresholds,
    tuningLocked: DEFAULT_POLICY_META.tuningLocked,
    tunedFromVersion: DEFAULT_POLICY_META.tunedFromVersion,
    createdBy: DEFAULT_POLICY_META.createdBy,
  };
}

/**
 * Invalidate the policy cache.
 * Call this after saving a new policy version.
 */
export function invalidatePolicyCache(): void {
  _cached = null;
  _cachedAt = 0;
}

/**
 * Seed the initial policy version into the database.
 * No-ops if a policy already exists.
 */
export async function seedPolicyIfNeeded(db: Database): Promise<void> {
  const existing = await db
    .select({ version: scoringPolicies.version })
    .from(scoringPolicies)
    .limit(1);

  if (existing.length > 0) return;

  await db.insert(scoringPolicies).values({
    version: DEFAULT_POLICY_META.version,
    name: DEFAULT_POLICY_META.name,
    weights: DEFAULT_POLICY_WEIGHTS,
    thresholds: DEFAULT_POLICY_WEIGHTS.thresholds,
    createdBy: DEFAULT_POLICY_META.createdBy,
    changeNotes: DEFAULT_POLICY_META.changeNotes,
    tunedFromVersion: DEFAULT_POLICY_META.tunedFromVersion,
    tuningLocked: DEFAULT_POLICY_META.tuningLocked,
    isActive: true,
    activatedAt: new Date(),
  });
}
