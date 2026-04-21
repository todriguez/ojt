/**
 * Calendar DB client (A5.2).
 *
 * The calendar lives in its own database — `calendar_prod` on the VPS,
 * a dedicated PGlite instance in dev. The shapes that
 * `@semantos/calendar-ext` reads (sem_objects, sem_object_patches,
 * sem_object_states, sem_participants) come from
 * `@semantos/semantic-objects`'s canonical schema, which is NOT the
 * same as OJT's existing `sem_objects` (OJT's adds `vertical`,
 * `type_hash`, etc.). Sharing one PGlite for both would explode at
 * INSERT time, so even in dev we point calendar at its own dir.
 *
 * Mode selection:
 *   - CALENDAR_DATABASE_URL  → postgres-js to the shared calendar DB
 *   - else                    → PGlite at PGLITE_DATA_DIR_CALENDAR
 *                              (default ./pglite-data-calendar)
 *
 * The drizzle handle is memoised; the bootstrap call also runs the
 * canonical migration so the four canonical tables exist regardless
 * of which mode we picked. Idempotent — `IF NOT EXISTS` everywhere.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { PgDatabase } from "drizzle-orm/pg-core";

import { createLogger } from "@/lib/logger";

const log = createLogger("calendar.db");

export type CalendarDb = PgDatabase<any, any, any>;

let _db: CalendarDb | null = null;
let _bootstrapped = false;

/**
 * Returns the lazily-initialised calendar drizzle handle. Idempotent;
 * callers may invoke this on every request without overhead.
 */
export async function getCalendarDb(): Promise<CalendarDb> {
  if (_db) return _db;

  const url = process.env.CALENDAR_DATABASE_URL;
  if (url) {
    _db = await initPostgresJs(url);
  } else {
    _db = await initPglite();
  }

  if (!_bootstrapped) {
    await applyCanonicalMigration(_db);
    _bootstrapped = true;
  }
  return _db;
}

async function initPostgresJs(url: string): Promise<CalendarDb> {
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const sql = postgres(url, { max: 5, idle_timeout: 30 });
  log.info("calendar.db.postgres_connected");
  return drizzle(sql) as unknown as CalendarDb;
}

async function initPglite(): Promise<CalendarDb> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const dataDir =
    process.env.PGLITE_DATA_DIR_CALENDAR || "./pglite-data-calendar";
  const client = new PGlite(dataDir);
  await client.waitReady;
  log.info({ dataDir }, "calendar.db.pglite_connected");
  return drizzle(client) as unknown as CalendarDb;
}

/**
 * Apply the canonical sem_objects / sem_object_patches /
 * sem_object_states / sem_participants migration shipped with
 * @semantos/semantic-objects. Tolerant of in-place re-runs (every
 * statement is `IF NOT EXISTS` or wrapped in a duplicate_object guard).
 */
async function applyCanonicalMigration(db: CalendarDb): Promise<void> {
  const sqlPath = resolveCanonicalMigrationPath();
  if (!sqlPath) {
    log.warn(
      "calendar.db.canonical_migration_missing — skipping; assume DB is pre-migrated",
    );
    return;
  }
  const sqlText = fs.readFileSync(sqlPath, "utf8");
  // postgres-js / pglite drizzle handles both expose `.execute(sql)`
  // for raw SQL via `sql` template; here we drop down to the underlying
  // session for a multi-statement string.
  const session = (
    db as unknown as { $client?: { exec?: (s: string) => Promise<unknown> } }
  ).$client;
  if (session?.exec) {
    // PGlite path
    await session.exec(sqlText);
  } else {
    // postgres-js: split on statement terminators that aren't inside DO $$ blocks.
    const statements = splitSqlStatements(sqlText);
    for (const stmt of statements) {
      if (!stmt.trim()) continue;
      // Use the postgres tag interpolation via raw — drizzle's execute
      // expects an SQL chunk, but we have raw text; lean on the underlying.
      await runRaw(db, stmt);
    }
  }
  log.info({ sqlPath }, "calendar.db.canonical_migration_applied");
}

async function runRaw(db: CalendarDb, stmt: string): Promise<void> {
  // drizzle's execute accepts the `sql` tag; lean on the runtime
  // dynamic dispatch — every concrete adapter (pglite, postgres-js,
  // node-postgres) has an `execute` method that takes a raw string.
  const exec = (db as unknown as { execute?: (s: string) => Promise<unknown> })
    .execute;
  if (typeof exec === "function") {
    await exec.call(db, stmt);
    return;
  }
  throw new Error("calendar.db: raw exec not supported on this adapter");
}

function splitSqlStatements(sql: string): string[] {
  // Cheap splitter — preserves DO $$ ... $$ blocks. The canonical
  // migration uses exactly this shape; nothing fancier is needed.
  const out: string[] = [];
  let buf = "";
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (sql.startsWith("$$", i)) {
      inDollar = !inDollar;
      buf += "$$";
      i += 1;
      continue;
    }
    if (ch === ";" && !inDollar) {
      if (buf.trim()) out.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
}

function resolveCanonicalMigrationPath(): string | null {
  const candidates = [
    path.join(
      process.cwd(),
      "node_modules",
      "@semantos",
      "semantic-objects",
      "migrations",
      "0000_init.sql",
    ),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Reset hook for tests — clears the memoised handle and bootstrap flag.
 * Production code must NOT call this.
 */
export function __resetCalendarDbForTests(): void {
  _db = null;
  _bootstrapped = false;
}
