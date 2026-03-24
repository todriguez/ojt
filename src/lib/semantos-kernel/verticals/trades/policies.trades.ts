/**
 * policies.trades.ts
 *
 * Trades-specific access policy templates.
 * Defines who can see/contribute/approve what in maintenance job scenarios.
 */

import type { RoleRule, AiContextFilter, OverrideHierarchy } from "../../policyEvaluator";
import { upsertPolicyTemplate } from "../../channelService";

// ─────────────────────────────────────────────
// Common building blocks
// ─────────────────────────────────────────────

const ESTIMATE_FIELDS = [
  "estimatedCostMin", "estimatedCostMax", "estimatedHoursMin", "estimatedHoursMax",
  "effortBand", "effortBandReason", "romConfidence", "labourOnly", "materialsNote",
  "customerFitScore", "customerFitLabel", "quoteWorthinessScore", "quoteWorthinessLabel",
  "recommendation", "recommendationReason",
];

const STANDARD_HIERARCHY: OverrideHierarchy = {
  ranks: ["observer", "contributor", "executor", "approver", "creator"],
  rules: {
    creator: { canOverride: ["contributor", "observer"], requiresApproval: [] },
    approver: { canOverride: ["creator", "contributor", "executor", "observer"], requiresApproval: [] },
    executor: { canOverride: [], requiresApproval: ["approver"] },
    contributor: { canOverride: [], requiresApproval: ["creator", "approver"] },
    observer: { canOverride: [], requiresApproval: [] },
  },
};

// ─────────────────────────────────────────────
// 1. Direct Homeowner — full access, single party
// ─────────────────────────────────────────────

const DIRECT_HOMEOWNER_ROLES: Record<string, RoleRule> = {
  creator: {
    fieldVisibility: {}, // empty = all visible
    contributionRights: {
      scope: "contribute",
      allowedEvidenceKinds: ["message", "image", "voice", "document"],
      allowedActions: ["*"],
    },
    selectionGates: {}, // empty = all participable
  },
  executor: {
    fieldVisibility: {},
    contributionRights: {
      scope: "contribute",
      allowedEvidenceKinds: ["message", "image", "voice", "document"],
      allowedActions: ["*"],
    },
    selectionGates: {},
  },
  default: {
    fieldVisibility: {},
    contributionRights: {
      scope: "contribute",
      allowedEvidenceKinds: ["message", "image", "voice", "document"],
      allowedActions: ["*"],
    },
    selectionGates: {},
  },
};

const DIRECT_HOMEOWNER_AI: AiContextFilter = {
  visibleFields: "*",
  redactedFields: [],
  systemPromptAdditions: [],
};

// ─────────────────────────────────────────────
// 2. REA Maintenance — Short-term tenant
//    Tenant can't see estimates or participate in product selection
// ─────────────────────────────────────────────

const REA_SHORT_TERM_ROLES: Record<string, RoleRule> = {
  creator: { // REA
    fieldVisibility: {},
    contributionRights: {
      scope: "contribute",
      allowedEvidenceKinds: ["message", "image", "document"],
      allowedActions: ["*"],
    },
    selectionGates: {},
  },
  contributor: { // Tenant
    fieldVisibility: Object.fromEntries(
      ESTIMATE_FIELDS.map((f) => [f, "hidden" as const])
    ),
    contributionRights: {
      scope: "contribute",
      allowedEvidenceKinds: ["message", "image", "voice"],
      allowedActions: ["submit_photo", "describe_scope", "provide_access"],
    },
    selectionGates: {}, // all blocked by default for short-term
  },
  approver: { // Landlord
    fieldVisibility: {},
    contributionRights: {
      scope: "approve",
      allowedEvidenceKinds: ["message"],
      allowedActions: ["approve_estimate", "reject_estimate", "set_budget"],
    },
    selectionGates: {},
  },
  executor: { // Todd
    fieldVisibility: {},
    contributionRights: {
      scope: "contribute",
      allowedEvidenceKinds: ["message", "image", "voice", "document"],
      allowedActions: ["*"],
    },
    selectionGates: {},
  },
};

const REA_SHORT_TERM_TENANT_AI: AiContextFilter = {
  visibleFields: [
    "customerName", "suburb", "address", "accessNotes",
    "jobType", "scopeDescription", "urgency", "quantity",
    "conversationPhase", "missingInfo",
  ],
  redactedFields: ESTIMATE_FIELDS,
  systemPromptAdditions: [
    "You are speaking with a tenant about a maintenance issue at their rental property.",
    "Do NOT discuss pricing, estimates, or costs — the property manager handles that.",
    "Focus on understanding the issue, getting photos, and confirming access arrangements.",
  ],
  toneOverrides: {
    formality: "casual",
    role: "Tenant liaison",
  },
};

