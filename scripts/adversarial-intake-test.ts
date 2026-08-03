/**
 * Adversarial Intake Test — boomer edition.
 *
 * Purpose: pressure-test the deterministic SPP estimator pipeline without
 * hitting Anthropic or the DB. Each persona is a sequence of realistic
 * (mis)spelt / rambly / ambiguous customer messages. For each turn we
 * hand-roll the TaggedFacts that a WELL-BEHAVED extractor LLM would
 * produce from that message, then feed them through `runEstimatorTurn`.
 *
 * What this catches:
 *   - Band math producing silly numbers (too low / too high)
 *   - Amendments firing correctly when scope grows mid-conversation
 *   - Next-question policy routing to the right missing dimension
 *   - Policy clamp / Paskian multipliers behaving
 *   - Phase machine never regressing
 *
 * What this DOESN'T catch (not its job):
 *   - Whether the real LLM actually emits these facts from the raw
 *     messages — that's a separate LLM-quality test, run against Claude.
 *     If a persona's messages are too weird for the real LLM to parse,
 *     THIS harness will still land a sensible ROM because we hand-rolled
 *     the facts. The gap between "hand-rolled facts" and "what the LLM
 *     actually produces" is the bot's extraction quality, measured
 *     separately.
 *
 * Run: npx tsx scripts/adversarial-intake-test.ts
 */
import {
  emptyEstimatorState,
  runEstimatorTurn,
  anchorForMessage,
  DEFAULT_PRICING_POLICY,
  IDENTITY_MULTIPLIERS,
  type EstimatorState,
  type RomInstrument,
  type EstimatorPatch,
} from "../src/lib/domain/estimates/sppEstimator";
import { pickNextQuestion } from "../src/lib/domain/estimates/nextQuestionPolicy";
import type { TaggedFact } from "../src/lib/lexicons";

// ── Persona shape ─────────────────────────────────────────────────────────

interface Turn {
  /** What the customer actually typed. */
  message: string;
  /** What a reasonable extractor would pull out — hand-rolled. */
  facts: TaggedFact[];
  /** A one-line note about what this turn is testing. */
  note?: string;
}

interface Persona {
  name: string;
  persona: string; // short description
  turns: Turn[];
}

// ── Fact builder helpers (makes the persona data less verbose) ────────────

const f = {
  trade: (cat: string, conf = 0.9, src = ""): TaggedFact => ({
    lexicon: "trades",
    category: cat,
    confidence: conf,
    fact: `Trade is ${cat}`,
    source: src,
  }),
  dim: (cat: string, val: string, conf = 0.85, src = ""): TaggedFact => ({
    lexicon: "building-job-dimensions",
    category: cat,
    confidence: conf,
    fact: val,
    source: src,
  }),
  untagged: (fact: string, src = ""): TaggedFact => ({
    lexicon: null,
    category: null,
    confidence: 0.9,
    fact,
    source: src,
  }),
};

// ── Personas ──────────────────────────────────────────────────────────────

