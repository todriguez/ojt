# Semantic Commerce Compiler — Pipeline Architecture

**Version**: 0.1-draft
**Date**: March 2026
**Status**: Architectural reference — maps the semantic compiler model to implemented modules
**Companion**: universal-commerce-taxonomy-spec.md, plexus-unified-spec.md

---

## 1. The Claim

This system is not a chatbot, CRM, or intake app. It is a **semantic compiler for commerce**.

A traditional compiler transforms source text into executable machine code through a deterministic pipeline: parse → type → optimise → emit. This system transforms natural language customer interactions into typed commercial instruments (quotes, contracts, invoices, capabilities) through an analogous pipeline.

The analogy is not metaphorical. Each phase has a defined input type, output type, invariant set, and error model. The phases compose. The intermediate representations are explicit, inspectable, and recoverable.

---

## 2. Pipeline Phases

```
┌─────────┐    ┌───────┐    ┌────────┐    ┌─────┐    ┌──────────┐
│ SOURCE  │───▶│ LEXER │───▶│ PARSER │───▶│ AST │───▶│ TYPE     │
│         │    │       │    │        │    │     │    │ CHECKER  │
└─────────┘    └───────┘    └────────┘    └─────┘    └──────────┘
                                                          │
                                                          ▼
┌──────────┐    ┌─────────┐    ┌──────────┐    ┌─────────────────┐
│DIAGNOSTICS│◀──│ RUNTIME │◀───│ CODEGEN  │◀───│ OPTIMISER       │
│          │    │         │    │          │    │                 │
└──────────┘    └─────────┘    └──────────┘    └─────────────────┘
```

---

## 3. Phase Detail

### 3.1 SOURCE — Raw Input

**Compiler analogue**: source files on disk
**Input**: customer messages, uploads, voice recordings, file attachments
**Output**: normalised message records with channel metadata
**Invariant**: every input is persisted before processing begins

| Module | Path | Status |
|--------|------|--------|
| Chat endpoint | `app/api/v2/chat/route.ts` | Built |
| Upload endpoint | `app/api/upload/route.ts` | Stub |
| OTP auth flow | `services/otpService.ts` | Built |
| System prompt | `ai/prompts/systemPrompt.ts` | Built |
| Chat orchestrator | `services/chatService.ts` | Built |

**Gaps**: Voice transcription (Whisper or equivalent). Image understanding (describe photos, extract text from receipts). Multi-channel ingest (SMS via Twilio, email, Messenger webhook).

---

### 3.2 LEXER — Channel Normalisation & Auth

**Compiler analogue**: tokeniser / preprocessor
**Input**: raw HTTP requests with auth tokens, cookies, headers
**Output**: authenticated, rate-limited, session-tagged request context
**Invariant**: no unauthenticated request reaches the parser

| Module | Path | Status |
|--------|------|--------|
| Customer JWT middleware | `middleware/withCustomerAuth.ts` | Built |
| Admin JWT middleware | `middleware/withAdminAuth.ts` | Built |
| JWT sign/verify | `auth/jwt.ts` | Built |
| Session management | `auth/session.ts` | Partial |
| Cookie transport | `auth/cookies.ts` | Partial |
| Rate limiter | `rateLimit.ts` | Built |

**Gaps**: None critical. Session management could be more robust for multi-device.

---

### 3.3 PARSER — Extraction Layer

**Compiler analogue**: parser (source text → syntax tree)
**Input**: authenticated message + accumulated conversation state
**Output**: `MessageExtraction` — typed fields for scope, contact, location, tone, signals
**Invariant**: extraction is idempotent merge — re-parsing the same message produces the same delta

| Module | Path | Status |
|--------|------|--------|
| Extraction prompt | `ai/prompts/extractionPrompt.ts` | Built |
| Extraction schema + merge | `ai/extractors/extractionSchema.ts` | Built |
| Estimate ack classifier | `ai/classifiers/estimateAcknowledgementClassifier.ts` | Built |
| Category-aware hints | `domain/categories/categoryResolver.ts` (injection fn) | Built |

The parser is the LLM call. It takes free text and produces a typed `MessageExtraction` record conforming to a Zod schema. The `mergeExtraction()` function is the key operation — it accumulates extractions across multiple messages into a single `AccumulatedJobState`, which is the parser's final output and the AST's input.

Category-aware extraction hints are injected into the prompt at parse time, giving the LLM domain-specific field knowledge based on the current WHAT classification. This is analogous to parser directives or pragma hints — they don't change the grammar, they guide disambiguation.

