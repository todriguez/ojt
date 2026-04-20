# Compiler ↔ Semantos Bridge Specification

**Version**: 0.1-draft
**Date**: March 2026
**Companion docs**: semantic-compiler-pipeline.md, universal-commerce-taxonomy-spec.md, semantos/docs/semantic-object-model.md

---

## 1. The Claim

Every object the commerce compiler produces — AST nodes, scored states, emitted instruments — maps to a semantic object in the semantos 1KB cell model. The compiler's type system and the cell's type hash are the same thing. The compiler's pipeline phases map to linearity transitions. The interactions between parties are edges expressed as semantic objects with defined linearity.

This document specifies the exact mapping, identifies what changes on each side, and defines the type hash registry that bridges TypeScript types to Forth cell headers.

---

## 2. Cell Fit Analysis

Semantos cells: 1024 bytes = 256-byte header + 768-byte payload.

### JSON serialised (current, development mode)

| Compiler Object | JSON Bytes | Fits 768? | Cells |
|----------------|-----------|-----------|-------|
| Category triple (AST type ID) | 99 | ✅ | 1 |
| Minimal AST node | 186 | ✅ | 1 |
| Category resolution (full) | 656 | ✅ | 1 |
| Accumulated job state | 866 | ❌ | 2 |
| System scores snapshot | 1120 | ❌ | 2 |
| ROM estimate | 214 | ✅ | 1 |
| Fixed-price quote | 1294 | ❌ | 2 |
| Service agreement | 946 | ❌ | 2 |
| Disagreement result | 853 | ❌ | 2 |
| Job outcome record | 1457 | ❌ | 2 |

### Binary TLV-packed (production mode)

| Compiler Object | Binary Est. | Fits 768? | Cells |
|----------------|------------|-----------|-------|
| Category triple | 96 | ✅ | 1 |
| Minimal AST node | ~40 | ✅ | 1 |
| Category resolution | ~350 | ✅ | 1 |
| Accumulated job state | ~500 | ✅ | 1 |
| System scores snapshot | ~400 | ✅ | 1 |
| ROM estimate | ~80 | ✅ | 1 |
| Fixed-price quote | ~600 | ✅ | 1 |
| Service agreement | ~550 | ✅ | 1 |

**Key finding**: With binary packing, every compiler object fits in a single cell. JSON mode uses multi-cell (CELL-COUNT > 1) during development. The header's CELL-COUNT field already supports this.

---

## 3. Object-to-Cell Mapping

### 3.1 The Type Hash Is the Bridge

The semantos header has a 32-byte TYPE-HASH field (offset 30-61) — SHA256 of the type definition. The compiler's `(WHAT, HOW, INSTRUMENT)` triple produces a deterministic type hash:

```
TYPE-HASH = SHA256(WHAT-path || ":" || HOW-slug || ":" || INSTRUMENT-path)
```

Example:
```
SHA256("services.trades.carpentry:hire:inst.contract.service-agreement")
→ 0x7a3f... (32 bytes)
```

This hash is identical whether computed in TypeScript or Forth. It goes in the cell header at offset 30. The actual attribute data goes in the 768-byte payload.

The type hash serves as a **routing hint** for the semantos dispatch system. Objects with the same type hash follow the same processing pipeline. This is why ROUTING-HINT and TYPE-HASH can be the same field for commerce objects — the type *is* the route.

### 3.2 Compiler Phases Map to Linearity Transitions

| Phase | Object | Linearity | Semantos Type | Rationale |
|-------|--------|-----------|---------------|-----------|
| SOURCE | Customer message | RELEVANT | — | Can be read multiple times; never consumed |
| PARSER | MessageExtraction | LINEAR | Patch | Consumed once when merged into accumulated state |
| AST | AccumulatedJobState | AFFINE | Container | Can be updated (new extraction) or discarded (abandoned lead) |
| TYPE CHECK | Confidence/Completeness scores | RELEVANT | — | Reference data, attached to container |
| OPTIMISER | ScoringPipelineResult | LINEAR | Patch | Consumed once to produce the recommendation |
| CODEGEN | Emitted instrument (quote, contract) | RELEVANT→LINEAR | Capsule | Sealed, immutable, signed. Quoted multiple times (RELEVANT). Accepted once (LINEAR spend) |
| RUNTIME | Operator action (approve, decline) | LINEAR | Patch | Consumed once to transition state |
| DIAGNOSTICS | Outcome record | RELEVANT | — | Reference data for policy tuning |

