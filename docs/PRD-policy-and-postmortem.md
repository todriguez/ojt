# PRD: Policy & Post-Mortem Layer

**Author:** Todd Price / Claude
**Date:** 2026-03-21
**Status:** Draft — v2 (incorporates Todd's 10 refinements)
**Depends on:** Sprint 3 (Decision Engine), Sprint 4 (Admin Ops Layer)

---

## Problem

The scoring and recommendation system currently has all weights, thresholds, and penalties hardcoded in TypeScript service files. This means:

- Tuning requires code changes and redeployment
- There's no record of what the system recommended vs what Todd actually did
- There's no feedback loop — the system can't learn from outcomes
- There's no way to simulate "what would change if I adjusted this weight?"
- Policy changes are invisible — no versioning, no audit trail

The system is technically impressive but operationally brittle. It needs to become a governed decision system with observable outcomes, adjustable parameters, and a feedback loop.

---

## Architecture

Three-layer separation:

### Layer 1: Extraction (stable, LLM-driven)

Pulls structured signals from conversation. Already built. Changes rarely — only when the LLM prompt needs tuning for new signal types. Not admin-adjustable.

### Layer 2: Scoring (tuneable, rule-based)

Converts signals into customer fit, quote-worthiness, confidence, and recommendations. This is where the tuneable weights and thresholds live. Currently hardcoded — needs to move to database-backed policy tables. Scoring also accepts a **context** object (schedule load, distance, weather) to factor in operational reality, not just extraction signals.

### Layer 3: Policy (admin-adjustable)

Decides what scores mean, what thresholds trigger which recommendation, what to cap, escalate, or ignore. Fully admin-configurable via sliders and numeric inputs. Includes a **tuning lock** to prevent over-fiddling.

The flow: **LLM extracts signals → rules score signals (with context) → policy tunes rules → outcomes teach policy.**

---

## Data Model

### 1. `scoring_policies` — versioned policy snapshots

Stores the complete set of weights and thresholds as a single JSON document. Every time Todd adjusts a weight, a new version is created.

```
scoring_policies
├── id: uuid PK
├── version: integer (auto-increment, unique)
├── name: varchar(100) — e.g. "Initial calibration", "Post week-1 tune"
├── weights: jsonb — full weight configuration (see Weight Schema below)
├── thresholds: jsonb — recommendation threshold configuration
├── created_by: varchar(100) — "todd", "system"
├── change_notes: text — what changed and why (REQUIRED)
├── tuned_from_version: integer — which version this was derived from (lineage)
├── tuning_locked: boolean — when true, sliders disabled, new version requires note
├── is_active: boolean — only one active at a time
├── activated_at: timestamp
├── created_at: timestamp
```

### 2. `job_outcomes` — post-mortem capture

One row per meaningful lead decision. Captures what the system said, what Todd did, and what happened. **Every lead that gets touched must end up with a human_decision, actual_outcome, and was_system_correct** — even if outcome is still_active.

```
job_outcomes
├── id: uuid PK
├── job_id: uuid FK → jobs (unique — one outcome per job)
├── policy_version: integer FK → scoring_policies.version
├── system_policy_snapshot: jsonb — full weights+thresholds at time of scoring (for debugging)
├── system_recommendation: varchar(50) — what the engine recommended
├── system_scores: jsonb — structured snapshot (see System Scores Schema below)
├── system_confidence: integer — 0-100, derived confidence score
├── scoring_context: jsonb — operational context at time of scoring (see Context Schema)
├── human_decision: varchar(50) — what Todd actually did (see Decision Enum below)
├── human_override_reason: text — optional: why Todd disagreed with the system
├── actual_outcome: varchar(50) — what happened (see Outcome Enum below)
├── outcome_value: integer — job value in cents (if completed)
├── outcome_notes: text — free-form post-mortem
├── miss_type: varchar(50) — classification of the miss (see Miss Types below)
├── was_system_correct: boolean — Todd's judgment call
├── created_at: timestamp — when human_decision was recorded
├── resolved_at: timestamp — when outcome was recorded
```

### 3. `scoring_weight_overrides` — per-category weight adjustments (optional, future)

For when Todd wants different weights for different job types (e.g. plumbing jobs should weigh location more heavily than painting jobs).

```
scoring_weight_overrides
├── id: uuid PK
├── policy_version: integer FK → scoring_policies.version
├── job_category: varchar(50) — "plumbing", "carpentry", etc. or "*" for all
├── weight_key: varchar(100) — dot-path like "fit.cheapestMindsetPenalty"
├── override_value: numeric
├── reason: text
├── created_at: timestamp
```

---

## System Scores Schema

The `system_scores` JSONB column in `job_outcomes` is structured, not a flat blob. This enables direct KPI queries.

```typescript
interface SystemScoresSnapshot {
  fit: {
    score: number;                  // 0-100
    label: string;                  // poor_fit | risky | mixed | good_fit | strong_fit
    reasoning: string[];
    positiveSignals: string[];
    negativeSignals: string[];
  };
  worthiness: {
    score: number;                  // 0-100
    label: string;                  // ignore | only_if_convenient | maybe_quote | worth_quoting | priority
    reasoning: string[];
  };
  recommendation: {
    value: string;                  // the recommendation enum
    reason: string;
    actionHint: string;
  };
  confidence: {
    score: number;                  // 0-100
    factors: string[];              // what contributed
  };
  completeness: {
    total: number;
    scopeClarity: number;
    locationClarity: number;
    contactReadiness: number;
    estimateReadiness: number;
    decisionReadiness: number;
  };
  estimateAck: {
    status: string;
    presented: boolean;
    acknowledged: boolean;
  };
}
```

---

## Confidence Score

New derived score (0–100) that measures how certain the system is about its recommendation.

```typescript
interface ConfidenceConfig {
  // Weights for confidence calculation
  scopeClarityWeight: number;         // default: 0.25
  locationClarityWeight: number;      // default: 0.15
  estimateReadinessWeight: number;    // default: 0.20
  contactReadinessWeight: number;     // default: 0.10
  jobTypeConfidenceWeight: number;    // default: 0.15
  toneSignalWeight: number;           // default: 0.15

  // Thresholds
  lowConfidenceThreshold: number;     // default: 35 → triggers "needs more info" flag
  siteVisitConfidenceThreshold: number; // default: 25 → suggests site visit
}
```

Derived from:
- scopeClarity (weighted)
- locationClarity (weighted)
- estimateReadiness (weighted)
- contactReadiness (weighted)
- jobTypeConfidence: certain=100, likely=70, guess=30, null=0 (weighted)
- Whether tone signal was detected (has data vs null)

Use cases:
- `worth_quoting but low confidence` → suggest site visit first
- `high confidence` → estimate OK to present
- `very low confidence` → don't present estimate, keep gathering

Confidence weights are stored in the policy and admin-tuneable.

---

## Scoring Context

Scoring currently only sees extraction signals. But real decisions depend on operational context. Design scoring to accept a context object now, even if most fields are null initially.

```typescript
interface ScoringContext {
  // Travel / location (future: geocoding integration)
  distanceKm: number | null;
  travelTimeMin: number | null;
  isNearExistingJob: boolean | null;  // already booked nearby that day?

  // Schedule load
  dayLoadScore: number | null;        // 0-100: how full is the day/week?
  weekLoadScore: number | null;

  // Environment
  weatherRisk: string | null;         // "clear" | "rain_likely" | "storm_warning"

  // Customer history
  isRepeatCustomer: boolean;
  previousJobCount: number;
  previousOutcomeAvg: string | null;  // avg was_system_correct for this customer

  // Material
  materialsAvailable: boolean | null; // are the materials in stock / on hand?
}
```

The context object is passed to scoring services alongside the accumulated state. Initially most fields will be null/false and have no effect. As integrations are added (calendar, weather API, supplier stock), they populate context and the scoring services start using it.

Context weights are also stored in the policy:

```typescript
interface ContextWeights {
  nearExistingJobBonus: number;       // default: 10
  repeatCustomerBonus: number;        // default: 8
  highDayLoadPenalty: number;         // default: -5  (day > 80% full)
  weatherRiskPenalty: number;         // default: -3
  materialsUnavailablePenalty: number; // default: -5
}
```

---

## Weight Schema

The `weights` JSONB column in `scoring_policies` contains:

```typescript
interface PolicyWeights {
  // ── Customer Fit Weights ──
  fit: {
    baseline: number;                    // default: 50
    acceptedRomBonus: number;            // default: 20
    tentativeRomBonus: number;           // default: 10
    clearCommunicationBonus: number;     // default: 12
    practicalToneBonus: number;          // default: 8
    photosProvidedBonus: number;         // default: 8
    flexibleTimingBonus: number;         // default: 5
    realisticUrgencyBonus: number;       // default: 5
    offeredContactBonus: number;         // default: 8
    willingContactBonus: number;         // default: 4
    detailedScopeBonus: number;          // default: 10
    knowsRepairReplaceBonus: number;     // default: 5

    rejectedRomPenalty: number;          // default: -25
    pushbackPenalty: number;             // default: -12
    wantsExactPricePenalty: number;      // default: -15
    rateShoppingPenalty: number;         // default: -8
    cheapestMindsetPenalty: number;      // default: -15
    micromanagerPenalty: number;         // default: -12
    demandingTonePenalty: number;        // default: -10
    suspiciousTonePenalty: number;       // default: -6
    priceFocusedPenalty: number;         // default: -8
    vagueCommunicationPenalty: number;   // default: -8
    reluctantContactPenalty: number;     // default: -6
    refusedContactPenalty: number;       // default: -12
    fakeEmergencyPenalty: number;        // default: -5

    // Stacking caps
    adversarial2Cap: number;             // default: 35
    adversarial3Cap: number;             // default: 15
  };

  // ── Quote-Worthiness Weights ──
  worthiness: {
    coreSuburbPoints: number;            // default: 25
    extendedSuburbPoints: number;        // default: 15
    unknownSuburbPoints: number;         // default: 5
    locationCluePoints: number;          // default: 15

    effortBandPoints: {
      quick: number;                     // default: 5
      short: number;                     // default: 10
      quarter_day: number;               // default: 18
      half_day: number;                  // default: 25
      full_day: number;                  // default: 30
      multi_day: number;                 // default: 28
      unknown: number;                   // default: 8
    };

    fitContributionMultiplier: number;   // default: 0.2
    acceptedEstimateBonus: number;       // default: 15
    tentativeEstimateBonus: number;      // default: 8
    pushbackPenalty: number;             // default: -5
    rejectedPenalty: number;             // default: -15
    wantsExactPricePenalty: number;      // default: -8

    clearScopeBonus: number;             // default: 10
    moderateScopeBonus: number;          // default: 5
    scopeUndefinedCap: number;           // default: 25

    cheapestMindsetPenalty: number;      // default: -10
    micromanagerPenalty: number;         // default: -5
    smallJobFarAwayPenalty: number;      // default: -10

    adversarial2Cap: number;             // default: 35
    adversarial3Cap: number;             // default: 15
  };

  // ── Recommendation Thresholds ──
  thresholds: {
    priorityLeadMinWorthiness: number;   // default: 70
    priorityLeadMinFit: number;          // default: 60
    probablyBookableMinWorthiness: number; // default: 55
    probablyBookableMinFit: number;      // default: 50
    worthQuotingMinWorthiness: number;    // default: 45
    worthQuotingMinFit: number;          // default: 40
    onlyIfNearbyMinWorthiness: number;   // default: 25

    fitHardRejectThreshold: number;      // default: 20
    fitPushbackRejectThreshold: number;  // default: 40
  };

  // ── Confidence Score Weights ──
  confidence: {
    scopeClarityWeight: number;          // default: 0.25
    locationClarityWeight: number;       // default: 0.15
    estimateReadinessWeight: number;     // default: 0.20
    contactReadinessWeight: number;      // default: 0.10
    jobTypeConfidenceWeight: number;     // default: 0.15
    toneSignalWeight: number;            // default: 0.15
    lowConfidenceThreshold: number;      // default: 35
    siteVisitConfidenceThreshold: number; // default: 25
  };

  // ── Context Weights ──
  context: {
    nearExistingJobBonus: number;        // default: 10
    repeatCustomerBonus: number;         // default: 8
    highDayLoadPenalty: number;          // default: -5
    weatherRiskPenalty: number;          // default: -3
    materialsUnavailablePenalty: number; // default: -5
  };

  // ── Completeness Sub-Score Weights ──
  completeness: {
    scopeWeight: number;                 // default: 0.30
    locationWeight: number;              // default: 0.15
    contactWeight: number;               // default: 0.15
    estimateReadinessWeight: number;     // default: 0.20
    decisionReadinessWeight: number;     // default: 0.20
  };

  // ── Estimate Controls ──
  estimates: {
    presentEstimateMinReadiness: number; // default: 50
    fallbackEstimateMinClarity: number;  // default: 35
    vagueHourlySeekerScopeMin: number;   // default: 40
    scopeUndefinedMinClarity: number;    // default: 15
  };
}
```

---

## Decision Enum (human_decision)

What Todd actually did with the lead:

- `followed_up` — contacted the customer
- `quoted` — sent a formal quote
- `booked` — scheduled the job
- `site_visited` — went for an inspection
- `declined` — chose not to pursue
- `archived` — marked as dead/old
- `referred_out` — sent to another tradie
- `deferred` — parked for later
- `let_expire` — didn't act, lead went cold

---

## Outcome Enum (actual_outcome)

What actually happened:

- `completed_paid` — job done, got paid
- `completed_disputed` — job done, payment issues
- `booked_cancelled` — customer cancelled after booking
- `quoted_rejected` — sent quote, customer said no
- `quoted_ghosted` — sent quote, no response
- `site_visit_declined` — visited, declined the job
- `site_visit_booked` — visited, then booked
- `customer_went_elsewhere` — lost to competitor
- `customer_ghosted` — customer went silent
- `not_pursued` — Todd decided not to follow up
- `still_active` — lead still in progress

---

## Miss Types

Classification of where the system got it wrong:

- `false_negative` — good job that the system scored too low
- `false_positive` — bad job that the system scored too high
- `underquoted_risk` — ROM was too low, job cost more than expected
- `overestimated_friction` — system flagged as difficult but customer was fine
- `customer_turned_painful` — looked good initially, became a headache
- `not_worth_travel` — travel time killed the economics
- `ideal_fill_job_missed` — perfect gap-filler that was scored ignore/only_if_nearby
- `site_visit_wasted` — went to look, shouldn't have bothered
- `good_repeat_misread` — returning customer scored poorly
- `scope_creep` — job grew beyond original estimate
- `too_small_but_took_anyway` — job was flagged low-value but Todd did it and it was fine
- `good_customer_low_value` — great customer, small job — worth doing for the relationship
- `schedule_gap_fill` — job looked bad in isolation but filled a schedule gap perfectly
- `none` — system was correct

---

## KPI Dashboard (future)

Track these over rolling 30/60/90-day windows:

### Conversion KPIs
- Quote-to-book rate
- Recommendation-to-action alignment (how often Todd agrees with the system)
- False negative rate (good jobs scored low)
- False positive rate (bad jobs scored high)

### Economic KPIs
- Average job value by recommendation tier
- Average travel time per billed hour
- Margin per effort band
- Revenue per lead (including zeros for declined leads)

### Efficiency KPIs
- Leads filtered out that were correctly rejected
- Admin time saved (estimated)
- Quotes sent but not accepted (waste)
- Site visits that led to bookings vs not

### Calibration KPIs
- System-vs-human agreement rate
- Average score delta between system recommendation and human decision
- Weight drift over time (how much tuning is happening)
- Confidence score vs actual outcome correlation

---

## Re-Score Simulation

When Todd adjusts weights in the admin panel, before saving:

1. Load the last N leads (default 50)
2. Re-run scoring with the proposed new weights
3. Show a diff: "These 8 leads would change recommendation"
4. Let Todd review each change
5. Only then save the new policy version

### Simulation filter modes

Beyond "last 50 leads", allow:
- Last 7 days / 30 days
- All leads with outcome recorded
- Only false negatives (system scored low, Todd took the job anyway)
- Only false positives (system scored high, turned out badly)
- Only leads where system disagreed with Todd's decision

This makes tuning surgical rather than blind.

---

## Policy Stability Controls

### Tuning lock

```
tuning_locked: boolean
```

When true:
- Sliders in admin UI are disabled (read-only)
- New version can only be created with an explicit unlock + change note
- Prevents daily fiddling that destabilises the system

### Policy lineage

```
tuned_from_version: integer
```

Every new policy version records which version it was derived from. This builds a lineage tree so you can trace why the system behaves the way it does.

### Recommended workflow

1. Run shadow mode for 1 week with current weights
2. Review post-mortems and disagreements
3. Unlock tuning
4. Adjust weights using re-score simulation
5. Save new version with notes
6. Lock tuning
7. Repeat weekly

---

## Admin UI: Tuning Panel

### Customer Fit Controls

Group: **Positive Signals**
- Accepted ROM bonus: slider 0–30 (default 20)
- Clear communication bonus: slider 0–20 (default 12)
- Photos provided bonus: slider 0–15 (default 8)
- Proactive contact bonus: slider 0–15 (default 8)
- Detailed scope bonus: slider 0–15 (default 10)

Group: **Negative Signals**
- Rejected ROM penalty: slider 0–40 (default 25)
- Cheapest mindset penalty: slider 0–25 (default 15)
- Micromanager penalty: slider 0–20 (default 12)
- Demanding/impatient tone penalty: slider 0–20 (default 10)
- Price-focused penalty: slider 0–15 (default 8)
- Vague communication penalty: slider 0–15 (default 8)

Group: **Stacking Caps**
- 2-signal adversarial cap: input 0–100 (default 35)
- 3-signal adversarial cap: input 0–100 (default 15)

### Quote-Worthiness Controls

Group: **Location**
- Core suburb bonus: slider 0–40 (default 25)
- Extended suburb bonus: slider 0–30 (default 15)
- Unknown suburb bonus: slider 0–15 (default 5)

Group: **Job Size**
- Quick job points: slider 0–20 (default 5)
- Half-day points: slider 0–40 (default 25)
- Full-day points: slider 0–40 (default 30)

Group: **Penalties**
- Cheapest mindset penalty: slider 0–20 (default 10)
- Small job + far away penalty: slider 0–20 (default 10)
- Scope undefined cap: input 0–100 (default 25)

### Confidence Controls
- Low confidence threshold: input 0–100 (default 35)
- Site visit confidence threshold: input 0–100 (default 25)

### Context Controls
- Near existing job bonus: slider 0–20 (default 10)
- Repeat customer bonus: slider 0–15 (default 8)
- High day load penalty: slider 0–15 (default 5)

### Recommendation Thresholds
- Priority lead: min worthiness [70] + min fit [60]
- Probably bookable: min worthiness [55] + min fit [50]
- Worth quoting: min worthiness [45] + min fit [40]
- Only if nearby: min worthiness [25]
- Hard reject fit threshold: [20]

### Estimate Controls
- Min readiness to present estimate: slider 0–100 (default 50)
- Fallback estimate min scope clarity: slider 0–100 (default 35)
- Vague hourly seeker scope minimum: slider 0–100 (default 40)

---

## Post-Mortem Capture Flow

### In the lead queue (Sprint 4)

Each lead card shows:
- System recommendation badge
- Confidence badge (high/medium/low)
- Quick action buttons: **Follow Up** / **Quote** / **Book** / **Decline** / **Site Visit** / **Archive**
- Clicking any button records `human_decision` and creates the `job_outcomes` row with full snapshots

### After job completion

A "How'd it go?" prompt appears on completed/archived jobs:
- Outcome dropdown (completed_paid, quoted_rejected, etc.)
- Was the system right? **Yes** / **No**
- If No: miss type dropdown + optional notes
- Job value input (if completed)

### Mandatory logging

Every lead that gets any human action **must** end up with:
- `human_decision`
- `actual_outcome` (even if `still_active`)
- `was_system_correct`

Incomplete post-mortems show as a "needs review" badge in the admin queue. This enforces data discipline from day one so KPIs are meaningful when the dashboard arrives.

### Automatic tracking

The system auto-records:
- `system_recommendation` and `system_scores` at the time of the decision
- `system_policy_snapshot` — full weights+thresholds (for future debugging)
- `system_confidence` — confidence score at time of scoring
- `scoring_context` — operational context at time of scoring
- `policy_version` that was active
- Timestamps

---

## Implementation Plan

### Phase 1: Schema + Migration (Sprint 4 prerequisite)

- Add `scoring_policies`, `job_outcomes` tables
- Seed initial policy version from current hardcoded values
- Add confidence score calculation service
- Add ScoringContext type (initially all nulls)
- Generate Drizzle migration

### Phase 2: Policy-Driven Scoring (Sprint 4)

- Refactor `customerFitService`, `quoteWorthinessService`, `recommendationService` to read weights from the active policy instead of constants
- Add confidence score to scoring pipeline
- Add context object passthrough (initially empty)
- Store `policyVersion` + full policy snapshot on every scored job
- Cache active policy in memory (refresh on change)

### Phase 3: Post-Mortem Capture (Sprint 4/5)

- Add quick-action buttons to lead queue that record `human_decision`
- Auto-create `job_outcomes` row with full snapshots on first human action
- Add outcome recording UI to completed jobs
- Add "needs review" badge for incomplete post-mortems
- API endpoints: `POST /api/v2/outcomes`, `PATCH /api/v2/outcomes/:id`

### Phase 4: Tuning Panel (Sprint 5)

- Admin page with grouped sliders/inputs
- Save creates new policy version (with lineage tracking)
- Show current vs previous weights
- Change notes required
- Tuning lock toggle

### Phase 5: Re-Score Simulation (Sprint 5/6)

- "Preview changes" button in tuning panel
- Re-runs leads with proposed weights
- Filter modes: last 50, last 7d/30d, false negatives, false positives, disagreements
- Shows diff table before saving

### Phase 6: KPI Dashboard (Sprint 6+)

- Rolling window metrics
- Trend charts
- Weight change annotations on timeline
- Confidence vs outcome correlation
- Context factor analysis (once context data is flowing)

---

## Risks

- **Over-tuning**: Constant weight fiddling can make the system unstable. Mitigation: tuning lock + policy versioning + require change notes + show re-score impact before saving.
- **Insufficient data**: Need 50+ post-mortems before KPIs are meaningful. Mitigation: start capturing from day one with mandatory logging, even if the dashboard comes later.
- **LLM extraction drift**: Haiku model updates could change extraction behaviour. Mitigation: pin model version, re-run field simulation after any model change.
- **Complexity creep**: Per-category overrides could get unwieldy. Mitigation: start with global weights only, add per-category later if needed.
- **Incomplete post-mortems**: Todd forgets to log outcomes. Mitigation: "needs review" badge, weekly review prompt.

---

## Definition of Done

- [ ] Scoring services read weights from active policy (not hardcoded constants)
- [ ] Policy version + full snapshot recorded on every scored lead
- [ ] Confidence score calculated and stored alongside fit/worthiness
- [ ] ScoringContext type accepted by scoring services (initially empty)
- [ ] Admin can adjust weights and save as new version with lineage
- [ ] Tuning lock prevents casual fiddling
- [ ] Quick actions on lead queue record human decisions and create outcome rows
- [ ] Completed jobs can capture outcome + miss type
- [ ] "Was system right?" toggle on every post-mortem
- [ ] "Needs review" badge for incomplete post-mortems
- [ ] Re-score simulation shows impact of weight changes before saving
- [ ] Re-score simulation supports filter modes (last N, false neg/pos, disagreements)
- [ ] Initial policy seeded from current hardcoded values
- [ ] All existing tests still pass
- [ ] Field simulation still ≥90% with policy-driven scoring
