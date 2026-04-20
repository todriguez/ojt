/**
 * policies.risk.ts
 *
 * BREM-specific access policy templates.
 * Defines who can see/contribute/approve what in risk assessment scenarios.
 *
 * Participant roles in BREM context:
 *   - creator:     Primary assessor who initiated the project assessment
 *   - approver:    CTO / senior reviewer who can finalize scores
 *   - contributor: Developer / analyst delegated specific cells to de-risk
 *   - observer:    Stakeholder with read-only access to assessment state
 *   - executor:    AI agent performing extraction and interrogation
 *
 * SelectionGate access per role:
 *   - "participate" — can submit evidence and resolve the gate
 *   - "observe"     — can see the gate exists but cannot resolve it
 *   - "blocked"     — cannot see or interact with the gate
 */

import type { RoleRule, AiContextFilter, OverrideHierarchy } from "../../policyEvaluator";
import { upsertPolicyTemplate } from "../../channelService";

// ─────────────────────────────────────────────
// Common building blocks
// ─────────────────────────────────────────────

/** Fields that contain internal scoring diagnostics — hidden from observers */
const SCORING_INTERNALS = [
  "asymmetricScore", "discretionClusterCount", "discretionClusterCells",
  "smEffective", "stateHash", "prevStateHash", "mergeCount",
];

/** Fields that contain evidence quality metadata */
const EVIDENCE_QUALITY_FIELDS = [
  "evidenceQuality", "evidenceQualitySummary", "needsInterrogation",
  "highConfidenceCount", "lowConfidenceCount",
];

/** The 9 cell keys for gate ID generation */
const CELL_KEYS = ["na", "nc", "ns", "se", "sm", "sf", "ls", "lr", "lp"] as const;

/** Build selectionGates map: all cells participable for a role */
function allCellsParticipable(): Record<string, "participate" | "observe" | "blocked"> {
  return Object.fromEntries(CELL_KEYS.map(k => [`gate:${k}`, "participate"]));
}

/** Build selectionGates map: all cells observable (read-only) */
function allCellsObservable(): Record<string, "participate" | "observe" | "blocked"> {
  return Object.fromEntries(CELL_KEYS.map(k => [`gate:${k}`, "observe"]));
}

/** Build selectionGates map: specific cells participable, rest observable */
function delegatedCells(
  participable: string[],
): Record<string, "participate" | "observe" | "blocked"> {
  const gates: Record<string, "participate" | "observe" | "blocked"> = {};
  for (const k of CELL_KEYS) {
    gates[`gate:${k}`] = participable.includes(k) ? "participate" : "observe";
  }
  return gates;
}

// ─────────────────────────────────────────────
// Override Hierarchy
// ─────────────────────────────────────────────

const BREM_HIERARCHY: OverrideHierarchy = {
  ranks: ["observer", "contributor", "executor", "creator", "approver"],
  rules: {
    approver: {
      canOverride: ["creator", "contributor", "executor", "observer"],
      requiresApproval: [],
    },
    creator: {
      canOverride: ["contributor", "observer"],
      requiresApproval: ["approver"],
    },
    contributor: {
      canOverride: [],
      requiresApproval: ["creator", "approver"],
    },
    executor: {
      canOverride: [],
      requiresApproval: ["creator", "approver"],
    },
    observer: {
      canOverride: [],
      requiresApproval: [],
    },
  },
};

// ─────────────────────────────────────────────
// 1. Solo Assessment — single analyst, full access
// ─────────────────────────────────────────────

const SOLO_ASSESSMENT_ROLES: Record<string, RoleRule> = {
  creator: {
    fieldVisibility: {},
    contributionRights: {
      scope: "contribute",
      allowedEvidenceKinds: ["message", "document", "observation", "image", "selection"],
      allowedActions: ["*"],
    },
    selectionGates: allCellsParticipable(),
  },
  executor: {
    fieldVisibility: {},
    contributionRights: {
      scope: "contribute",
      allowedEvidenceKinds: ["message", "document", "observation", "selection"],
      allowedActions: ["extract", "interrogate", "update_scorecard", "generate_mitigations"],
    },
    selectionGates: allCellsParticipable(),
  },
  default: {
    fieldVisibility: {},
    contributionRights: {
      scope: "contribute",
      allowedEvidenceKinds: ["message", "document"],
      allowedActions: ["*"],
    },
    selectionGates: allCellsParticipable(),
  },
};