**Gaps**: Multi-modal parsing (images → extraction). Streaming parse (partial extraction mid-message for long voice transcripts).

---

### 3.4 AST — Typed Intermediate Representation

**Compiler analogue**: abstract syntax tree / intermediate representation
**Input**: `AccumulatedJobState` from the parser
**Output**: typed `(WHAT, HOW, INSTRUMENT)` triple + context graph + effort band
**Invariant**: every node in the AST is addressable by a canonical LTREE path

| Module | Path | Status |
|--------|------|--------|
| Universal taxonomy | `domain/categories/categoryTree.ts` | Built |
| Category resolver | `domain/categories/categoryResolver.ts` | Built |
| Conversation state machine | `domain/workflow/conversationStateManager.ts` | Built |
| Effort band inference | `domain/estimates/effortBandService.ts` | Built |
| Database schema (tables) | `db/schema.ts` | Built |

The AST is not a single object. It is the **composition of three structures**:

**1. Semantic category triple** (from `categoryTree.ts`)
```
Intent:
  WHAT = services.trades.carpentry     ← domain ontology
  HOW  = tx.hire                       ← transaction primitive
  INST = inst.contract.service-agreement ← derived document
```

Each WHAT node carries typed attributes (`timber_type`, `area_sqm`), extraction hints, scoring context (value multiplier, site-visit likelihood, licensed trade flag), and valid transaction types.

**2. Accumulated job state** (from `extractionSchema.ts`)
```
Context:
  scopeClarity      = 72
  estimateReadiness  = 61
  tone               = practical
  cheapestMindset    = false
  suburb             = "Paddington"
  effortBand         = "half_day"
```

This is the parser's output, accumulated across messages. It carries every extracted signal. The merge function is append-only for arrays and last-write-wins for scalars (with null-coalescing).

**3. Context graph** (Plexus — partially built, see §5)
```
Graph:
  org      = OddJobTodd
  customer = {name, phone, email, address}
  site     = {suburb, postcode, access}
  role     = operator
  path     = org/customer/site/job
```

In OJT today, this is implicit in the database relations. In Plexus, it becomes an explicit recoverable graph with typed edges, derivation paths, and governance policies.

**Gaps**: Plexus graph integration. Explicit AST node serialisation (currently scattered across `metadata` JSONB and denormalised columns). The job row is doing double duty as AST node and storage record.

---

### 3.5 TYPE CHECKER — Confidence, Completeness & Policy Validation

**Compiler analogue**: type checker / semantic analysis
**Input**: AST (accumulated state + category triple)
**Output**: typed confidence score, completeness breakdown, policy validation result
**Invariant**: type checking never mutates the AST — it only annotates

| Module | Path | Status |
|--------|------|--------|
| Confidence scorer | `domain/scoring/confidenceService.ts` | Built |
| Customer fit scorer | `domain/scoring/customerFitService.ts` | Built |
| Policy loader | `domain/policy/policyService.ts` | Built |
| Default policy | `domain/policy/defaultPolicy.ts` | Built |
| Policy types | `domain/policy/policyTypes.ts` | Built |
| Job scoring sync | `domain/scoring/jobScoringSync.ts` | Built |

The type checker answers: **"Is this AST well-formed enough to proceed?"**

- **Confidence** measures system certainty: do we have enough information to score reliably? (scope clarity, location clarity, estimate readiness, contact readiness, tone signal strength)
- **Completeness** measures extraction coverage: what percentage of needed fields have values?
- **Customer fit** is a type constraint: does this customer's behaviour match the operator's working preferences?

Policy is the configuration language for the type checker. `PolicyWeights` is literally a set of compiler flags — you can make scoring more or less aggressive without changing the source grammar. The policy loader supports versioned policies from the database with in-memory cache and fallback to defaults.

