const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, LevelFormat,
  HeadingLevel, BorderStyle, WidthType, ShadingType,
  PageNumber, PageBreak, TabStopType, TabStopPosition,
} = require("docx");

// ─── Constants ──────────────────────────────────────────
const PAGE_WIDTH = 12240;
const MARGINS = { top: 1440, right: 1296, bottom: 1440, left: 1296 };
const CONTENT_WIDTH = PAGE_WIDTH - MARGINS.left - MARGINS.right;
const ACCENT = "1B4F72";
const ACCENT_LIGHT = "D4E6F1";
const ACCENT_MED = "2E86C1";
const GREY = "F8F9FA";
const BORDER_LIGHT = { style: BorderStyle.SINGLE, size: 1, color: "D5D8DC" };
const BORDERS = { top: BORDER_LIGHT, bottom: BORDER_LIGHT, left: BORDER_LIGHT, right: BORDER_LIGHT };
const CELL_MARGINS = { top: 80, bottom: 80, left: 120, right: 120 };

// ─── Helpers ────────────────────────────────────────────
function heading(level, text) {
  return new Paragraph({
    heading: level,
    spacing: { before: level === HeadingLevel.HEADING_1 ? 400 : 240, after: 200 },
    children: [new TextRun({ text, bold: true, font: "Arial", size: level === HeadingLevel.HEADING_1 ? 32 : level === HeadingLevel.HEADING_2 ? 28 : 24, color: ACCENT })],
  });
}

function para(text, opts = {}) {
  return new Paragraph({
    spacing: { after: 160 },
    children: [new TextRun({ text, font: "Arial", size: 22, ...opts })],
  });
}

function paraRuns(runs) {
  return new Paragraph({
    spacing: { after: 160 },
    children: runs.map(r => typeof r === "string" ? new TextRun({ text: r, font: "Arial", size: 22 }) : new TextRun({ font: "Arial", size: 22, ...r })),
  });
}

function bullet(text, ref = "bullets", level = 0) {
  return new Paragraph({
    numbering: { reference: ref, level },
    spacing: { after: 80 },
    children: [new TextRun({ text, font: "Arial", size: 22 })],
  });
}

function bulletBold(boldPart, rest, ref = "bullets") {
  return new Paragraph({
    numbering: { reference: ref, level: 0 },
    spacing: { after: 80 },
    children: [
      new TextRun({ text: boldPart, font: "Arial", size: 22, bold: true }),
      new TextRun({ text: rest, font: "Arial", size: 22 }),
    ],
  });
}

function headerCell(text, width) {
  return new TableCell({
    borders: BORDERS, width: { size: width, type: WidthType.DXA },
    shading: { fill: ACCENT, type: ShadingType.CLEAR },
    margins: CELL_MARGINS,
    children: [new Paragraph({ children: [new TextRun({ text, font: "Arial", size: 20, bold: true, color: "FFFFFF" })] })],
  });
}

function cell(text, width, shade) {
  return new TableCell({
    borders: BORDERS, width: { size: width, type: WidthType.DXA },
    shading: shade ? { fill: shade, type: ShadingType.CLEAR } : undefined,
    margins: CELL_MARGINS,
    children: [new Paragraph({ children: [new TextRun({ text, font: "Arial", size: 20 })] })],
  });
}

function cellBold(text, width, shade) {
  return new TableCell({
    borders: BORDERS, width: { size: width, type: WidthType.DXA },
    shading: shade ? { fill: shade, type: ShadingType.CLEAR } : undefined,
    margins: CELL_MARGINS,
    children: [new Paragraph({ children: [new TextRun({ text, font: "Arial", size: 20, bold: true })] })],
  });
}

function cellMulti(runs, width, shade) {
  return new TableCell({
    borders: BORDERS, width: { size: width, type: WidthType.DXA },
    shading: shade ? { fill: shade, type: ShadingType.CLEAR } : undefined,
    margins: CELL_MARGINS,
    children: [new Paragraph({ children: runs.map(r => new TextRun({ font: "Arial", size: 20, ...r })) })],
  });
}

// ─── Build Document ─────────────────────────────────────
const COL1 = 2400;
const COL2 = 2600;
const COL3 = 2200;
const COL4 = 2448;

const COL_A = 1800;
const COL_B = 2700;
const COL_C = 2700;
const COL_D = 2448;

