/**
 * adapter.risk.ts
 *
 * RiskSemanticAdapter — Vertical-Specific Adapter
 *
 * Extends SemanticAdapter with blockchain risk assessment logic:
 *   - Project assessment creation and lifecycle
 *   - 9-cell score updates with delta tracking
 *   - Discretion cluster cross-correlation
 *   - Mitigation instrument generation
 *   - Challenge/rebuttal audit trail
 *   - State hash chain for assessment versioning
 *
 * All writes are safe (queued on failure) via the base adapter.
 */

import { eq, and, sql } from "drizzle-orm";
import { SemanticAdapter, SemanticContext, VerticalConfig } from "../../adapter.base";
import {
  riskProjects,
  riskCellStates,
  riskMitigations,
  riskChallenges,
  riskSelectionGates,
} from "./schema.risk";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const VERTICAL = "risk";
const COMPILER_VERSION = "risk-v1.0";

/** The 9 BREM cell keys */
const CELL_KEYS = ["na", "nc", "ns", "se", "sm", "sf", "ls", "lr", "lp"] as const;
type CellKey = typeof CELL_KEYS[number];

/** Cell → domain mapping */
const CELL_TO_DOMAIN: Record<CellKey, string> = {
  na: "network", nc: "network", ns: "network",
  se: "systemState", sm: "systemState", sf: "systemState",
  ls: "law", lr: "law", lp: "law",
};

/** Cell → SPP role */
const CELL_SPP_ROLE: Record<CellKey, string> = {
  na: "structure", nc: "process", ns: "persistence",
  se: "structure", sm: "process", sf: "persistence",
  ls: "structure", lr: "process", lp: "persistence",
};

/** Asymmetric weighting ratios from the empirical dataset */
const ASYMMETRY_RATIOS: Record<CellKey, number> = {
  nc: 8.22, se: 4.53, na: 2.10, ls: 1.80, ns: 1.50,
  sm: 1.40, sf: 1.30, lr: 1.20, lp: 1.10,
};

/** Discretion cluster cells — these correlate multiplicatively */
const DISCRETION_CLUSTER: CellKey[] = ["nc", "sm", "lr", "sf", "se"];

/** Score thresholds */
const THRESHOLD_OVERALL = 2.5;
const THRESHOLD_DOMAIN_CEILING = 3.0;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ProjectClassification {
  projectName: string;
  organization?: string;
  segment?: string;
  category?: string;
  region?: string;
  protocolFamily?: string;
  permissionModel?: string;
  consensusFamily?: string;
  architectureType?: string;
  governanceType?: string;
  threatModel?: string;
  isMultiPlatform?: boolean;
  platformCount?: number;
  investmentUsd?: number;
  valueAtRiskUsd?: number;
}

export interface CellScoreUpdate {
  cellKey: CellKey;
  score: number; // 0–4
  reasoning: string;
  branchPath?: string;
  q1Answer?: string;
  scoringMethod?: string;
  evidence?: Array<{
    text: string;
    source: string;
    sourceRef: string;
    confidence: number;
  }>;
  deRiskActions?: string[];
}

export interface ChallengeRecord {
  cellKey: CellKey;
  originalScore: number;
  challengeReason: string;
  challengeEvidence?: Array<{ text: string; source: string; sourceRef: string; confidence: number }>;
  accepted: boolean;
  challengedScore?: number;
  rebuttal?: string;
}

/** Valid gate statuses — LINEAR progression only */
type GateStatus = "opened" | "interrogating" | "confirmed" | "challenged" | "escalated" | "expired";

/** Valid gate kinds */
type GateKind = "evidence_quality" | "score_challenge" | "delegation" | "escalation";

/** Legal gate transitions — the state can only advance, never revert */
const GATE_TRANSITIONS: Record<GateStatus, GateStatus[]> = {
  opened:        ["interrogating", "confirmed", "escalated", "expired"],
  interrogating: ["confirmed", "challenged", "escalated", "expired"],
  confirmed:     [],  // terminal
  challenged:    [],  // terminal
  escalated:     ["interrogating", "confirmed", "challenged", "expired"], // re-enters interrogation under new participant
  expired:       [],  // terminal
};

