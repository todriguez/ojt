import * as schema from "./schema";
import * as universalSchema from "./schema.universal";
import * as kernelCoreSchema from "../semantos-kernel/schema.core";
import * as tradesSchema from "../semantos-kernel/verticals/trades/schema.trades";
import { createLogger } from "@/lib/logger";
import type { PgDatabase } from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────
// Dual-mode database client
//
// If DATABASE_URL is set → use node-postgres (Neon / hosted Postgres)
// Otherwise → fall back to PGlite (embedded, local dev)
// ─────────────────────────────────────────────

const log = createLogger("db");

const allSchema = { ...schema, ...universalSchema, ...kernelCoreSchema, ...tradesSchema };
type DbClient = PgDatabase<any, typeof allSchema>;
let _db: DbClient | null = null;

async function initPostgres() {
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on("error", (err) => {
    log.error({ error: err.message }, "db.pool.error");
  });

  log.info("Connected to Postgres via DATABASE_URL");
  return drizzle(pool, { schema: allSchema });
}

async function initPglite() {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");

  const dataDir = process.env.PGLITE_DATA_DIR || "./pglite-data-v2";
  const client = new PGlite(dataDir);
  await client.waitReady;

  log.info({ dataDir }, "Connected to PGlite (local dev)");
  return drizzlePglite(client, { schema: allSchema });
}

export async function getDb(): Promise<DbClient> {
  if (_db) return _db;

  try {
    if (process.env.DATABASE_URL) {
      _db = await initPostgres();
    } else {
      _db = await initPglite();
    }
  } catch (err) {
    log.error({ error: err instanceof Error ? err.message : String(err) }, "db.init.error");
    throw err;
  }

  return _db;
}

// For scripts (seed, migrate) that need direct SQL access
export async function getClientForScripts() {
  if (process.env.DATABASE_URL) {
    const { Pool } = await import("pg");
    return new Pool({ connectionString: process.env.DATABASE_URL });
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const dataDir = process.env.PGLITE_DATA_DIR || "./pglite-data-v2";
  const client = new PGlite(dataDir);
  await client.waitReady;
  return client;
}

export type Database = Awaited<ReturnType<typeof getDb>>;
