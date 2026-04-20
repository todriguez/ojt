#!/usr/bin/env npx tsx
/**
 * seed-trades-taxonomy.ts
 *
 * Populates sem_taxonomies with the trades/services vertical entries
 * from the Universal Commerce Taxonomy spec.
 *
 * Three dimensions seeded:
 *   WHAT: services.trades.* (11 L2 categories)
 *   HOW: tx.hire, tx.meter (valid for services)
 *   INSTRUMENT: inst.quote.*, inst.contract.*, inst.invoice.* (trades-relevant)
 *
 * Usage: npx tsx scripts/seed-trades-taxonomy.ts
 */

import "dotenv/config";
import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

interface TaxonomyEntry {
  vertical: string;
  dimension: string;
  path: string;
  parentPath: string | null;
  attributes: Record<string, unknown>;
  keywords: string[];
}

const VERTICAL = "trades";

// ─── WHAT dimension: services.trades.* ──────────────────────────────

const whatEntries: TaxonomyEntry[] = [
  // L0
  {
    vertical: VERTICAL, dimension: "what", path: "services",
    parentPath: null,
    attributes: { level: 0, description: "Labour, expertise, creative output, professional work" },
    keywords: ["services", "labour", "work", "professional"],
  },
  // L1
  {
    vertical: VERTICAL, dimension: "what", path: "services.trades",
    parentPath: "services",
    attributes: { level: 1, description: "Licensed and unlicensed trade work", siteVisitLikely: true, validTxTypes: ["hire", "meter"] },
    keywords: ["trades", "tradesman", "tradie", "handyman", "contractor"],
  },
  // L2 — the 11 OJT categories
  ...[
    { slug: "plumbing", desc: "Water supply, drainage, gas fitting, pipe repair, fixture installation", keywords: ["plumber", "plumbing", "pipes", "tap", "drain", "toilet", "hot water", "leak"], licensed: true, attrs: { fixtureTypes: true, pipeMaterial: true } },
    { slug: "electrical", desc: "Wiring, switchboards, lighting, power points, safety switches", keywords: ["electrician", "electrical", "wiring", "lights", "powerpoint", "switchboard", "safety switch"], licensed: true, attrs: { circuitType: true, safetySwitch: true } },
    { slug: "carpentry", desc: "Timber framing, decking, cabinetry, doors, windows, structural timber", keywords: ["carpenter", "carpentry", "timber", "wood", "deck", "cabinet", "framing", "door"], licensed: false, attrs: { timberType: true, structural: false } },
    { slug: "painting", desc: "Interior and exterior painting, staining, wallpaper, surface prep", keywords: ["painter", "painting", "paint", "stain", "wallpaper", "interior", "exterior"], licensed: false, attrs: { surfaceType: true, coats: true } },
    { slug: "fencing", desc: "Colorbond, timber, pool fencing, gate installation, post replacement", keywords: ["fencing", "fence", "gate", "colorbond", "timber fence", "pool fence", "boundary"], licensed: false, attrs: { fenceType: true, linealMetres: true } },
    { slug: "tiling", desc: "Floor tiles, wall tiles, bathroom tiling, waterproofing, grouting", keywords: ["tiler", "tiling", "tiles", "grout", "waterproof", "bathroom tiles", "floor tiles"], licensed: false, attrs: { tileType: true, waterproofing: true } },
    { slug: "roofing", desc: "Roof repairs, re-roofing, gutters, downpipes, fascia, flashing", keywords: ["roofer", "roofing", "roof", "gutter", "downpipe", "fascia", "flashing", "leak"], licensed: false, attrs: { roofType: true, accessHeight: true } },
    { slug: "doors-windows", desc: "Door hanging, window replacement, locks, hardware, security screens", keywords: ["door", "window", "lock", "screen door", "sliding door", "security", "hardware"], licensed: false, attrs: { doorType: true, lockType: true } },
    { slug: "gardening", desc: "Lawn mowing, hedge trimming, garden maintenance, landscaping, tree work", keywords: ["gardener", "gardening", "lawn", "mow", "hedge", "landscaping", "tree", "garden"], licensed: false, attrs: { areaSize: true, greenWaste: true } },
    { slug: "cleaning", desc: "Residential cleaning, pressure washing, carpet cleaning, end-of-lease", keywords: ["cleaner", "cleaning", "pressure wash", "carpet clean", "end of lease", "house clean"], licensed: false, attrs: { cleanType: true, propertySize: true } },
    { slug: "general-handyman", desc: "General repairs, assembly, mounting, odd jobs, maintenance", keywords: ["handyman", "odd job", "repair", "fix", "mount", "assemble", "maintenance", "general"], licensed: false, attrs: {} },
  ].map(t => ({
    vertical: VERTICAL,
    dimension: "what",
    path: `services.trades.${t.slug}`,
    parentPath: "services.trades",
    attributes: { level: 2, description: t.desc, licensedTrade: t.licensed, siteVisitLikely: true, validTxTypes: ["hire", "meter"], ...t.attrs },
    keywords: t.keywords,
  })),
];