export interface OpenGateInput {
  cellKey: CellKey;
  scoreAtOpen: number;
  gateKind: GateKind;
  openReason: string;
  openedByParticipantId?: string;
  assignedToParticipantId?: string;
  channelId?: string;
  stateHashAtOpen?: string;
  expiresAt?: Date;
}

export interface ResolveGateInput {
  gateId: string;
  resolution: "confirmed" | "challenged" | "escalated" | "expired";
  resolvedByParticipantId?: string;
  resolutionChannelId?: string;
  resolutionReason: string;
  scoreAtClose?: number;
  evidenceItemIds?: string[];
  interrogationQuestions?: string[];
  interrogationAnswers?: string[];
}

export interface ScoreVector {
  na?: number; nc?: number; ns?: number;
  se?: number; sm?: number; sf?: number;
  ls?: number; lr?: number; lp?: number;
}

export interface ThresholdAnalysis {
  overallScore: number;
  aboveThreshold: boolean;
  domainCeilingTriggered: boolean;
  flagged: boolean;
  riskLevel: "low" | "moderate" | "elevated" | "critical";
  smZone: "safe" | "caution" | "danger";
  discretionClusterCount: number;
  discretionClusterCells: CellKey[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure Scoring Functions
// ─────────────────────────────────────────────────────────────────────────────

function computeDomainScore(scores: ScoreVector, cells: CellKey[]): number {
  const vals = cells.map(k => scores[k]).filter(v => v !== undefined && v !== null) as number[];
  if (vals.length === 0) return 0;
  return round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

function computeOverallScore(scores: ScoreVector): number {
  const vals = CELL_KEYS.map(k => scores[k]).filter(v => v !== undefined && v !== null) as number[];
  if (vals.length === 0) return 0;
  return round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

function computeAsymmetricScore(scores: ScoreVector): number {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const key of CELL_KEYS) {
    const score = scores[key];
    if (score === undefined || score === null) continue;
    const ratio = ASYMMETRY_RATIOS[key];
    const weight = score >= 3 ? ratio : 1;
    weightedSum += score * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? round(weightedSum / totalWeight) : 0;
}

function computeThreshold(scores: ScoreVector, platformCount: number = 1): ThresholdAnalysis {
  const overall = computeOverallScore(scores);
  const networkDomain = computeDomainScore(scores, ["na", "nc", "ns"]);
  const systemDomain = computeDomainScore(scores, ["se", "sm", "sf"]);
  const lawDomain = computeDomainScore(scores, ["ls", "lr", "lp"]);

  const domainCeilingTriggered = [networkDomain, systemDomain, lawDomain].some(d => d > THRESHOLD_DOMAIN_CEILING);
  const aboveThreshold = overall >= THRESHOLD_OVERALL;
  const flagged = aboveThreshold || domainCeilingTriggered;

  let riskLevel: ThresholdAnalysis["riskLevel"];
  if (overall >= 3.0) riskLevel = "critical";
  else if (flagged) riskLevel = "elevated";
  else if (overall >= 2.0) riskLevel = "moderate";
  else riskLevel = "low";

  const sm = scores.sm ?? 0;
  let smZone: ThresholdAnalysis["smZone"];
  if (sm <= 2) smZone = "safe";
  else if (sm === 3) smZone = "caution";
  else smZone = "danger";

  // Discretion cluster analysis
  const clusterCells = DISCRETION_CLUSTER.filter(k => (scores[k] ?? 0) >= 3);

  return {
    overallScore: overall,
    aboveThreshold,
    domainCeilingTriggered,
    flagged,
    riskLevel,
    smZone,
    discretionClusterCount: clusterCells.length,
    discretionClusterCells: clusterCells,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// RiskSemanticAdapter Class
// ─────────────────────────────────────────────────────────────────────────────

export class RiskSemanticAdapter extends SemanticAdapter {
  private dbInstance: any;

  constructor(db: any, verticalConfig?: VerticalConfig) {
    const config: VerticalConfig = verticalConfig || {
      verticalId: VERTICAL,
      compilerVersion: COMPILER_VERSION,
      irVersion: 1,
    };
    super(db, config);
    this.dbInstance = db;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Project Lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * ensureRiskProject: Creates a semantic object for a risk assessment
   * and initializes the riskProjects projection row + 9 empty cell states.
   */
  async ensureRiskProject(
    classification: ProjectClassification,
    legacyProjectId?: string,
    ownerId?: string,
  ): Promise<SemanticContext> {
    const typeHash = this._computeTypeHash("assessment", classification.protocolFamily || "unknown");
    const typePath = `risk.assessment.${classification.protocolFamily || "unknown"}`;

    const ctx = await this.ensureObject("assessment", typeHash, typePath, ownerId);

    // Create riskProjects projection row
    try {
      await this.dbInstance.insert(riskProjects).values({
        objectId: ctx.semanticObjectId,
        legacyProjectId,
        projectName: classification.projectName,
        organization: classification.organization,
        segment: classification.segment,
        category: classification.category,
        region: classification.region,
        protocolFamily: classification.protocolFamily,
        permissionModel: classification.permissionModel,
        consensusFamily: classification.consensusFamily,
        architectureType: classification.architectureType,
        governanceType: classification.governanceType,
        threatModel: classification.threatModel,
        isMultiPlatform: classification.isMultiPlatform || false,
        platformCount: classification.platformCount || 1,
        investmentUsd: classification.investmentUsd,
        valueAtRiskUsd: classification.valueAtRiskUsd,
        assessmentStatus: "in_progress",
      }).onConflictDoNothing();

      // Create 9 empty cell state rows
      for (const cellKey of CELL_KEYS) {
        await this.dbInstance.insert(riskCellStates).values({
          projectObjectId: ctx.semanticObjectId,
          cellKey,
          domain: CELL_TO_DOMAIN[cellKey],
          sppRole: CELL_SPP_ROLE[cellKey],
          scored: false,
          scoringMethod: "unscored",
          version: 0,
        }).onConflictDoNothing();
      }
    } catch (err) {
      // Non-fatal — projection is secondary to semantic object
      console.error("[risk-adapter] Failed to create projection:", err);
    }

    return ctx;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Score Updates
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * updateCellScore: Updates a single cell score and recomputes all aggregates.
   * This is the merge operation — each call produces a new state version.
   */
  async updateCellScore(
    objectId: string,
    update: CellScoreUpdate,
  ): Promise<ThresholdAnalysis | null> {
    try {
      const now = new Date();

      // Update cell state
      await this.dbInstance
        .update(riskCellStates)
        .set({
          score: update.score,
          scored: true,
          branchPathString: update.branchPath,
          q1Answer: update.q1Answer,
          evidence: update.evidence || [],
          reasoning: update.reasoning,
          deRiskActions: update.deRiskActions || [],
          scoringMethod: update.scoringMethod || "agent-scored",
          lastUpdatedAt: now,
          firstScoredAt: now, // TODO: only set if null
          version: 1, // TODO: increment
        })
        .where(
          and(
            eq(riskCellStates.projectObjectId, objectId),
            eq(riskCellStates.cellKey, update.cellKey),
          )
        );

      // Recompute aggregates
      return await this._recomputeAggregates(objectId);
    } catch (err) {
      console.error("[risk-adapter] Failed to update cell score:", err);
      return null;
    }
  }

  /**
   * updateCellScoreBatch: Updates multiple cells in one pass.
   * Recomputes aggregates once at the end.
   */
  async updateCellScoreBatch(
    objectId: string,
    updates: CellScoreUpdate[],
  ): Promise<ThresholdAnalysis | null> {
    try {
      const now = new Date();

      for (const update of updates) {
        await this.dbInstance
          .update(riskCellStates)
          .set({
            score: update.score,
            scored: true,
            branchPathString: update.branchPath,
            q1Answer: update.q1Answer,
            evidence: update.evidence || [],
            reasoning: update.reasoning,
            deRiskActions: update.deRiskActions || [],
            scoringMethod: update.scoringMethod || "agent-scored",
            lastUpdatedAt: now,
            firstScoredAt: now,
            version: 1,
          })
          .where(
            and(
              eq(riskCellStates.projectObjectId, objectId),
              eq(riskCellStates.cellKey, update.cellKey),
            )
          );
      }

      return await this._recomputeAggregates(objectId);
    } catch (err) {
      console.error("[risk-adapter] Batch update failed:", err);
      return null;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Challenge / Rebuttal
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * recordChallenge: Records a score challenge in the audit trail.
   * If accepted, updates the cell score and recomputes aggregates.
   */
  async recordChallenge(
    objectId: string,
    challenge: ChallengeRecord,
  ): Promise<ThresholdAnalysis | null> {
    try {
      // Get current state hash
      const project = await this.dbInstance.query.riskProjects.findFirst({
        where: eq(riskProjects.objectId, objectId),
      });
      const hashBefore = project?.stateHash || "";

      // Record the challenge
      await this.dbInstance.insert(riskChallenges).values({
        projectObjectId: objectId,
        cellKey: challenge.cellKey,
        originalScore: challenge.originalScore,
        challengedScore: challenge.accepted ? challenge.challengedScore : null,
        challengeReason: challenge.challengeReason,
        challengeEvidence: challenge.challengeEvidence || [],
        rebuttal: challenge.rebuttal,
        accepted: challenge.accepted,
        stateHashBefore: hashBefore,
      });

      // If accepted, update the score
      if (challenge.accepted && challenge.challengedScore !== undefined) {
        const result = await this.updateCellScore(objectId, {
          cellKey: challenge.cellKey,
          score: challenge.challengedScore,
          reasoning: `Challenge accepted: ${challenge.challengeReason}`,
          scoringMethod: "expert-scored",
          evidence: challenge.challengeEvidence,
        });

        // Update the challenge with the new state hash
        if (result) {
          const updatedProject = await this.dbInstance.query.riskProjects.findFirst({
            where: eq(riskProjects.objectId, objectId),
          });
          // The stateHashAfter would be set here if we track it
        }

        return result;
      }

      return null;
    } catch (err) {
      console.error("[risk-adapter] Failed to record challenge:", err);
      return null;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Mitigation Instruments
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * recordMitigation: Stores a generated mitigation instrument.
   */
  async recordMitigation(
    objectId: string,
    mitigation: {
      cellKey: CellKey;
      category: string;
      actionSlug: string;
      title: string;
      description: string;
      rationale?: string;
      impact?: Array<{ cellKey: string; from: number; to: number }>;
      totalImpact?: number;
      priority?: number;
      effort?: string;
      timeline?: string;
      dependencies?: string[];
      verification?: string[];
    },
  ): Promise<void> {
    try {
      await this.dbInstance.insert(riskMitigations).values({
        projectObjectId: objectId,
        cellKey: mitigation.cellKey,
        domain: CELL_TO_DOMAIN[mitigation.cellKey as CellKey] || "unknown",
        category: mitigation.category,
        actionSlug: mitigation.actionSlug,
        title: mitigation.title,
        description: mitigation.description,
        rationale: mitigation.rationale,
        impact: mitigation.impact || [],
        totalImpact: mitigation.totalImpact || 0,
        priority: mitigation.priority || 0,
        effort: mitigation.effort || "medium",
        timeline: mitigation.timeline || "3-months",
        dependencies: mitigation.dependencies || [],
        verification: mitigation.verification || [],
      });
    } catch (err) {
      console.error("[risk-adapter] Failed to record mitigation:", err);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Selection Gates — Evidence Quality Checkpoints
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * openGate: Creates a SelectionGate on a cell.
   * Called after extraction when evidence quality is weak,
   * or when a participant challenges a score.
   *
   * A gate is a typed decision checkpoint — the score is provisional
   * until the gate is cleared. LINEAR: once opened, it must advance
   * to a terminal state.
   */
  async openGate(
    objectId: string,
    input: OpenGateInput,
  ): Promise<string | null> {
    try {
      const [gate] = await this.dbInstance
        .insert(riskSelectionGates)
        .values({
          projectObjectId: objectId,
          cellKey: input.cellKey,
          scoreAtOpen: input.scoreAtOpen,
          gateKind: input.gateKind,
          status: "opened",
          openedByParticipantId: input.openedByParticipantId,
          assignedToParticipantId: input.assignedToParticipantId,
          channelId: input.channelId,
          openReason: input.openReason,
          stateHashAtOpen: input.stateHashAtOpen,
          expiresAt: input.expiresAt,
        })
        .returning({ id: riskSelectionGates.id });

      console.log(`[risk-adapter] Gate opened: ${input.gateKind} on ${input.cellKey} (score=${input.scoreAtOpen})`);
      return gate.id;
    } catch (err) {
      console.error("[risk-adapter] Failed to open gate:", err);
      return null;
    }
  }

  /**
   * openGatesFromExtraction: Batch-opens gates for all cells flagged
   * during extraction as having weak evidence quality.
   * Returns the list of gate IDs.
   */
  async openGatesFromExtraction(
    objectId: string,
    needsInterrogation: CellKey[],
    cellScores: Partial<Record<CellKey, number>>,
    stateHash?: string,
    channelId?: string,
    openedByParticipantId?: string,
  ): Promise<string[]> {
    const gateIds: string[] = [];
    for (const cellKey of needsInterrogation) {
      const score = cellScores[cellKey];
      if (score === undefined) continue;

      const gateId = await this.openGate(objectId, {
        cellKey,
        scoreAtOpen: score,
        gateKind: "evidence_quality",
        openReason: `Extraction flagged ${cellKey} (score=${score}) for interrogation — evidence quality insufficient for confident scoring.`,
        openedByParticipantId,
        channelId,
        stateHashAtOpen: stateHash,
      });

      if (gateId) gateIds.push(gateId);
    }

    // Update assessment status to reflect open gates
    if (gateIds.length > 0) {
      await this.dbInstance
        .update(riskProjects)
        .set({ assessmentStatus: "gated" })
        .where(eq(riskProjects.objectId, objectId));
    }

    return gateIds;
  }

  /**
   * advanceGate: Transitions a gate to the next state.
   * Enforces LINEAR constraint — can only move forward per GATE_TRANSITIONS.
   */
  async advanceGate(
    gateId: string,
    toStatus: GateStatus,
  ): Promise<boolean> {
    try {
      const gates = await this.dbInstance
        .select()
        .from(riskSelectionGates)
        .where(eq(riskSelectionGates.id, gateId))
        .limit(1);

      if (gates.length === 0) {
        console.error(`[risk-adapter] Gate not found: ${gateId}`);
        return false;
      }

      const gate = gates[0];
      const currentStatus = gate.status as GateStatus;
      const allowed = GATE_TRANSITIONS[currentStatus];

      if (!allowed.includes(toStatus)) {
        console.error(
          `[risk-adapter] Illegal gate transition: ${currentStatus} → ${toStatus}. ` +
          `Allowed: [${allowed.join(", ")}]`
        );
        return false;
      }

      const updates: Record<string, any> = { status: toStatus };
      if (toStatus === "interrogating") {
        updates.interrogationStartedAt = new Date();
      }

      await this.dbInstance
        .update(riskSelectionGates)
        .set(updates)
        .where(eq(riskSelectionGates.id, gateId));

      console.log(`[risk-adapter] Gate ${gateId}: ${currentStatus} → ${toStatus}`);
      return true;
    } catch (err) {
      console.error("[risk-adapter] Failed to advance gate:", err);
      return false;
    }
  }

  /**
   * resolveGate: Closes a gate with a terminal resolution.
   * Records the resolution reason, evidence chain, and optional score change.
   * If the resolution is "challenged", also updates the cell score.
   */
  async resolveGate(
    objectId: string,
    input: ResolveGateInput,
  ): Promise<ThresholdAnalysis | null> {
    try {
      const gates = await this.dbInstance
        .select()
        .from(riskSelectionGates)
        .where(eq(riskSelectionGates.id, input.gateId))
        .limit(1);

      if (gates.length === 0) {
        console.error(`[risk-adapter] Gate not found: ${input.gateId}`);
        return null;
      }

      const gate = gates[0];
      const currentStatus = gate.status as GateStatus;
      const allowed = GATE_TRANSITIONS[currentStatus];

      if (!allowed.includes(input.resolution)) {
        console.error(
          `[risk-adapter] Illegal gate resolution: ${currentStatus} → ${input.resolution}`
        );
        return null;
      }

      // Get current state hash for the close record
      const project = await this.dbInstance.query.riskProjects.findFirst({
        where: eq(riskProjects.objectId, objectId),
      });

      // Close the gate
      await this.dbInstance
        .update(riskSelectionGates)
        .set({
          status: input.resolution,
          resolvedByParticipantId: input.resolvedByParticipantId,
          resolutionChannelId: input.resolutionChannelId,
          resolutionReason: input.resolutionReason,
          scoreAtClose: input.scoreAtClose ?? gate.scoreAtOpen,
          evidenceItemIds: input.evidenceItemIds || [],
          interrogationQuestions: input.interrogationQuestions || [],
          interrogationAnswers: input.interrogationAnswers || [],
          stateHashAtClose: project?.stateHash,
          resolvedAt: new Date(),
        })
        .where(eq(riskSelectionGates.id, input.gateId));

      console.log(
        `[risk-adapter] Gate ${input.gateId} resolved: ${input.resolution} ` +
        `(${gate.cellKey}: ${gate.scoreAtOpen} → ${input.scoreAtClose ?? gate.scoreAtOpen})`
      );

      // If challenged with a new score, update the cell
      if (input.resolution === "challenged" && input.scoreAtClose !== undefined && input.scoreAtClose !== gate.scoreAtOpen) {
        return await this.updateCellScore(objectId, {
          cellKey: gate.cellKey as CellKey,
          score: input.scoreAtClose,
          reasoning: `SelectionGate challenge: ${input.resolutionReason}`,
          scoringMethod: "gate-challenged",
          evidence: input.evidenceItemIds?.map(id => ({
            text: `Evidence from gate interrogation`,
            source: "selection_gate",
            sourceRef: id,
            confidence: 0.8,
          })),
        });
      }

      // Check if all gates are now cleared → advance assessment status
      await this._checkGateCompletion(objectId);

      return null;
    } catch (err) {
      console.error("[risk-adapter] Failed to resolve gate:", err);
      return null;
    }
  }

  /**
   * getOpenGates: Returns all non-terminal gates for a project.
   */
  async getOpenGates(objectId: string): Promise<any[]> {
    try {
      return await this.dbInstance
        .select()
        .from(riskSelectionGates)
        .where(
          and(
            eq(riskSelectionGates.projectObjectId, objectId),
            // Non-terminal statuses
            sql`${riskSelectionGates.status} IN ('opened', 'interrogating', 'escalated')`,
          )
        );
    } catch (err) {
      console.error("[risk-adapter] Failed to get open gates:", err);
      return [];
    }
  }

  /**
   * getGatesForCell: Returns all gates (open and closed) for a specific cell.
   */
  async getGatesForCell(objectId: string, cellKey: CellKey): Promise<any[]> {
    try {
      return await this.dbInstance
        .select()
        .from(riskSelectionGates)
        .where(
          and(
            eq(riskSelectionGates.projectObjectId, objectId),
            eq(riskSelectionGates.cellKey, cellKey),
          )
        );
    } catch (err) {
      console.error("[risk-adapter] Failed to get gates for cell:", err);
      return [];
    }
  }

  /**
   * getGatesForParticipant: Returns all open gates assigned to a participant.
   * Used to build the participant's "inbox" of cells requiring their attention.
   */
  async getGatesForParticipant(participantId: string): Promise<any[]> {
    try {
      return await this.dbInstance
        .select()
        .from(riskSelectionGates)
        .where(
          and(
            eq(riskSelectionGates.assignedToParticipantId, participantId),
            sql`${riskSelectionGates.status} IN ('opened', 'interrogating', 'escalated')`,
          )
        );
    } catch (err) {
      console.error("[risk-adapter] Failed to get gates for participant:", err);
      return [];
    }
  }

  /**
   * canFinalize: Checks whether all gates are cleared.
   * A project can only transition to "finalized" when no open gates remain.
   */
  async canFinalize(objectId: string): Promise<{ canFinalize: boolean; openGateCount: number; openCells: string[] }> {
    const openGates = await this.getOpenGates(objectId);
    return {
      canFinalize: openGates.length === 0,
      openGateCount: openGates.length,
      openCells: [...new Set(openGates.map((g: any) => g.cellKey))],
    };
  }

  /**
   * delegateCell: Opens a delegation gate — assigns a cell to a contributor
   * for de-risking work. The contributor works on that cell through their
   * own channel with scoped write permissions.
   */
  async delegateCell(
    objectId: string,
    cellKey: CellKey,
    assignedToParticipantId: string,
    delegatedByParticipantId: string,
    channelId?: string,
  ): Promise<string | null> {
    // Get current score
    const cells = await this.dbInstance
      .select()
      .from(riskCellStates)
      .where(
        and(
          eq(riskCellStates.projectObjectId, objectId),
          eq(riskCellStates.cellKey, cellKey),
        )
      )
      .limit(1);

    const currentScore = cells[0]?.score ?? 0;

    return this.openGate(objectId, {
      cellKey,
      scoreAtOpen: currentScore,
      gateKind: "delegation",
      openReason: `Cell ${cellKey} (score=${currentScore}) delegated for de-risking.`,
      openedByParticipantId: delegatedByParticipantId,
      assignedToParticipantId,
      channelId,
    });
  }

  // ── Internal: check if all gates cleared → update status ──

  private async _checkGateCompletion(objectId: string): Promise<void> {
    const openGates = await this.getOpenGates(objectId);
    if (openGates.length === 0) {
      // All gates cleared — project can advance from "gated" to "scored"
      const project = await this.dbInstance.query.riskProjects.findFirst({
        where: eq(riskProjects.objectId, objectId),
      });
      if (project?.assessmentStatus === "gated") {
        await this.dbInstance
          .update(riskProjects)
          .set({ assessmentStatus: "scored", updatedAt: new Date() })
          .where(eq(riskProjects.objectId, objectId));
        console.log(`[risk-adapter] All gates cleared for ${objectId} — status → scored`);
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internal: Recompute Aggregates
  // ───────────────────────────────────────────────────────────────────────────

  private async _recomputeAggregates(objectId: string): Promise<ThresholdAnalysis> {
    // Read all cell states
    const cells = await this.dbInstance.query.riskCellStates.findMany({
      where: eq(riskCellStates.projectObjectId, objectId),
    });

    // Build score vector
    const scores: ScoreVector = {};
    let scoredCount = 0;
    for (const cell of cells) {
      if (cell.scored && cell.score !== null) {
        (scores as any)[cell.cellKey] = cell.score;
        scoredCount++;
      }
    }

    // Compute all aggregates
    const networkDomain = computeDomainScore(scores, ["na", "nc", "ns"]);
    const systemDomain = computeDomainScore(scores, ["se", "sm", "sf"]);
    const lawDomain = computeDomainScore(scores, ["ls", "lr", "lp"]);
    const overall = computeOverallScore(scores);
    const asymmetric = computeAsymmetricScore(scores);

    // Get project for platform count
    const project = await this.dbInstance.query.riskProjects.findFirst({
      where: eq(riskProjects.objectId, objectId),
    });
    const platformCount = project?.platformCount || 1;

    const threshold = computeThreshold(scores, platformCount);

    // Compute sm_effective for multi-platform
    const smBase = scores.sm ?? 0;
    const smEffective = platformCount > 1
      ? Math.min(4, smBase + Math.ceil(Math.log2(platformCount)))
      : smBase;

    // Determine assessment status
    let assessmentStatus = "in_progress";
    if (scoredCount === 9) assessmentStatus = "scored";

    // Determine risk band
    let riskBand = "LOW";
    if (overall >= 3.0) riskBand = "CRITICAL";
    else if (threshold.flagged) riskBand = "HIGH";
    else if (overall >= 2.0) riskBand = "MODERATE";

    // Update projection
    const prevHash = project?.stateHash || "";
    const stateHash = this._computeStateHash(scores, overall, project?.version || 0);

    await this.dbInstance
      .update(riskProjects)
      .set({
        naScore: scores.na, ncScore: scores.nc, nsScore: scores.ns,
        seScore: scores.se, smScore: scores.sm, sfScore: scores.sf,
        lsScore: scores.ls, lrScore: scores.lr, lpScore: scores.lp,
        networkDomain, systemStateDomain: systemDomain, lawDomain,
        overallScore: overall,
        asymmetricScore: asymmetric,
        riskBand,
        riskLevel: threshold.riskLevel,
        aboveThreshold: threshold.aboveThreshold,
        domainCeilingTriggered: threshold.domainCeilingTriggered,
        flagged: threshold.flagged,
        smZone: threshold.smZone,
        discretionClusterCount: threshold.discretionClusterCount,
        discretionClusterCells: threshold.discretionClusterCells,
        smEffective: smEffective,
        scoredCellCount: scoredCount,
        assessmentStatus,
        stateHash,
        prevStateHash: prevHash,
        mergeCount: (project?.mergeCount || 0) + 1,
        version: (project?.version || 0) + 1,
        updatedAt: new Date(),
      })
      .where(eq(riskProjects.objectId, objectId));

    return threshold;
  }

  /**
   * Compute type hash for risk objects.
   * Format: SHA256(vertical:objectKind:subtype)
   */
  private _computeTypeHash(objectKind: string, subtype: string): string {
    const { createHash } = require("crypto");
    const input = `${VERTICAL}:${objectKind}:${subtype}`;
    return createHash("sha256").update(input).digest("hex");
  }

  /**
   * Compute a deterministic state hash from scores + version.
   */
  private _computeStateHash(scores: ScoreVector, overall: number, version: number): string {
    const { createHash } = require("crypto");
    const input = JSON.stringify({
      scores: Object.fromEntries(
        CELL_KEYS.map(k => [k, scores[k] ?? null]).sort()
      ),
      overall,
      version: version + 1,
    });
    return createHash("sha256").update(input).digest("hex");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Reads (for UI / API)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * getProjectWithScores: Returns the full project assessment state.
   */
  async getProjectWithScores(objectId: string) {
    const project = await this.dbInstance.query.riskProjects.findFirst({
      where: eq(riskProjects.objectId, objectId),
      with: {
        cellStates: true,
        mitigations: { orderBy: (m: any, { desc }: any) => [desc(m.priority)] },
        challenges: { orderBy: (c: any, { desc }: any) => [desc(c.createdAt)] },
        selectionGates: { orderBy: (g: any, { desc }: any) => [desc(g.openedAt)] },
      },
    });
    return project;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

export {
  CELL_KEYS,
  CELL_TO_DOMAIN,
  CELL_SPP_ROLE,
  ASYMMETRY_RATIOS,
  DISCRETION_CLUSTER,
  computeDomainScore,
  computeOverallScore,
  computeAsymmetricScore,
  computeThreshold,
};
export type { CellKey };
