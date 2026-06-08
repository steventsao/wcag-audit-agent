// pipeline.ts — the PDF accessibility business-domain pipeline.
//
// THE REFRAME (binding, final): the a11y agent's workflow is no longer the abstract
// `Routine → Turn → Done` phase model at the report level. It is the PDF-remediation
// DOMAIN pipeline that mirrors the generated report (remediation-report.json):
//
//     Start → Audit source PDF → Create HTML → Review PDF → End
//
//   Audit source PDF = original_failures / wcag_summary / pdfua_summary
//   Create HTML      = cited content layer / semantic HTML / tag plan
//   Review PDF       = emitted-candidate validation / human gates / export snapshots
//
// KEY PRINCIPLE: `routine` (deterministic) is NOT a global phase — it is a TECHNIQUE that
// lives INSIDE a step (Audit reuses the byte probe + contrast pixel math + validator lanes;
// other steps will grow their own). EVERY step is a HYBRID of routine + llm, weighted by
// config. This file makes that explicit: PIPELINE declares, per step, its routine components
// and its llm components (+ a weight, where 1.0 = fully deterministic, 0.0 = fully model).
//
// The Routine→settle→turn loop survives — but DEMOTED to the technique a specialist facet
// runs INSIDE the Audit step (SpecialistWorkflow / ValidatorAgent / ColorContrastAgent are
// unchanged). The pipeline is the new top-level structure; the specialist loop is a tool of it.

import type { Assessment, Evidence } from './a2a';

// ───────────────────────── pipeline taxonomy ─────────────────────────

/** The ordered business-domain steps. Stable identities the report ledger + event log key on. */
export type PipelineStep = 'audit' | 'create-html' | 'review-pdf';

export const PIPELINE_STEPS: PipelineStep[] = ['audit', 'create-html', 'review-pdf'];

/** A single routine (deterministic) OR llm (model) component a step is built from. */
export interface StepComponent {
  /** Stable id (e.g. 'byte-probe', 'contrast-pixel-math', 'llm-alt-quality'). */
  id: string;
  /** One-line description of what this component does. */
  description: string;
}

/**
 * A pipeline step's declaration: its deterministic routine components + its llm components, with a
 * `routineWeight` making the hybrid explicit (1.0 = fully deterministic this build; 0.0 = fully
 * model). The weight is descriptive metadata surfaced in the report — it documents the
 * routine⇄llm split per step so the design (and any future re-weighting) is legible, not buried.
 */
export interface PipelineStepConfig {
  step: PipelineStep;
  /** Human label for the report row. */
  label: string;
  /** Which slice of remediation-report.json this step mirrors. */
  reportKeys: string[];
  /** Deterministic components run inside this step (bytes / pixels / validators). */
  routine: StepComponent[];
  /** Model components run inside this step (VLM / LLM completion routers). */
  llm: StepComponent[];
  /** Hybrid weight: fraction of this step that is deterministic in THIS build (0..1). */
  routineWeight: number;
}

/**
 * THE PIPELINE CONFIG — each step is a hybrid of routine + llm, weighted.
 *
 * Audit is FULLY REAL and the most hybrid step: deterministic byte probe (tags/lang/title/figure-Alt/
 * table-TH) + per-pixel contrast math + dual-validator reconciliation are the routine floor; the VLM
 * alt-text-quality + reading-order judges and the contrast borderline router are the llm layer (they
 * only ESCALATE here — they never clear a deterministic fail). Create HTML / Review PDF are thin-real
 * this build: Create HTML emits a cited, copyable semantic HTML draft + tag plan from machine evidence;
 * Review PDF validates a supplied/generated V2 when available and otherwise records the honest blocker.
 */