The critical lifecycle:

```
Container (job state)
  ← Patch (extraction merge)         LINEAR: consumed once
  ← Patch (extraction merge)         LINEAR: consumed once
  ← Patch (scoring result)           LINEAR: consumed once
  → Capsule (ROM quote)              RELEVANT: can be shown, referenced
  ← Patch (customer accepts)         LINEAR: consumed once
  → Capsule (service agreement)      RELEVANT→LINEAR: signed once by both parties
  ← Patch (work completed)           LINEAR: consumed once
  → Capsule (invoice)                LINEAR: paid once
```

### 3.3 Concrete Cell Layouts

**Container Cell: Accumulated Job State**

```
┌─────────── HEADER (256 bytes) ───────────┐
│ Magic:      0xDEADBEEF CAFEBABE ...      │ 16 bytes
│ Linearity:  AFFINE (2)                   │  4 bytes
│ Version:    1                            │  4 bytes
│ Flags:      0x00                         │  4 bytes
│ RefCount:   1                            │  2 bytes
│ TypeHash:   SHA256(what:how:inst)        │ 32 bytes  ← THE BRIDGE
│ OwnerID:    operator pubkey hash         │ 16 bytes
│ Timestamp:  creation epoch               │  8 bytes
│ CellCount:  1                            │  4 bytes
│ TotalSize:  actual payload bytes         │  4 bytes
│ Reserved:   (phase, parent-id, etc.)     │162 bytes
└──────────────────────────────────────────┘

┌─────────── PAYLOAD (768 bytes) ──────────┐
│ Schema version:  1                       │  1 byte
│ WHAT-path:       varint len + UTF-8      │ ~30 bytes
│ HOW-slug:        varint len + UTF-8      │  ~6 bytes
│ INST-path:       varint len + UTF-8      │ ~35 bytes
│ Customer name:   varint len + UTF-8      │ ~15 bytes
│ Phone:           varint len + UTF-8      │ ~12 bytes
│ Email:           varint len + UTF-8      │ ~25 bytes
│ Suburb:          varint len + UTF-8      │ ~15 bytes
│ Postcode:        4 bytes fixed           │  4 bytes
│ Scope:           varint len + UTF-8      │~100 bytes
│ Scores block:    packed numerics         │ ~40 bytes
│   fit, worthiness, confidence, completeness
│   scopeClarity, locationClarity, etc.
│ Flags:           bitfield                │  2 bytes
│   estimatePresented, cheapestMindset,
│   photosProvided, siteVisitLikely
│ EffortBand:      1 byte enum             │  1 byte
│ Tone:            1 byte enum             │  1 byte
│ Category attrs:  TLV-encoded             │~50 bytes
│                                          │
│ Remaining:       ~430 bytes free         │
└──────────────────────────────────────────┘
```

**Patch Cell: Extraction Merge**

```
Header: Linearity = LINEAR, TypeHash = SHA256("patch.extraction")
Payload:
  container-id:   32 bytes (hash of target container)
  prev-hash:      32 bytes (hash of container state before)
  delta:          TLV-encoded field changes only (~100-300 bytes)
  signature:      64 bytes (operator or system key)
```

**Capsule Cell: Emitted Instrument (Quote/Contract/Invoice)**

```
Header: Linearity = RELEVANT, TypeHash = SHA256(what:how:inst)
Payload:
  container-ref:  32 bytes (hash of source container)
  instrument-data: TLV-encoded quote/contract/invoice (~400-600 bytes)
  issuer-cert:    33 bytes (compressed pubkey)
  signature:      64 bytes (ECDSA)
  merkle-proof:   32 bytes (if on-chain)
```

