/**
 * A5.2 calendar-guard gate tests.
 *
 * Runner: bun test (matches P7's pattern; the booking + page paths
 * use Bun's runtime modules anyway).
 *
 * Gates:
 *   G1 — flag OFF → no guard injected, runHandleMessage flows like P5
 *   G2 — flag ON + no conflict → bookSlot creates a booking (cal_bookings)
 *   G3 — flag ON + conflict   → reply contains "Sorry" + ≥ 2 free windows
 *                               and no booking is created
 *   G4 — /admin/calendar — 200 with admin session, 403 otherwise
 *   G5 — extractProposedSlot returns the expected shape
 *
 * Both DBs (OJT main + calendar) run as in-process PGlite pointed at a
 * per-test temp dir. The calendar DB is NOT shared with OJT's main DB
 * (they share a table name but have divergent schemas — see
 * src/lib/calendar/db.ts).
 */
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  mock,
} from "bun:test";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { extractProposedSlot } from "@semantos/intent";
import {
  bookSlot as calBookSlot,
  listBookings,
  seedAll,
} from "@semantos/calendar-ext";

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { getPublicKey } from "@noble/secp256k1";

// ── Fixtures + per-suite env ─────────────────────────────────────

const FIXTURE_SEED_HEX =
  "a1b2c3d4e5f60708091011121314151617181920212223242526272829303132";
const ADMIN_PRIVKEY_HEX = "9".repeat(64);
const ADMIN_PUBKEY_HEX = bytesToHex(
  getPublicKey(hexToBytes(ADMIN_PRIVKEY_HEX), true),
);
const ADMIN_CERT_ID = bytesToHex(
  sha256(new TextEncoder().encode("ojt:admin:a5-calendar-gate")),
);

const SCHEDULE_OBJECT_ID = "schedule-test";

let DATA_DIR: string;
let CAL_DATA_DIR: string;

beforeAll(async () => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ojt-a5-"));
  CAL_DATA_DIR = path.join(DATA_DIR, "pglite-cal");

  // OJT main DB env
  process.env.PGLITE_DATA_DIR = path.join(DATA_DIR, "pglite-main");
  process.env.OJT_DERIVATION_SEED = FIXTURE_SEED_HEX;
  process.env.OJT_ADMIN_CERT_ID = ADMIN_CERT_ID;
  process.env.OJT_ADMIN_PUBKEY_HEX = ADMIN_PUBKEY_HEX;
  process.env.OJT_ADMIN_PRIVKEY_HEX = ADMIN_PRIVKEY_HEX;
  process.env.JWT_SECRET = "test-secret-that-is-at-least-32-characters-long";
  process.env.ADMIN_EMAIL = "todd@oddjobtodd.info";
  process.env.ADMIN_PASSWORD_HASH = "fakesalt:fakehash";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  delete process.env.DATABASE_URL;

  // Calendar DB env
  process.env.PGLITE_DATA_DIR_CALENDAR = CAL_DATA_DIR;
  delete process.env.CALENDAR_DATABASE_URL;
  process.env.CAL_SCHEDULE_OBJECT_ID = SCHEDULE_OBJECT_ID;

  // Seed the schedule + the two operator hats so calendar-ext's
  // findFreeWindows / bookSlot have somewhere to land.
  const { getCalendarDb, __resetCalendarDbForTests } = await import(
    "../../src/lib/calendar/db"
  );
  __resetCalendarDbForTests();
  const calDb = await getCalendarDb();
  await seedAll(calDb as never, {
    ownerCertId: ADMIN_CERT_ID,
    timezone: "Australia/Brisbane",
    scheduleObjectId: SCHEDULE_OBJECT_ID,
    operatorHatId: "operator",
    operatorDisplayName: "Operator",
    childHats: [
      { id: "todd-handyman", displayName: "Handyman" },
      { id: "todd-advisor", displayName: "Advisor" },
    ],
  });
});