// ─── HOW dimension: transaction types valid for trades ───────────────

const howEntries: TaxonomyEntry[] = [
  {
    vertical: VERTICAL, dimension: "how", path: "tx.hire",
    parentPath: null,
    attributes: { description: "Service engagement — labour/expertise exchanged", settlementPattern: "fixed_price_or_hourly_or_milestone" },
    keywords: ["hire", "quote", "get a quote", "need someone", "looking for"],
  },
  {
    vertical: VERTICAL, dimension: "how", path: "tx.meter",
    parentPath: null,
    attributes: { description: "Continuous flow — pay per unit consumed (hourly rates)", settlementPattern: "per_hour_or_per_unit" },
    keywords: ["hourly", "per hour", "by the hour", "metered", "time and materials"],
  },
];

// ─── INSTRUMENT dimension: document types for trades ────────────────

const instrumentEntries: TaxonomyEntry[] = [
  // Quotes
  {
    vertical: VERTICAL, dimension: "instrument", path: "inst.quote",
    parentPath: null,
    attributes: { description: "Non-binding offer with terms and pricing" },
    keywords: ["quote", "estimate", "pricing", "ballpark"],
  },
  {
    vertical: VERTICAL, dimension: "instrument", path: "inst.quote.rough-order-of-magnitude",
    parentPath: "inst.quote",
    attributes: { description: "ROM quote — ballpark range, not binding, generated from conversation", compilerPhase: "codegen" },
    keywords: ["rom", "rough", "ballpark", "estimate", "roughly"],
  },
  {
    vertical: VERTICAL, dimension: "instrument", path: "inst.quote.fixed-price",
    parentPath: "inst.quote",
    attributes: { description: "Fixed-price quote — binding, itemised, after site visit", compilerPhase: "codegen" },
    keywords: ["fixed price", "firm quote", "exact price", "itemised"],
  },
  // Contracts
  {
    vertical: VERTICAL, dimension: "instrument", path: "inst.contract",
    parentPath: null,
    attributes: { description: "Binding agreement between parties" },
    keywords: ["contract", "agreement"],
  },
  {
    vertical: VERTICAL, dimension: "instrument", path: "inst.contract.service-agreement",
    parentPath: "inst.contract",
    attributes: { description: "Service agreement for trade work — scope, price, terms, warranty", compilerPhase: "codegen" },
    keywords: ["service agreement", "work agreement", "terms"],
  },
  // Invoices
  {
    vertical: VERTICAL, dimension: "instrument", path: "inst.invoice",
    parentPath: null,
    attributes: { description: "Payment request from provider to customer" },
    keywords: ["invoice", "bill", "payment"],
  },
  {
    vertical: VERTICAL, dimension: "instrument", path: "inst.invoice.standard",
    parentPath: "inst.invoice",
    attributes: { description: "Standard invoice after work completion", compilerPhase: "action" },
    keywords: ["invoice", "bill", "pay"],
  },
  {
    vertical: VERTICAL, dimension: "instrument", path: "inst.invoice.progress",
    parentPath: "inst.invoice",
    attributes: { description: "Progress invoice for multi-day work", compilerPhase: "action" },
    keywords: ["progress", "partial", "milestone"],
  },
];

const allEntries = [...whatEntries, ...howEntries, ...instrumentEntries];

async function seed() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Upsert each entry — use the unique index columns directly
    let inserted = 0;
    let updated = 0;
    for (const entry of allEntries) {
      // Check if exists
      const exists = await client.query(
        `SELECT id FROM sem_taxonomies WHERE vertical = $1 AND dimension = $2 AND path = $3`,
        [entry.vertical, entry.dimension, entry.path]
      );
      if (exists.rows.length > 0) {
        await client.query(
          `UPDATE sem_taxonomies SET attributes = $1, keywords = $2 WHERE id = $3`,
          [JSON.stringify(entry.attributes), JSON.stringify(entry.keywords), exists.rows[0].id]
        );
        updated++;
      } else {
        await client.query(
          `INSERT INTO sem_taxonomies (id, vertical, dimension, path, parent_path, attributes, keywords, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW())`,
          [entry.vertical, entry.dimension, entry.path, entry.parentPath, JSON.stringify(entry.attributes), JSON.stringify(entry.keywords)]
        );
        inserted++;
      }
    }

    await client.query("COMMIT");
    console.log(`\n✅ Trades taxonomy seeded: ${inserted} inserted, ${updated} updated, ${allEntries.length} total`);
    console.log(`   WHAT:       ${whatEntries.length} entries (services.trades.*)`);
    console.log(`   HOW:        ${howEntries.length} entries (tx.hire, tx.meter)`);
    console.log(`   INSTRUMENT: ${instrumentEntries.length} entries (inst.quote.*, inst.contract.*, inst.invoice.*)`);

  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
