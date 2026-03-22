/**
 * Effort Band Service
 *
 * Infers the effort band from job scope signals.
 * Biases toward the upper realistic band — better to over-estimate
 * and come in under than surprise a customer.
 */

export type EffortBand =
  | "quick"        // < 1 hour
  | "short"        // 1–2 hours
  | "quarter_day"  // 2–3 hours
  | "half_day"     // 3–5 hours
  | "full_day"     // 5–8 hours
  | "multi_day"    // > 1 day
  | "unknown";

export interface EffortSignals {
  jobType: string | null;
  subcategory?: string | null;
  quantity?: string | null;
  scopeDescription?: string | null;
  materials?: string | null;
  accessDifficulty?: string | null;
}

interface BandRule {
  band: EffortBand;
  keywords: string[];
}

/**
 * Keyword-to-band mapping per job type.
 * When multiple match, we pick the highest (longest) band.
 */
const JOB_TYPE_RULES: Record<string, BandRule[]> = {
  doors_windows: [
    { band: "short", keywords: ["adjust", "lock", "handle", "latch", "hinge"] },
    { band: "half_day", keywords: ["1 door", "single door", "one door", "dog door", "pet door"] },
    { band: "full_day", keywords: ["2 door", "two door", "3 door", "three door", "frame", "mortise", "hung", "paint"] },
    { band: "multi_day", keywords: ["4 door", "four door", "5 door", "five door", "multiple", "all door", "whole house", "renovation", "custom", "window", "sliding"] },
  ],
  carpentry: [
    { band: "short", keywords: ["shelf", "bracket", "small repair"] },
    { band: "quarter_day", keywords: ["shelving", "patch", "board", "minor"] },
    { band: "half_day", keywords: ["deck repair", "railing", "balustrade", "stair", "cabinet"] },
    { band: "full_day", keywords: ["deck", "pergola", "carport", "cupboard", "kitchen", "install"] },
    { band: "multi_day", keywords: ["build deck", "new deck", "renovation", "extension", "full kitchen"] },
  ],
  fencing: [
    { band: "quarter_day", keywords: ["gate", "1 post", "single post", "latch", "repair"] },
    { band: "half_day", keywords: ["section", "panel", "3m", "4m", "5m", "6m", "few metres"] },
    { band: "full_day", keywords: ["10m", "15m", "side fence", "boundary"] },
    { band: "multi_day", keywords: ["full fence", "whole yard", "20m", "30m", "perimeter"] },
  ],
  painting: [
    { band: "short", keywords: ["touch up", "patch", "small area"] },
    { band: "quarter_day", keywords: ["1 room", "one room", "single room", "feature wall"] },
    { band: "half_day", keywords: ["2 room", "two room", "bathroom", "laundry"] },
    { band: "full_day", keywords: ["3 room", "three room", "4 room", "exterior", "outside"] },
    { band: "multi_day", keywords: ["whole house", "full interior", "full exterior", "all room"] },
  ],
  plumbing: [
    { band: "quick", keywords: ["washer", "drip", "aerator"] },
    { band: "short", keywords: ["tap", "faucet", "toilet seat", "unblock", "drain"] },
    { band: "quarter_day", keywords: ["toilet", "cistern", "mixer", "shower head"] },
    { band: "half_day", keywords: ["hot water", "pipe", "vanity", "basin"] },
    { band: "full_day", keywords: ["bathroom", "kitchen plumbing", "reroute"] },
  ],
  tiling: [
    { band: "quarter_day", keywords: ["repair", "replace tile", "crack", "grout"] },
    { band: "half_day", keywords: ["splash back", "splashback", "small area"] },
    { band: "full_day", keywords: ["bathroom floor", "laundry", "shower"] },
    { band: "multi_day", keywords: ["full bathroom", "kitchen floor", "outdoor"] },
  ],
  roofing: [
    { band: "quarter_day", keywords: ["leak", "single tile", "ridge cap"] },
    { band: "half_day", keywords: ["flashing", "few tiles", "gutter", "valley"] },
    { band: "full_day", keywords: ["section", "roof repair", "whirlybird"] },
    { band: "multi_day", keywords: ["re-roof", "full roof", "roof replacement"] },
  ],
  electrical: [
    { band: "quick", keywords: ["light globe", "bulb"] },
    { band: "short", keywords: ["power point", "switch", "dimmer"] },
    { band: "quarter_day", keywords: ["light fitting", "fan", "downlight"] },
    { band: "half_day", keywords: ["circuit", "safety switch", "multiple light"] },
    { band: "full_day", keywords: ["rewire", "switchboard", "full house"] },
  ],
  general: [
    { band: "quick", keywords: ["hang", "picture", "curtain rod"] },
    { band: "short", keywords: ["assemble", "flatpack", "ikea", "mount tv"] },
    { band: "quarter_day", keywords: ["odd jobs", "few things", "handyman list"] },
    { band: "half_day", keywords: ["several", "multiple", "list of"] },
    { band: "full_day", keywords: ["full day", "big list", "many jobs"] },
  ],
  gardening: [
    { band: "short", keywords: ["mow", "edge", "small garden"] },
    { band: "quarter_day", keywords: ["hedge", "prune", "weed"] },
    { band: "half_day", keywords: ["garden bed", "mulch", "clean up"] },
    { band: "full_day", keywords: ["landscaping", "retaining wall", "full yard"] },
  ],
  cleaning: [
    { band: "short", keywords: ["small clean", "window", "pressure wash small"] },
    { band: "quarter_day", keywords: ["pressure wash", "driveway"] },
    { band: "half_day", keywords: ["house wash", "roof clean", "gutter clean"] },
    { band: "full_day", keywords: ["full property", "end of lease"] },
  ],
};