const doc = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 22 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, font: "Arial", color: ACCENT },
        paragraph: { spacing: { before: 400, after: 200 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, font: "Arial", color: ACCENT },
        paragraph: { spacing: { before: 300, after: 180 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 24, bold: true, font: "Arial", color: ACCENT_MED },
        paragraph: { spacing: { before: 240, after: 160 }, outlineLevel: 2 } },
    ],
  },
  numbering: {
    config: [
      {
        reference: "bullets",
        levels: [
          { level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
          { level: 1, format: LevelFormat.BULLET, text: "\u25E6", alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 1440, hanging: 360 } } } },
        ],
      },
      {
        reference: "numbers",
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }],
      },
      {
        reference: "phases",
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "Phase %1:", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 720 } } } }],
      },
    ],
  },
  sections: [
    // ════════════════════════════════════════
    // COVER / TITLE
    // ════════════════════════════════════════
    {
      properties: {
        page: {
          size: { width: PAGE_WIDTH, height: 15840 },
          margin: MARGINS,
        },
      },
      headers: {
        default: new Header({ children: [
          new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: ACCENT, space: 4 } },
            children: [
              new TextRun({ text: "BREM Semantic Compiler Migration", font: "Arial", size: 18, color: "999999" }),
            ],
            tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
          }),
        ] }),
      },
      footers: {
        default: new Footer({ children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: "Page ", font: "Arial", size: 18, color: "999999" }),
              new TextRun({ children: [PageNumber.CURRENT], font: "Arial", size: 18, color: "999999" }),
            ],
          }),
        ] }),
      },
      children: [
        new Paragraph({ spacing: { before: 2400 } }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
          children: [new TextRun({ text: "BREM Semantic Compiler", font: "Arial", size: 56, bold: true, color: ACCENT })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 100 },
          children: [new TextRun({ text: "Migration Philosophy, Architecture & Roadmap", font: "Arial", size: 32, color: ACCENT_MED })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 600 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: ACCENT, space: 20 } },
          children: [new TextRun({ text: "Applying the OJT Semantic Commerce Compiler architecture to the Blockchain Risk Evaluation Model", font: "Arial", size: 22, italics: true, color: "666666" })],
        }),
        new Paragraph({ spacing: { after: 200 } }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: "Version 1.0  \u2014  March 2026", font: "Arial", size: 22, color: "888888" })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 100 },
          children: [new TextRun({ text: "Todd Price", font: "Arial", size: 22, color: "888888" })],
        }),
        new Paragraph({ spacing: { before: 1200 } }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: "CONFIDENTIAL", font: "Arial", size: 20, bold: true, color: "CC0000" })],
        }),

        // ════════════════════════════════════════
        // PAGE BREAK → EXECUTIVE SUMMARY
        // ════════════════════════════════════════
        new Paragraph({ children: [new PageBreak()] }),

        heading(HeadingLevel.HEADING_1, "1. Executive Summary"),
        para("BREM (Blockchain Risk Evaluation Model) is already a compiler. The 9-cell SP\u00B2P matrix is a type system. The branching decision logic is a pattern matcher. The asymmetric weighting is an optimiser. The 83-project dataset is a training corpus with empirical validation (F1=0.929, 92.5% sensitivity, 100% specificity on resolved projects)."),
        para("But it is an incomplete compiler. It scores once and forgets. It cannot track how a project changes over time. It cannot explain what changed between assessments. Its de-risking recommendations are free-form narrative, not typed instruments that can be tracked, ordered by impact, and verified when implemented. And it cannot learn from its own prediction errors."),
        para("This document maps the proven OJT (OddJobTodd) semantic commerce compiler architecture onto BREM, identifying exactly which OJT components solve which BREM gaps. It defines a migration philosophy, formal architecture mappings, typed data structures, and a phased implementation roadmap that transforms BREM from a one-shot diagnostic tool into a living, learning risk compiler."),

        // ════════════════════════════════════════
        // 2. MIGRATION PHILOSOPHY
        // ════════════════════════════════════════
        new Paragraph({ children: [new PageBreak()] }),
        heading(HeadingLevel.HEADING_1, "2. Migration Philosophy"),

        heading(HeadingLevel.HEADING_2, "2.1 What We Are NOT Doing"),
        para("We are not replacing the BREM methodology. The SP\u00B2P framework, the 9-cell matrix, the branching decision instrument, and the empirical dataset are the crown jewels. They work. The scoring rubric achieves Cohen\u2019s \u03BA = 0.81 at cell level. The threshold rule (overall \u2265 2.5) catches 92.5% of failures with zero false positives among resolved projects. The sm diagnostic variable (\u2264 2 = 0% failure rate) is the single strongest predictor in the entire model."),
        para("None of this changes."),

        heading(HeadingLevel.HEADING_2, "2.2 What We ARE Doing"),
        para("We are wrapping the existing BREM scoring engine in a compiler pipeline that adds four capabilities it currently lacks:"),
        bulletBold("Accumulated State. ", "Assessments become living documents. Each new evidence upload, chat exchange, or external event merges into a persistent project state with cryptographic hashing at every boundary."),
        bulletBold("Delta Tracking. ", "Every state change is captured as a typed diff. When Stripe adds independent validators (nc: 4\u21922), the system can say exactly what changed, when, and what the score impact was."),
        bulletBold("Typed Mitigation Instruments. ", "De-risking recommendations become first-class objects with target cells, impact scores, dependency chains, and verification criteria\u2014not prose buried in reports."),
        bulletBold("Profile-Guided Optimisation (PGO). ", "When scored projects resolve (fail or survive), the outcome feeds back into weight calibration and signal attribution, systematically improving accuracy over time."),

        heading(HeadingLevel.HEADING_2, "2.3 The Guiding Principle"),
        para("Every change must be empirically testable against the 83-project dataset. If a change does not improve F1, sensitivity, or specificity on the existing data, it does not ship. The dataset is the ground truth. The compiler serves the dataset, not the other way around."),

        // ════════════════════════════════════════
        // 3. ARCHITECTURE MAPPING
        // ════════════════════════════════════════
        new Paragraph({ children: [new PageBreak()] }),
        heading(HeadingLevel.HEADING_1, "3. Architecture Mapping: OJT \u2192 BREM"),
        para("The table below maps each compiler phase from OJT\u2019s semantic commerce pipeline to its BREM equivalent. Where BREM currently has no equivalent, the \u201CBREM (Target)\u201D column describes what will be built."),

        new Table({
          width: { size: CONTENT_WIDTH, type: WidthType.DXA },
          columnWidths: [COL1, COL2, COL3, COL4],
          rows: [
            new TableRow({ children: [
              headerCell("Phase", COL1),
              headerCell("OJT (Current)", COL2),
              headerCell("BREM (Current)", COL3),
              headerCell("BREM (Target)", COL4),
            ] }),
            new TableRow({ children: [
              cellBold("SOURCE", COL1, GREY),
              cell("Customer message (text/voice/photo)", COL2),
              cell("Whitepaper, docs, regulatory filings", COL3),
              cell("Same + live monitoring feeds", COL4),
            ] }),
            new TableRow({ children: [
              cellBold("LEXER", COL1, GREY),
              cell("extractionSchema.ts \u2014 Zod-validated MessageExtraction", COL2),
              cell("Haiku chunking \u2014 extract relevant text per cell", COL3),
              cell("Same, but chunks accumulate into evidence chains", COL4),
            ] }),
            new TableRow({ children: [
              cellBold("PARSER", COL1, GREY),
              cell("mergeExtraction() \u2014 AccumulatedJobState with delta tracking", COL2),
              cell("MISSING \u2014 no state accumulation", COL3),
              cell("mergeEvidence() \u2014 AccumulatedProjectState with per-cell evidence, hashes, deltas", COL4),
            ] }),
            new TableRow({ children: [
              cellBold("AST", COL1, GREY),
              cell("AccumulatedJobState \u2014 40+ typed fields across 5 dimensions", COL2),
              cell("MISSING \u2014 scores are ephemeral", COL3),
              cell("AccumulatedProjectState \u2014 9 cell evidence chains + classification + history", COL4),
            ] }),
            new TableRow({ children: [
              cellBold("TYPE\nCHECKER", COL1, GREY),
              cell("categoryResolver.ts \u2014 WHAT/HOW/INST triple resolution", COL2),
              cell("Threat model in LLM prompt (untyped)", COL3),
              cell("ProjectClassifier \u2014 typed resolution of protocol family, threat model, governance type", COL4),
            ] }),
            new TableRow({ children: [
              cellBold("OPTIMISER", COL1, GREY),
              cell("quoteWorthinessService \u2014 weighted scoring with category adjustments", COL2),
              cell("Asymmetric weights + domain ceiling (deterministic post-Claude)", COL3),
              cell("Same + PGO-calibrated weights from outcome feedback", COL4),
            ] }),
            new TableRow({ children: [
              cellBold("CODEGEN", COL1, GREY),
              cell("instrumentService.ts \u2014 6 typed renderers (ROM, fixed-price, itemised, etc.)", COL2),
              cell("HTML report synthesis (free-form)", COL3),
              cell("Typed MitigationInstrument[] + typed report + comparison instruments", COL4),
            ] }),
            new TableRow({ children: [
              cellBold("RUNTIME", COL1, GREY),
              cell("Chat loop \u2014 multi-turn extraction + scoring", COL2),
              cell("Chat loop (5 tool-use rounds, 3 continuations)", COL3),
              cell("Same + re-scoring on evidence change + monitoring triggers", COL4),
            ] }),
            new TableRow({ children: [
              cellBold("DIAGNOSTICS", COL1, GREY),
              cell("disagreementAnalysis.ts \u2014 PGO with signal attribution", COL2),
              cell("MISSING \u2014 no outcome feedback", COL3),
              cell("BREMDisagreementAnalysis \u2014 outcome feedback, weight calibration, signal attribution", COL4),
            ] }),
          ],
        }),

        // ════════════════════════════════════════
        // 4. TYPED DATA STRUCTURES
        // ════════════════════════════════════════
        new Paragraph({ children: [new PageBreak()] }),
        heading(HeadingLevel.HEADING_1, "4. Core Typed Data Structures"),

        heading(HeadingLevel.HEADING_2, "4.1 ProjectClassification (Type Checker)"),
        para("Resolved deterministically before cell scoring begins. Drives weight adjustments, composition rules, and benchmark matching. This is the BREM equivalent of OJT\u2019s CategoryResolution."),

        new Table({
          width: { size: CONTENT_WIDTH, type: WidthType.DXA },
          columnWidths: [2200, 2000, 5448],
          rows: [
            new TableRow({ children: [
              headerCell("Field", 2200),
              headerCell("Type", 2000),
              headerCell("Values / Description", 5448),
            ] }),
            new TableRow({ children: [
              cellBold("protocolFamily", 2200, GREY), cell("enum", 2000),
              cell("utxo | account_based | dag | hybrid | custodial | custom", 5448),
            ] }),
            new TableRow({ children: [
              cellBold("threatModel", 2200, GREY), cell("enum", 2000),
              cell("cooperative | adversarial | hybrid \u2014 from SPF 2.0 Threat Model Context Filter", 5448),
            ] }),
            new TableRow({ children: [
              cellBold("governanceType", 2200, GREY), cell("enum", 2000),
              cell("single_entity | consortium | open_community | dao | immutable", 5448),
            ] }),
            new TableRow({ children: [
              cellBold("platformCount", 2200, GREY), cell("number", 2000),
              cell("Number of independent platforms for dependency decomposition (Extension 1)", 5448),
            ] }),
            new TableRow({ children: [
              cellBold("segment", 2200, GREY), cell("enum", 2000),
              cell("enterprise | defi \u2014 determines benchmark pool", 5448),
            ] }),
            new TableRow({ children: [
              cellBold("typeHash", 2200, GREY), cell("string (64 hex)", 2000),
              cell("SHA256(protocolFamily + \":\" + threatModel + \":\" + governanceType) \u2014 bridges to Semantos", 5448),
            ] }),
          ],
        }),

        new Paragraph({ spacing: { after: 200 } }),

        heading(HeadingLevel.HEADING_2, "4.2 AccumulatedProjectState (AST)"),
        para("The persistent, versioned state of a BREM assessment. Every evidence merge produces a new state hash. Every cell re-score is a delta against the previous state."),

        new Table({
          width: { size: CONTENT_WIDTH, type: WidthType.DXA },
          columnWidths: [2400, 7248],
          rows: [
            new TableRow({ children: [
              headerCell("Component", 2400),
              headerCell("Contents", 7248),
            ] }),
            new TableRow({ children: [
              cellBold("classification", 2400, GREY),
              cell("ProjectClassification (resolved at Step 0, immutable for assessment version)", 7248),
            ] }),
            new TableRow({ children: [
              cellBold("cellStates[9]", 2400, GREY),
              cell("Per-cell: { score, branchPath, evidence[], reasoning, confidence, lastScoredAt, evidenceHash }", 7248),
            ] }),
            new TableRow({ children: [
              cellBold("domainScores[3]", 2400, GREY),
              cell("Network, SystemState, Law \u2014 derived (mean of 3 cells each)", 7248),
            ] }),
            new TableRow({ children: [
              cellBold("overallScore", 2400, GREY),
              cell("Derived: mean of 9 cells (flat) + asymmetric-weighted + domain ceiling flags", 7248),
            ] }),
            new TableRow({ children: [
              cellBold("extensions", 2400, GREY),
              cell("{ smEffective, asymmetricScore, domainCeilingFlags[], dependencyPenalty }", 7248),
            ] }),
            new TableRow({ children: [
              cellBold("mitigations[]", 2400, GREY),
              cell("Array of MitigationInstrument objects (see \u00A74.3)", 7248),
            ] }),
            new TableRow({ children: [
              cellBold("stateHash", 2400, GREY),
              cell("SHA256 of full serialised state \u2014 integrity anchor", 7248),
            ] }),
            new TableRow({ children: [
              cellBold("prevStateHash", 2400, GREY),
              cell("Hash of state before last merge \u2014 Patch cell PREV-STATE", 7248),
            ] }),
            new TableRow({ children: [
              cellBold("version", 2400, GREY),
              cell("Monotonic version counter (increments on every evidence merge)", 7248),
            ] }),
          ],
        }),

        new Paragraph({ spacing: { after: 200 } }),

        heading(HeadingLevel.HEADING_2, "4.3 MitigationInstrument (Codegen)"),
        para("Each de-risking recommendation is a first-class typed object. Replaces free-form prose in assessment reports. Enables tracking, ordering by impact, dependency resolution, and verification."),

        new Table({
          width: { size: CONTENT_WIDTH, type: WidthType.DXA },
          columnWidths: [2200, 1800, 5648],
          rows: [
            new TableRow({ children: [
              headerCell("Field", 2200),
              headerCell("Type", 1800),
              headerCell("Description", 5648),
            ] }),
            new TableRow({ children: [
              cellBold("cell", 2200, GREY), cell("BREMCell", 1800),
              cell("Target cell (na, nc, ns, se, sm, sf, ls, lr, lp)", 5648),
            ] }),
            new TableRow({ children: [
              cellBold("currentScore", 2200, GREY), cell("0\u20134", 1800),
              cell("Score at time of recommendation", 5648),
            ] }),
            new TableRow({ children: [
              cellBold("targetScore", 2200, GREY), cell("0\u20134", 1800),
              cell("Score achievable if mitigation implemented", 5648),
            ] }),
            new TableRow({ children: [
              cellBold("action", 2200, GREY), cell("string (slug)", 1800),
              cell("Machine-readable action (expand_validator_set, publish_governance, etc.)", 5648),
            ] }),
            new TableRow({ children: [
              cellBold("description", 2200, GREY), cell("string", 1800),
              cell("Human-readable description of what needs to happen", 5648),
            ] }),
            new TableRow({ children: [
              cellBold("impact", 2200, GREY), cell("enum", 1800),
              cell("critical | high | moderate | low \u2014 derived from asymmetric weight of target cell", 5648),
            ] }),
            new TableRow({ children: [
              cellBold("asymmetryRatio", 2200, GREY), cell("number", 1800),
              cell("Cell\u2019s empirical asymmetry (nc=8.22, se=4.53, na=2.07, etc.) \u2014 orders priority", 5648),
            ] }),
            new TableRow({ children: [
              cellBold("dependencies", 2200, GREY), cell("string[]", 1800),
              cell("Other mitigations that must complete first (e.g., sm must drop before nc can)", 5648),
            ] }),
            new TableRow({ children: [
              cellBold("precedent", 2200, GREY), cell("string | null", 1800),
              cell("Reference to a project in the 83-project dataset that implemented this mitigation", 5648),
            ] }),
            new TableRow({ children: [
              cellBold("verificationCriteria", 2200, GREY), cell("string", 1800),
              cell("What evidence would prove implementation (on-chain verification, governance doc URL, etc.)", 5648),
            ] }),
            new TableRow({ children: [
              cellBold("status", 2200, GREY), cell("enum", 1800),
              cell("recommended | in_progress | implemented | verified | rejected", 5648),
            ] }),
          ],
        }),

        new Paragraph({ spacing: { after: 200 } }),

        heading(HeadingLevel.HEADING_2, "4.4 BREMDisagreementResult (Diagnostics)"),
        para("When a scored project resolves, the outcome is classified against the BREM prediction. This is the direct equivalent of OJT\u2019s disagreementAnalysis.ts."),

        new Table({
          width: { size: CONTENT_WIDTH, type: WidthType.DXA },
          columnWidths: [3200, 6448],
          rows: [
            new TableRow({ children: [
              headerCell("Classification", 3200),
              headerCell("Definition", 6448),
            ] }),
            new TableRow({ children: [
              cellBold("true_positive", 3200, GREY),
              cell("BREM predicted elevated risk (\u22652.5), project failed", 6448),
            ] }),
            new TableRow({ children: [
              cellBold("true_negative", 3200, GREY),
              cell("BREM predicted safe (<2.5), project survived", 6448),
            ] }),
            new TableRow({ children: [
              cellBold("false_negative", 3200, GREY),
              cell("BREM predicted safe, project failed \u2014 which cells were underscored?", 6448),
            ] }),
            new TableRow({ children: [
              cellBold("false_positive", 3200, GREY),
              cell("BREM predicted risk, project survived \u2014 which cells were overscored?", 6448),
            ] }),
            new TableRow({ children: [
              cellBold("domain_masked", 3200, GREY),
              cell("Overall <2.5 but domain >3.0 \u2014 did domain ceiling rule correctly flag?", 6448),
            ] }),
          ],
        }),

        para("For each disagreement, signal attribution identifies which cells contributed most to the error, and suggests specific weight adjustments with confidence levels. Over time, this auto-calibrates the asymmetric weights (nc: 8.22\u00D7, se: 4.53\u00D7) from the empirical data rather than deriving them once from the initial 83-project dataset."),

        // ════════════════════════════════════════
        // 5. CUSTOMER SEGMENT IMPACT
        // ════════════════════════════════════════
        new Paragraph({ children: [new PageBreak()] }),
        heading(HeadingLevel.HEADING_1, "5. Impact on Customer Segments"),

        heading(HeadingLevel.HEADING_2, "5.1 Pre-Audit Founders ($499 self-service / $2,499 certified)"),
        para("Current: One-shot report. Upload docs, get 9-cell score, read recommendations."),
        para("With compiler: Living assessment. Upload initial docs, get scored. Then implement mitigations and re-upload evidence. The system re-scores only the affected cells, shows the delta (\u201Cnc dropped 4\u21922 after adding independent validators\u201D), and updates the mitigation instrument status. The founder sees a roadmap from their current score to below-threshold, ordered by impact. Each mitigation has verification criteria \u2014 they know exactly when they\u2019re done."),
        para("Revenue impact: Converts a transactional $499 into a subscription. Founders return after each milestone to re-score. The $2,499 certified tier becomes a \u201Cde-risking programme\u201D with milestone tracking."),

        heading(HeadingLevel.HEADING_2, "5.2 VC Analysts ($5K/mo portfolio tier)"),
        para("Current: Individual assessments compared manually."),
        para("With compiler: Portfolio-level diagnostics. Aggregate MitigationInstruments across 12 portfolio companies: \u201C8 of your 12 investments have nc\u22653. Consensus is your portfolio\u2019s systematic risk. Here are the 5 highest-impact mitigations across the portfolio, ordered by asymmetric weight.\u201D The PGO loop means the portfolio risk model improves with every outcome resolution."),
        para("Revenue impact: Portfolio dashboards become indispensable. The compiler\u2019s ability to track mitigation progress across investments justifies the $5K/mo as an ongoing operating tool, not a one-time analysis."),

        heading(HeadingLevel.HEADING_2, "5.3 Grant Program Managers ($50K\u2013$200K/yr)"),
        para("Current: Bulk scoring of applications."),
        para("With compiler: Typed mitigations with dependency chains become grant conditions. \u201CWe\u2019ll fund you at sm=3, but the second tranche requires publishing a governance framework (sm\u21922) within 6 months. Verification: governance-framework.pdf uploaded and cell re-scored.\u201D The delta tracking proves compliance. The ecosystem can track aggregate sm scores across all grantees over time."),
        para("Revenue impact: Contract value increases because the tool now enforces conditions, not just diagnoses risk."),

        // ════════════════════════════════════════
        // 6. SEMANTOS BRIDGE
        // ════════════════════════════════════════
        new Paragraph({ children: [new PageBreak()] }),
        heading(HeadingLevel.HEADING_1, "6. Semantos Bridge"),

        para("Every BREM assessment maps to semantos 1KB cells using the identical bridge architecture built for OJT:"),

        bulletBold("TYPE-HASH = SHA256(protocolFamily + \":\" + threatModel + \":\" + governanceType)", " \u2014 same 32 bytes in TypeScript and Forth. Routes cells to the correct handler in the Semantos dispatch system."),
        bulletBold("Container (AFFINE) = AccumulatedProjectState", " \u2014 mutable as evidence accumulates, can be safely discarded if assessment is abandoned."),
        bulletBold("Patch (LINEAR) = EvidenceMerge", " \u2014 each evidence merge is consumed exactly once, with PREV-STATE validation preventing double-application."),
        bulletBold("Capsule (RELEVANT) = Final Assessment Report", " \u2014 immutable, referenceable by all parties, potentially BRC-52 signed for cryptographic attestation."),
        bulletBold("MitigationInstrument \u2192 Capsule", " \u2014 each typed mitigation can be sealed as an independent Capsule when verified, creating an auditable chain of de-risking actions."),

        para("The 83-project dataset becomes a library of reference Capsules. When scoring a new project, the type checker finds the nearest typed match by type hash prefix (same protocolFamily + governanceType) and surfaces it as a benchmark \u2014 not by LLM similarity search, but by deterministic type matching."),

        // ════════════════════════════════════════
        // 7. COMPOSITION RULES
        // ════════════════════════════════════════
        heading(HeadingLevel.HEADING_1, "7. Multi-Platform Composition Rules"),

        para("Project Acacia and Project Guardian exposed that the SP\u00B2P framework cannot properly decompose multi-dependency systems. The current sm_eff = min(4, sm_base + \u2308log\u2082N\u2309) applies uniformly, but the Acacia assessment itself noted that composition rules differ by cell."),
        para("The compiler types these rules explicitly:"),

        new Table({
          width: { size: CONTENT_WIDTH, type: WidthType.DXA },
          columnWidths: [1400, 2800, 5448],
          rows: [
            new TableRow({ children: [
              headerCell("Cell", 1400),
              headerCell("Composition Rule", 2800),
              headerCell("Rationale", 5448),
            ] }),
            new TableRow({ children: [
              cellBold("na", 1400, GREY), cell("max(platform scores) + interop penalty", 2800),
              cell("Worst architecture dominates; interoperability adds its own surface", 5448),
            ] }),
            new TableRow({ children: [
              cellBold("nc", 1400, GREY), cell("max(platform scores)", 2800),
              cell("Weakest consensus dominates system finality guarantees", 5448),
            ] }),
            new TableRow({ children: [
              cellBold("ns", 1400, GREY), cell("score of bottleneck platform", 2800),
              cell("System throughput limited by slowest link; best scalability irrelevant if bottleneck exists", 5448),
            ] }),
            new TableRow({ children: [
              cellBold("se", 1400, GREY), cell("max(platform scores) + log\u2082(N) penalty", 2800),
              cell("Execution risk is additive; each platform\u2019s vulnerability surface combines", 5448),
            ] }),
            new TableRow({ children: [
              cellBold("sm", 1400, GREY), cell("min(4, sm_base + \u2308log\u2082N\u2309)", 2800),
              cell("Union of all governance bodies; uncoordinated mutation compounds", 5448),
            ] }),
            new TableRow({ children: [
              cellBold("sf", 1400, GREY), cell("weighted avg by TVL share", 2800),
              cell("Economics weighted by where value actually sits", 5448),
            ] }),
            new TableRow({ children: [
              cellBold("ls/lr/lp", 1400, GREY), cell("score of weakest jurisdiction", 2800),
              cell("Legal chain is only as strong as its weakest link; cross-border gaps dominate", 5448),
            ] }),
          ],
        }),

        // ════════════════════════════════════════
        // 8. ROADMAP
        // ════════════════════════════════════════
        new Paragraph({ children: [new PageBreak()] }),
        heading(HeadingLevel.HEADING_1, "8. Implementation Roadmap"),

        heading(HeadingLevel.HEADING_2, "Phase 1: Typed Infrastructure (Weeks 1\u20133)"),
        para("Zero blockchain dependency. Pure TypeScript. Testable against the 83-project dataset."),
        bulletBold("ProjectClassifier ", "\u2014 resolve protocolFamily, threatModel, governanceType from project metadata. Validate against all 83 projects."),
        bulletBold("AccumulatedProjectState ", "\u2014 data structure with per-cell evidence chains, stateHash, prevStateHash, version counter."),
        bulletBold("mergeEvidence() ", "\u2014 evidence merge function with delta tracking (direct port of OJT\u2019s mergeExtraction pattern)."),
        bulletBold("MitigationInstrument type ", "\u2014 full typed structure with action slugs, impact scoring from asymmetric weights, dependency chains."),
        bulletBold("Mitigation generator ", "\u2014 given a scored project, emit ordered MitigationInstrument[] for all cells \u22652. Highest asymmetry ratio first."),
        bullet("Deliverable: Run all 83 projects through the typed pipeline. Verify scores match existing dataset within \u00B10.1."),

        heading(HeadingLevel.HEADING_2, "Phase 2: Diagnostics Engine (Weeks 4\u20135)"),
        para("The PGO feedback loop. Uses the 40 resolved failures and 22 resolved successes as the training set."),
        bulletBold("BREMDisagreementAnalysis ", "\u2014 classify each resolved project: TP, TN, FP, FN, domain-masked."),
        bulletBold("Signal attribution ", "\u2014 for each FN (HSBC FX, NASDAQ Linq, SETL), identify which cells were underscored and by how much."),
        bulletBold("Weight calibration ", "\u2014 auto-derive asymmetric weights from the dataset (currently hand-derived). Verify they converge to within 10% of the published values."),
        bulletBold("Composition rule validation ", "\u2014 apply typed composition rules to Acacia/Guardian and verify they improve scoring accuracy vs monolithic assessment."),
        bullet("Deliverable: PGO-calibrated weights. Documented improvement (or confirmation) of F1 vs current 0.929."),

        heading(HeadingLevel.HEADING_2, "Phase 3: Agent Integration (Weeks 6\u20138)"),
        para("Wire the typed infrastructure into the existing BREM agent pipeline."),
        bulletBold("Stage 0 injection ", "\u2014 ProjectClassifier runs before cell scoring. Classification result injected into every cell prompt."),
        bulletBold("Evidence accumulation ", "\u2014 replace ephemeral scoring with persistent AccumulatedProjectState. Each chat round and document upload merges into state."),
        bulletBold("Mitigation codegen ", "\u2014 replace free-form de-risking prose with structured MitigationInstrument[] in the synthesis stage."),
        bulletBold("Re-scoring ", "\u2014 when new evidence arrives for a specific cell, re-score only that cell and recompute domains/overall."),
        bullet("Deliverable: Assessment agent produces typed, ordered mitigations. Re-scoring on evidence change works."),

        heading(HeadingLevel.HEADING_2, "Phase 4: Semantos Bridge (Weeks 9\u201310)"),
        para("Connect BREM assessments to the semantos 1KB cell model."),
        bulletBold("Type hash registry ", "\u2014 extend OJT\u2019s typeHashRegistry.ts with BREM classification hashes."),
        bulletBold("Cell serialisation ", "\u2014 pack AccumulatedProjectState into Container cells, evidence merges into Patch cells, final reports into Capsule cells."),
        bulletBold("commerce-header.fs extension ", "\u2014 add BREM phase constants to the Forth header."),
        bullet("Deliverable: BREM assessments are serialisable as semantos cells. Roundtrip pack/unpack tests pass."),

        heading(HeadingLevel.HEADING_2, "Phase 5: Product Integration (Weeks 11\u201312)"),
        para("Customer-facing features built on the compiler infrastructure."),
        bulletBold("Living assessments ", "\u2014 founders upload new evidence, system re-scores affected cells and shows delta."),
        bulletBold("Mitigation roadmap UI ", "\u2014 visual mitigation tracker ordered by impact, with dependency chains and verification status."),
        bulletBold("Portfolio diagnostics ", "\u2014 VC dashboard aggregating MitigationInstruments across portfolio companies."),
        bulletBold("Grant condition engine ", "\u2014 API for ecosystem grant programs to set typed, verifiable conditions based on cell scores."),
        bullet("Deliverable: All three customer segments (founder, VC, grant program) have compiler-powered features live."),

        // ════════════════════════════════════════
        // 9. SUCCESS METRICS
        // ════════════════════════════════════════
        new Paragraph({ children: [new PageBreak()] }),
        heading(HeadingLevel.HEADING_1, "9. Success Metrics"),

        new Table({
          width: { size: CONTENT_WIDTH, type: WidthType.DXA },
          columnWidths: [3800, 2824, 3024],
          rows: [
            new TableRow({ children: [
              headerCell("Metric", 3800),
              headerCell("Current", 2824),
              headerCell("Target", 3024),
            ] }),
            new TableRow({ children: [
              cellBold("F1 Score (resolved projects)", 3800),
              cell("0.929 (with extensions)", 2824),
              cell("\u22650.929 (no regression)", 3024),
            ] }),
            new TableRow({ children: [
              cellBold("Sensitivity", 3800),
              cell("92.5% (37/40 failures)", 2824),
              cell("\u226592.5% (\u226537/40)", 3024),
            ] }),
            new TableRow({ children: [
              cellBold("Specificity (resolved)", 3800),
              cell("100%", 2824),
              cell("100%", 3024),
            ] }),
            new TableRow({ children: [
              cellBold("PGO weight convergence", 3800),
              cell("N/A (hand-derived)", 2824),
              cell("Auto-derived within \u00B110% of published", 3024),
            ] }),
            new TableRow({ children: [
              cellBold("Mitigation instruments per assessment", 3800),
              cell("0 (prose only)", 2824),
              cell("3\u20137 typed, ordered by impact", 3024),
            ] }),
            new TableRow({ children: [
              cellBold("Re-score latency (single cell)", 3800),
              cell("Full re-run (~45s)", 2824),
              cell("<5s (targeted cell re-score)", 3024),
            ] }),
            new TableRow({ children: [
              cellBold("Assessment state versions", 3800),
              cell("1 (ephemeral)", 2824),
              cell("Unlimited (persisted with full history)", 3024),
            ] }),
          ],
        }),

        // ════════════════════════════════════════
        // 10. CONCLUSION
        // ════════════════════════════════════════
        new Paragraph({ spacing: { before: 400 } }),
        heading(HeadingLevel.HEADING_1, "10. Conclusion"),

        para("BREM\u2019s empirical methodology is the foundation. The 9-cell matrix with its branching decision logic is a proven type system. The sm diagnostic variable is a genuine discovery \u2014 zero failure rate for sm \u2264 2 across 83 projects. The asymmetric weights and domain ceiling rule push F1 to 0.929."),
        para("The compiler architecture does not replace any of this. It wraps it in infrastructure that makes it persistent, trackable, prescriptive, and self-improving. Accumulated state means assessments evolve. Delta tracking means changes are auditable. Typed mitigations mean recommendations are actionable. PGO means the model gets better with every resolved outcome."),
        para("The result is a system that does not just tell you your project is risky \u2014 it tells you exactly which cells to fix, in what order, with what evidence, and it verifies when you\u2019re done."),
      ],
    },
  ],
});

// ── Write ──────────────────────────────────────────
Packer.toBuffer(doc).then((buffer) => {
  const outPath = "/sessions/charming-inspiring-meitner/mnt/projects/oddjobtodd/docs/brem-semantic-compiler-migration.docx";
  fs.writeFileSync(outPath, buffer);
  console.log(`Written to ${outPath} (${(buffer.length / 1024).toFixed(0)} KB)`);
});