afterAll(() => {
  if (DATA_DIR && fs.existsSync(DATA_DIR)) {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  // Reset feature flag to a known starting state per test.
  delete process.env.CALENDAR_GUARD_ENABLED;
  const { __resetCalendarGuardForTests } = await import(
    "../../src/lib/calendar/guard"
  );
  __resetCalendarGuardForTests();
});

// ── G1 flag OFF — no guard injected, legacy behaviour ────────────

describe("A5.2 calendar-guard gates", () => {
  test("G1 flag OFF → runHandleMessage skips guard step", async () => {
    process.env.CALENDAR_GUARD_ENABLED = "false";
    const { runHandleMessage } = await import(
      "../../src/lib/services/ojtHandleMessage"
    );
    const { getCalendarGuard } = await import("../../src/lib/calendar/guard");
    const guard = await getCalendarGuard();
    expect(guard).toBeNull();

    const result = await runHandleMessage({
      objectId: "obj-g1",
      identity: { facetId: "facet-g1", certId: "cert-g1" },
      message: "Need a fence repair next month sometime.",
      // No proposedSlot, no guard — runHandleMessage takes the legacy
      // path identical to P5/P6 behaviour.
    });
    expect(result.triageHint).toBe("PROPOSES");
    expect(result.raw.kind).toBe("proposed");
  });

  // ── G2 happy path — guard ON, no conflict, bookSlot lands ─────

  test("G2 flag ON + no conflict → bookSlot creates a cal_bookings row", async () => {
    process.env.CALENDAR_GUARD_ENABLED = "true";
    const { __resetCalendarGuardForTests, getCalendarGuard } = await import(
      "../../src/lib/calendar/guard"
    );
    __resetCalendarGuardForTests();
    const guard = await getCalendarGuard();
    expect(guard).not.toBeNull();

    const startAt = new Date("2026-06-10T02:00:00Z");
    const endAt = new Date("2026-06-10T04:00:00Z");
    const proposedSlot = {
      startAt,
      endAt,
      hatId: "todd-handyman",
      subjectKind: "ojt-job",
      subjectId: "job-g2",
      proposedByCertId: ADMIN_CERT_ID,
    };

    const { runHandleMessage, buildProposedSlotClassifier } = await import(
      "../../src/lib/services/ojtHandleMessage"
    );
    const result = await runHandleMessage({
      objectId: "obj-g2",
      identity: { facetId: "facet-g2", certId: ADMIN_CERT_ID },
      message: "Tuesday 10 June 12pm-2pm works for the deck job.",
      calendarGuard: guard ?? undefined,
      classifier: buildProposedSlotClassifier(proposedSlot),
    });
    expect(result.triageHint).toBe("PROPOSES");
    expect(result.raw.kind).toBe("proposed");

    // Now book the slot directly — mirrors what chatService does on
    // the happy-path confirmBooking branch.
    const { getCalendarDb } = await import("../../src/lib/calendar/db");
    const db = await getCalendarDb();
    await calBookSlot(db as never, {
      hatId: proposedSlot.hatId,
      startAt: proposedSlot.startAt,
      endAt: proposedSlot.endAt,
      subjectKind: proposedSlot.subjectKind,
      subjectId: proposedSlot.subjectId,
      bookedByCertId: ADMIN_CERT_ID,
      scheduleObjectId: SCHEDULE_OBJECT_ID,
    });

    const bookings = await listBookings(db as never, {
      hatId: proposedSlot.hatId,
      scheduleObjectId: SCHEDULE_OBJECT_ID,
    });
    const found = bookings.find(
      (b) =>
        b.subjectId === "job-g2" &&
        new Date(b.startAt).toISOString() === startAt.toISOString(),
    );
    expect(found).toBeDefined();
  });

  // ── G3 conflict path — reply lists free windows ───────────────

  test(
    "G3 flag ON + conflict → reject_conflict carries ≥ 2 free windows; no booking",
    async () => {
      process.env.CALENDAR_GUARD_ENABLED = "true";
      const { __resetCalendarGuardForTests, getCalendarGuard } = await import(
        "../../src/lib/calendar/guard"
      );
      __resetCalendarGuardForTests();
      const guard = await getCalendarGuard();
      expect(guard).not.toBeNull();

      // Pre-seed a booking so the proposed slot collides.
      const blockerStart = new Date("2026-07-15T02:00:00Z");
      const blockerEnd = new Date("2026-07-15T04:00:00Z");
      const { getCalendarDb } = await import("../../src/lib/calendar/db");
      const db = await getCalendarDb();
      await calBookSlot(db as never, {
        hatId: "todd-handyman",
        startAt: blockerStart,
        endAt: blockerEnd,
        subjectKind: "ojt-job",
        subjectId: "job-g3-blocker",
        bookedByCertId: ADMIN_CERT_ID,
        scheduleObjectId: SCHEDULE_OBJECT_ID,
      });

      const conflictingSlot = {
        startAt: new Date("2026-07-15T03:00:00Z"), // overlaps the blocker
        endAt: new Date("2026-07-15T05:00:00Z"),
        hatId: "todd-handyman",
        subjectKind: "ojt-job",
        subjectId: "job-g3",
        proposedByCertId: ADMIN_CERT_ID,
      };

      const { runHandleMessage, buildProposedSlotClassifier } = await import(
        "../../src/lib/services/ojtHandleMessage"
      );
      const result = await runHandleMessage({
        objectId: "obj-g3",
        identity: { facetId: "facet-g3", certId: ADMIN_CERT_ID },
        message: "Wednesday 15 July 1pm-3pm please.",
        calendarGuard: guard ?? undefined,
        classifier: buildProposedSlotClassifier(conflictingSlot),
      });
      expect(result.triageHint).toBe("REJECT_CONFLICT");
      expect(result.raw.kind).toBe("reject_conflict");
      const raw = result.raw as Extract<
        typeof result.raw,
        { kind: "reject_conflict" }
      >;
      expect(raw.conflictingBookings.length).toBeGreaterThan(0);
      expect(raw.freeWindows.length).toBeGreaterThanOrEqual(2);

      // Confirm the conflict reply formatter renders correctly.
      const { formatConflictReply } = await import(
        "../../src/lib/services/chatService"
      );
      const reply = formatConflictReply(raw);
      expect(reply).toContain("Sorry");
      // ≤ 3 windows shown — count the bullet markers.
      const bulletCount = (reply.match(/^  •/gm) ?? []).length;
      expect(bulletCount).toBeGreaterThanOrEqual(2);
      expect(bulletCount).toBeLessThanOrEqual(3);

      // Confirm no booking landed for job-g3 (the blocker stays).
      const bookings = await listBookings(db as never, {
        hatId: "todd-handyman",
        scheduleObjectId: SCHEDULE_OBJECT_ID,
      });
      const conflicted = bookings.find((b) => b.subjectId === "job-g3");
      expect(conflicted).toBeUndefined();
    },
  );

  // ── G4 admin page auth ────────────────────────────────────────

  test("G4 /admin/calendar — 200 for admin session, 403 otherwise", async () => {
    // Drive the page component's auth gate by swapping the cookies
    // accessor via Bun's `mock.module`. The page imports {cookies}
    // from 'next/headers'; the mock returns whatever's in cookieMap.
    const { SignJWT } = await import("jose");
    const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
    const adminToken = await new SignJWT({
      type: "admin",
      email: "todd@oddjobtodd.info",
      certId: ADMIN_CERT_ID,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("oddjobtodd")
      .setExpirationTime("8h")
      .sign(secret);

    const cookieMap = new Map<string, string>([
      ["ojt_admin_session", adminToken],
    ]);

    mock.module("next/headers", () => ({
      cookies: async () => ({
        get: (name: string) =>
          cookieMap.has(name) ? { value: cookieMap.get(name)! } : undefined,
      }),
      headers: async () => ({
        get: (_name: string) => null,
      }),
    }));

    process.env.OJT_OPERATOR_CERT_ID = ADMIN_CERT_ID;

    const pageMod = await import("../../src/app/admin/calendar/page");
    const okResult = await pageMod.default();
    // okResult is a JSX element (server component) — not a Response.
    expect(okResult).toBeDefined();
    // Loose duck check — server component returned a JSX node, not 403.
    expect((okResult as unknown as Response).status).not.toBe(403);

    // Forbidden case: empty cookie jar.
    cookieMap.clear();
    const forbidden = await pageMod.default();
    expect((forbidden as unknown as Response).status).toBe(403);
  });

  // ── G5 extractProposedSlot unit ────────────────────────────────

  test("G5 extractProposedSlot returns the expected shape", () => {
    const startIso = "2026-08-01T02:00:00Z";
    const endIso = "2026-08-01T04:00:00Z";
    const slot = extractProposedSlot({
      proposedSlot: {
        startAt: startIso,
        endAt: endIso,
        hatId: "todd-handyman",
        subjectKind: "ojt-job",
        subjectId: "job-g5",
      },
    });
    expect(slot).not.toBeNull();
    expect(slot!.hatId).toBe("todd-handyman");
    expect(slot!.subjectKind).toBe("ojt-job");
    expect(slot!.subjectId).toBe("job-g5");
    expect(slot!.startAt instanceof Date).toBe(true);
    expect(slot!.endAt instanceof Date).toBe(true);
    // Dates normalise to Date instances; compare by millisecond.
    expect(slot!.startAt.getTime()).toBe(new Date(startIso).getTime());

    // Bad payload returns null.
    expect(extractProposedSlot({})).toBeNull();
    expect(
      extractProposedSlot({ proposedSlot: { startAt: "garbage" } }),
    ).toBeNull();
  });
});
