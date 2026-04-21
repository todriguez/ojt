/**
 * CalendarGuard singleton (A5.2).
 *
 * Lazily instantiates `createCalendarGuard` from
 * `@semantos/calendar-ext` against the calendar DB handle. The whole
 * wiring is gated behind the `CALENDAR_GUARD_ENABLED` env var:
 *
 *   - flag false           → `getCalendarGuard()` returns null;
 *                            /api/v3/chat passes no guard to handleMessage
 *                            (legacy behaviour).
 *   - flag true, URL set   → guard wired against the shared calendar DB.
 *   - flag true, no URL    → guard wired against the dev PGlite fallback.
 *                            We log a warning if we're clearly in prod
 *                            (NODE_ENV=production) so misconfiguration
 *                            on the VPS doesn't silently cause OJT to
 *                            evaluate against an empty schedule.
 *
 * The singleton mirrors the pattern in `src/lib/federation/singletons.ts`
 * — module-scope memo, async on first read, with a test-only reset hook.
 */
import { createCalendarGuard } from "@semantos/calendar-ext";
import type { CalendarGuard } from "@semantos/intent";

import { createLogger } from "@/lib/logger";

import { getCalendarDb } from "./db";

const log = createLogger("calendar.guard");

let _guard: CalendarGuard | null = null;
let _resolved = false;

/**
 * Returns the configured CalendarGuard, or null when the feature flag
 * is off (or when the guard couldn't be constructed — logged once).
 */
export async function getCalendarGuard(): Promise<CalendarGuard | null> {
  if (_resolved) return _guard;
  _resolved = true;

  if (!isCalendarGuardEnabled()) {
    log.debug("calendar.guard.disabled (CALENDAR_GUARD_ENABLED!=true)");
    _guard = null;
    return null;
  }

  if (!process.env.CALENDAR_DATABASE_URL) {
    if (process.env.NODE_ENV === "production") {
      log.warn(
        "calendar.guard.no_database_url — falling back to PGlite. " +
          "OJT will evaluate against an empty schedule. Set " +
          "CALENDAR_DATABASE_URL on the VPS.",
      );
    } else {
      log.info(
        "calendar.guard.no_database_url — using PGlite fallback (dev/test).",
      );
    }
  }

  try {
    const db = await getCalendarDb();
    // Cast across drizzle-orm major boundaries: OJT runs 0.45, calendar-ext
    // bundles a 0.33-shaped `Database`. Structurally identical at runtime
    // (the `PgDatabase<any, any, any>` boundary) but TS treats the
    // protected `dialect` property as nominally distinct between versions.
    _guard = createCalendarGuard(db as never, {
      scheduleObjectId: scheduleObjectId(),
    });
    log.info(
      { scheduleObjectId: scheduleObjectId() },
      "calendar.guard.initialised",
    );
    return _guard;
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : String(err) },
      "calendar.guard.init_failed",
    );
    _guard = null;
    return null;
  }
}

export function isCalendarGuardEnabled(): boolean {
  const v = process.env.CALENDAR_GUARD_ENABLED;
  return v === "true" || v === "1";
}

export function scheduleObjectId(): string {
  return process.env.CAL_SCHEDULE_OBJECT_ID || "schedule-primary";
}

/**
 * Test-only reset hook. Production code must not call this.
 */
export function __resetCalendarGuardForTests(): void {
  _guard = null;
  _resolved = false;
}