const SOLO_ASSESSMENT_AI: AiContextFilter = {
  visibleFields: "*",
  redactedFields: [],
  systemPromptAdditions: [
    "You are assessing a blockchain project for risk. The user is the primary analyst.",
    "Use Socratic probing to challenge weak evidence. Call update_scorecard when evidence changes.",
  ],
};

// ─────────────────────────────────────────────
// 2. Collaborative Assessment — CTO + analyst
// ─────────────────────────────────────────────

const COLLABORATIVE_ASSESSMENT_ROLES: Record<string, RoleRule> = {
  approver: { // CTO / Senior Reviewer
    fieldVisibility: {},
    contributionRights: {
      scope: "approve",
      allowedEvidenceKinds: ["message", "document", "observation", "selection"],
      allowedActions: [
        "approve_score", "reject_score", "finalize_assessment",
        "update_scorecard", "delegate_cell", "escalate_gate",
        "generate_mitigations",
      ],
    },
    selectionGates: allCellsParticipable(),
  },
  creator: { // Primary Analyst
    fieldVisibility: {},
    contributionRights: {
      scope: "contribute",
      allowedEvidenceKinds: ["message", "document", "observation", "image", "selection"],
      allowedActions: [
        "extract", "interrogate", "update_scorecard",
        "challenge_score", "delegate_cell", "generate_mitigations",
      ],
    },
    selectionGates: allCellsParticipable(),
  },
  contributor: { // Developer / Analyst on delegated cells
    fieldVisibility: Object.fromEntries(
      SCORING_INTERNALS.map(f => [f, "hidden" as const])
    ),
    contributionRights: {
      scope: "contribute",
      allowedEvidenceKinds: ["message", "document", "image"],
      allowedActions: [
        "update_scorecard", "challenge_score", "submit_evidence",
      ],
    },
    // Default: all observe. Specific cells granted via delegation.
    // The adapter's delegateCell() sets per-participant gate overrides.
    selectionGates: allCellsObservable(),
  },
  observer: { // Stakeholder — read-only
    fieldVisibility: Object.fromEntries([
      ...SCORING_INTERNALS.map(f => [f, "hidden" as const]),
      ...EVIDENCE_QUALITY_FIELDS.map(f => [f, "hidden" as const]),
    ]),
    contributionRights: {
      scope: "read_only",
      allowedEvidenceKinds: [],
      allowedActions: [],
    },
    selectionGates: allCellsObservable(),
  },
  executor: { // AI Agent
    fieldVisibility: {},
    contributionRights: {
      scope: "contribute",
      allowedEvidenceKinds: ["message", "observation", "selection"],
      allowedActions: [
        "extract", "interrogate", "update_scorecard", "generate_mitigations",
        "open_gate", "advance_gate",
      ],
    },
    selectionGates: allCellsParticipable(),
  },
};

const COLLABORATIVE_ANALYST_AI: AiContextFilter = {
  visibleFields: "*",
  redactedFields: [],
  systemPromptAdditions: [
    "You are assessing a blockchain project for risk as part of a collaborative review.",
    "The user is the primary analyst. A senior reviewer (approver) may also be working on this project.",
    "When evidence quality is weak, open selection gates and probe with Socratic questions.",
    "Score changes must be recorded as LINEAR patches — they cannot be silently undone.",
  ],
};

const COLLABORATIVE_REVIEWER_AI: AiContextFilter = {
  visibleFields: "*",
  redactedFields: [],
  systemPromptAdditions: [
    "You are supporting a senior reviewer examining a blockchain risk assessment.",
    "The reviewer has approval authority — they can finalize scores and override analyst decisions.",
    "Present open selection gates that need their attention. Highlight where evidence quality is insufficient.",
    "Be concise — the reviewer wants to focus on structural risk, not re-read the whitepaper.",
  ],
};

