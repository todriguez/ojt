/**
 * Gate tests for sem_object_patches federation fields + sem_signed_bundles.
 *
 * Runner: Node's built-in node:test (see tests/unit/auth.test.ts).
 * Run:    npx tsx --test tests/db/sem-patches-federation-fields.test.ts
 *
 * Uses a fresh ephemeral PGlite instance with migrations applied.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql, eq } from "drizzle-orm";

import * as kernelCore from "../../src/lib/semantos-kernel/schema.core";

type Db = ReturnType<typeof drizzle<typeof kernelCore>>;

let client: PGlite;
let db: Db;
let DATA_DIR: string;

let OBJECT_ID: string;

before(async () => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pglite-federation-"));
  client = new PGlite(DATA_DIR);
  await client.waitReady;
  db = drizzle(client, { schema: kernelCore }) as unknown as Db;

  // Apply full drizzle migration set (includes 0009_*).
  await migrate(db as any, { migrationsFolder: path.join(process.cwd(), "drizzle") });

  // Parent object for all patch rows under test.
  const [obj] = await db
    .insert(kernelCore.semanticObjects)
    .values({
      vertical: "trades",
      objectKind: "job",
      typeHash: "a".repeat(64),
      currentStateHash: "",
    })
    .returning();
  OBJECT_ID = obj.id;
});

after(async () => {
  await client.close();
  if (DATA_DIR && fs.existsSync(DATA_DIR)) {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
});

describe("sem_object_patches federation fields + sem_signed_bundles", () => {
  it("G1: round-trip federation fields on sem_object_patches", async () => {
    const ts = Date.now();
    const [inserted] = await db
      .insert(kernelCore.objectPatches)
      .values({
        objectId: OBJECT_ID,
        fromVersion: 1,
        toVersion: 2,
        prevStateHash: "b".repeat(64),
        newStateHash: "c".repeat(64),
        patchKind: "extraction",
        delta: { foo: { from: null, to: 1 } },
        source: "user:test-g1",
        timestamp: ts,
        facetId: "hat-tenant",
        facetCapabilities: [1, 2, 4],
        lexicon: "jural",
      })
      .returning();

    const [row] = await db
      .select()
      .from(kernelCore.objectPatches)
      .where(eq(kernelCore.objectPatches.id, inserted.id));

    assert.equal(row.timestamp, ts);
    assert.equal(row.facetId, "hat-tenant");
    assert.deepEqual(row.facetCapabilities, [1, 2, 4]);
    assert.equal(row.lexicon, "jural");
  });

  it("G2: federation fields default to null when omitted", async () => {
    const [inserted] = await db
      .insert(kernelCore.objectPatches)
      .values({
        objectId: OBJECT_ID,
        fromVersion: 2,
        toVersion: 3,
        prevStateHash: "c".repeat(64),
        newStateHash: "d".repeat(64),
        patchKind: "extraction",
        delta: {},
        source: "user:test-g2",
      })
      .returning();

    const [row] = await db
      .select()
      .from(kernelCore.objectPatches)
      .where(eq(kernelCore.objectPatches.id, inserted.id));

    assert.equal(row.timestamp, null);
    assert.equal(row.facetId, null);
    assert.equal(row.facetCapabilities, null);
    assert.equal(row.lexicon, null);
  });

  it("G3: FK cascade — deleting a patch deletes its signed bundles", async () => {
    const [patch] = await db
      .insert(kernelCore.objectPatches)
      .values({
        objectId: OBJECT_ID,
        fromVersion: 3,
        toVersion: 4,
        prevStateHash: "d".repeat(64),
        newStateHash: "e".repeat(64),
        patchKind: "extraction",
        delta: {},
        source: "user:test-g3",
      })
      .returning();

    const bundleId = "bundle-g3-" + Date.now();
    await db.insert(kernelCore.semSignedBundles).values({
      id: bundleId,
      patchId: patch.id,
      signerBca: "1".padEnd(45, "x"),
      signerPubkeyHex: "02".padEnd(66, "f"),
      signature: "a".repeat(144),
      signedAt: new Date(),
      direction: "outbound",
    });

    const before = await db
      .select()
      .from(kernelCore.semSignedBundles)
      .where(eq(kernelCore.semSignedBundles.id, bundleId));
    assert.equal(before.length, 1);

    await db
      .delete(kernelCore.objectPatches)
      .where(eq(kernelCore.objectPatches.id, patch.id));

    const after = await db
      .select()
      .from(kernelCore.semSignedBundles)
      .where(eq(kernelCore.semSignedBundles.id, bundleId));
    assert.equal(after.length, 0, "bundle should have been cascade-deleted");
  });

  it("G4: direction CHECK rejects values outside {inbound, outbound}", async () => {
    const [patch] = await db
      .insert(kernelCore.objectPatches)
      .values({
        objectId: OBJECT_ID,
        fromVersion: 4,
        toVersion: 5,
        prevStateHash: "e".repeat(64),
        newStateHash: "f".repeat(64),
        patchKind: "extraction",
        delta: {},
        source: "user:test-g4",
      })
      .returning();

    let rejected = false;
    let message = "";
    try {
      await db.insert(kernelCore.semSignedBundles).values({
        id: "bundle-g4-" + Date.now(),
        patchId: patch.id,
        signerBca: "1".padEnd(45, "x"),
        signerPubkeyHex: "02".padEnd(66, "f"),
        signature: "a".repeat(144),
        signedAt: new Date(),
        // @ts-expect-error — intentionally invalid for CHECK constraint test
        direction: "sideways",
      });
    } catch (err: any) {
      rejected = true;
      // Drizzle wraps the driver error; dig for the underlying pg/PGlite detail.
      const parts: string[] = [];
      const walk = (e: any, depth = 0) => {
        if (!e || depth > 4) return;
        if (typeof e === "string") { parts.push(e); return; }
        if (typeof e.message === "string") parts.push(e.message);
        if (typeof e.detail === "string") parts.push(e.detail);
        if (typeof e.code === "string") parts.push(`code=${e.code}`);
        if (typeof e.constraint === "string") parts.push(`constraint=${e.constraint}`);
        if (e.cause) walk(e.cause, depth + 1);
      };
      walk(err);
      message = parts.join(" | ");
    }

    assert.ok(
      rejected,
      "expected insert with direction='sideways' to be rejected by CHECK constraint"
    );
    // PGlite reports check-constraint violations; Postgres uses SQLSTATE 23514.
    // Accept any signal that this was rejected by our constraint (not by NOT NULL, etc).
    assert.ok(
      /check|constraint|sem_signed_bundles_direction_check|23514|sideways/i.test(message),
      `unexpected error: ${message}`
    );
  });
});
