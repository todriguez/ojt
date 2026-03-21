# PRD: Sprint 4 — Admin Ops Layer

**Author:** Todd Price / Claude
**Date:** 2026-03-21
**Status:** Draft — v2 (incorporates Todd's refinements)
**Depends on:** Sprint 3 (Decision Engine — complete), Policy PRD (schema from Phase 1)
**Goal:** Todd can open the dashboard and know what deserves attention first.

---

## Problem

The decision engine is working — it extracts signals, scores leads, and generates recommendations. But Todd can't see any of it. Everything is in JSON blobs and API responses. There's no interface for:

- Viewing the lead queue sorted by priority
- Seeing recommendation / fit / worthiness badges at a glance
- Taking quick actions (follow up, quote, decline, site visit)
- Recording what he actually did (post-mortem data capture)
- Viewing a lead's full conversation + scoring history
- Filtering by recommendation type, suburb, effort band

Until this sprint lands, the system is technically capable but practically useless.

---

## Design Principles

1. **Mobile-first** — Todd's on site most of the day. The queue needs to work on a phone.
2. **Glanceable** — Badges, not paragraphs. Todd should know the verdict in under 2 seconds per lead.
3. **Action-oriented** — Every screen should have a clear "what do I do next?" button.
4. **Captures data silently** — Every button press records human_decision for the post-mortem loop.
5. **Non-blocking** — The UI never forces Todd to fill in a form before moving on. Mandatory fields get prompted later via "needs review" badges.
6. **Denormalized for speed** — Queue queries hit flat columns on jobs, not JSONB blobs. Snapshots are for history; flat columns are for UI.

---

## Pages

### 1. Lead Queue (`/admin/leads`)

The primary view. A sorted list of active leads with scoring badges and quick actions.

#### Card layout (one per lead)

```
┌──────────────────────────────────────────────────────────┐
│ [PRIORITY LEAD]  [Fit: 85 ●●●●○]  [Worth: 72]          │
│ [Confidence: High]  [🔁 Repeat · 3 jobs]                │
│──────────────────────────────────────────────────────────│
│ 🔨 Deck repair — 6-7 merbau boards                      │
│ 📍 Cooroy  ·  ⏱ Half-day  ·  🕐 Next 2 weeks           │
│ 💰 $350–600 ROM (accepted ✓)  ·  📞 Contact given       │
│──────────────────────────────────────────────────────────│
│ 📅 Week: 60%  ·  📍 Near booked Tue  ·  ☀ Clear         │
│──────────────────────────────────────────────────────────│
│ [Follow Up] [Quote] [Book] [Site Visit] [Decline]        │
│──────────────────────────────────────────────────────────│
│ System: worth_quoting  ·  Todd: followed_up              │
└──────────────────────────────────────────────────────────┘
```

#### Badges

- **Recommendation badge** — colour-coded: priority_lead (green), worth_quoting (blue), probably_bookable (teal), needs_site_visit (orange), only_if_nearby (grey), not_price_aligned (red), not_a_fit (dark red), ignore (muted)
- **Customer fit** — 5-dot scale: ●●●●● strong_fit, ●●●●○ good_fit, ●●●○○ mixed, ●●○○○ risky, ●○○○○ poor_fit
- **Quote-worthiness** — numeric score + label
- **Confidence badge** — High (green) / Medium (amber) / Low (red)
- **Estimate ack** — accepted ✓ / tentative ~ / pushback ⚠ / rejected ✗ / pending ⋯
- **Repeat customer** — 🔁 badge with job count + last outcome. Shows when same phone, email, or address matches a previous job. Even if data isn't flowing yet, the UI should have a slot for it.
- **Schedule context** — 📅 week load / 📍 near existing job / 🌧 weather risk. Values will be null initially — the UI renders placeholders that light up once context data flows. Designing the card now prevents redesign later.
- **System vs Todd** — when a `job_outcomes` row exists, show both: `System: worth_quoting · Todd: declined`. This is gold for tuning later.

#### Default sort

Primary: recommendation tier (priority_lead first, ignore last)
Secondary: quote-worthiness score descending
Tertiary: updated_at descending

#### Filters

Checkboxes (multi-select):
- **Recommendation**: priority_lead, worth_quoting, probably_bookable, needs_site_visit, only_if_nearby, not_price_aligned, not_a_fit, ignore
- **Status**: new_lead, partial_intake, awaiting_customer, ready_for_review, estimate_presented, estimate_accepted, needs_site_visit, bookable
- **Effort band**: quick, short, quarter_day, half_day, full_day, multi_day
- **Suburb group**: Core area, Extended area, Outside area, Unknown
- **Estimate ack**: accepted, tentative, pushback, rejected, pending
- **Needs review**: show only leads missing human_decision or outcome
- **System disagreement**: show only leads where system recommendation ≠ human_decision

#### Sort options

- Worthiness (high → low)
- Customer fit (high → low)
- Confidence (high → low)
- Suburb (alphabetical)
- Updated at (newest first)
- Created at (newest first)
- Estimate accepted (yes first)

#### Quick actions

Each action button is **idempotent**:

```
if job_outcomes row exists for this job:
  UPDATE human_decision (don't overwrite snapshot)
else:
  CREATE job_outcomes row with:
    - human_decision
    - system_recommendation (current)
    - system_scores (current, structured)
    - system_confidence (current)
    - system_policy_snapshot (current active policy weights+thresholds)
    - scoring_context (current)
    - policy_version (current)
```

Snapshot is stored only on first decision. Changing the decision later only updates `human_decision` — the original scoring snapshot is preserved for honest post-mortem analysis.

| Button | human_decision | New job status |
|--------|---------------|----------------|
| Follow Up | `followed_up` | `ready_for_review` |
| Quote | `quoted` | `estimate_presented` |
| Book | `booked` | `bookable` → `scheduled` |
| Site Visit | `site_visited` | `needs_site_visit` |
| Decline | `declined` | `not_a_fit` or `not_price_aligned` |
| Archive | `archived` | `archived` |
| Defer | `deferred` | (no change, just logged) |

---

### 2. Lead Detail (`/admin/leads/[id]`)

Full view of a single lead. Five sections.

#### Section A: Scoring summary

Large badges for recommendation, fit, worthiness, confidence, repeat customer. Reasoning list shown on tap/click (expandable). Sub-scores shown as a bar set: scopeClarity, locationClarity, contactReadiness, estimateReadiness, decisionReadiness.

**[Re-score] button** — triggers re-scoring with current policy + current metadata. Use cases: changed policy version, fixed extraction, corrected suburb, added context later. Shows before/after diff inline.

#### Section B: Conversation

Full message history. Customer messages on the left, AI replies on the right. Each message shows:
- Timestamp
- What was extracted from that message (collapsible: "Extracted: jobType=carpentry, suburb=Cooroy, urgency=next_2_weeks")
- If estimate was presented in this reply, show the ROM range

#### Section C: Job metadata

Structured fields:
- Job type + confidence
- Suburb + address + location clue
- Scope description (accumulated)
- Materials + condition
- Urgency
- Effort band
- ROM estimate range
- Customer name / phone / email
- Estimate ack status + reaction
- Customer tone + clarity
- Cheapest mindset flag
- Micromanager flag

All fields editable (Todd can correct extraction errors manually). Changes logged in job_state_events. **Editing any field triggers automatic re-score.**

#### Section D: Schedule context

Context fields (initially mostly null — the UI shows placeholders):
- Distance / travel time
- Near existing booked job
- Day/week load
- Weather risk
- Repeat customer history
- Materials availability

#### Section E: Post-mortem (bottom of page)

If `job_outcomes` row exists:
- Show current human_decision, outcome, was_system_correct, miss_type, notes
- Show System vs Todd comparison
- All editable

If no `job_outcomes` row:
- Show "No action recorded yet" with action buttons

---

### 3. Outcome Review (`/admin/review`)

List of leads that need post-mortem completion. Shows leads where:
- `human_decision` is set but `actual_outcome` is null (action taken, no result yet)
- `actual_outcome` is set but `was_system_correct` is null (result known, no judgment)
- Job status is `complete`, `invoiced`, `paid`, or `archived` but no `job_outcomes` row exists

Each row: lead summary + outcome form inline. No need to navigate away.

**Nag indicators:**
- Badge count on queue page header: "4 needs review"
- Badge on individual lead cards
- Weekly review prompt (Sunday planning integration later)

---

### 4. Settings: Scoring Policy (`/admin/settings/policy`)

Read-only view of current active policy weights. Shows all weight groups with current values. Links to tuning panel (Phase 4/Sprint 5 — not in Sprint 4).

Sprint 4 scope: display only. Tuning UI comes in Sprint 5.

---

## API Endpoints

### Lead queue

```
GET /api/v2/admin/leads
  Query params:
    ?sort=worthiness|fit|confidence|suburb|updated_at|created_at
    ?order=asc|desc
    ?recommendation=priority_lead,worth_quoting  (comma-separated)
    ?status=new_lead,partial_intake
    ?effortBand=half_day,full_day
    ?suburbGroup=core|extended|outside|unknown
    ?estimateAck=accepted,tentative
    ?needsReview=true
    ?disagreement=true  (system rec ≠ human decision)
    ?limit=20&offset=0

  Response: {
    leads: [{
      id, jobType, suburb, suburbGroup, scopeSummary, effortBand, urgency,
      recommendation, recommendationReason,
      customerFitScore, customerFitLabel,
      quoteWorthinessScore, quoteWorthinessLabel,
      confidenceScore, confidenceLabel,
      estimatePresented, estimateAckStatus,
      romRange: { min, max } | null,
      customerName, customerPhone,
      isRepeatCustomer: boolean,
      repeatJobCount: number,
      lastOutcome: string | null,
      scheduleContext: { weekLoad, nearExisting, weatherRisk } | null,
      hasOutcome: boolean,
      humanDecision: string | null,
      needsReview: boolean,
      updatedAt, createdAt
    }],
    total: number,
    filters: { applied filters echoed back }
  }

  PERFORMANCE NOTE:
  This query hits flat denormalized columns on the jobs table,
  NOT JSONB blob queries. See "Denormalization" section below.
```

### Lead detail

```
GET /api/v2/admin/leads/:id
  Response: {
    job: { ... full job record ... },
    scoring: {
      fit: { score, label, reasoning, positiveSignals, negativeSignals },
      worthiness: { score, label, reasoning },
      recommendation: { value, reason, actionHint },
      confidence: { score, label, factors },
      completeness: { total, scopeClarity, locationClarity, contactReadiness, estimateReadiness, decisionReadiness },
      estimateAck: { status, presented, acknowledged }
    },
    conversation: [{
      id, senderType, content, timestamp,
      extraction: { ... what was extracted ... } | null
    }],
    metadata: { ... accumulated job state ... },
    outcome: { ... job_outcomes row ... } | null,
    repeatHistory: {
      isRepeat: boolean,
      previousJobs: [{ id, jobType, outcome, value, date }]
    },
    scheduleContext: { ... context at time of last score ... },
    policyVersion: number
  }
```

### Quick actions (idempotent)

```
POST /api/v2/admin/leads/:id/action
  Body: {
    action: "followed_up" | "quoted" | "booked" | "site_visited" | "declined" | "archived" | "deferred",
    notes?: string
  }

  Behaviour:
    IF job_outcomes row exists:
      UPDATE human_decision only (preserve original snapshot)
    ELSE:
      CREATE job_outcomes row with:
        - human_decision = action
        - system_recommendation (current)
        - system_scores (current, structured)
        - system_confidence (current)
        - system_policy_snapshot (full active policy)
        - scoring_context (current)
        - policy_version (current)
    THEN:
      Update job status
      Return updated lead + outcome

  Response: { lead: { ... updated ... }, outcome: { ... created or updated ... } }
```

### Re-score

```
POST /api/v2/admin/leads/:id/rescore
  Body: {} (uses current policy + current metadata)

  Effect:
    1. Load current accumulated state + active policy
    2. Re-run fit, worthiness, confidence, recommendation
    3. Update denormalized columns on jobs table
    4. Log change in job_state_events
    5. Return before/after diff

  Response: {
    before: { fit, worthiness, confidence, recommendation },
    after: { fit, worthiness, confidence, recommendation },
    changed: boolean
  }
```

### Outcome recording

```
PATCH /api/v2/admin/outcomes/:jobId
  Body: {
    actual_outcome?: string,
    outcome_value?: number,     // cents
    outcome_notes?: string,
    miss_type?: string,
    was_system_correct?: boolean
  }

  Response: { outcome: { ... updated ... } }
```

### Lead field corrections

```
PATCH /api/v2/admin/leads/:id/metadata
  Body: {
    jobType?: string,
    suburb?: string,
    urgency?: string,
    scopeDescription?: string,
    // ... any accumulated state field
  }

  Effect:
    1. Updates job metadata
    2. Auto re-runs scoring with corrected data
    3. Updates denormalized columns
    4. Logs change in job_state_events

  Response: { lead: { ... updated ... }, scoring: { ... recalculated ... } }
```

---

## Denormalization Strategy

The lead queue must load fast on mobile. JSONB blob queries are too slow for filtered/sorted lists.

**Add flat columns to `jobs` table:**

```
recommendation: varchar(50)
recommendation_reason: text
customer_fit_score: integer           (already exists)
customer_fit_label: varchar(20)
quote_worthiness_score: integer       (already exists)
quote_worthiness_label: varchar(20)
confidence_score: integer
confidence_label: varchar(20)
estimate_ack_status: varchar(20)
suburb_group: varchar(20)             — "core" | "extended" | "outside" | "unknown"
needs_review: boolean
is_repeat_customer: boolean
repeat_job_count: integer
```

These columns are updated every time scoring runs (on new messages, re-score, metadata correction). The queue query becomes a simple indexed `SELECT` with `WHERE` and `ORDER BY` on flat columns.

The `metadata` JSONB column remains the source of truth for the full accumulated state. Flat columns are a read-optimized projection.

---

## Repeat Customer Detection

Match on any of:
- Same phone number (normalized)
- Same email (lowercased)
- Same address (fuzzy — same suburb + similar address_line_1)

When matched:
- Set `is_repeat_customer = true` on the job
- Set `repeat_job_count` = count of previous jobs
- Pull last outcome from most recent previous job's `job_outcomes`

This data feeds into:
- 🔁 badge on lead cards
- `context.isRepeatCustomer` for scoring
- `context.previousJobCount` for scoring
- Repeat customer bonus in policy weights

---

## Data Requirements

### Sprint 4 schema additions

**New tables:**
- `scoring_policies` (from Policy PRD, Phase 1)
- `job_outcomes` (from Policy PRD, Phase 1)

**New columns on jobs:**
- `recommendation: varchar(50)`
- `recommendation_reason: text`
- `customer_fit_label: varchar(20)`
- `quote_worthiness_label: varchar(20)`
- `confidence_score: integer`
- `confidence_label: varchar(20)`
- `estimate_ack_status: varchar(20)`
- `suburb_group: varchar(20)`
- `needs_review: boolean default false`
- `is_repeat_customer: boolean default false`
- `repeat_job_count: integer default 0`

**Seed data:**
- Policy version 1 with all current hardcoded weights

---

## UI Technology

Next.js App Router with:
- Server Components for initial data fetch
- Client Components for interactivity (filters, actions, expandables)
- Tailwind CSS for styling
- No additional UI framework needed (keep it simple)

Mobile breakpoints:
- Cards stack vertically on mobile
- Filters collapse into a slide-out panel
- Quick actions become a bottom action bar
- Schedule context row collapses on small screens

---

## Implementation Order

### Week 1: Foundation

1. Schema migration (scoring_policies, job_outcomes, new job columns)
2. Seed policy version 1 from hardcoded values
3. Confidence score service
4. Suburb group classification utility
5. Repeat customer detection utility
6. Denormalized column update service (runs after every score)
7. API: GET /api/v2/admin/leads (with sorting/filtering on flat columns)
8. API: GET /api/v2/admin/leads/:id

### Week 2: Queue UI

9. Lead queue page with cards, all 7 badges
10. Filter panel (including disagreement filter)
11. Quick action buttons (idempotent) + POST /api/v2/admin/leads/:id/action
12. Job_outcomes row creation with full snapshots
13. System vs Todd indicator on cards

### Week 3: Detail + Review

14. Lead detail page (scoring, conversation, metadata, context placeholders)
15. Re-score button + POST /api/v2/admin/leads/:id/rescore
16. Metadata correction + auto re-score + PATCH endpoint
17. Outcome review page with inline forms
18. PATCH /api/v2/admin/outcomes/:jobId
19. "Needs review" badge logic + nag indicators

### Week 4: Polish + Mobile

20. Mobile responsive layout (cards, filters, bottom action bar)
21. Schedule context placeholder slots on cards
22. Policy display page (read-only)
23. Integration testing with field simulation data
24. Performance pass (pagination, query optimization, index verification)

---

## Success Criteria

1. Todd can open `/admin/leads` on his phone and see leads sorted by priority
2. Each lead shows recommendation + fit + worthiness + confidence + repeat + estimate ack badges
3. Schedule context slots are visible (even if null) — no card redesign needed later
4. Todd can take action (follow up, quote, book, decline) with one tap
5. Quick actions are idempotent — clicking twice doesn't create duplicate outcome rows
6. Every action automatically records human_decision + scoring snapshot (once, on first action)
7. System vs Todd comparison visible on cards with outcomes
8. Completed jobs prompt for outcome recording
9. "Needs review" badge surfaces incomplete post-mortems
10. Lead detail shows full conversation + extraction history + scoring breakdown
11. Re-score button works on lead detail page
12. Todd can correct extraction errors and trigger re-scoring
13. Filters work for recommendation type, status, suburb, effort band, disagreements
14. Queue queries hit denormalized flat columns (no JSONB scans)
15. Page loads in under 2 seconds on mobile
16. All Sprint 2/3 tests still pass
17. Field simulation still ≥90%

---

## What this unlocks

Once Sprint 4 is live:
- Todd starts his shadow run (1 week of real leads flowing through)
- Post-mortem data starts accumulating
- Scoring disagreements become visible (System vs Todd indicators)
- Sprint 5 (tuning panel) has real data to work with
- The system transitions from "technically works" to "practically useful"

This is the milestone where the system starts helping Todd's actual day-to-day life.

---

## What comes after

```
Sprint 4  → queue usable
Shadow    → 1 week, 20-40 leads
Sprint 5  → tuning panel + re-score simulation
Calibrate → adjust weights from real disagreements
Sprint 6  → schedule context (calendar, suburb clustering, weather)
Integrate → Telegram / OpenClaw / SMS gateway
Sprint 7  → KPI dashboard
```

At that point it's not a chatbot. It's an operating system for field work.
