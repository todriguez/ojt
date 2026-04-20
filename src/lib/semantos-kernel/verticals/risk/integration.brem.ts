/**
 * integration.brem.ts
 *
 * Bridge between the brem-agent (Next.js app) and the semantic kernel.
 *
 * The brem-agent currently operates through:
 *   1. extractFromDocument() → produces cell scores + needsInterrogation
 *   2. ChatInterface.tsx → auto-triggers interrogation for weak cells
 *   3. chat-prompt.ts → instructs agent to call update_scorecard
 *
 * This integration layer translates those flows into semantic kernel operations:
 *   - Extraction result → riskProject + cellStates + selectionGates
 *   - Chat score update → gate advancement + LINEAR patches
 *   - Finalization → gate completion check + status transition
 *
 * Usage pattern (called from brem-agent API routes):
 *
 *   const bridge = new BremSemanticBridge(db);
 *
 *   // After extraction:
 *   const result = await bridge.onExtractionComplete(projectId, extractionResult);
 *   // result.gateIds = gates opened for weak evidence cells
 *   // result.objectId = semantic object ID for subsequent operations
 *
 *   // During chat (when agent calls update_scorecard):
 *   await bridge.onScoreUpdate(objectId, cellKey, newScore, reasoning, channelId, participantId);
 *
 *   // When checking if assessment can be finalized:
 *   const { canFinalize, openCells } = await bridge.checkFinalization(objectId);
 */

import { RiskSemanticAdapter, type CellScoreUpdate, type ProjectClassification } from "./adapter.risk";
import { checkSelectionGateAccess, checkContributionRight, evaluateChannelPolicy } from "../../policyEvaluator";
import type { CellKey } from "./adapter.risk";

// ─────────────────────────────────────────────
// Types — matching brem-agent's extraction output
// ─────────────────────────────────────────────

export interface BremExtractionResult {
  cells: Array<{
    cell: string;
    score: number;
    reasoning: string;
    branchPath?: string;
    q1Answer?: string;
    claims?: string[];
    inferences?: string[];
    deRiskActions?: string[];
  }>;
  summary: string;
  escapeAnalysis: string;
  evidenceQuality: Record<string, string>;
  needsInterrogation: string[];
  highConfidenceCount: number;
  lowConfidenceCount: number;
  needsClarification: string[];
  evidenceQualitySummary?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface BremProjectContext {
  projectId: string;           // legacy Prisma ID
  projectName: string;
  protocolFamily?: string;
  permissionModel?: string;
  consensusFamily?: string;
  architectureType?: string;
  governanceType?: string;
}

export interface ExtractionBridgeResult {
  objectId: string;
  gateIds: string[];
  gatedCells: string[];
  assessmentStatus: string;
}

export interface ScoreUpdateBridgeResult {
  success: boolean;
  gateResolved: boolean;
  gateId?: string;
  newThreshold?: any;
}

// ─────────────────────────────────────────────
// BremSemanticBridge
// ─────────────────────────────────────────────

export class BremSemanticBridge {
  private adapter: RiskSemanticAdapter;

  constructor(db: any) {
    this.adapter = new RiskSemanticAdapter(db);
  }

  /**
   * onExtractionComplete: Called after extractFromDocument() succeeds.
   * Creates/updates the semantic object, records cell scores,
   * and opens selection gates for cells needing interrogation.
   */
  async onExtractionComplete(
    context: BremProjectContext,
    extraction: BremExtractionResult,
    channelId?: string,
    participantId?: string,
  ): Promise<ExtractionBridgeResult> {
    // 1. Ensure semantic object exists
    const classification: ProjectClassification = {
      projectName: context.projectName,
      protocolFamily: context.protocolFamily,
      permissionModel: context.permissionModel,
      consensusFamily: context.consensusFamily,
      architectureType: context.architectureType,
      governanceType: context.governanceType,
    };

    const ctx = await this.adapter.ensureRiskProject(
      classification,
      context.projectId,
      participantId,
    );

    const objectId = ctx.semanticObjectId;

    // 2. Batch-update all cell scores
    const updates: CellScoreUpdate[] = extraction.cells.map(cell => ({
      cellKey: cell.cell as CellKey,
      score: cell.score,
      reasoning: cell.reasoning,
      branchPath: cell.branchPath,
      q1Answer: cell.q1Answer,
      scoringMethod: "agent-scored",
      deRiskActions: cell.deRiskActions,
    }));

    await this.adapter.updateCellScoreBatch(objectId, updates);

    // 3. Open selection gates for cells needing interrogation
    const cellScores: Partial<Record<CellKey, number>> = {};
    for (const cell of extraction.cells) {
      cellScores[cell.cell as CellKey] = cell.score;
    }

    const gateIds = await this.adapter.openGatesFromExtraction(
      objectId,
      extraction.needsInterrogation as CellKey[],
      cellScores,
      ctx.stateHash,
      channelId,
      participantId,
    );

    // 4. Record the extraction as evidence on the semantic object
    await this.adapter.recordEvidence(
      ctx,
      "observation",
      `Extraction complete: ${extraction.cells.length}/9 cells scored. ` +
      `Evidence quality: ${extraction.highConfidenceCount} high, ${extraction.lowConfidenceCount} low. ` +
      `${extraction.needsInterrogation.length} cells flagged for interrogation.`,
      `extraction:${context.projectId}`,
      0.7,
    );

    return {
      objectId,
      gateIds,
      gatedCells: extraction.needsInterrogation,
      assessmentStatus: gateIds.length > 0 ? "gated" : "scored",
    };
  }

