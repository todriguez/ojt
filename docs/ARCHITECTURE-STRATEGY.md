# OddJobTodd — Architecture Strategy

## What you have today

**OJT (~/projects/oddjobtodd)** — a production Next.js app on Vercel:
- 13-step chat pipeline: save → extract → merge → classify → score → recommend → estimate → inject → reply → persist
- Effort band inference with keyword matching, quantity bumps, access bumps, cure/dry time bumps
- ROM estimates with per-unit pricing, material hints, confidence scoring
- Customer fit scoring, quote worthiness scoring, recommendation engine
- Estimate acknowledgement classification (accepted/rejected/tentative/pushback)
- Job pivot handling (customer switches topic mid-conversation)
- Confirmed-facts injection (prevents re-asking)
- PDF import pipeline (REA referrals — already exists!)
- Semantic kernel bridge (adapter.trades.ts) — wired but lightweight
- Admin dashboard, lead management, OTP auth, rate limiting
- Drizzle ORM + Postgres

**Semantos Core (~/projects/semantos-core)** — the protocol kernel:
- Compression gradient: natural language → shell grammar → Lisp policy → opcodes
- Linear type system (LINEAR, AFFINE, RELEVANT, FUNGIBLE)
- Facet provenance — patches track who said what
- Policy engine — Lisp s-expressions compile to Bitcoin Script-like opcodes
- Two-party conversation model (homeowner ↔ tradie as different facets)
- Vertical config system — trades-services is one vertical, could be anything
- Auto-ROM with configurable pricing policies, sizing questions per trade category
- Cell engine (Zig → WASM) for the 2-PDA execution

**Key insight:** OJT has the better product logic (battle-tested scoring, calibrated effort bands, real conversation flow). Semantos has the better kernel (deterministic types, provenance, policy compilation, cross-party sync). They need to converge, not compete.

---

## Three use cases, priority order

### 1. Your instance (OddJobTodd for Todd's handyman business)
What it is now. Keep it running, keep improving the chat quality and pricing accuracy.

