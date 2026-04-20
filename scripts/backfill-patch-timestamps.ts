/**
 * Backfill sem_object_patches.timestamp from created_at for legacy rows.
 *
 * Idempotent: only updates rows where timestamp IS NULL AND created_at IS NOT NULL.
 * A second run on the same DB will report "Backfilled 0 patch rows".
 *
 * Usage: pnpm tsx scripts/backfill-patch-timestamps.ts
 */
import { sql } from "drizzle-orm";
import { getDb } from "../src/lib/db/client";

async function main() {
  const db = await getDb();

  const result: any = await db.execute(sql`
    UPDATE sem_object_patches
    SET timestamp = CAST(EXTRACT(EPOCH FROM created_at) * 1000 AS BIGINT)
    WHERE timestamp IS NULL AND created_at IS NOT NULL
  `);

  // Drizzle returns different shapes depending on driver (pg vs pglite).
  // Try common locations for the affected-row count.
  const count =
    (typeof result?.rowCount === "number" ? result.rowCount : undefined) ??
    (typeof result?.affectedRows === "number" ? result.affectedRows : undefined) ??
    (Array.isArray(result?.rows) ? result.rows.length : undefined) ??
    0;

  console.log(`Backfilled ${count} patch rows`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