const COLLABORATIVE_CONTRIBUTOR_AI: AiContextFilter = {
  visibleFields: [
    "projectName", "organization", "protocolFamily", "permissionModel",
    "overallScore", "riskLevel", "riskBand",
    // Contributor only sees cells they're delegated
    // This is further filtered at runtime by gate access
  ],
  redactedFields: [...SCORING_INTERNALS, ...EVIDENCE_QUALITY_FIELDS],
  systemPromptAdditions: [
    "You are helping a developer de-risk specific cells of a blockchain risk assessment.",
    "Focus ONLY on the cells delegated to this participant. Do not discuss other cells.",
    "Ask for concrete technical evidence: architecture docs, code references, protocol specifications.",
    "When sufficient evidence is provided, submit it and recommend whether the score should change.",
  ],
};

// ─────────────────────────────────────────────
// 3. Enterprise Due Diligence — full multi-party
// ─────────────────────────────────────────────

const ENTERPRISE_DD_ROLES: Record<string, RoleRule> = {
  ...COLLABORATIVE_ASSESSMENT_ROLES,
  // Enterprise adds tighter controls on the contributor role
  contributor: {
    ...COLLABORATIVE_ASSESSMENT_ROLES.contributor,
    contributionRights: {
      scope: "contribute",
      allowedEvidenceKinds: ["message", "document"],
      allowedActions: [
        "submit_evidence", "challenge_score",
        // No update_scorecard — contributors propose, approvers decide
      ],
    },
  },
};

const ENTERPRISE_DD_AI: AiContextFilter = {
  visibleFields: "*",
  redactedFields: [],
  systemPromptAdditions: [
    "You are supporting an enterprise due diligence process for a blockchain project.",
    "This is a formal assessment. All score changes must go through selection gates.",
    "Maintain strict evidence standards — assertions without structural proof do not clear gates.",
    "The assessment may involve multiple participants with different authority levels.",
  ],
};

// ─────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────

/**
 * registerRiskPolicies: Seeds policy templates into the database.
 * Called during application boot or migration.
 */
export async function registerRiskPolicies(): Promise<void> {
  await upsertPolicyTemplate({
    vertical: "risk",
    name: "solo-assessment",
    version: 1,
    roleRules: SOLO_ASSESSMENT_ROLES,
    overrideHierarchy: BREM_HIERARCHY,
    aiContextFilter: SOLO_ASSESSMENT_AI,
    changeNotes: "Initial solo assessment policy — single analyst, all gates participable",
  });

  await upsertPolicyTemplate({
    vertical: "risk",
    name: "collaborative-assessment",
    version: 1,
    roleRules: COLLABORATIVE_ASSESSMENT_ROLES,
    overrideHierarchy: BREM_HIERARCHY,
    aiContextFilter: COLLABORATIVE_ANALYST_AI,
    changeNotes: "Collaborative assessment — CTO + analyst + delegated contributors",
  });

  await upsertPolicyTemplate({
    vertical: "risk",
    name: "collaborative-reviewer",
    version: 1,
    roleRules: COLLABORATIVE_ASSESSMENT_ROLES,
    overrideHierarchy: BREM_HIERARCHY,
    aiContextFilter: COLLABORATIVE_REVIEWER_AI,
    changeNotes: "Reviewer channel AI context for collaborative assessment",
  });

  await upsertPolicyTemplate({
    vertical: "risk",
    name: "collaborative-contributor",
    version: 1,
    roleRules: COLLABORATIVE_ASSESSMENT_ROLES,
    overrideHierarchy: BREM_HIERARCHY,
    aiContextFilter: COLLABORATIVE_CONTRIBUTOR_AI,
    changeNotes: "Contributor channel AI context — scoped to delegated cells",
  });

  await upsertPolicyTemplate({
    vertical: "risk",
    name: "enterprise-due-diligence",
    version: 1,
    roleRules: ENTERPRISE_DD_ROLES,
    overrideHierarchy: BREM_HIERARCHY,
    aiContextFilter: ENTERPRISE_DD_AI,
    changeNotes: "Enterprise DD — tighter contributor controls, formal gate clearance required",
  });
}

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

export {
  BREM_HIERARCHY,
  SOLO_ASSESSMENT_ROLES,
  COLLABORATIVE_ASSESSMENT_ROLES,
  ENTERPRISE_DD_ROLES,
  allCellsParticipable,
  allCellsObservable,
  delegatedCells,
};