### 2. Multi-tenant SaaS for sole operators
Same product, different tradies. Each operator gets:
- Their own service area / suburb groups
- Their own pricing policy (base rates, category modifiers)
- Their own tone / personality in the chat
- Their own trade categories (a sparky doesn't need fencing config)
- Their own admin dashboard

This is mostly a data isolation problem. Add `tenantId` to every table, load policy/config per tenant, route by subdomain or API key.

### 3. REA collaboration
An REA creates a job from a tenant maintenance request. The job lands in your queue as a collaborator. You fork it locally — add your photos, ramblings, ROM, schedule. The REA sees status updates, completion, and the invoice. The tenant sees progress.

This is where semantos earns its keep. The semantic object model with facet provenance is exactly this:
- **REA facet**: can create jobs, see status + invoice, can't see your internal cost notes
- **Tradie facet**: can patch with photos/notes/ROM/quotes, can publish invoice back
- **Tenant facet**: can see job status, can message, can't see pricing
- **Linear types enforce boundaries**: your internal ROM workings are AFFINE (consumed locally), the published invoice is RELEVANT (freely readable by REA + tenant)

---

## Flutter: pros and cons

### Option A: Flutter replaces everything
Single codebase for iOS, Android, web.

| Pro | Con |
|-----|-----|
| One codebase, deploy everywhere | Rewrite cost — you have a working product |
| Native mobile feel — camera, offline, push | Flutter web is good but not great for SEO |
| Dart is solid for structured data + state | Lose Next.js ecosystem (Vercel serverless, ISR) |
| Local SQLite for offline-first | Bigger upfront investment |
| Hot reload, fast iteration | |

### Option B: Flutter mobile + Next.js web stays
Flutter for tradie app, web stays for homeowner intake + admin.

| Pro | Con |
|-----|-----|
| Best of both — native mobile where it matters | Two codebases, eventual drift |
| Reuse all existing web code | Shared logic needs to live in the API |
| Lower migration risk | Homeowners might want a mobile app too |
| Web admin dashboard stays as-is | |

### Option C: Flutter web + mobile (one codebase)
Flutter for everything — web widget for homeowner, native app for tradies.

| Pro | Con |
|-----|-----|
| True single codebase | Bigger rewrite than Option B |
| Offline-first everywhere | SEO needs a separate landing/marketing site |
| Consistent UX across platforms | Flutter web bundle is larger |
| Camera, push, biometrics on mobile | |

### Recommendation: Option B first, migrate to C later

Start with a Flutter mobile app for the tradie side. That's where the pain is — tradies are in the van, on site, taking photos with dodgy reception. The homeowner chat widget and admin dashboard can stay on the web for now.

The API backend stays on Vercel either way. All the intelligence (chatService, scoring, extraction, estimates) lives server-side. The Flutter app just calls the API.

Later, if you want to go full Flutter (Option C), the web frontend is the smallest piece to replace. The homeowner chat is basically a text input + message list + photo upload — trivial in Flutter.

**What you'd need for a separate marketing/landing site:** A simple static site (Astro, Hugo, even just HTML) for SEO and customer acquisition. This is not the app — it's the funnel.

---

## Recommended architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Client Layer                           │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Flutter App   │  │ Web Chat     │  │ Web Admin    │  │
│  │ (tradie)     │  │ Widget (HO)  │  │ Dashboard    │  │
│  │ iOS/Android  │  │ (Next.js)    │  │ (Next.js)    │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
└─────────┼─────────────────┼─────────────────┼────────────┘
          │                 │                 │
          └─────────┬───────┴─────────┬───────┘
                    │   REST / WS     │
┌───────────────────┴─────────────────┴────────────────────┐
│                    API Layer (Vercel)                      │
│                                                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │ Chat        │  │ Scoring &   │  │ Multi-tenant    │  │
│  │ Pipeline    │  │ Estimation  │  │ Router          │  │
│  │ (extract →  │  │ (effort →   │  │ (tenant config, │  │
│  │  score →    │  │  ROM →      │  │  pricing policy │  │
│  │  reply)     │  │  recommend) │  │  service area)  │  │
│  └──────┬──────┘  └──────┬──────┘  └────────┬────────┘  │
│         │                │                   │           │
│  ┌──────┴────────────────┴───────────────────┴────────┐  │
│  │              Semantos Kernel Bridge                 │  │
│  │  ├─ Semantic objects + append-only patches          │  │
│  │  ├─ Facet provenance (homeowner/tradie/REA/tenant) │  │
│  │  ├─ Linear types (AFFINE for private, RELEVANT     │  │
│  │  │   for shared, FUNGIBLE for public)              │  │
│  │  ├─ Policy engine (configurable per tenant)        │  │
│  │  └─ Sync protocol (fork/extend/merge for REA)     │  │
│  └────────────────────────┬───────────────────────────┘  │
└───────────────────────────┼──────────────────────────────┘
                            │
┌───────────────────────────┼──────────────────────────────┐
│                    Storage Layer                          │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Postgres     │  │ Local SQLite │  │ Blob Storage │  │
│  │ (Supabase/   │  │ (Flutter     │  │ (Vercel Blob │  │
│  │  Neon)       │  │  offline)    │  │  / R2)       │  │
│  │ per-tenant   │  │ sync queue   │  │ photos/PDFs  │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
└──────────────────────────────────────────────────────────┘
```

---

## Multi-tenant: what changes

The current OJT codebase is single-operator. To sell to other tradies:

**Database:** Add `tenant_id` to `jobs`, `messages`, `estimates`, `customers`, `scoring_policies`. Use Postgres RLS (Row Level Security) or middleware filtering.

**Configuration per tenant:**
- Pricing policy (base rates, category modifiers, travel zones) — already exists as `pricing-v1` in the semantos vertical config, just needs to be per-tenant
- Service area (suburb groups: core/extended/outside) — per tenant
- Trade categories (a sparky only needs electrical, a handyman needs everything)
- Chat personality/tone (operator name, area, tone rules) — `buildSystemPrompt()` already takes `operatorName` and `serviceArea`
- Scoring weights — the full `PolicyWeights` type already supports this

**Routing:** Subdomain (`todd.oddjobtodd.com.au`) or API key per tenant. Vercel middleware can route.

**What stays shared:** The chat pipeline, extraction model, scoring engine, effort band inference — these are the platform. Tenants configure them, not replace them.

**Estimated effort:** Medium. The biggest piece is the tenant routing + config loading. The domain logic barely changes — it already takes configuration as input.

---

## REA collaboration: the fork/extend/merge model

This is where semantos really shines. The model you described — REA creates a job, passes it to you, you work on it locally and merge back — maps directly to the protocol.

**How it works:**

1. **REA creates a job** (tenant maintenance request):
   - Semantic object created with REA facet
   - Fields: property address, tenant name, description, photos
   - Linearity: RELEVANT (readable by collaborators)

2. **Job lands in your queue:**
   - You see the REA's patches (property, description, photos)
   - You accept collaboration → your facet gets added to the object

3. **You fork locally:**
   - Your internal notes, cost calculations, supplier quotes — AFFINE patches
   - These exist on your side only. The REA can't see your margins.
   - Photos, site assessment notes — you choose what to share

4. **You work the job:**
   - ROM → quote → schedule → complete
   - Status transitions are RELEVANT — REA sees progress
   - Your internal ramblings stay AFFINE

5. **You merge back:**
   - Publish the invoice (RELEVANT → REA can see it)
   - Completion status, photos of finished work
   - REA can present to tenant / property owner

**Linearity boundaries:**
- `AFFINE` (your eyes only): internal cost notes, supplier quotes, margin calculations
- `RELEVANT` (shared with REA): job status, ROM range, completion photos, invoice
- `FUNGIBLE` (public): nothing — this is B2B, not a public marketplace (yet)

**What this needs from semantos-core:**
- The sync protocol (not yet built — this is the next big kernel piece)
- Cross-tenant object references
- Facet capability negotiation (REA grants you "patch" capability, you grant them "read" on RELEVANT patches)

**Estimated effort:** Large. The sync protocol is real engineering. But the object model, facet provenance, and linear types are already designed for exactly this.

---

## Migration path

### Phase 1: Multi-tenant OJT (4-6 weeks)
- Add `tenantId` throughout the schema
- Per-tenant config loading (pricing policy, service area, trade categories)
- Tenant onboarding flow (create account, configure, get API key)
- Keep the existing Next.js web app
- **Your instance keeps running throughout — it's just tenant #1**

### Phase 2: Flutter tradie app (6-8 weeks)
- Flutter app calling the same API
- Job queue, chat, photo capture, offline sync
- Push notifications for new jobs
- Local SQLite cache for offline access on job sites
- **Web stays for homeowner intake + admin**

### Phase 3: Semantos kernel integration (4-6 weeks)
- Replace the lightweight `semanticRuntimeAdapter.ts` bridge with real kernel calls
- Append-only patch log with facet provenance on every write
- Policy engine for configurable scoring/pricing per tenant
- Compression gradient available for admin/debug views

### Phase 4: REA collaboration (8-12 weeks)
- Sync protocol for cross-tenant semantic objects
- REA portal (web — Flutter optional later)
- Facet capability negotiation
- Fork/extend/merge workflow
- Invoice publishing back to REA

### Phase 5: Flutter web (optional, 4 weeks)
- Replace the Next.js homeowner chat with Flutter web widget
- Full single-codebase if desired
- Or keep the web as-is — it works

---

## Key decisions to make now

1. **Database:** Stay with Postgres on Neon/Supabase? Or move to Supabase for the auth/RLS combo? (Supabase gives you RLS for multi-tenant isolation basically for free.)

2. **Offline strategy:** How critical is offline for tradies? If they're on rural job sites with no reception, you need local-first with sync. If they're mostly suburban, a basic cache + retry is enough.

3. **REA MVP:** Do you need the full fork/extend/merge from day one, or is a simple "REA pushes a job via API, you see it in your queue" enough to start selling?

4. **Pricing model:** Per-seat (per tradie)? Per-job? Freemium with limits? This affects the multi-tenant architecture (metering, billing).

5. **Flutter state management:** Riverpod, BLoC, or Provider? (Riverpod is the modern choice for this kind of structured data flow.)