const BAND_ORDER: EffortBand[] = [
  "quick", "short", "quarter_day", "half_day", "full_day", "multi_day",
];

/**
 * Parse a quantity string and bump the band if the count is high.
 */
function quantityBump(quantity: string | null | undefined): number {
  if (!quantity) return 0;
  const match = quantity.match(/(\d+)/);
  if (!match) return 0;
  const n = parseInt(match[1], 10);
  if (n >= 10) return 2;
  if (n >= 5) return 1;
  return 0;
}

/**
 * Access difficulty adds time.
 */
function accessBump(difficulty: string | null | undefined): number {
  if (!difficulty) return 0;
  if (difficulty === "scaffolding_required") return 2;
  if (difficulty === "difficult_access") return 1;
  if (difficulty === "ladder_required") return 1;
  return 0;
}

/**
 * Cure/dry/set time bump — jobs that involve waiting (paint drying, concrete
 * curing, adhesive setting, plaster drying, render curing) take significantly
 * longer than active labour time suggests. A 3-hour paint job with 2 coats
 * is really a full day. Concrete post footings means you can't rail up same day.
 *
 * This is the single biggest source of underestimation — the effort band
 * only counts hands-on time, but the customer is paying for elapsed time.
 */
function cureTimeBump(jobType: string | null, searchText: string): number {
  // Painting: 2 coats, drying, primer — always adds significant wait time
  if (jobType === "painting" || /\bpaint|primer|undercoat|\bcoat|stain|lacquer|varnish/.test(searchText)) {
    // Multiple coats explicitly mentioned = guaranteed wait time
    if (/two coat|2 coat|three coat|3 coat|multiple coat|second coat/.test(searchText)) {
      return 2; // Big bump — drying between coats is half the job time
    }
    // Any painting = at least 1 bump (prep + coat + likely second coat)
    return 1;
  }

  // Concrete/cement: curing time, can't work on it same day
  if (/concret|cement|footing|post.?hole|\bpour/.test(searchText)) {
    return 1; // Often means return visit
  }

  // Plastering/rendering: apply, dry, sand/finish — multi-stage
  if (/plaster|render|skim.?coat|gyproc|cornic|patch.*wall|filler/.test(searchText)) {
    return 1;
  }

  // Tiling: adhesive set time before grouting
  if (jobType === "tiling" || /\btil(e|ing)|grout|adhesive/.test(searchText)) {
    if (/grout|full.*til|bathroom|shower|floor/.test(searchText)) {
      return 1; // Adhesive set + grout = 2 stages
    }
  }

  // Fencing with new posts: concrete footings need to cure
  if (jobType === "fencing" && /new post|replace post|post.*concret|set.*post/.test(searchText)) {
    return 1;
  }

  // Epoxy, resin, gap filler — anything that needs to cure
  if (/epoxy|resin|gap.?fill|silicon|sealant|bog/.test(searchText)) {
    return 1;
  }

  return 0;
}

