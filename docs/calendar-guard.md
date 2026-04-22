# CalendarGuard in OJT (A5.2)

## What it does

When a tenant proposes a specific date + time in `/api/v3/chat`, OJT
routes the classifier's `proposedSlot` through
[`@semantos/calendar-ext`](https://github.com/semantos/semantos-core/tree/main/extensions/calendar)'s
`CalendarGuard` before running the expensive LLM extraction/scoring
loop. Conflicts short-circuit: the guard reports any live bookings or
holds on the proposed window, emits a list of free alternatives, and
OJT returns a user-facing "Sorry, Todd isn't free …" reply without
consulting Claude.

Happy-path proposals (no conflict) flow through the normal chat
pipeline. When the caller asks OJT to confirm a booking
(`confirmBooking: true` on the request body), OJT calls
`bookSlot` on the shared calendar DB inside the same turn. A booking
failure rolls back the chat turn — the caller sees a 500 with detail.

## Env contract

| Variable | Purpose | Default |
| -------- | ------- | ------- |
| `CALENDAR_GUARD_ENABLED` | Master feature flag. `true` or `1` activates the guard. | `false` |
| `CALENDAR_DATABASE_URL` | Postgres connection string for the shared `calendar_prod` DB. | — falls back to PGlite |
| `CAL_SCHEDULE_OBJECT_ID` | `sem_objects.id` of the schedule aggregate. | `schedule-primary` |
| `PGLITE_DATA_DIR_CALENDAR` | PGlite data directory when running without `CALENDAR_DATABASE_URL`. | `./pglite-data-calendar` |
| `OJT_OPERATOR_CERT_ID` | Cert id allowed to view `/admin/calendar`. Falls back to `OJT_ADMIN_CERT_ID`. | — |

The calendar DB is deliberately **separate** from OJT's main DB.
OJT's `sem_objects` table (in `src/lib/semantos-kernel/schema.core.ts`)
has OJT-specific columns (`vertical`, `type_hash`, `type_path`) that
the canonical `@semantos/semantic-objects` schema doesn't carry. Even
in dev, the calendar falls back to its own PGlite instance so inserts
from `calendar-ext` don't collide with OJT's shape.

## Seeding the schedule + hats

The calendar DB needs one `schedule` row (`sem_objects.object_kind =
'schedule'`) and one hat row per operator. Run this once per
deployment:

```ts
import { seedAll, readSeedEnv } from '@semantos/calendar-ext';
import { getCalendarDb } from '@/lib/calendar/db';

const db = await getCalendarDb();
await seedAll(db as never, readSeedEnv());
```

`readSeedEnv` reads:

```
CAL_OWNER_CERT_ID        — operator cert that owns the schedule
CAL_SCHEDULE_OBJECT_ID   — id for the schedule
CAL_TIMEZONE             — IANA tz (default 'UTC')
CAL_OPERATOR_HAT_ID      — root hat id (default 'operator')
CAL_OPERATOR_DISPLAY_NAME
CAL_CHILD_HATS           — JSON array: [{id, displayName, weekendsEnabled?}, ...]
```

OJT wires two child hats by default — `todd-handyman` and
`todd-advisor`. Adjust per deployment.

## How to disable

Set `CALENDAR_GUARD_ENABLED=false` (or leave it unset). OJT behaves
exactly like pre-A5:

- `/api/v3/chat` ignores `proposedSlot` in the body.
- No calendar DB connection is opened.
- `/admin/calendar` still renders (with an empty grid) so operators
  can visually confirm the deployment.

## How to enable

1. Set `CALENDAR_GUARD_ENABLED=true`.
2. Set `CALENDAR_DATABASE_URL` to the shared calendar DB.
3. Run the canonical migration against that DB (OJT applies this on
   first connect, but run it manually against Postgres on the VPS
   for the two-DB-VPS topology):

   ```
   psql $CALENDAR_DATABASE_URL \
     -f node_modules/@semantos/semantic-objects/migrations/0000_init.sql
   ```

4. Seed the schedule + hats (see above).
5. Restart OJT. The `calendar.guard.initialised` log line confirms
   the guard came up.

## Rollback

Flip `CALENDAR_GUARD_ENABLED=false` and restart. Bookings already
written stay in `calendar_prod`; OJT just stops consulting the
guard. No schema changes to OJT's main DB, no patch-chain
migrations to unwind.

## Files

- `src/lib/calendar/db.ts` — drizzle handle + lazy canonical migration
- `src/lib/calendar/guard.ts` — `createCalendarGuard` singleton
- `src/lib/services/chatService.ts` — REJECT_CONFLICT branch + atomic
  `bookSlot` on happy-path confirms
- `src/lib/services/ojtHandleMessage.ts` — threads the guard +
  `buildProposedSlotClassifier` through `@semantos/intent.handleMessage`
- `src/app/api/v3/chat/route.ts` — accepts optional `proposedSlot` +
  `confirmBooking` on the request body
- `src/app/admin/calendar/page.tsx` — operator-only PlateView render
- `tests/federation/calendar-guard.test.ts` — five gate tests

## Test coverage

- G1 — flag OFF → no guard injected
- G2 — flag ON + no conflict → `cal_bookings` row appears
- G3 — flag ON + conflict → reply lists ≥ 2 free windows; no booking
- G4 — `/admin/calendar` 200 for admin session, 403 otherwise
- G5 — `extractProposedSlot` returns the expected `ProposedSlot` shape

Run with `bun test tests/federation/calendar-guard.test.ts`.