export const PIPELINE: Record<PipelineStep, PipelineStepConfig> = {
  audit: {
    step: 'audit',
    label: 'Audit source PDF',
    reportKeys: ['original_failures', 'wcag_summary', 'pdfua_summary'],
    routine: [
      { id: 'byte-probe', description: 'pdf-lib byte audit: tagged/StructTreeRoot, /Lang, Title+DisplayDocTitle, figure /Alt presence, table TH presence (WCAG 1.3.1/2.4.2 + 1.1.1/1.3.1 presence)' },
      { id: 'contrast-pixel-math', description: 'fal layerize + in-Worker PNG decode + per-span worst-case WCAG 2.x ratio (WCAG 1.4.3) — ColorContrastAgent facet' },
      { id: 'validator-reconcile', description: 'veraPDF lane + PAC lane + reconcileValidators; single-oracle/disagreement → escalate (WCAG 4.1.2 / PDF-UA) — ValidatorAgent facet' },
    ],
    llm: [
      { id: 'vlm-alt-quality', description: 'VLM judges figure-description QUALITY beyond mere /Alt presence (WCAG 1.1.1) → escalate (deferred VLM call; escalates today)' },
      { id: 'vlm-reading-order', description: 'VLM vs reading-order pre-assessment (WCAG 1.3.2) → escalate (deferred VLM call; escalates today)' },
      { id: 'contrast-borderline-router', description: 'gemini-2.5-flash routes the PASS-side borderline contrast case (accept vs escalate) — cannot clear a fail' },
    ],
    routineWeight: 0.8,
  },
  'create-html': {
    step: 'create-html',
    label: 'Create HTML',
    reportKeys: ['content_layer', 'semantic_html', 'tag_plan', 'repair_plan'],
    routine: [
      { id: 'repair-plan-derive', description: 'Derive a per-failure repair plan from the audit findings.' },
      { id: 'html-draft', description: 'Create a cited, Canvas-safe semantic HTML draft from audit evidence and source metadata.' },
      { id: 'tag-plan', description: 'Project the same evidence into a PDF tag plan for later fixed-PDF generation.' },
    ],
    llm: [
      { id: 'content-rewrite', description: 'LLM/VLM reconstructs richer source content with citations (deferred until a content layer is available).' },
    ],
    routineWeight: 0.6,
  },
  'review-pdf': {
    step: 'review-pdf',
    label: 'Review PDF',
    reportKeys: ['validation_delta', 'visual_parity', 'human_gate', 'export_snapshot'],
    routine: [
      { id: 'revalidate-delta', description: 'When a V2 exists, re-run the deterministic byte probe on the V2 over the 4 byte-decidable structural criteria (1.1.1/1.3.1/1.3.2/2.4.2 — same set both sides) and diff non-pass counts vs V1 → a real before→after delta; no V2 → before only (after=null). Contrast (1.4.3) + validator (4.1.2) are excluded from the delta (not re-measured on V2)' },
      { id: 'html-review', description: 'Surface the Create HTML draft as review evidence and keep attestation human-gated.' },
      { id: 'pixel-parity', description: 'Pixel-diff V1 vs V2 renders to prove the fix did not change visual layout (deferred — needs a render lane).' },
    ],
    llm: [],
    routineWeight: 1.0,
  },
};

// ───────────────────────── pipeline report state ─────────────────────────

/** Per-step lifecycle status the report surfaces. */
export type StepStatus = 'pending' | 'started' | 'done' | 'skipped';

/** One step's row in the report's step list (the pipeline progress surface). */
export interface PipelineStepState {
  step: PipelineStep;
  status: StepStatus;
  startedAt?: number;
  doneAt?: number;
}

/** The Audit step's structured output = the 6 WCAG-criterion findings + the worst-case rollup. */
export interface AuditResult {
  /** One finding per WCAG criterion assessed (1.1.1, 1.3.1, 1.3.2, 1.4.3, 2.4.2, 4.1.2). */
  criteria: CriterionFinding[];
  /** Worst-case gate derived from the criteria (any needs_human/fail → pending_review). */
  gate: 'finalized' | 'pending_review';
  /** Count of criteria with a non-pass or needs_human verdict (the "before" fail count for Compare). */
  failCount: number;
}

/** A single WCAG-criterion finding (the Audit step's unit of work). */
export interface CriterionFinding {
  /** WCAG SC id + name, e.g. "1.4.3 Contrast (Minimum)". */
  criterion: string;
  /** The technique that produced this finding (byte-probe | contrast | validator | vlm-escalate). */
  via: string;
  verdict: Assessment['verdict'];
  needs_human: boolean;
  evidence: Assessment['evidence'];
  rationale: string;
}