const personas: Persona[] = [
  {
    name: "Gerald, 78",
    persona: "rambles about the council, wants 'me shed doing up', adds the dunny mid-way",
    turns: [
      {
        message: "oi mate me shed needs doing up the council keeps writin me letters",
        facts: [
          // Extractor should hedge — "doing up" is ambiguous. No trade fact yet.
        ],
        note: "Vague intent, no trade tagged",
      },
      {
        message: "painted i mean i reckon it needs paintin its tin",
        facts: [
          f.trade("painting", 0.85, "paintin its tin"),
          f.dim("surface", "exterior", 0.9, "tin shed"),
          f.dim("dwelling_type", "house", 0.6, "shed"), // treating a shed as a detached structure; dwelling_type imperfect fit
        ],
        note: "Trade revealed: exterior paint on a metal shed",
      },
      {
        message: "and the dunny out there while yers at it",
        facts: [
          // Same trade, more scope — dunny = small outdoor toilet structure
        ],
        note: "Scope add (same trade) — should NOT trigger different_job",
      },
      {
        message: "oh n look its rustin in a few spots probly need a scrub",
        facts: [
          f.dim("prep_level", "strip_back", 0.85, "rustin in a few spots probly need a scrub"),
        ],
        note: "Prep level escalates — should amend the ROM",
      },
    ],
  },

  {
    name: "Marj, 81",
    persona: "terse, asks price first, wants cash discount, gate latch",
    turns: [
      {
        message: "how much love",
        facts: [
          // Nothing extractable — pricing question before scope
        ],
        note: "Price-before-scope — bot should NOT quote",
      },
      {
        message: "the gate thingo doesnt shut",
        facts: [
          f.trade("fencing", 0.75, "the gate thingo doesnt shut"),
          f.dim("work_type", "repair", 0.85, "doesnt shut"),
          f.dim("quantity_signal", "single", 0.9, "the gate"),
        ],
        note: "Gate repair — small fencing job",
      },
      {
        message: "cash is ok yeah? me pension",
        facts: [],
        note: "No dimension update, just payment method chat",
      },
    ],
  },

  {
    name: "Col, 72",
    persona: "Queenslander full-exterior repaint, reveals paint is flaking badly",
    turns: [
      {
        message: "need the whole outside of the house done, its a queenslander",
        facts: [
          f.trade("painting", 0.95, "the whole outside of the house done"),
          f.dim("surface", "exterior", 0.95, "whole outside"),
          f.dim("dwelling_type", "house", 0.9, "queenslander"),
        ],
        note: "Exterior full-repaint, house — should land in mega",
      },
      {
        message: "its two story",
        facts: [
          f.dim("access", "scaffold", 0.9, "two story"),
        ],
        note: "Access bump — scaffold adds +2",
      },
      {
        message: "paints flakin off somethin chronic, big flakes comin off the weatherboards",
        facts: [
          f.dim("prep_level", "strip_back", 0.95, "flakin off somethin chronic, big flakes"),
        ],
        note: "Strip-back prep — painting +2 bump. Amendment expected.",
      },
    ],
  },

  {
    name: "Dot, 69",
    persona: "starts with 2 doors, pivots to a pergola mid-way",
    turns: [
      {
        message: "two doors need hangin",
        facts: [
          f.trade("doors_windows", 0.95, "two doors need hangin"),
          f.dim("work_type", "install", 0.9, "need hangin"),
          f.dim("room_count", "2", 0.95, "two doors"),
          f.dim("quantity_signal", "small_batch", 0.9, "two"),
        ],
      },
      {
        message: "theyre in the bedrooms",
        facts: [
          f.dim("surface", "interior", 0.9, "bedrooms"),
          f.dim("dwelling_type", "house", 0.7, "bedrooms"), // plausible
        ],
      },
      {
        message: "oh yeah and a pergola while yers here",
        facts: [
          // This is a DIFFERENT trade (carpentry). Extractor SHOULD emit a
          // different_job signal, not overwrite the doors job. The
          // estimator's handling of this is: second trade fact will
          // update state.trade to carpentry, which is a bug we'd want to
          // catch. The chatService-side jobPivot guard should intercept
          // this before it reaches runEstimatorTurn. For this harness
          // (which bypasses chatService) we emit both facts and watch
          // what happens — the bug is visible here as state.trade
          // overwriting from doors_windows → carpentry.
          f.trade("carpentry", 0.9, "pergola"),
        ],
        note: "Different-trade pivot — THIS IS A KNOWN GAP (jobPivot guard lives in chatService, not in runEstimatorTurn)",
      },
    ],
  },

  {
    name: "Bazza, 75",
    persona: "underselves scope, reveals it's actually 15m with concrete posts",
    turns: [
      {
        message: "a few palings need replacin",
        facts: [
          f.trade("fencing", 0.95, "palings need replacin"),
          f.dim("work_type", "replace", 0.9, "replacin"),
          f.dim("quantity_signal", "small_batch", 0.85, "a few"),
        ],
      },
      {
        message: "nah actual its buggered the whole side of the fence mate maybe 15 metres",
        facts: [
          f.dim("quantity_signal", "large_batch", 0.95, "the whole side maybe 15 metres"),
        ],
        note: "Scope blows out from 'a few' to 15m — amendment",
      },
      {
        message: "posts are all concreted in too",
        facts: [
          f.dim("prep_level", "strip_back", 0.85, "posts are all concreted in"),
          // Access stays ground by default
        ],
        note: "Concrete posts = major prep bump on fencing",
      },
    ],
  },

  {
    name: "Shirl, 82",
    persona: "unclear trade (gardening? cleaning?), arthritis, wants someone to 'do the lot'",
    turns: [
      {
        message: "me yards a mess can someone come do the lot i got arthritis",
        facts: [
          f.trade("gardening", 0.8, "me yards a mess"),
          f.dim("quantity_signal", "large_batch", 0.85, "do the lot"),
        ],
      },
      {
        message: "grass up to me knees and the hedges are like a jungle",
        facts: [
          f.dim("work_type", "repair", 0.7, "grass up to me knees"), // mow + hedge = maintenance
        ],
      },
    ],
  },

  {
    name: "Ron, 77",
    persona: "caps-lock, impatient, aggressive",
    turns: [
      {
        message: "PAINT HOUSE WHITE ALL OF IT NOW",
        facts: [
          f.trade("painting", 0.9, "PAINT HOUSE WHITE ALL OF IT"),
          f.dim("surface", "mixed", 0.7, "HOUSE ALL OF IT"), // could be either — mixed is the hedge
          f.dim("dwelling_type", "house", 0.85, "HOUSE"),
          f.dim("quantity_signal", "large_batch", 0.85, "ALL OF IT"),
        ],
        note: "Aggressive tone — the urgency is a signal for the chat LLM, not the estimator",
      },
      {
        message: "HOW LONG",
        facts: [],
        note: "Asking for time — bot should give band range not duck",
      },
    ],
  },

  {
    name: "Nev, 70",
    persona: "multi-job bleed, pushback on ROM as 'robbery'",
    turns: [
      {
        message: "fix taps",
        facts: [
          f.trade("plumbing", 0.9, "fix taps"),
          f.dim("work_type", "repair", 0.9, "fix"),
          f.dim("quantity_signal", "small_batch", 0.8, "taps"), // plural
        ],
      },
      {
        message: "ow about lights in kitchen too",
        facts: [
          // Different trade (electrical). Same pivot issue as Dot.
          f.trade("electrical", 0.85, "lights in kitchen"),
        ],
        note: "Cross-trade bleed",
      },
      {
        // Assume ROM presented on turn 2 or 3. This is the pushback turn.
        message: "mate thats robbery",
        facts: [
          // Pushback is caught upstream via extraction.estimateReaction
          // which doesn't flow through taggedFacts. No dimension update.
        ],
        note: "Pushback — harness won't see it via facts; chatService handles estimateReaction separately",
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────
  //  More personas: real odd-job long tail
  //  The `general` trade bucket is probably 40-50% of a handyman's inbox.
  //  These personas exercise hang-this / mount-that / assemble / one-off
  //  weirdness that doesn't fit neatly into painting/fencing/plumbing.
  // ─────────────────────────────────────────────────────────────────────

  {
    name: "Stu, 44",
    persona: "just wants a TV mounted — quick, typical general job",
    turns: [
      {
        message: "need a 65 inch tv mounted on the lounge wall",
        facts: [
          f.trade("general", 0.9, "tv mounted"),
          f.dim("work_type", "install", 0.9, "mounted"),
          f.dim("quantity_signal", "single", 0.9, "a 65 inch tv"),
          f.dim("surface", "interior", 0.8, "lounge wall"),
        ],
        note: "Classic TV-mount — should land in `short` band",
      },
      {
        message: "its a brick wall",
        facts: [
          f.dim("material_tier", "premium", 0.7, "brick wall"),
          // brick is not material_tier — this is testing the dim-fact
          // parser's rejection of off-target values. The parser will
          // reject because "premium" is valid but the SEMANTIC meaning is
          // wrong. (Real fix: add a `substrate` dimension.)
        ],
        note: "Substrate/material concern — off-target dim fact, should be rejected cleanly",
      },
    ],
  },

  {
    name: "Janine, 36",
    persona: "6-item list — hang pics, wobbly knob, shower seal, flatpack bedside",
    turns: [
      {
        message: "got a few things need doing — hang 3 pictures, fix a wobbly door handle, reseal the shower, assemble a bedside table, and put up a mirror in the hallway",
        facts: [
          f.trade("general", 0.95, "a few things"),
          f.dim("quantity_signal", "large_batch", 0.9, "a few things (5 items)"),
          f.dim("work_type", "install", 0.8, "hang, put up, assemble"),
          f.dim("surface", "interior", 0.85, "shower, hallway"),
          f.dim("dwelling_type", "house", 0.6, ""),
        ],
        note: "Multi-item list — big question: should 5 tiny jobs really land in mega?",
      },
    ],
  },

  {
    name: "Phil, 52",
    persona: "water coming through ceiling — symptom not fix, ambiguous trade",
    turns: [
      {
        message: "weve got water coming through the ceiling in the kitchen",
        facts: [
          // Could be plumbing (pipe burst upstairs), roofing (leak in
          // storm), structural. A good extractor leaves trade ambiguous
          // or picks the most likely single one and signals uncertainty.
          f.trade("plumbing", 0.6, "water coming through the ceiling"),
          f.dim("work_type", "repair", 0.85, "coming through"),
          f.dim("surface", "interior", 0.85, "kitchen"),
        ],
        note: "Symptom not fix — low-confidence trade. Should NOT emit high-confidence ROM.",
      },
      {
        message: "upstairs bathroom is above the kitchen",
        facts: [
          // Confirms plumbing origin
          f.dim("dwelling_type", "house", 0.8, "upstairs"),
        ],
        note: "Disambiguator — upstairs bathroom makes plumbing the likely culprit",
      },
    ],
  },

  {
    name: "Deb, 62",
    persona: "car won't start — out of scope, should be polite refusal",
    turns: [
      {
        message: "me car wont start mate, battery or somethin",
        facts: [
          // No trade tag — this is out of handyman scope entirely. A
          // well-behaved extractor tags lexicon=null, fact="Car won't
          // start, suspected battery", leaving trade unset.
          f.untagged("Car won't start, suspected battery", "me car wont start"),
        ],
        note: "Out of scope — automotive. No trade, should NOT emit ROM.",
      },
      {
        message: "cant ya just come have a look",
        facts: [],
        note: "Pressure to take the job — bot should decline gracefully",
      },
    ],
  },

  {
    name: "Maz, 33",
    persona: "wasp nest in eaves — ambiguous trade, urgent-ish",
    turns: [
      {
        message: "theres a wasp nest up in the eaves near the front door, kids are freaking out",
        facts: [
          // Not a handyman job strictly — pest control. Could be general
          // if done DIY with a can of surfex. An honest extractor either
          // leaves trade blank or tags general with low confidence.
          f.trade("general", 0.5, "wasp nest in the eaves"),
          f.dim("access", "ladder", 0.85, "up in the eaves"),
          f.dim("surface", "exterior", 0.9, "eaves"),
        ],
        note: "Ambiguous trade (handyman vs pest control) — low confidence should suppress a confident ROM",
      },
    ],
  },

  {
    name: "Gazza, 48",
    persona: "emergency — tree fell on carport in last night's storm",
    turns: [
      {
        message: "tree came down on me carport last night, crushed one end, leaning over the car",
        facts: [
          // Structural damage + urgency. Should signal needs_site_visit
          // at the conversationStateManager level. Trade is carpentry
          // for the carport repair but scale is unknowable without a
          // visit.
          f.trade("carpentry", 0.85, "carport crushed, tree down"),
          f.dim("work_type", "repair", 0.9, "crushed"),
          f.dim("access", "difficult", 0.8, "tree leaning over car"),
          f.dim("surface", "exterior", 0.9, "carport"),
          f.dim("quantity_signal", "large_batch", 0.7, "one end crushed"),
        ],
        note: "Emergency + structural damage — should flag site-visit regardless of ROM value",
      },
    ],
  },

  {
    name: "Rhonda, 58",
    persona: "letterbox blown over + a few odd jobs, chatty",
    turns: [
      {
        message: "the wind blew me letterbox clean over in the storm, pole n all, and while im at it there's a few bits n bobs around the place — a door handle, a loose shelf, maybe a bit of caulk round the bath",
        facts: [
          f.trade("general", 0.9, "letterbox + odd jobs list"),
          f.dim("work_type", "repair", 0.85, "blown over, loose, caulk"),
          f.dim("quantity_signal", "large_batch", 0.8, "letterbox + a few bits n bobs"),
          f.dim("surface", "mixed", 0.8, "letterbox outdoor + bath indoor"),
        ],
        note: "Several one-offs — general trade, should probably land half_day or full_day",
      },
      {
        message: "oh i forgot — also the clothesline wire snapped last week, me granddaughter hit it with a ball",
        facts: [
          // Adds another item. Keeps quantity=large_batch, work_type=repair.
          // Should be a no-op amendment (same shape of job).
        ],
        note: "Scope add — quantity already large_batch, band shouldn't move",
      },
    ],
  },

  {
    name: "Frank, 71",
    persona: "sagging ceiling — structural hazard signal, should route to site visit",
    turns: [
      {
        message: "me ceilings got a sag in it near the bathroom, bit of a brown mark too",
        facts: [
          f.trade("general", 0.55, "sagging ceiling"),
          // The "sag" + "brown mark" combo is the hazard-keyword
          // combination that conversationStateManager.detectNeedsSiteVisit
          // is supposed to catch. A good extractor flags material
          // condition as damaged.
          f.dim("work_type", "inspect", 0.85, "got a sag"),
        ],
        note: "Structural hazard — needsSiteVisit should fire upstream; estimator should NOT confidently quote",
      },
    ],
  },

  {
    name: "Mike, 41",
    persona: "assemble 4 IKEA flatpacks",
    turns: [
      {
        message: "need 4 ikea flatpacks done — a wardrobe, a bookshelf, a desk and a bed frame",
        facts: [
          f.trade("general", 0.95, "4 ikea flatpacks"),
          f.dim("work_type", "install", 0.9, "assemble, done"),
          f.dim("quantity_signal", "large_batch", 0.9, "4 flatpacks"),
          f.dim("room_count", "4", 0.7, "wardrobe, bookshelf, desk, bed frame"),
          // "room_count" is a bit of a stretch for flatpacks (they're not
          // rooms) but it's how the harness fakes item-count flowing into
          // the estimator. Real extractor would probably tag
          // quantity_signal only.
        ],
        note: "Flatpack batch — general + large_batch should land full_day",
      },
    ],
  },

  {
    name: "Sonia, 67",
    persona: "haggler from turn 1",
    turns: [
      {
        message: "whats the cheapest you can do a front door lock change for",
        facts: [
          f.trade("doors_windows", 0.9, "front door lock change"),
          f.dim("work_type", "replace", 0.9, "change"),
          f.dim("quantity_signal", "single", 0.95, "a front door"),
          // Price-focused signal carried through `extraction.customerToneSignal`
          // in the real pipeline, not through taggedFacts. The estimator
          // doesn't see price focus directly — conversationStateManager
          // does via `isVagueHourlySeeker` logic.
        ],
        note: "Price-focused opener — chatService should detect 'cheap'-first tone and not race to quote",
      },
    ],
  },

  {
    name: "Ahmed, 29",
    persona: "non-native English, minimal prose",
    turns: [
      {
        message: "hello. window not close. rain enter. need fix asap.",
        facts: [
          f.trade("doors_windows", 0.9, "window not close"),
          f.dim("work_type", "repair", 0.9, "need fix"),
          f.dim("quantity_signal", "single", 0.85, "window"),
          // Urgency is an `extraction.urgency` field, not a tagged dim —
          // flows through the regular extraction payload.
        ],
        note: "Terse + non-native. Short sentences should still produce a clean ROM for a window repair.",
      },
    ],
  },

  {
    name: "Trevor, 84",
    persona: "lonely + rambling, simple job buried in grief",
    turns: [
      {
        message: "well since me wife passed last year ive been meanin to sort a few things. the garden's overgrown, the grass is knee high, nothin been done in a while. i used to do it all meself but me back won't let me anymore",
        facts: [
          f.trade("gardening", 0.9, "garden's overgrown, grass knee high"),
          f.dim("work_type", "repair", 0.7, "tidy-up"),
          f.dim("quantity_signal", "large_batch", 0.8, "garden's overgrown"),
          f.untagged("Widowed, physically limited — context for tone", "since me wife passed"),
        ],
        note: "Grief-adjacent context shouldn't break extraction. Tone handling is chat-LLM's job.",
      },
    ],
  },

  {
    name: "Kim, 39",
    persona: "'my electrician said to call you' — wrong trade from the jump",
    turns: [
      {
        message: "my sparky said you'd be the one to fix the ducting under the sink, he doesnt do plumbing",
        facts: [
          f.trade("plumbing", 0.9, "ducting under the sink"),
          f.dim("work_type", "repair", 0.85, "fix"),
          f.dim("access", "ladder", 0.3, "under the sink"),
          // "under the sink" is cramped-access but not ladder. Testing
          // that off-target access values don't break the pipeline.
        ],
        note: "Customer used wrong terminology ('ducting' for plumbing). Extractor corrects it.",
      },
    ],
  },

  {
    name: "Bec, 45",
    persona: "bundled multi-trade — dishwasher + tap + light fitting, all at once",
    turns: [
      {
        message: "need a dishwasher installed, kitchen tap replaced, and a new pendant light over the island",
        facts: [
          // Three distinct trades in one turn. Extractor picks the
          // dominant one or tags all three. We test the "mixed trades"
          // boundary: what band does the estimator land on when the LLM
          // flip-flops between trades mid-conversation?
          f.trade("plumbing", 0.8, "dishwasher installed, kitchen tap"),
          f.dim("work_type", "install", 0.9, "installed, replaced, new"),
          f.dim("quantity_signal", "small_batch", 0.85, "3 items"),
          f.dim("surface", "interior", 0.85, "kitchen"),
        ],
        note: "Multi-trade bundle — real pipeline's jobPivot guard should spawn separate jobs. Harness can't test that.",
      },
    ],
  },
];

// ── Pretty printer ────────────────────────────────────────────────────────

function banner(s: string): void {
  console.log("\n" + "═".repeat(78));
  console.log("  " + s);
  console.log("═".repeat(78));
}

function rule(ch = "─"): void {
  console.log(ch.repeat(78));
}

function formatInstrument(inst: RomInstrument | null): string {
  if (!inst) return "(none)";
  const superPart = inst.supersedes ? ` ⟵ supersedes ${inst.supersedes.slice(0, 24)}…` : "";
  return (
    `  band=${inst.band} r${inst.revision} conf=${inst.confidence}\n` +
    `  $${inst.costMin}–$${inst.costMax} | ${inst.hoursMin}–${inst.hoursMax}h | ${inst.labourOnly ? "labour-only" : "all-in"}${superPart}\n` +
    `  reason: ${inst.reason}`
  );
}

function formatPatches(patches: ReadonlyArray<EstimatorPatch>): string {
  const kinds = patches.map((p) => p.kind).join(" → ");
  return `  patches: ${kinds}`;
}

function formatState(state: EstimatorState): string {
  return (
    `  state: trade=${state.trade ?? "∅"} | surface=${state.surface} | prep=${state.prepLevel} | ` +
    `dwelling=${state.dwellingType} | access=${state.access} | qty=${state.quantity} ` +
    `| rooms=${state.roomCount ?? "∅"} | phase=${state.phase} | v=${state.version} | amend=${state.amendmentCount}`
  );
}

function formatNextQ(state: EstimatorState): string {
  const q = pickNextQuestion(state);
  if (!q) return "  next: (nothing — ready to present/close)";
  return `  next: ask about "${q.slot}" — "${q.question}"`;
}

// ── Runner ────────────────────────────────────────────────────────────────

interface Flag {
  persona: string;
  turn: number;
  severity: "warn" | "fail";
  message: string;
}

const flags: Flag[] = [];

function flag(persona: string, turn: number, severity: "warn" | "fail", msg: string): void {
  flags.push({ persona, turn, severity, message: msg });
}

/** Sanity checks applied after each turn — surfaces weird outcomes
 *  automatically instead of me eyeballing everything. Deliberately
 *  coarse; these are smells not truth. */
function checkTurn(
  personaName: string,
  turnNo: number,
  turn: Turn,
  state: EstimatorState,
  instrument: RomInstrument | null,
  priorInstrument: RomInstrument | null,
  isLast: boolean,
): void {
  void isLast;
  // 1. ROM emitted when no trade was tagged (should be impossible).
  if (instrument && !state.trade) {
    flag(personaName, turnNo, "fail", "ROM emitted with no trade in state");
  }

  // 2. ROM > $3000 on what looks like a tiny job. Tiny = single quantity
  //    + short message (< 60 chars). Catches the "tin shed" / "a picture"
  //    case landing in multi_day.
  if (
    instrument &&
    instrument.costMin > 3000 &&
    state.quantity === "single" &&
    turn.message.length < 60
  ) {
    flag(
      personaName,
      turnNo,
      "warn",
      `ROM min $${instrument.costMin} seems high for a single-item short-prompt job`,
    );
  }

  // 3. No trade established by turn 3+ when customer was clearly asking
  //    for something. Suggests extractor is too hedging.
  if (!state.trade && turnNo >= 3) {
    flag(
      personaName,
      turnNo,
      "warn",
      "No trade tagged after 3+ turns — possibly out-of-scope or over-cautious extraction",
    );
  }

  // 4. Amendment fired but band + costs barely moved — detector is
  //    over-sensitive. Compares against the PRIOR instrument (not
  //    state.lastInstrument, which has already been updated).
  if (
    instrument?.supersedes &&
    priorInstrument &&
    priorInstrument.band === instrument.band
  ) {
    const priorMid = (priorInstrument.costMin + priorInstrument.costMax) / 2;
    const newMid = (instrument.costMin + instrument.costMax) / 2;
    if (Math.abs(newMid - priorMid) < 100) {
      flag(
        personaName,
        turnNo,
        "warn",
        `Amendment fired but costs barely moved (${instrument.band} both sides, Δ$${Math.round(Math.abs(newMid - priorMid))}) — over-sensitive detector?`,
      );
    }
  }
}

function runPersona(p: Persona): void {
  banner(`${p.name}  —  ${p.persona}`);

  let state = emptyEstimatorState();
  let lastInstrument: RomInstrument | null = null;
  let turnNo = 0;

  for (const turn of p.turns) {
    turnNo++;
    const isLast = turnNo === p.turns.length;
    console.log(`\n── Turn ${turnNo} ─────────────────────────────────────────`);
    console.log(`CUSTOMER: "${turn.message}"`);
    if (turn.note) console.log(`(test intent: ${turn.note})`);
    console.log("");

    const result = runEstimatorTurn(state, turn.facts, turn.message, {
      policy: DEFAULT_PRICING_POLICY,
      multipliers: IDENTITY_MULTIPLIERS, // no Paskian data — this is the fresh-install case
      anchor: anchorForMessage(`msg-${p.name}-${turnNo}`, turn.message),
    });

    console.log(formatPatches(result.patches));
    console.log(formatState(result.state));
    console.log("  ROM:");
    console.log(formatInstrument(result.instrument));
    console.log(formatNextQ(result.state));

    // Diff check: did the ROM change from last turn?
    if (result.instrument && lastInstrument && result.instrument.id !== lastInstrument.id) {
      if (result.instrument.supersedes === lastInstrument.id) {
        console.log("  AMENDMENT FIRED ✓");
      } else {
        console.log("  new instrument (not an amendment)");
      }
    }

    checkTurn(p.name, turnNo, turn, result.state, result.instrument, lastInstrument, isLast);

    state = result.state;
    if (result.instrument) lastInstrument = result.instrument;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

banner("ADVERSARIAL INTAKE — deterministic-pipeline only, no LLM, no DB");
for (const p of personas) runPersona(p);

banner("FLAG SUMMARY");
if (flags.length === 0) {
  console.log("No flags raised.");
} else {
  const fails = flags.filter((f) => f.severity === "fail");
  const warns = flags.filter((f) => f.severity === "warn");
  console.log(`${fails.length} fail(s), ${warns.length} warn(s):\n`);
  for (const f of flags) {
    const tag = f.severity === "fail" ? "FAIL" : "warn";
    console.log(`  [${tag}]  ${f.persona} turn ${f.turn} — ${f.message}`);
  }
}

rule("═");
console.log(`Ran ${personas.length} personas through runEstimatorTurn.`);
console.log("For real extraction-quality tests, use scripts/field-simulation.ts which");
console.log("hits Anthropic + the real pipeline end-to-end.");