  /**
   * onScoreUpdate: Called when the chat agent calls update_scorecard.
   * Records the score change and checks if it resolves any open gates.
   */
  async onScoreUpdate(
    objectId: string,
    cellKey: CellKey,
    newScore: number,
    reasoning: string,
    channelId?: string,
    participantId?: string,
  ): Promise<ScoreUpdateBridgeResult> {
    // 1. Check for open gates on this cell
    const openGates = await this.adapter.getGatesForCell(objectId, cellKey);
    const activeGate = openGates.find(
      (g: any) => ["opened", "interrogating", "escalated"].includes(g.status)
    );

    // 2. If there's a gate, check participant access
    if (activeGate && participantId && channelId) {
      const policy = await evaluateChannelPolicy(channelId, participantId, "contributor");
      if (policy) {
        const gateAccess = checkSelectionGateAccess(policy.roleRule, `gate:${cellKey}`);
        if (gateAccess === "blocked") {
          return { success: false, gateResolved: false };
        }
        if (gateAccess === "observe") {
          // Observer can't update scores — they can only watch
          const canContribute = checkContributionRight(policy.roleRule, "update_scorecard");
          if (!canContribute) {
            return { success: false, gateResolved: false };
          }
        }
      }
    }

    // 3. Update the cell score
    const threshold = await this.adapter.updateCellScore(objectId, {
      cellKey,
      score: newScore,
      reasoning,
      scoringMethod: activeGate ? "gate-interrogation" : "agent-scored",
    });

    // 4. If there's an active gate, advance or resolve it
    let gateResolved = false;
    let gateId: string | undefined;

    if (activeGate) {
      const activeGateId: string = activeGate.id;
      gateId = activeGateId;

      // If score changed from gate open → this is a challenge
      // If score stayed the same → this is confirmation with additional evidence
      const resolution = newScore !== activeGate.scoreAtOpen ? "challenged" : "confirmed";

      // First advance to interrogating if still in opened
      if (activeGate.status === "opened") {
        await this.adapter.advanceGate(activeGate.id, "interrogating");
      }

      await this.adapter.resolveGate(objectId, {
        gateId: activeGateId,
        resolution,
        resolvedByParticipantId: participantId,
        resolutionChannelId: channelId,
        resolutionReason: reasoning,
        scoreAtClose: newScore,
      });

      gateResolved = true;
    }

    return {
      success: true,
      gateResolved,
      gateId,
      newThreshold: threshold,
    };
  }

  /**
   * onInterrogationStart: Called when the chat agent begins probing a cell.
   * Advances the gate from "opened" to "interrogating".
   */
  async onInterrogationStart(
    objectId: string,
    cellKey: CellKey,
  ): Promise<void> {
    const openGates = await this.adapter.getGatesForCell(objectId, cellKey);
    const activeGate = openGates.find(
      (g: any) => g.status === "opened"
    );

    if (activeGate) {
      await this.adapter.advanceGate(activeGate.id, "interrogating");
    }
  }

  /**
   * onCellDelegation: Called when a reviewer delegates a cell to a contributor.
   */
  async onCellDelegation(
    objectId: string,
    cellKey: CellKey,
    assignedToParticipantId: string,
    delegatedByParticipantId: string,
    channelId?: string,
  ): Promise<string | null> {
    return this.adapter.delegateCell(
      objectId,
      cellKey,
      assignedToParticipantId,
      delegatedByParticipantId,
      channelId,
    );
  }

  /**
   * checkFinalization: Returns whether all gates are cleared.
   */
  async checkFinalization(objectId: string) {
    return this.adapter.canFinalize(objectId);
  }

  /**
   * getAssessmentState: Returns the full project state including gates.
   */
  async getAssessmentState(objectId: string) {
    return this.adapter.getProjectWithScores(objectId);
  }

  /**
   * getParticipantInbox: Returns open gates assigned to a participant.
   */
  async getParticipantInbox(participantId: string) {
    return this.adapter.getGatesForParticipant(participantId);
  }
}
