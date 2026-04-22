/**
 * /admin/calendar — operator-only PlateView render (A5.2).
 *
 * Read-only at this stage. Renders bookings + holds for Todd's two
 * working hats (handyman + advisor) using `PlateView` from
 * @semantos/calendar-ext/ui.
 *
 * Auth gate:
 *   - The /admin layout already enforces a valid `ojt_admin_session`
 *     JWT cookie with `type: 'admin'`. We additionally cross-check the
 *     session's effective certId against `OJT_OPERATOR_CERT_ID` (or
 *     `OJT_ADMIN_CERT_ID` as a fallback) so a future split between
 *     "admin login" and "calendar operator" is a one-line env flip.
 *
 * No fetch from the calendar DB happens unless CALENDAR_GUARD_ENABLED
 * is true — when the flag is off we still render the shell so an
 * operator can confirm the page exists, with an empty grid.
 */
import * as React from "react";

import { cookies } from "next/headers";
import { jwtVerify } from "jose";

import { PlateView } from "@semantos/calendar-ext/ui";
import {
  listBookings,
  listHolds,
} from "@semantos/calendar-ext";

import { getCalendarDb } from "@/lib/calendar/db";
import {
  isCalendarGuardEnabled,
  scheduleObjectId,
} from "@/lib/calendar/guard";
import { createLogger } from "@/lib/logger";

const log = createLogger("admin.calendar");

export const dynamic = "force-dynamic";
export const revalidate = 0;

const HAT_IDS = ["todd-handyman", "todd-advisor"];

interface AdminSessionPayload {
  type?: string;
  email?: string;
  certId?: string;
}

async function readAdminSession(): Promise<AdminSessionPayload | null> {
  const token = (await cookies()).get("ojt_admin_session")?.value;
  if (!token) return null;
  const secret = new TextEncoder().encode(process.env.JWT_SECRET || "");
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: "oddjobtodd",
    });
    return payload as AdminSessionPayload;
  } catch {
    const prev = process.env.JWT_SECRET_PREVIOUS;
    if (!prev) return null;
    try {
      const { payload } = await jwtVerify(
        token,
        new TextEncoder().encode(prev),
        { issuer: "oddjobtodd" },
      );
      return payload as AdminSessionPayload;
    } catch {
      return null;
    }
  }
}

function operatorCertId(): string | null {
  return (
    process.env.OJT_OPERATOR_CERT_ID || process.env.OJT_ADMIN_CERT_ID || null
  );
}

function isAuthorisedAdmin(session: AdminSessionPayload | null): boolean {
  if (!session || session.type !== "admin") return false;
  // The JWT may not carry a certId yet (legacy sessions). When it
  // doesn't, having `type: 'admin'` is sufficient — the layout already
  // verified the cookie. When it does, it must match the operator cert.
  const expected = operatorCertId();
  if (!expected) return true;
  if (!session.certId) return true; // legacy admin session — pass
  return session.certId === expected;
}

export default async function AdminCalendarPage() {
  const session = await readAdminSession();

  if (!isAuthorisedAdmin(session)) {
    // Page-level 403. We deliberately do NOT redirect to /admin/login —
    // the user IS authenticated, just not as the operator. Surfacing a
    // 403 makes misconfiguration obvious. Next 16 lets a server
    // component return a Response directly to set the status code.
    return new Response("forbidden", { status: 403 }) as unknown as React.ReactElement;
  }

  let bookings: Awaited<ReturnType<typeof listBookings>> = [];
  let holds: Awaited<ReturnType<typeof listHolds>> = [];

  if (isCalendarGuardEnabled()) {
    try {
      const db = await getCalendarDb();
      const sched = scheduleObjectId();
      bookings = await listBookings(db as never, {
        scheduleObjectId: sched,
      });
      holds = await listHolds(db as never, {
        scheduleObjectId: sched,
      });
    } catch (err) {
      log.error(
        { error: err instanceof Error ? err.message : String(err) },
        "admin.calendar.fetch_failed",
      );
    }
  }

  return (
    <main className="p-6">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Calendar — this week</h1>
        <div className="text-sm text-slate-500">
          {isCalendarGuardEnabled()
            ? `${bookings.length} bookings · ${holds.length} holds`
            : "calendar guard disabled (CALENDAR_GUARD_ENABLED=false)"}
        </div>
      </header>
      <PlateView hatIds={HAT_IDS} bookings={bookings} holds={holds} />
    </main>
  );
}
