import { z } from "zod";

/**
 * Schema for what the LLM extracts from each customer message.
 * This is incremental — fields can be null if not mentioned.
 * Each extraction is merged into the running job state.
 *
 * Sprint 3: Added confidence levels, tone signals, estimate reaction,
 * repair/replace classification, and contact readiness.
 */
/**
 * Helper: lenient enum that falls back to null if the LLM returns an unexpected value.
 * This prevents a single bad field from blowing up the entire extraction.
 */
function lenientEnum<T extends [string, ...string[]]>(values: T) {
  return z
    .string()
    .nullable()
    .default(null)
    .transform((val) => {
      if (val === null) return null;
      return (values as readonly string[]).includes(val) ? (val as T[number]) : null;
    });
}

/**
 * Helper: lenient enum with a non-null default for required fields.
 */
function lenientEnumWithDefault<T extends [string, ...string[]]>(values: T, defaultVal: T[number]) {
  return z
    .string()
    .default(defaultVal)
    .transform((val) => {
      return (values as readonly string[]).includes(val) ? (val as T[number]) : defaultVal;
    });
}

export const JOB_TYPE_VALUES = [
  "carpentry", "plumbing", "electrical", "painting", "general",
  "fencing", "tiling", "roofing", "doors_windows", "gardening",
  "cleaning", "other",
] as const;

export const messageExtractionSchema = z.object({
  // Customer details (extracted if mentioned)
  customerName: z.string().nullable().default(null),
  customerPhone: z.string().nullable().default(null),
  customerEmail: z.string().nullable().default(null),

  // Location
  suburb: z.string().nullable().default(null),
  locationClue: z.string().nullable().default(null),
  address: z.string().nullable().default(null),
  postcode: z.string().nullable().default(null),
  accessNotes: z.string().nullable().default(null),

  // Job scope — all enums are lenient to survive unexpected LLM values
  jobType: lenientEnum(JOB_TYPE_VALUES as unknown as [string, ...string[]]),
  jobTypeConfidence: lenientEnum(["certain", "likely", "guess"]),
  jobSubcategory: z.string().nullable().default(null),
  repairReplaceSignal: lenientEnum(["repair", "replace", "install", "inspect", "unclear"]),
  scopeDescription: z.string().nullable().default(null),
  quantity: z.string().nullable().default(null),
  materials: z.string().nullable().default(null),
  materialCondition: z.string().nullable().default(null),
  accessDifficulty: lenientEnum(["ground_level", "ladder_required", "scaffolding_required", "difficult_access"]),
  photosReferenced: z.boolean().nullable().default(null),

  // Urgency
  urgency: lenientEnum(["emergency", "urgent", "next_week", "next_2_weeks", "flexible", "when_convenient", "unspecified"]),

  // Customer signals — Sprint 3 enriched
  estimateReaction: lenientEnum(["accepted", "tentative", "uncertain", "pushback", "rejected", "wants_exact_price", "rate_shopping", "unclear"]),
  budgetReaction: lenientEnum(["accepted", "ok", "unsure", "expensive", "cheap", "wants_hourly", "wants_guarantee"]),
  customerToneSignal: lenientEnum(["friendly", "practical", "demanding", "suspicious", "price_focused", "vague", "impatient"]),
  micromanagerSignals: z.boolean().nullable().default(null),
  cheapestMindset: z.boolean().nullable().default(null),
  clarityScore: lenientEnum(["very_clear", "clear", "vague", "confused"]),
  contactReadiness: lenientEnum(["offered", "willing", "reluctant", "refused"]),

  // Conversation state
  isComplete: z.boolean().default(false),
  missingInfo: z.array(z.string()).default([]),
  conversationPhase: lenientEnumWithDefault([
    "greeting",
    "describing_job",
    "providing_details",
    "providing_location",
    "providing_contact",
    "reviewing_estimate",
    "confirmed",
    "disengaged",
  ], "greeting"),
});

export type MessageExtraction = z.infer<typeof messageExtractionSchema>;

/**
 * Schema for accumulated job state built from multiple extractions.
 * Sprint 3: Added scoring fields, estimate ack details, and sub-completeness.
 */