---

## 4. The Type Hash Registry

A mapping from compiler types to deterministic 32-byte hashes. This is the canonical bridge.

### 4.1 WHAT Dimension Types

Computed as: `SHA256("what." + path)`

```
SHA256("what.services.trades.carpentry")    → hash for carpentry container
SHA256("what.services.trades.plumbing")     → hash for plumbing container
SHA256("what.goods.vehicles.sedan")         → hash for vehicle sale container
...
```

### 4.2 HOW Dimension Types

Computed as: `SHA256("how." + slug)`

```
SHA256("how.hire")      → hash for hire transactions
SHA256("how.sale")      → hash for sale transactions
SHA256("how.rental")    → hash for rental transactions
...
```

### 4.3 INSTRUMENT Dimension Types

Computed as: `SHA256("inst." + path)`

```
SHA256("inst.quote.rom")                      → ROM quote capsule type
SHA256("inst.quote.fixed-price")              → formal quote capsule type
SHA256("inst.contract.service-agreement")     → service agreement capsule type
SHA256("inst.invoice.standard")               → invoice capsule type
...
```

### 4.4 Composite Type Hash (The Full Triple)

The cell header TYPE-HASH is the composite:

```
TYPE-HASH = SHA256(WHAT-path + ":" + HOW-slug + ":" + INST-path)
```

This means two containers with the same `(WHAT, HOW, INST)` triple have the same type hash. They are the same type of commercial interaction, just different instances. The OBJECT-ID (8 bytes) or the data content distinguishes instances.

### 4.5 Pipeline Phase Types

For Patch objects (state transitions), the type hash encodes the phase:

```
SHA256("phase.parse")           → extraction patch
SHA256("phase.typecheck")       → confidence/completeness patch
SHA256("phase.optimise")        → scoring pipeline patch
SHA256("phase.codegen")         → instrument derivation patch
SHA256("phase.action")          → operator action patch
SHA256("phase.outcome")         → outcome recording patch
```

---

## 5. Changes Required

### 5.1 Changes to OJT (Compiler Side)

**Add: Type hash computation utility**

New file: `src/lib/domain/bridge/typeHashRegistry.ts`

Purpose: Compute deterministic SHA256 type hashes from compiler types. These hashes are used as cell TYPE-HASH values and as the canonical identifier for the type system across TypeScript and Forth.

Functions needed:
- `computeTypeHash(what: string, how: string, inst: string): Buffer` — composite triple hash
- `computeWhatHash(path: string): Buffer` — WHAT dimension hash
- `computeHowHash(slug: string): Buffer` — HOW dimension hash
- `computeInstHash(path: string): Buffer` — INSTRUMENT dimension hash
- `computePhaseHash(phase: string): Buffer` — pipeline phase hash

**Add: Serialisation layer**

New file: `src/lib/domain/bridge/cellSerialiser.ts`

Purpose: Serialise/deserialise compiler objects to/from the 768-byte payload format. Two modes:
- JSON mode (development): UTF-8 JSON, multi-cell via CELL-COUNT if needed
- Binary TLV mode (production): compact varint-length-prefixed fields, single cell

Functions needed:
- `serialiseToPayload(obj: unknown, mode: "json" | "binary"): Buffer`
- `deserialiseFromPayload(buf: Buffer, mode: "json" | "binary"): unknown`
- `buildCellHeader(typeHash: Buffer, linearity: number, ownerId: Buffer, cellCount: number): Buffer`
- `packCell(header: Buffer, payload: Buffer): Buffer` — returns 1024-byte cell

**Add: Category triple to CategoryResolution**

The `CategoryResolution` interface should include a `typeHash` field:
```typescript
export interface CategoryResolution {
  // ... existing fields ...
  typeHash: Buffer;  // SHA256(path + ":" + txType + ":" + instrumentPath)
}
```

This means `resolveCategory()` computes the type hash at resolution time. It's available everywhere the category is used.