/**
 * Bump band up by N steps, capped at multi_day.
 */
function bumpBand(band: EffortBand, steps: number): EffortBand {
  const idx = BAND_ORDER.indexOf(band);
  if (idx === -1) return band;
  const newIdx = Math.min(idx + steps, BAND_ORDER.length - 1);
  return BAND_ORDER[newIdx];
}

/**
 * Infer effort band from job scope signals.
 * Returns the band and a short reasoning string.
 */
export function inferEffortBand(signals: EffortSignals): {
  band: EffortBand;
  reason: string;
} {
  const jobType = signals.jobType || "general";
  const rules = JOB_TYPE_RULES[jobType] || JOB_TYPE_RULES["general"];

  // Build search text from all signals
  const searchText = [
    signals.scopeDescription,
    signals.quantity,
    signals.materials,
    signals.subcategory,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!searchText) {
    return { band: "unknown", reason: "Not enough scope detail to estimate effort" };
  }

  // Find highest matching band
  let matchedBand: EffortBand = "unknown";
  let matchedKeyword = "";

  for (const rule of rules) {
    for (const kw of rule.keywords) {
      if (searchText.includes(kw.toLowerCase())) {
        const ruleIdx = BAND_ORDER.indexOf(rule.band);
        const currentIdx = BAND_ORDER.indexOf(matchedBand);
        if (ruleIdx > currentIdx) {
          matchedBand = rule.band;
          matchedKeyword = kw;
        }
      }
    }
  }

  if (matchedBand === "unknown") {
    if (searchText.length > 20) {
      // No keyword match but we have a description — default to half_day
      // but still apply cure/dry time bumps since those are scope-aware
      const cBump = cureTimeBump(signals.jobType, searchText);
      const defaultBand = cBump > 0 ? bumpBand("half_day", cBump) : "half_day" as EffortBand;
      const note = cBump > 0
        ? `Defaulting to half-day for ${jobType}, adjusted to ${defaultBand} (cure/dry time bump +${cBump})`
        : `Defaulting to half-day for ${jobType} — not enough specifics to narrow down`;
      return { band: defaultBand, reason: note };
    }
    return { band: "unknown", reason: "Not enough scope detail to estimate effort" };
  }

  // Apply bumps
  const qBump = quantityBump(signals.quantity);
  const aBump = accessBump(signals.accessDifficulty);
  const cBump = cureTimeBump(signals.jobType, searchText);
  const totalBump = qBump + aBump + cBump;

  const finalBand = totalBump > 0 ? bumpBand(matchedBand, totalBump) : matchedBand;

  const bumpNotes = [];
  if (qBump > 0) bumpNotes.push(`quantity bump +${qBump}`);
  if (aBump > 0) bumpNotes.push(`access bump +${aBump}`);
  if (cBump > 0) bumpNotes.push(`cure/dry time bump +${cBump}`);

  const reason = totalBump > 0
    ? `Matched "${matchedKeyword}" → ${matchedBand}, adjusted to ${finalBand} (${bumpNotes.join(", ")})`
    : `Matched "${matchedKeyword}" → ${finalBand}`;

  return { band: finalBand, reason };
}