export const accumulatedJobStateSchema = z.object({
  customerName: z.string().nullable().default(null),
  customerPhone: z.string().nullable().default(null),
  customerEmail: z.string().nullable().default(null),
  suburb: z.string().nullable().default(null),
  locationClue: z.string().nullable().default(null),
  address: z.string().nullable().default(null),
  postcode: z.string().nullable().default(null),
  accessNotes: z.string().nullable().default(null),
  jobType: z.string().nullable().default(null),
  jobTypeConfidence: z.string().nullable().default(null),
  jobSubcategory: z.string().nullable().default(null),
  repairReplaceSignal: z.string().nullable().default(null),
  scopeDescription: z.string().nullable().default(null),
  quantity: z.string().nullable().default(null),
  materials: z.string().nullable().default(null),
  materialCondition: z.string().nullable().default(null),
  accessDifficulty: z.string().nullable().default(null),
  photosReferenced: z.boolean().nullable().default(null),
  urgency: z.string().nullable().default(null),

  // Customer signals
  estimateReaction: z.string().nullable().default(null),
  budgetReaction: z.string().nullable().default(null),
  customerToneSignal: z.string().nullable().default(null),
  micromanagerSignals: z.boolean().nullable().default(null),
  cheapestMindset: z.boolean().nullable().default(null),
  clarityScore: z.string().nullable().default(null),
  contactReadiness: z.string().nullable().default(null),

  // Conversation state
  conversationPhase: z.string().default("greeting"),
  missingInfo: z.array(z.string()).default([]),

  // Scores (computed, not extracted)
  completenessScore: z.number().default(0),
  scopeClarity: z.number().default(0),       // 0-100 sub-score
  locationClarity: z.number().default(0),     // 0-100 sub-score
  contactReadinessScore: z.number().default(0), // 0-100 sub-score
  estimateReadiness: z.number().default(0),   // 0-100 sub-score
  decisionReadiness: z.number().default(0),   // 0-100 sub-score

  // Estimate acknowledgement
  estimatePresented: z.boolean().default(false),
  estimateAcknowledged: z.boolean().default(false),
  estimateAckStatus: z
    .enum(["accepted", "tentative", "uncertain", "pushback", "rejected", "wants_exact_price", "rate_shopping", "unclear", "pending"])
    .default("pending"),
  estimateAckMessageId: z.string().nullable().default(null),
  estimateAckTimestamp: z.string().nullable().default(null),

  // Scoring (set by scoring services)
  customerFitScore: z.number().nullable().default(null),
  customerFitLabel: z.string().nullable().default(null),
  quoteWorthinessScore: z.number().nullable().default(null),
  quoteWorthinessLabel: z.string().nullable().default(null),

  // Recommendation
  recommendation: z.string().nullable().default(null),
  recommendationReason: z.string().nullable().default(null),
});

export type AccumulatedJobState = z.infer<typeof accumulatedJobStateSchema>;

/**
 * Merge a new extraction into the accumulated state.
 * Only non-null values from the new extraction overwrite.
 */
export function mergeExtraction(
  current: AccumulatedJobState,
  extraction: MessageExtraction
): AccumulatedJobState {
  const merged = { ...current };

  // Merge each field — only overwrite if new extraction has a non-null value
  if (extraction.customerName) merged.customerName = extraction.customerName;
  if (extraction.customerPhone) merged.customerPhone = extraction.customerPhone;
  if (extraction.customerEmail) merged.customerEmail = extraction.customerEmail;
  if (extraction.suburb) merged.suburb = extraction.suburb;
  if (extraction.locationClue) merged.locationClue = extraction.locationClue;
  if (extraction.address) merged.address = extraction.address;
  if (extraction.postcode) merged.postcode = extraction.postcode;
  if (extraction.accessNotes) merged.accessNotes = extraction.accessNotes;
  if (extraction.jobType) {
    merged.jobType = extraction.jobType;
    merged.jobTypeConfidence = extraction.jobTypeConfidence;
  }
  if (extraction.jobSubcategory) merged.jobSubcategory = extraction.jobSubcategory;
  if (extraction.repairReplaceSignal) merged.repairReplaceSignal = extraction.repairReplaceSignal;
  if (extraction.scopeDescription) {
    // Append scope description rather than replace
    merged.scopeDescription = merged.scopeDescription
      ? `${merged.scopeDescription}. ${extraction.scopeDescription}`
      : extraction.scopeDescription;
  }
  if (extraction.quantity) merged.quantity = extraction.quantity;
  if (extraction.materials) merged.materials = extraction.materials;
  if (extraction.materialCondition) merged.materialCondition = extraction.materialCondition;
  if (extraction.accessDifficulty) merged.accessDifficulty = extraction.accessDifficulty;
  if (extraction.photosReferenced !== null) merged.photosReferenced = extraction.photosReferenced;
  if (extraction.urgency) merged.urgency = extraction.urgency;

  // Customer signals — accumulate, don't overwrite frivolously
  if (extraction.estimateReaction) merged.estimateReaction = extraction.estimateReaction;
  if (extraction.budgetReaction) merged.budgetReaction = extraction.budgetReaction;
  if (extraction.customerToneSignal) merged.customerToneSignal = extraction.customerToneSignal;
  if (extraction.micromanagerSignals !== null) merged.micromanagerSignals = extraction.micromanagerSignals;
  if (extraction.cheapestMindset !== null) merged.cheapestMindset = extraction.cheapestMindset;
  if (extraction.clarityScore) merged.clarityScore = extraction.clarityScore;
  if (extraction.contactReadiness) merged.contactReadiness = extraction.contactReadiness;

  merged.conversationPhase = extraction.conversationPhase;
  merged.missingInfo = extraction.missingInfo;

  // Recalculate completeness sub-scores and total
  const sub = calculateSubScores(merged);
  merged.scopeClarity = sub.scopeClarity;
  merged.locationClarity = sub.locationClarity;
  merged.contactReadinessScore = sub.contactReadiness;
  merged.estimateReadiness = sub.estimateReadiness;
  merged.decisionReadiness = sub.decisionReadiness;
  merged.completenessScore = sub.total;

  return merged;
}

