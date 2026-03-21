/**
 * Run migrations against PGlite (local dev) or real Postgres.
 *
 * Usage: npx tsx scripts/migrate.ts
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../src/lib/db/schema";

const DATA_DIR = process.env.PGLITE_DATA_DIR || "./pglite-data";

async function main() {
  console.log("Connecting to PGlite at", DATA_DIR, "...");
  const client = new PGlite(DATA_DIR);
  await client.waitReady;

  const db = drizzle(client, { schema });

  console.log("Running migrations...");
  await migrate(db, { migrationsFolder: "./drizzle" });

  console.log("Migrations complete.");

  // Verify tables exist
  const result = await client.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
  );
  console.log(
    "Tables created:",
    result.rows.map((r: any) => r.table_name)
  );

  await client.close();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