// ─────────────────────────────────────────────
// 3. REA Maintenance — Long-term tenant
//    Tenant can see estimates and participate in product selection
// ─────────────────────────────────────────────

const REA_LONG_TERM_ROLES: Record<string, RoleRule> = {
  ...REA_SHORT_TERM_ROLES,
  contributor: { // Tenant — upgraded access
    fieldVisibility: {
      // Can see estimates but not internal scoring
      customerFitScore: "hidden",
      customerFitLabel: "hidden",
      quoteWorthinessScore: "hidden",
      quoteWorthinessLabel: "hidden",
      recommendation: "hidden",
      recommendationReason: "hidden",
    },
    contributionRights: {
      scope: "contribute",
      allowedEvidenceKinds: ["message", "image", "voice"],
      allowedActions: ["submit_photo", "describe_scope", "provide_access", "select_product"],
    },
    selectionGates: {}, // empty = all participable
  },
};

const REA_LONG_TERM_TENANT_AI: AiContextFilter = {
  visibleFields: "*",
  redactedFields: [
    "customerFitScore", "customerFitLabel",
    "quoteWorthinessScore", "quoteWorthinessLabel",
    "recommendation", "recommendationReason",
  ],
  systemPromptAdditions: [
    "You are speaking with a long-term tenant about maintenance at their rental.",
    "They can see rough pricing and participate in product/style selection.",
    "Be helpful with options but note that final approval may need to come from the property owner.",
  ],
  toneOverrides: {
    formality: "casual",
    role: "Tenant adviser",
  },
};

// ─────────────────────────────────────────────
// 4. REA with Landlord Approval
//    Landlord must approve budget before quote is committed
// ─────────────────────────────────────────────

const REA_LANDLORD_APPROVAL_ROLES: Record<string, RoleRule> = {
  ...REA_SHORT_TERM_ROLES,
  approver: { // Landlord — required approval
    fieldVisibility: {},
    contributionRights: {
      scope: "approve",
      allowedEvidenceKinds: ["message"],
      allowedActions: ["approve_estimate", "reject_estimate", "set_budget", "approve_product_selection"],
    },
    selectionGates: {},
  },
};

const REA_LANDLORD_APPROVAL_AI: AiContextFilter = {
  visibleFields: "*",
  redactedFields: [],
  systemPromptAdditions: [
    "You are speaking with the property owner about a maintenance job.",
    "They need to approve the budget before work can proceed.",
    "Present costs clearly and ask for explicit approval.",
  ],
  toneOverrides: {
    formality: "professional",
    role: "Budget approval",
  },
};

// ─────────────────────────────────────────────
// Template Registry
// ─────────────────────────────────────────────

export const TRADES_POLICY_TEMPLATES = {
  direct_homeowner: {
    roleRules: DIRECT_HOMEOWNER_ROLES,
    overrideHierarchy: STANDARD_HIERARCHY,
    aiContextFilter: DIRECT_HOMEOWNER_AI,
  },
  rea_short_term_tenant: {
    roleRules: REA_SHORT_TERM_ROLES,
    overrideHierarchy: STANDARD_HIERARCHY,
    aiContextFilter: REA_SHORT_TERM_TENANT_AI,
  },
  rea_long_term_tenant: {
    roleRules: REA_LONG_TERM_ROLES,
    overrideHierarchy: STANDARD_HIERARCHY,
    aiContextFilter: REA_LONG_TERM_TENANT_AI,
  },
  rea_landlord_approval: {
    roleRules: REA_LANDLORD_APPROVAL_ROLES,
    overrideHierarchy: STANDARD_HIERARCHY,
    aiContextFilter: REA_LANDLORD_APPROVAL_AI,
  },
} as const;

export type TradesPolicyTemplateName = keyof typeof TRADES_POLICY_TEMPLATES;

/**
 * Pick the right policy template based on job context.
 */
export function getPolicyTemplateForScenario(
  leadSource: string | null,
  tenantTenure?: "short_term" | "long_term",
  requiresLandlordApproval?: boolean,
): TradesPolicyTemplateName {
  if (leadSource !== "agent_pdf" && leadSource !== "referral") {
    return "direct_homeowner";
  }

  if (requiresLandlordApproval) {
    return "rea_landlord_approval";
  }

  if (tenantTenure === "long_term") {
    return "rea_long_term_tenant";
  }

  return "rea_short_term_tenant";
}

/**
 * Seed all trades policy templates into the database.
 */
export async function seedTradesPolicyTemplates() {
  for (const [name, template] of Object.entries(TRADES_POLICY_TEMPLATES)) {
    await upsertPolicyTemplate({
      vertical: "trades",
      name,
      version: 1,
      roleRules: template.roleRules,
      overrideHierarchy: template.overrideHierarchy,
      aiContextFilter: template.aiContextFilter,
      changeNotes: `Initial trades policy template: ${name}`,
    });
  }
}