**Add: Linearity annotation to pipeline result**

The `ScoringPipelineResult` should carry the linearity class:
```typescript
export interface ScoringPipelineResult {
  // ... existing fields ...
  linearity: "linear" | "affine" | "relevant";
}
```

For OJT, this is always `"affine"` (container can be updated or discarded). But it's the right place to encode it for when other verticals need LINEAR (one-shot transactions) or RELEVANT (reference data).

### 5.2 Changes to Semantos (Object Model Side)

**Add: Commerce-aware type hash validation**

The current TYPE-HASH field uses placeholder patterns (0xC0 fill, 0xD0 fill). For commerce objects, the type hash should be validated against the triple format:

```forth
: VALIDATE-COMMERCE-TYPE-HASH ( hash-addr -- valid? )
  \ Check that hash matches SHA256(what:how:inst) format
  \ by looking up in the type registry
  TYPE-REGISTRY @ FIND-HASH
;
```

**Add: Type hash registry as a semantic object itself**

The registry of known type hashes should be a RELEVANT semantic object (duplicable, not discardable). This means the type system is on-chain and version-controlled.

```forth
: CREATE-TYPE-REGISTRY ( -- container-addr )
  \ Create a RELEVANT container holding all known type hashes
  \ Each entry: 32-byte hash + 1-byte dimension + varint path
  LINEARITY-RELEVANT CREATE-SEMANTIC-OBJECT
;
```

**Add: Extended header fields for commerce**

The current 162-byte RESERVED block in the header has room. Commerce objects should use:

```
Offset 94:  PHASE         1 byte   — compiler phase that produced this object
Offset 95:  DIMENSION     1 byte   — 0=composite, 1=what, 2=how, 3=instrument
Offset 96:  PARENT-HASH  32 bytes  — hash of parent container (for patches)
Offset 128: PREV-STATE   32 bytes  — hash of container state before this patch
Offset 160: RESERVED     96 bytes  — remaining
```

This uses 66 bytes of the 162-byte reserved block. The PHASE byte encodes which compiler phase produced the object (0=source, 1=parse, 2=ast, 3=typecheck, 4=optimise, 5=codegen, 6=action, 7=outcome). The DIMENSION byte encodes which taxonomy dimension the type hash references.

**Add: Multi-cell linking**

For JSON-mode development, objects that exceed 768 bytes need continuation cells. The current CELL-COUNT field supports this. What's needed is a linking mechanism:

```forth
: NEXT-CELL ( cell-addr -- next-cell-addr | 0 )
  \ If CELL-COUNT > 1, continuation cells follow at addr + 1024
  DUP OBJECT-CELL-COUNT @ 1 > IF
    CELL-SIZE +
  ELSE
    DROP 0
  THEN
;
```

Continuation cells don't need the full 256-byte header — just a 16-byte continuation header (magic + cell-index + parent-ref), giving 1008 bytes of payload per continuation cell.

**Add: Certificate-based instrument signing**

Capsule objects (emitted instruments) need to carry a BRC-52 certificate reference. The current certificate-objects.fs defines CERT-SUBJECT (33 bytes) and CERT-SIGNATURE (71 bytes). The capsule payload should include:

```
Offset 0:   container-ref     32 bytes  (source container hash)
Offset 32:  instrument-data   variable  (TLV-encoded)
Offset N:   issuer-cert-ref   32 bytes  (hash of BRC-52 certificate)
Offset N+32: signature        71 bytes  (DER-encoded ECDSA)
```

This means an instrument (quote, contract, invoice) is cryptographically signed by the issuer and verifiable against their BRC-52 certificate. The certificate itself is a separate AFFINE semantic object that can be revoked.

### 5.3 Changes to Both Sides

**Shared: Canonical encoding for taxonomy paths**

Both sides need to agree on path encoding. Current OJT uses dot-separated strings (`"services.trades.carpentry"`). Semantos uses 32-byte hashes. The bridge needs both:

1. **Human-readable path** (in payload): varint-length-prefixed UTF-8 string
2. **Type hash** (in header): SHA256 of the canonical path string

The encoding rules:
- Paths are lowercase ASCII, dot-separated
- No trailing dots
- Max depth 8 levels
- Max path length 255 bytes (fits in 1-byte varint)
- Hash computed on the exact UTF-8 byte sequence (no normalisation beyond lowercase)

**Shared: Phase enum values**

Both sides must agree on the 1-byte phase encoding:

```
0x00 = source
0x01 = parse
0x02 = ast (category resolution)
0x03 = typecheck (confidence, completeness)
0x04 = optimise (scoring pipeline)
0x05 = codegen (instrument derivation)
0x06 = action (operator decision)
0x07 = outcome (post-mortem)
0xFF = unknown
```

---

## 6. What This Means Architecturally

### Interactions ARE semantic objects

Every edge in the commerce graph — message → extraction, extraction → state, state → score, score → instrument — is a Patch semantic object with LINEAR linearity. It's consumed once when the transition fires. The result is a new Container state.

This means the full conversation history of a job is a chain of semantic objects:

```
Container₀ (empty state)
  ← Patch₁ (first message extraction)       LINEAR, consumed
Container₁ (partial state)
  ← Patch₂ (second message extraction)      LINEAR, consumed
Container₂ (fuller state)
  ← Patch₃ (scoring result)                 LINEAR, consumed
Container₃ (scored state)
  → Capsule₁ (ROM quote)                    RELEVANT, referenced
  ← Patch₄ (customer accepts)               LINEAR, consumed
Container₄ (accepted state)
  → Capsule₂ (service agreement)            RELEVANT→LINEAR on signing
  ← Patch₅ (work completed)                 LINEAR, consumed
Container₅ (completed state)
  → Capsule₃ (invoice)                      LINEAR, paid once
```

Each object has a TYPE-HASH linking it to the universal taxonomy. Each patch references its parent container by hash. The chain is verifiable, recoverable, and auditable.

### The taxonomy IS the type system IS the routing table

The TYPE-HASH in the semantos header, the `(WHAT, HOW, INSTRUMENT)` triple in the compiler, and the ROUTING-HINT in the dispatch system are all derived from the same canonical paths. There's no separate routing layer — the type *is* the route.

When a new semantic object arrives at a node, the dispatcher:
1. Reads TYPE-HASH from header (32 bytes)
2. Looks up in the type registry (a RELEVANT semantic object)
3. Finds the handler for that type (which compiler phase processes it)
4. Reads LINEARITY to enforce usage rules
5. Reads PHASE byte to know where in the pipeline this object belongs

### The compiler pipeline is a state machine over semantic objects

Each phase takes semantic objects as input and produces semantic objects as output. The linearity rules enforce correctness:
- A LINEAR patch can't be applied twice (no double-extraction)
- An AFFINE container can be abandoned (lead not pursued) — the discard is valid
- A RELEVANT capsule can be referenced by multiple parties (customer and operator both see the quote)
- A capsule that transitions to LINEAR on signing can only be signed once (no double-signing of contracts)

This is not a metaphor. The Forth stack machine literally enforces these rules at the 2-PDA level.

---

## 7. Implementation Order

1. **Type hash registry** (OJT side) — pure function, no dependencies, enables everything else
2. **Phase/dimension bytes in reserved header** (semantos side) — backward compatible, just uses reserved space
3. **Cell serialiser** (OJT side) — JSON mode first, binary later
4. **TypeHash field on CategoryResolution** (OJT side) — computed at resolution time
5. **Type registry as semantic object** (semantos side) — the taxonomy on-chain
6. **Certificate-based capsule signing** (both sides) — needs BRC-52 integration

Steps 1-4 can happen now with no blockchain dependency. Steps 5-6 need Plexus identity integration.

---

*The compiler produces typed objects. Semantos gives them cryptographic identity, linearity enforcement, and on-chain persistence. The type hash is the bridge — same 32 bytes, computed the same way, on both sides.*