/**
 * Sub-score calculations for completeness dimensions.
 */
interface SubScores {
  scopeClarity: number;
  locationClarity: number;
  contactReadiness: number;
  estimateReadiness: number;
  decisionReadiness: number;
  total: number;
}

function calculateSubScores(state: AccumulatedJobState): SubScores {
  // Scope clarity (0-100)
  let scopeClarity = 0;
  if (state.scopeDescription) scopeClarity += 35;
  if (state.jobType) scopeClarity += 15;
  if (state.repairReplaceSignal && state.repairReplaceSignal !== "unclear") scopeClarity += 10;
  if (state.quantity) scopeClarity += 15;
  if (state.materials) scopeClarity += 10;
  if (state.accessDifficulty) scopeClarity += 5;
  if (state.photosReferenced) scopeClarity += 5;
  if (state.urgency && state.urgency !== "unspecified") scopeClarity += 5;
  scopeClarity = Math.min(100, scopeClarity);

  // Location clarity (0-100)
  let locationClarity = 0;
  if (state.suburb) locationClarity += 60;
  if (state.locationClue && !state.suburb) locationClarity += 20;
  if (state.address) locationClarity += 25;
  if (state.postcode) locationClarity += 10;
  if (state.accessNotes) locationClarity += 5;
  locationClarity = Math.min(100, locationClarity);

  // Contact readiness (0-100)
  let contactReadiness = 0;
  if (state.customerName) contactReadiness += 30;
  if (state.customerPhone) contactReadiness += 40;
  if (state.customerEmail) contactReadiness += 30;
  contactReadiness = Math.min(100, contactReadiness);

  // Estimate readiness — can we give a ROM? (0-100)
  let estimateReadiness = 0;
  if (state.scopeDescription) estimateReadiness += 30;
  if (state.jobType) estimateReadiness += 20;
  if (state.suburb) estimateReadiness += 20;
  if (state.quantity) estimateReadiness += 15;
  if (state.materials || state.materialCondition) estimateReadiness += 10;
  if (state.accessDifficulty) estimateReadiness += 5;
  estimateReadiness = Math.min(100, estimateReadiness);

  // Decision readiness — can Todd act on this? (0-100)
  let decisionReadiness = 0;
  if (state.estimatePresented) decisionReadiness += 15;
  if (state.estimateAcknowledged) decisionReadiness += 20;
  if (state.estimateAckStatus === "accepted" || state.estimateAckStatus === "tentative") decisionReadiness += 10;
  if (state.customerFitScore !== null) decisionReadiness += 10;
  if (state.quoteWorthinessScore !== null) decisionReadiness += 10;
  if (scopeClarity >= 50) decisionReadiness += 15;
  if (locationClarity >= 60) decisionReadiness += 10;
  if (contactReadiness >= 30) decisionReadiness += 10;
  decisionReadiness = Math.min(100, decisionReadiness);

  // Overall completeness — weighted blend
  const total = Math.min(100, Math.round(
    scopeClarity * 0.30 +
    locationClarity * 0.15 +
    contactReadiness * 0.15 +
    estimateReadiness * 0.20 +
    decisionReadiness * 0.20
  ));

  return { scopeClarity, locationClarity, contactReadiness, estimateReadiness, decisionReadiness, total };
}
