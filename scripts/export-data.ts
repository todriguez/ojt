/**
 * Export data as JSONL files for backup/analysis.
 *
 * Usage: npx tsx scripts/export-data.ts
 *
 * Exports: jobs, messages, customers, job_outcomes
 */

import "dotenv/config";
import { writeFileSync } from "fs";
import { getDb } from "../src/lib/db/client";
import { jobs, messages, customers, jobOutcomes } from "../src/lib/db/schema";

async function exportTable(
  name: string,
  queryFn: () => Promise<Record<string, unknown>[]>
) {
  console.log(`Exporting ${name}...`);
  const rows = await queryFn();
  const lines = rows.map((r) => JSON.stringify(r)).join("\n");
  const filename = `export-${name}.jsonl`;
  writeFileSync(filename, lines + "\n");
  console.log(`  → ${filename} (${rows.length} rows)`);
}

async function main() {
  const db = await getDb();

  await exportTable("jobs", () => db.select().from(jobs));
  await exportTable("messages", () => db.select().from(messages));
  await exportTable("customers", () => db.select().from(customers));
  await exportTable("outcomes", () => db.select().from(jobOutcomes));

  console.log("Export complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Export failed:", err);
  process.exit(1);
});
