/**
 * policyEvaluator.ts
 *
 * Evaluates access policies to filter semantic object state per participant.
 * Determines field visibility, contribution rights, and AI context filtering.
 * Vertical-agnostic — works with any policy shape.
 */

import { getChannelPolicy } from "./channelService";
import { createLogger } from "@/lib/logger";

const log = createLogger("policy-evaluator");

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type FieldVisibility = "visible" | "hidden" | "approval_required" | "redacted_value";

export interface RoleRule {
  fieldVisibility: Record<string, FieldVisibility>;
  contributionRights: {
    scope: "read_only" | "contribute" | "approve";
    allowedEvidenceKinds: string[];
    allowedActions: string[];
  };
  selectionGates?: Record<string, "participate" | "observe" | "blocked">;
}

export interface OverrideHierarchy {
  ranks: string[];
  rules: Record<string, {
    canOverride: string[];
    requiresApproval: string[];
  }>;
}

export interface AiContextFilter {
  visibleFields: string[] | "*";
  redactedFields: string[];
  systemPromptAdditions: string[];
  toneOverrides?: {
    formality: "casual" | "professional" | "formal";
    role: string;
  };
}

export interface PolicyEvaluation {
  roleRule: RoleRule;
  aiContext: AiContextFilter;
  fieldOverrides: Record<string, string>;
}

// ─────────────────────────────────────────────
// State Filtering
// ─────────────────────────────────────────────

/**
 * Filter an accumulated state object based on role rules.
 * Hidden fields are removed. Redacted fields get placeholder values.
 */
export function filterState(
  state: Record<string, any>,
  roleRule: RoleRule,
  fieldOverrides?: Record<string, string>,
): Record<string, any> {
  const filtered: Record<string, any> = {};
  const visibility = { ...roleRule.fieldVisibility };

  // Apply overrides
  if (fieldOverrides) {
    Object.assign(visibility, fieldOverrides);
  }

  for (const [key, value] of Object.entries(state)) {
    const rule = visibility[key];

    if (rule === "hidden") {
      // Skip — participant can't see this field
      continue;
    }

    if (rule === "redacted_value") {
      // Show that the field exists but redact its value
      if (typeof value === "number") {
        filtered[key] = 0;
      } else if (typeof value === "string") {
        filtered[key] = "[redacted]";
      } else {
        filtered[key] = null;
      }
      continue;
    }

    // "visible", "approval_required", or no rule (default visible)
    filtered[key] = value;
  }

  return filtered;
}

/**
 * Build AI-visible fields list from the context filter.
 * Returns a filtered copy of the state that the AI can include in its prompt.
 */
export function filterStateForAi(
  state: Record<string, any>,
  aiContext: AiContextFilter,
): Record<string, any> {
  // If visibleFields is "*", show everything except redacted
  if (aiContext.visibleFields === "*") {
    const filtered = { ...state };
    for (const field of aiContext.redactedFields) {
      delete filtered[field];
    }
    return filtered;
  }

  // Only include explicitly visible fields
  const filtered: Record<string, any> = {};
  for (const field of aiContext.visibleFields) {
    if (field in state && !aiContext.redactedFields.includes(field)) {
      filtered[field] = state[field];
    }
  }
  return filtered;
}

// ─────────────────────────────────────────────
// Policy Evaluation
// ─────────────────────────────────────────────

/**
 * Evaluate the full policy for a participant in a channel.
 * Returns the applicable role rule, AI context, and any overrides.
 */
export async function evaluateChannelPolicy(
  channelId: string,
  participantId: string,
  participantRole: string,
): Promise<PolicyEvaluation | null> {
  const result = await getChannelPolicy(channelId, participantId);

  if (!result) {
    // No policy assigned — return default (full visibility)
    return getDefaultPolicy();
  }

  const policy = result.policy;
  const roleRules = policy.roleRules as Record<string, RoleRule>;
  const roleRule = roleRules[participantRole] || roleRules["default"] || getDefaultRoleRule();
  const aiContext = policy.aiContextFilter as AiContextFilter;
  const fieldOverrides = (result.fieldOverrides || {}) as Record<string, string>;

  return { roleRule, aiContext, fieldOverrides };
}

// ─────────────────────────────────────────────
// Contribution Rights
// ─────────────────────────────────────────────

/**
 * Check if a participant can perform a specific action.
 */
export function checkContributionRight(
  roleRule: RoleRule,
  action: string,
): boolean {
  if (roleRule.contributionRights.scope === "read_only") {
    return false;
  }
  if (roleRule.contributionRights.allowedActions.includes("*")) {
    return true;
  }
  return roleRule.contributionRights.allowedActions.includes(action);
}

/**
 * Check if a participant can submit a specific evidence kind.
 */
export function checkEvidenceRight(
  roleRule: RoleRule,
  evidenceKind: string,
): boolean {
  if (roleRule.contributionRights.scope === "read_only") {
    return false;
  }
  return roleRule.contributionRights.allowedEvidenceKinds.includes(evidenceKind);
}

/**
 * Check a participant's access to a selection gate.
 */
export function checkSelectionGateAccess(
  roleRule: RoleRule,
  gateId: string,
): "participate" | "observe" | "blocked" {
  return roleRule.selectionGates?.[gateId] || "observe";
}

// ─────────────────────────────────────────────
// Override Hierarchy
// ─────────────────────────────────────────────

/**
 * Check if one role can override another's decision.
 */
export function canOverride(
  hierarchy: OverrideHierarchy,
  actorRole: string,
  targetRole: string,
): boolean {
  const rules = hierarchy.rules[actorRole];
  if (!rules) return false;
  return rules.canOverride.includes(targetRole);
}

/**
 * Check if a decision requires approval from another role.
 */
export function requiresApproval(
  hierarchy: OverrideHierarchy,
  actorRole: string,
): string[] {
  const rules = hierarchy.rules[actorRole];
  if (!rules) return [];
  return rules.requiresApproval;
}

// ─────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────

function getDefaultRoleRule(): RoleRule {
  return {
    fieldVisibility: {},
    contributionRights: {
      scope: "contribute",
      allowedEvidenceKinds: ["message", "image", "voice", "document"],
      allowedActions: ["*"],
    },
    selectionGates: {},
  };
}

function getDefaultPolicy(): PolicyEvaluation {
  return {
    roleRule: getDefaultRoleRule(),
    aiContext: {
      visibleFields: "*",
      redactedFields: [],
      systemPromptAdditions: [],
    },
    fieldOverrides: {},
  };
}
