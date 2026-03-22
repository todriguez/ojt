/**
 * Seed the categories table with the full Universal Commerce Taxonomy.
 *
 * Inserts all three dimensions:
 *   WHAT  — L0 roots, L1 services branches, L2 services.trades.* (OJT operational)
 *   HOW   — 8 transaction type primitives
 *   INST  — 9 instrument types + their subtypes
 *
 * Safe to re-run: uses ON CONFLICT DO UPDATE on path (upsert).
 *
 * Usage:
 *   npx tsx scripts/seed-categories.ts           # uses PGlite (local)
 *   DATABASE_URL=postgres://... npx tsx scripts/seed-categories.ts  # uses Neon
 */
import { categories } from "../src/lib/db/schema";
import * as schema from "../src/lib/db/schema";
import {
  getAllCategories,
  TRANSACTION_TYPES,
  INSTRUMENT_TYPES,
} from "../src/lib/domain/categories/categoryTree";
import type { CategoryNode } from "../src/lib/domain/categories/categoryTree";
import { sql } from "drizzle-orm";

interface CategoryRow {
  path: string;
  dimension: "what" | "how" | "instrument";
  name: string;
  slug: string;
  level: number;
  parentPath: string | null;
  description: string | null;
  keywords: string[];
  attributes: any[];
  valueMultiplier: string;
  siteVisitLikely: boolean;
  licensedTrade: boolean;
  validTxTypes: string[];
  modalTemplate: string | null;
  embeddingText: string | null;
}

function whatNodeToRow(node: CategoryNode): CategoryRow {
  return {
    path: node.path,
    dimension: "what",
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
  };
}

async function createDb() {
  if (process.env.DATABASE_URL) {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    return { db: drizzle(pool, { schema }), close: () => pool.end() };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
  const dataDir = process.env.PGLITE_DATA_DIR || "./pglite-data-v2";
  const client = new PGlite(dataDir);
  await client.waitReady;
  return { db: drizzlePglite(client, { schema }), close: () => client.close() };
}

async function main() {
  const { db, close } = await createDb();
  const rows: CategoryRow[] = [];

  // ── WHAT dimension ──────────────────────────
  const whatNodes = getAllCategories();
  for (const node of whatNodes) {
    rows.push(whatNodeToRow(node));
  }
  console.log(`WHAT dimension: ${whatNodes.length} nodes`);

  // ── HOW dimension (transaction types) ───────
  for (const tx of TRANSACTION_TYPES) {
    rows.push({
      path: tx.path,
      dimension: "how",
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
  console.log(`HOW dimension: ${TRANSACTION_TYPES.length} types`);

  // ── INSTRUMENT dimension ────────────────────
  let instCount = 0;
  for (const inst of INSTRUMENT_TYPES) {
    // Parent instrument type
    rows.push({
      path: inst.path,
      dimension: "instrument",
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
    instCount++;

    // Subtypes
    for (const sub of inst.subtypes) {
      rows.push({
        path: sub.path,
        dimension: "instrument",
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
      instCount++;
    }
  }
  console.log(`INSTRUMENT dimension: ${instCount} types`);

  // ── Upsert all rows ─────────────────────────
  console.log(`\nInserting ${rows.length} total categories...`);

  let inserted = 0;
  let updated = 0;

  // Batch in chunks of 20 to avoid query param limits
  const BATCH_SIZE = 20;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    const result = await db
      .insert(categories)
      .values(batch)
      .onConflictDoUpdate({
        target: categories.path,
        set: {
          dimension: sql`excluded.dimension`,
          name: sql`excluded.name`,
          slug: sql`excluded.slug`,
          level: sql`excluded.level`,
          parentPath: sql`excluded.parent_path`,
          description: sql`excluded.description`,
          keywords: sql`excluded.keywords`,
          attributes: sql`excluded.attributes`,
          valueMultiplier: sql`excluded.value_multiplier`,
          siteVisitLikely: sql`excluded.site_visit_likely`,
          licensedTrade: sql`excluded.licensed_trade`,
          validTxTypes: sql`excluded.valid_tx_types`,
          modalTemplate: sql`excluded.modal_template`,
          embeddingText: sql`excluded.embedding_text`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ path: categories.path });

    inserted += result.length;
  }

  console.log(`\n✅ Seeded ${inserted} categories across 3 dimensions`);
  console.log(`   WHAT:       ${whatNodes.length} (5 roots + 12 services branches + ${whatNodes.length - 17} trades)`);
  console.log(`   HOW:        ${TRANSACTION_TYPES.length} transaction types`);
  console.log(`   INSTRUMENT: ${instCount} (${INSTRUMENT_TYPES.length} parents + ${instCount - INSTRUMENT_TYPES.length} subtypes)`);

  // Verify counts
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(categories);
  console.log(`\n   Total in DB: ${countResult[0].count}`);

  await close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Category seed failed:", err);
  process.exit(1);
});