**Gaps**: Policy versioning UI (admin can't yet A/B test policies). Category-aware policy overrides (licensed trades could have stricter confidence thresholds).

---

### 3.6 OPTIMISER — Scoring Pipeline & Recommendation

**Compiler analogue**: optimisation passes / lowering
**Input**: type-checked AST + policy weights
**Output**: `ScoringPipelineResult` — fit score, worthiness score, recommendation, confidence, suburb group, category
**Invariant**: single-writer principle — `jobScoringSync` is the only path that writes scores to the database

| Module | Path | Status |
|--------|------|--------|
| Scoring pipeline | `domain/scoring/scoringPipelineService.ts` | Built |
| Quote worthiness scorer | `domain/scoring/quoteWorthinessService.ts` | Built |
| Recommendation engine | `domain/scoring/recommendationService.ts` | Built |
| Suburb group classifier | `domain/scoring/suburbGroupService.ts` | Built |
| Repeat customer detector | `domain/scoring/repeatCustomerService.ts` | Built |

The optimiser takes the typed AST and lowers it to actionable decisions. This is where the category value multiplier applies, where suburb distance penalises distant jobs, where the repeat customer bonus fires.

The output is a recommendation enum with eight values:
```
priority_lead        → book immediately
probably_bookable    → schedule when convenient
worth_quoting        → send formal quote
only_if_nearby       → accept if already in area
needs_more_info      → keep extracting
needs_site_visit     → can't price remotely
not_a_fit            → decline politely
not_price_aligned    → customer expectations don't match
```

This is the lowered IR. It's what the codegen phase consumes.

**Gaps**: Multi-job optimisation (batching nearby jobs into route). Time-based scoring (urgent job on empty day vs. same job on packed day). Materials availability check.

---

### 3.7 CODEGEN — Document & Instrument Derivation

**Compiler analogue**: code generation / emission
**Input**: lowered recommendation + AST + category triple
**Output**: commercial instruments — ROM estimates, formal quotes, contracts, invoices
**Invariant**: every emitted instrument is typed by the INSTRUMENT dimension and traceable to its AST

| Module | Path | Status |
|--------|------|--------|
| ROM estimate generator | `domain/estimates/estimateService.ts` | Built |
| Estimate wording engine | `domain/estimates/estimateWordingService.ts` | Built |
| Effort band service | `domain/estimates/effortBandService.ts` | Built |

Currently, codegen only produces ROM (rough order of magnitude) estimates. The universal taxonomy defines nine instrument types with 25+ subtypes. The instrument derivation function (`deriveInstrument()` in `categoryTree.ts`) already maps `(WHAT, HOW, state)` → instrument path, but the actual document templates don't exist yet.

The derivation logic:
```
(services.trades.*, tx.hire, estimateAccepted=true)  → inst.contract.service-agreement
(services.trades.*, tx.hire, estimatePresented=true)  → inst.quote.rom
(goods.*, tx.sale, *)                                 → inst.contract.purchase-agreement
(resources.*, tx.rental, *)                           → inst.contract.rental-agreement
(*, tx.meter, *)                                      → inst.channel.prepaid
(*, tx.exchange, *)                                   → inst.escrow.dual-party
(*, tx.grant, *)                                      → inst.receipt.standard
```

**Gaps**: This is the biggest gap. Formal quote generation. Contract templates. Invoice generation. PDF emission. E-signature integration. The derivation logic exists but the actual document renderers don't.

---

### 3.8 RUNTIME — Admin Console, Sessions, Workflows

**Compiler analogue**: runtime / execution environment
**Input**: compiled instruments + operator decisions
**Output**: actions — scheduling, dispatching, customer communication
**Invariant**: every operator action is an explicit state transition, not an ad hoc mutation

| Module | Path | Status |
|--------|------|--------|
| Lead queue API | `app/api/v2/admin/leads/route.ts` | Built |
| Lead detail API | `app/api/v2/admin/leads/[id]/route.ts` | Partial |
| Lead action API | `app/api/v2/admin/leads/[id]/action/route.ts` | Partial |
| Rescore API | `app/api/v2/admin/leads/[id]/rescore/route.ts` | Partial |
| Admin auth | `app/api/v2/auth/admin/login/route.ts` | Built |
| Admin dashboard | `components/AdminDashboard.tsx` | Partial |
| Customer chatbot | `components/CustomerChatbot.tsx` | Partial |
| DB client (dual-mode) | `db/client.ts` | Built |

The runtime is where compiled decisions execute. In OJT, this is the admin dashboard where Todd sees scored leads and takes action. In the broader Plexus vision, this is where graph operations, key rotations, capability token issuance, and workflow automation happen.

**Gaps**: Scheduling/dispatch. Job lifecycle after acceptance (progress tracking, completion, payment). Notification system (push, SMS, email for status changes). Mobile-friendly operator UI.

---

### 3.9 DIAGNOSTICS — Post-Mortems, Outcomes & Policy Tuning

**Compiler analogue**: diagnostics, profiling, profile-guided optimisation (PGO)
**Input**: completed jobs + human decisions + actual outcomes
**Output**: policy adjustments, confidence recalibration, extraction improvements
**Invariant**: diagnostics never alter in-flight compilations — they feed forward to future policy versions

| Module | Path | Status |
|--------|------|--------|
| Outcome recording | `app/api/v2/admin/outcomes/[jobId]/route.ts` | Partial |
| Conversation analysis | `app/api/cron/analyze-conversations/route.ts` | Stub |
| Structured logging | `logger.ts` | Built |

This is profile-guided optimisation for the commerce compiler. When Todd marks a job outcome (great job, not worth it, customer was difficult, overscoped), that feeds back into scoring calibration.

The `job_outcomes` table exists in the schema. The recording endpoint exists. But the analysis pipeline — computing disagreement metrics between system recommendation and human decision, identifying systematic biases, proposing policy weight adjustments — is almost entirely unbuilt.

**Gaps**: Disagreement analysis (system said "worth quoting", Todd said "waste of time" — why?). Policy auto-tuning (gradient on outcome data). Extraction quality metrics (how often does the parser miss suburb names?). Conversion funnel analytics.

---

## 4. The AST in Full

When a job is compiled, the full intermediate representation looks like this:

```
┌─ SOURCE ──────────────────────────────────┐
│ messages: ["I need a deck built, about    │
│ 20sqm hardwood, in Paddington"]           │
└───────────────────────────────────────────┘
            │
            ▼ parse
┌─ PARSER OUTPUT ───────────────────────────┐
│ MessageExtraction {                       │
│   scopeDescription: "deck built, 20sqm   │
│     hardwood"                             │
│   jobType: "carpentry"                    │
│   suburb: "Paddington"                    │
│   effortBand: "multi_day"                │
│   tone: "practical"                       │
│   scopeClarity: 72                        │
│ }                                         │
└───────────────────────────────────────────┘
            │
            ▼ classify + resolve
┌─ AST (Typed IR) ──────────────────────────┐
│ Intent:                                   │
│   WHAT = services.trades.carpentry        │
│   HOW  = tx.hire                          │
│   INST = inst.quote.rom                   │
│                                           │
│ Attributes:                               │
│   timber_type = "hardwood"                │
│   area_sqm = 20                           │
│   deck_style = null (not yet extracted)   │
│                                           │
│ Context:                                  │
│   org = OddJobTodd                        │
│   suburb = Paddington (core)              │
│   effortBand = multi_day                  │
│   confidence = 68                         │
│   completeness = 71                       │
│                                           │
│ Scoring Context:                          │
│   valueMultiplier = 1.4                   │
│   siteVisitLikely = true                  │
│   licensedTrade = false                   │
└───────────────────────────────────────────┘
            │
            ▼ type check + optimise
┌─ LOWERED IR ──────────────────────────────┐
│ Scores:                                   │
│   fit = 78                                │
│   worthiness = 67                         │
│   confidence = 68                         │
│                                           │
│ Decision:                                 │
│   recommendation = worth_quoting          │
│   reason = "Good customer, high-value     │
│     job in core area, but needs site      │
│     visit to confirm scope"               │
│   actionHint = "Schedule site visit"      │
│                                           │
│ Category Metadata:                        │
│   path = services.trades.carpentry        │
│   valueMultiplier = 1.4                   │
│   siteVisitLikely = true                  │
└───────────────────────────────────────────┘
            │
            ▼ codegen
┌─ EMITTED INSTRUMENT ──────────────────────┐
│ inst.quote.rom                            │
│   "Deck build ~20sqm hardwood:            │
│    Labour: $4,800 – $7,200                │
│    Materials: timber, screws, bearers      │
│    (customer supply or ~$3,000 – $4,500)  │
│    Timeline: 3-5 days                     │
│    Note: site visit needed to confirm     │
│    access and fall requirements"           │
└───────────────────────────────────────────┘
```

---

## 5. Plexus as Semantic Runtime

The compiler model clarifies Plexus's role. It is not "another app." It is the **runtime and continuity layer** underneath the compiler.

### 5.1 Mapping

| Compiler Concept | Plexus Component | Status |
|-----------------|------------------|--------|
| Symbol table / scope graph | Identity graph (tenant nodes, context records, edge records) | 75% built |
| Name resolution | Key derivation (BRC-42/52) — deterministic path → key | Built |
| Capability system | BRC-100/108 capability tokens | Spec'd |
| Garbage collection | Recovery-as-a-service (key rotation, credential refresh, dead node cleanup) | Built |
| Module system | Tenant hierarchy (org → division → team → individual) | Built |
| Linking | Edge records (typed relationships between graph nodes) | Built |
| ABI / wire protocol | BRC-100 wire format for inter-node communication | Spec'd |
| Sandboxing | Data sovereignty rules (what data lives where, who can read) | Spec'd |
| Debug symbols | Attestation records (who signed what, when, under what authority) | Partial |

### 5.2 What Plexus Provides That OJT Lacks

**Persistent identity**: OJT customers are rows in a table. Plexus customers are recoverable graph nodes with derivation history, multi-device key management, and verifiable attestations.

**Context continuity**: OJT job state is a JSONB blob on a row. Plexus context records are first-class graph nodes with typed edges, version history, and recovery paths. A job that spans multiple conversations, sites, and operators becomes a subgraph, not a mutation log.

**Authority delegation**: OJT has one admin and one operator (Todd). Plexus has role-based authority with key-backed capability tokens. An apprentice can view jobs but not approve quotes. A subcontractor can see their assigned jobs but not the full pipeline.

**Cross-system composition**: OJT is a single-tenant app. Plexus identity is portable. A customer authenticated via Plexus for OJT can also authenticate for Shomee, CashLanes, or any other system built on the graph — without re-registering.

### 5.3 Integration Path

The bridge between OJT's compiler and Plexus's runtime is the **context graph**.

Today: `job.metadata` (JSONB blob) + `job.customerId` (FK) + `job.siteId` (FK)

Tomorrow: `plexus.context_record` (typed node) + `plexus.edge_record` (typed relationship) + `plexus.derivation_path` (key → identity → authority chain)

The migration is additive. OJT continues to work with its current schema. Plexus context records shadow the existing data, adding recoverability, attestation, and cross-system identity without breaking the compiler pipeline.

---

## 6. Gap Analysis

### Built & Solid (no action needed)
- Lexer (auth, rate limiting)
- Parser (extraction, classification, schema)
- AST (taxonomy, category resolver, state machine)
- Type Checker (confidence, fit, policy system)
- Optimiser (scoring pipeline, recommendations)

### Built but Incomplete (next sprint candidates)
- **Codegen**: Only ROM estimates exist. Need formal quotes, contracts, invoices, PDF emission. The derivation logic is ready — document templates are the gap.
- **Runtime**: Lead queue works. Need job lifecycle post-acceptance, scheduling, dispatch, notification.
- **Diagnostics**: Outcome recording exists. Need disagreement analysis, policy auto-tuning, extraction quality metrics.

### Not Yet Started (future phases)
- **Multi-modal parsing**: Image understanding, voice transcription
- **Multi-job optimisation**: Route batching, day scheduling
- **Plexus integration**: Graph-backed context, identity-linked instruments
- **Self-patch protocol**: User-driven taxonomy growth at L2+
- **Embedding overlay**: Vector search on WHAT tree for free-text classification

---

## 7. Design Principles (Compiler-Informed)

**Extraction is parsing.** Its job is to produce typed nodes and attributes, not chatbot vibes. Measure it by parse accuracy, not conversation quality.

**Scoring is type analysis.** It interprets the AST under a policy. It doesn't guess — it applies rules to typed values.

**Policy is compiler flags.** You can make the compiler more aggressive (lower thresholds, higher bonuses) without changing the source language. Policy versioning is like compiler version pinning.

**Post-mortems are profile-guided optimisation.** They tell you where the compiler made wrong decisions. Feed outcomes back into policy weights, extraction prompts, and confidence thresholds.

**Plexus is the runtime.** It gives persistent identity, context, authority, and recovery to compiled objects. The compiler produces instruments; the runtime executes them.

**The taxonomy is the type system.** WHAT nodes are types. HOW nodes are calling conventions. INSTRUMENT nodes are output formats. Category attributes are type members. Extraction hints are type annotations. Value multipliers are optimisation weights.

**Separation of concerns is literal.** Syntax (extraction schema) is separate from semantics (scoring policy). Semantics are separate from execution (admin actions). Execution is separate from diagnostics (outcome analysis). Each layer has its own versioning, its own error model, and its own feedback loop.

---

## 8. What This Means for Architecture Decisions

When adding a feature, ask: **which compiler phase does this belong to?**

- "I want to extract materials from photos" → **Parser** (add image understanding to extraction)
- "I want licensed trades scored higher" → **Type Checker** (add policy weight, not scoring logic)
- "I want automatic quote PDFs" → **Codegen** (add instrument renderer)
- "I want to batch nearby jobs" → **Optimiser** (add multi-job pass)
- "I want customers to sign quotes digitally" → **Runtime** (add execution capability)
- "I want to know which job types have the best margins" → **Diagnostics** (add outcome analysis)

This prevents the most common failure mode in growing systems: putting everything in the "service layer" until it becomes an unmaintainable ball of mud.

---

*This document is the architectural spine. The taxonomy spec defines the type system. The Plexus spec defines the runtime. Together, they describe a complete semantic commerce compiler.*