/** Find-Source step output (thin-real). */
export interface SourceResult {
  source_url: string;
  source_kind: 'pdf';
  /** Editable upstream source (TeX/DOCX); null until a source-resolution lane is built. */
  editable_source: string | null;
}

/**
 * Remediate step output — mirrors report.repair_plan + report.fixed_pdf.
 *
 * `status`:
 *  - `candidate`  → repair plan derived from the audit; NO V2 PDF was produced (the default this build:
 *                   the byte-level tagged-PDF write is NOT a callable Worker capability — see `note`).
 *  - `remediated` → a V2 (tagged) PDF exists at `fixed_pdf` (the caller supplied a pre-built one via
 *                   `fixedPdfUrl`; the lab Python+Chrome+pikepdf pipeline produces it offline today).
 */
export interface RemediationResult {
  repair_plan: RepairPlanItem[];
  status: 'candidate' | 'remediated';
  /** URL/ref of the remediated V2 (tagged) PDF when one exists; null on the candidate path. */
  fixed_pdf: string | null;
  note: string;
}

/** Create HTML phase status values intentionally avoid compliance claims. */
export type HtmlPhaseStatus = 'draft' | 'needs_review' | 'ready_for_review';

/** Summary card shape shared by the three-phase report projection. */
export interface PhaseSummaryCard {
  label: string;
  value: string | number;
  tone?: 'neutral' | 'pass' | 'warn' | 'fail';
}

/** Row shape shared by phase projections in the live UI and extension. */
export interface PhaseEvidenceRow {
  area: string;
  refs: string[];
  status: 'passed' | 'failed' | 'review' | 'not_applicable' | 'draft' | 'deferred';
  source: 'machine' | 'human' | 'draft' | 'deferred';
  evidence: string;
  rationale?: string;
}

/** One cited content-layer item used to create the HTML draft and eventual tag plan. */
export interface HtmlContentLayerItem {
  id: string;
  role: 'heading' | 'paragraph' | 'list' | 'table' | 'figure' | 'metadata' | 'review-note';
  text: string;
  refs: string[];
  source: 'audit-evidence' | 'source-pdf' | 'human-review';
  needs_human: boolean;
}

/** One semantic/PDF tag instruction projected from the content layer. */
export interface HtmlTagPlanItem {
  id: string;
  html: string;
  pdfTag: string;
  sourceId: string;
  needs_human: boolean;
}

/**
 * Create HTML step output — mirrors the product phase:
 * cited content layer + semantic HTML + tag plan. This is an accessible alternate, not a claim that
 * the original PDF bytes are fixed.
 */
export interface HtmlResult {
  html: string;
  content_layer: HtmlContentLayerItem[];
  tag_plan: HtmlTagPlanItem[];
  repair_plan: RepairPlanItem[];
  status: HtmlPhaseStatus;
  fixed_pdf: string | null;
  note: string;
  summaryCards: PhaseSummaryCard[];
  rows: PhaseEvidenceRow[];
}

/** One repair-plan item (mirrors remediation-report.json repair_plan[]). */
export interface RepairPlanItem {
  criterion: string;
  step: string;
  automation_confidence: 'high' | 'medium' | 'low';
  human_qa_required: boolean;
}

/** Compare step output — mirrors report.validation_delta + visual_parity. */
export interface ComparisonResult {
  /**
   * before = the V1 audit non-pass count. after = the SAME byte+validator re-audit on the V2 (when a
   * V2 PDF exists) → a real before→after delta (e.g. 6 → 0); null when no V2 was produced.
   */
  validation_delta: { before: number; after: number | null; note: string };
  /** Bbox/measurement evidence from the V2 re-audit (e.g. tagged=true, title set) — present iff after !== null. */
  after_evidence?: Evidence[];
  /** Pixel-diff of V1 vs V2 renders is still deferred (needs a render lane). */
  visual_parity: 'deferred';
}
