import { Agent, callable } from 'agents';
// @ts-ignore - plain-JS ESM module, bundled by wrangler/esbuild
import { probePdf } from './probe.mjs';
import { ValidatorAgent, type ValidatorEnv } from './agents/validator-agent';
import { ColorContrastAgent, type ContrastEnv } from './agents/contrast-agent';
import { WcagAgent, type WcagEnv, type WcagRollup } from './agents/wcag-agent';
import type { A11ySpecialist, AssessParams } from './specialist';
import type { Assessment } from './a2a';
import {
  PIPELINE,
  PIPELINE_STEPS,
  type PipelineStep,
  type PipelineStepState,
  type AuditResult,
  type CriterionFinding,
  type HtmlResult,
  type RemediationResult,
  type RepairPlanItem,
  type ComparisonResult,
} from './pipeline';
import type { RemediationParams } from './workflows/remediation-workflow';

/**
 * Env for A11yAgent (the coordinator). It is the worker env: the A11Y_AGENT DO
 * namespace (its own binding) plus the specialist pieces it dispatches as facets.
 * ValidatorEnv carries VALIDATOR_AGENT/VALIDATOR_WORKFLOW + the heavy validator-lane bindings;
 * ContrastEnv carries COLOR_CONTRAST_AGENT/CONTRAST_WORKFLOW + FAL_KEY/OPENROUTER for WCAG 1.4.3.
 * SPECIALIST_WORKFLOW is the ONE coordinator-owned shared workflow that drives any specialist
 * domain through routine→agent→done. REMEDIATION_WORKFLOW is the DOMAIN PIPELINE
 * (Audit→Remediate→Compare→gate) — the top-level structure.
 */
export interface Env extends ValidatorEnv, ContrastEnv, WcagEnv {
  A11Y_AGENT: DurableObjectNamespace<A11yAgent>;
  SPECIALIST_WORKFLOW: Workflow;
  REMEDIATION_WORKFLOW: Workflow;
  OPENROUTER_API_KEY?: string;
}

/**
 * Domain → concrete specialist class. The coordinator-owned SpecialistWorkflow + bridge methods
 * dispatch the facet for a domain via subAgent(SPECIALIST_CLASSES[domain], docId). Each class is a
 * concrete leaf (NOT the abstract base) whose EXACT name kebab-matches its DO binding. Add a domain
 * here + its DO binding/migration in wrangler.toml to onboard a 3rd specialist (no new workflow).
 */
const SPECIALIST_CLASSES = {
  validator: ValidatorAgent,
  'contrast-service': ColorContrastAgent,
} as const satisfies Record<string, abstract new (...args: any[]) => A11ySpecialist>;

type DomainName = keyof typeof SPECIALIST_CLASSES;

type Tier = 'Audited' | 'Remediated' | 'Attested';
type Gate = 'open' | 'pending_review' | 'finalized' | 'rejected';

export interface AuditRecord {
  pdfUrl: string;
  createdAt: number;
  decidedAt?: number;
  gate: Gate;
  tier: Tier;
  finalized: boolean;          // gate-until-finalized: only true when serving is allowed
  reviewReasons: string[];     // why a human is needed (the ask_human queue)
  note?: string;
  probe: any;
}

// ── The a11y report ledger (lives on the coordinator A11yAgent) ──

/** One append-only event in the report's event log (canonical events). */
export interface LedgerEvent {
  at: number;
  event:
    // ── DOMAIN PIPELINE lifecycle: one started/done per business-domain step so the
    // report's event log shows the pipeline advancing (Audit source PDF→Create HTML→Review PDF). ──
    | 'pipeline.audit.started'
    | 'pipeline.audit.done'
    | 'pipeline.create-html.started'
    | 'pipeline.create-html.done'
    | 'pipeline.review-pdf.started'
    | 'pipeline.review-pdf.done'
    // Backward-compatible legacy event names retained while older clients roll forward.
    | 'pipeline.remediate.started'
    | 'pipeline.remediate.done'
    | 'pipeline.compare.started'
    | 'pipeline.compare.done'
    // Specialist-technique lifecycle — Routine → Turn → Done. Emitted by the inline auditA11y()
    // path and the SpecialistWorkflow path (the technique INSIDE the Audit step).
    | 'routine.started'
    | 'routine.done'
    | 'turn.started'
    | 'turn.done'
    | 'machine.pre_assessment'
    | 'human.review.requested'
    | 'human.approved'
    | 'human.rejected'
    | 'rollup.updated';
  agent: string;          // which specialist this event speaks for
  detail?: string;
}

/** A specialist row in the coordinator's checklist (one per dispatched facet). */
export interface ReportRow {
  agent: string;          // facet class / area name (e.g. "validator")
  runId?: string;         // the facet dispatch id (subAgent name == docId here)
  state: Assessment['state'];
  verdict: Assessment['verdict'];
  needs_human: boolean;
  standard_refs: string[];
  evidence: Assessment['evidence'];
  rationale: string;
  updatedAt: number;
}

/**
 * The coordinator's durable a11y report = the PDF-remediation PIPELINE.
 * `pipeline` mirrors remediation-report.json (audit/source/remediated/comparison); `steps` is the
 * step-list progress surface; `gate` + `events` are the human gate + append-only event log. The legacy
 * `rows` (specialist checklist) stays for the inline 2-domain /v2/audit-a11y-wf path — the WCAG audit
 * findings live under `pipeline.audit.criteria`. Designed to move under A11yReportAgent later.
 */
export interface A11yReportState {
  docId?: string;
  pdfUrl?: string;
  /**
   * URL of a PRE-BUILT remediated V2 (tagged) PDF supplied by the caller (there is no in-Worker tagged-PDF
   * write — see RemediationParams.fixedPdfUrl). Carried on state so the @callable createHtml()/reviewPdf()
   * step methods can read it without a wider signature.
   */
  fixedPdfUrl?: string;
  gate: Gate;             // overall report gate (worst-case from the audit)
  /** The domain pipeline output (each key filled as its step completes). */
  pipeline: {
    audit: AuditResult | null;
    html: HtmlResult | null;
    /** Legacy alias retained for older callers that still render Remediate. */
    remediated: RemediationResult | null;
    /** Legacy Compare output; Review PDF writes here for backward compatibility. */
    comparison: ComparisonResult | null;
  };
  /**
   * The WCAG 2.2 AA rollup: pipeline.audit.criteria folded onto the full 55-SC
   * template, grouped by the 11 rule areas. READ-ONLY over the criteria — it never changes the gate.
   * Optional so existing reports + the inline 2-domain auditA11y path stay backward-compatible
   * (undefined there). The data contract the live WCAG report (src/ui.ts) renders over the WebSocket.
   */
  wcag?: WcagRollup;
  /** Per-step lifecycle status (the pipeline progress surface). */
  steps: PipelineStepState[];
  rows: ReportRow[];      // legacy specialist checklist (inline/workflow specialist path)
  events: LedgerEvent[];  // append-only event log
  updatedAt?: number;
  /**
   * Domains still in-flight on the SpecialistWorkflow path. The report gate rolls up
   * only once this is empty (onWorkflowProgress's row.ready clears each domain as its workflow emits
   * its final row). Unused on the inline subAgent().assess() path (auditA11y), which rolls up
   * synchronously.
   */
  pendingDomains?: string[];
  /**
   * Parked SpecialistWorkflow instances awaiting the human gate. decideReport()
   * approves/rejects each so the durable workflow unblocks when the report-level gate is resolved.
   */
  gatedWorkflows?: Array<{ domain: string; workflowId: string }>;
  /**
   * TRUE between dispatching the durable RemediationWorkflow and the workflow registering its parked
   * closes the TOCTOU window where decideReport() could finalize the
   * pending_review gate while the workflow id isn't tracked yet (then the workflow parks + strands).
   * While set, decideReport() REFUSES to finalize (stays gated, retry). Cleared when the workflow
   * durably registers its parked id via step.do(armPipelineGate), on terminal completion/error, or if
   * dispatch itself throws (runRemediation try/catch).
   */
  pipelineArming?: boolean;
}

const REVIEW_SLA_SECONDS = 7 * 24 * 60 * 60; // 7 days — durable, survives restarts

/** Fail-closed timeout for the Compare-step V2 re-audit fetch (a stalled V2 URL must not hang the DO). */
const V2_REAUDIT_TIMEOUT_MS = 30_000;
const UPLOADED_PDF_STORAGE_KEY = 'uploaded:source-pdf';

/**
 * The WCAG SC ids that are BYTE-DECIDABLE (decided by the pdf-lib probe alone, no image/network lane).
 * Compare's before→after delta is scoped to exactly these — 1.4.3 (contrast, needs the page image) and
 * 4.1.2 (validator, needs a network oracle) are excluded from BOTH sides so the delta is one honest metric.
 */
const BYTE_CRITERIA_SC = new Set(['1.1.1', '1.3.1', '1.3.2', '2.4.2']);

/**
 * Strip the query string + fragment from a URL before echoing it into the durable report ledger / event
 * log (signed-URL credentials live in the query). Returns origin+path, or a coarse redaction
 * if the value doesn't parse as a URL. The unredacted value is kept only in structured fields, not notes.
 */
function redactUrl(u: string): string {
  try {
    const parsed = new URL(u);
    return parsed.search || parsed.hash ? `${parsed.origin}${parsed.pathname} (query redacted)` : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return u.split('?')[0].split('#')[0];
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
}

function criterionCode(criterion: string): string {
  return criterion.split(' ')[0] || criterion;
}

function createHtmlRowStatus(c: CriterionFinding): HtmlResult['rows'][number]['status'] {
  if (c.verdict === 'passed' && !c.needs_human) return 'passed';
  if (c.verdict === 'not_present') return 'not_applicable';
  if (c.verdict === 'failed') return 'review';
  return 'review';
}

function htmlRoleForCriterion(code: string): HtmlResult['content_layer'][number]['role'] {
  if (code === '2.4.2') return 'metadata';
  if (code === '1.1.1') return 'figure';
  if (code === '1.3.1') return 'table';
  return 'review-note';
}

function pdfTagForRole(role: HtmlResult['content_layer'][number]['role']): string {
  const map: Record<HtmlResult['content_layer'][number]['role'], string> = {
    heading: 'H1',
    paragraph: 'P',
    list: 'L',
    table: 'Table',
    figure: 'Figure',
    metadata: 'DocumentInfo',
    'review-note': 'P',
  };
  return map[role];
}

function normalizeStoredBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value);
  return null;
}

/**
 * A11yAgent — one Agent (Durable Object) per document. It is BOTH:
 *  (1) the legacy deterministic byte-audit + human gate (audit/decide/status —
 *      the surface other services delegate to via the PDF_A11Y_AGENT binding;
 *      contract UNCHANGED), and
 *  (2) the coordinator that owns the a11y report ledger + event log and
 *      dispatches specialist facets (A11yValidatorAgent) via this.subAgent().
 *
 * Graduated from a plain DurableObject to the agents-SDK Agent base so it can host
 * facets (subAgent / ctx.facets). The Agent base owns alarm()/schedules, so the
 * 7-day review SLA now uses this.schedule() instead of a raw setAlarm/alarm().
 */
export class A11yAgent extends Agent<Env, A11yReportState> {
  initialState: A11yReportState = {
    gate: 'open',
    pipeline: { audit: null, html: null, remediated: null, comparison: null },
    steps: [],
    rows: [],
    events: [],
  };

  // ───────────────────────── legacy byte-audit surface (prod) ─────────────────────────

  async audit(pdfUrl: string): Promise<AuditRecord> {
    const res = await fetch(pdfUrl, { headers: { 'user-agent': 'wcag-audit-agent/0.1 (+https://app.example.com)' } });
    if (!res.ok) throw new Error(`fetch_failed ${res.status} for ${pdfUrl}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return this.auditBytes(pdfUrl, bytes);
  }

  async auditBytes(source: string, bytes: Uint8Array): Promise<AuditRecord> {
    const probe = await probePdf(bytes);

    // Decide the gate: any error finding, or a criterion code can't decide → human.
    const reviewReasons: string[] = [];
    for (const f of probe.findings ?? []) {
      if (f.severity === 'error') reviewReasons.push(`${f.criterion}: ${f.finding}`);
    }
    if (probe.verdicts?.logical_reading_order === 'cannot_tell') {
      reviewReasons.push('logical_reading_order: needs vision/diff + human confirm (code cannot decide)');
    }
    const needsHuman = reviewReasons.length > 0;

    const rec: AuditRecord = {
      pdfUrl: source,
      createdAt: Date.now(),
      gate: needsHuman ? 'pending_review' : 'finalized',
      tier: needsHuman ? 'Audited' : 'Remediated',
      finalized: !needsHuman,
      reviewReasons,
      probe,
    };
    await this.ctx.storage.put('record', rec);
    // Durable review SLA: if no decision in 7d, the scheduled callback fires (still gated).
    // Uses this.schedule() (NOT raw setAlarm) so it doesn't collide with the Agent base's
    // own alarm()/schedule housekeeping. Cancel any prior SLA first so a re-audit doesn't
    // leave a stale callback that later clobbers the current record's note.
    await this.cancelReviewSla();
    if (needsHuman) await this.schedule(REVIEW_SLA_SECONDS, 'onReviewSlaElapsed');
    return rec;
  }

  // The human-gate resolution (AskUserQuestion answer → this). Flips the gate.
  async decide(decision: 'approve' | 'reject', note?: string): Promise<AuditRecord> {
    const rec = await this.ctx.storage.get<AuditRecord>('record');
    if (!rec) throw new Error('no_audit_record');
    if (decision === 'approve') {
      rec.gate = 'finalized';
      rec.finalized = true;
      rec.tier = 'Attested';
    } else {
      rec.gate = 'rejected';
      rec.finalized = false;
      rec.tier = 'Audited';
    }
    rec.decidedAt = Date.now();
    rec.note = note;
    await this.ctx.storage.put('record', rec);
    // Decision made → the SLA no longer applies; cancel it so it can't fire later.
    await this.cancelReviewSla();
    return rec;
  }

  /** Cancel any pending onReviewSlaElapsed schedule(s) so stale callbacks can't fire. */
  private async cancelReviewSla(): Promise<void> {
    const schedules = await this.listSchedules();
    for (const s of schedules) {
      if (s.callback === 'onReviewSlaElapsed') await this.cancelSchedule(s.id);
    }
  }

  async status(): Promise<AuditRecord | null> {
    return (await this.ctx.storage.get<AuditRecord>('record')) ?? null;
  }

  /** Review SLA elapsed without a decision — keep the gate(s) closed, mark them. (schedule callback) */
  async onReviewSlaElapsed(): Promise<void> {
    const stamp = new Date().toISOString();
    // Legacy byte-audit record gate.
    const rec = await this.ctx.storage.get<AuditRecord>('record');
    if (rec && rec.gate === 'pending_review') {
      rec.note = `review SLA (7d) elapsed at ${stamp} — still gated`;
      await this.ctx.storage.put('record', rec);
    }
    // Report-ledger gate: surface the elapsed SLA on the coordinator report too.
    if (this.state.gate === 'pending_review') {
      this.appendEvent('rollup.updated', 'rollup', `review SLA (7d) elapsed at ${stamp} — still gated`);
    }
  }

  // ───────────────────── coordinator / facet surface ─────────────────────

  /**
   * Trivial subAgent round-trip smoke — proves facets/ctx.exports are enabled on this
   * runtime (else subAgent() throws "not supported in this runtime"). Creates the
   * ValidatorAgent facet under this coordinator and reads its (empty) state back.
   */
  async pingFacet(): Promise<{ ok: true; facet: string; childState: unknown }> {
    const child = await this.subAgent(ValidatorAgent, 'preflight');
    const childState = await child.getStatus();
    return { ok: true, facet: 'ValidatorAgent', childState };
  }

  /**
   * Coordinator entrypoint: dispatch the A11yValidatorAgent facet for {docId}, fold its
   * returned ledger row into THIS coordinator's report ledger, and open the human gate on
   * needs_human (single-oracle / validator disagreement). The coordinator owns the gate.
   *
   * Two SDK constraints shaped this (verified against cloudflare/agents 0.12.4):
   *  1. runAgentTool() requires the CHILD to extend AIChatAgent/Think (agent-tool child adapter);
   *     ValidatorAgent is a plain Agent, so the correct primitive is this.subAgent(Cls, name) + RPC.
   *  2. A facet calling runWorkflow()+mergeAgentState() reaches back to the TOP-LEVEL agent
   *     (getAgentByName(VALIDATOR_AGENT, name)), NOT the facet — so the durable-workflow path stays
   *     on the /v2/* direct surface, and the facet exposes a synchronous validateInline() whose RPC
   *     return crosses the facet boundary cleanly. This still proves the two-layer topology:
   *     A11yAgent (coordinator, owns ledger+gate) → A11yValidatorAgent (subAgent facet, isolated).
   */
  async auditA11y(input: {
    docId: string;
    pdfUrl: string;
    /** Rasterized page image for the contrast lane (fal layerize processes images, not PDFs). */
    imageUrl?: string;
    /** Page width in PostScript points → enables WCAG large-text classification in the contrast lane. */
    pagePointWidth?: number;
  }): Promise<{ docId: string; report: A11yReportState }> {
    const { docId, pdfUrl, imageUrl, pagePointWidth } = input;

    // Cross-path: this inline run supersedes any workflow-path run on the same docId.
    // Reject + clear any prior parked SpecialistWorkflow first, and REFUSE to start if a live one can't
    // be released — otherwise the inline rollup below (which only inspects `rows`) could finalize over a
    // still-parked workflow. Symmetric with auditA11yViaWorkflow.
    const stillParked = await this.releaseGatedWorkflows('reject', 'superseded by inline re-audit');
    if (stillParked.length > 0) {
      throw new Error(
        `prior_workflow_unreleased: ${stillParked.length} parked workflow(s) (${stillParked.map((g) => g.domain).join(', ')}) refused rejection — resolve before re-auditing.`,
      );
    }
    // Fresh rows/events for this run so a re-audit doesn't accrete stale rows under the new gate.
    this.setState({ ...this.state, docId, pdfUrl, rows: [], events: [], pendingDomains: [], updatedAt: Date.now() });

    // ── Domain row 1: validator (veraPDF/PAC reconciliation) ──
    this.appendEvent('routine.started', 'validator', `dispatch validator facet for ${docId}`);
    const validator = await this.subAgent(ValidatorAgent, docId);
    const vrow: Assessment = await validator.validateInline({ pdfUrl, id: docId, fileName: docId });
    this.appendEvent('routine.done', 'validator', `facet returned verdict=${vrow.verdict}`);
    this.upsertRow({
      agent: vrow.agent, runId: docId, state: vrow.state, verdict: vrow.verdict,
      needs_human: vrow.needs_human, standard_refs: vrow.standard_refs, evidence: vrow.evidence,
      rationale: vrow.rationale, updatedAt: Date.now(),
    });
    this.appendEvent('machine.pre_assessment', vrow.agent, `verdict=${vrow.verdict} (${vrow.rationale})`);
    if (vrow.needs_human) this.appendEvent('human.review.requested', vrow.agent, vrow.rationale);

    // ── Domain row 2: contrast (WCAG 1.4.3, fal layerize) ──
    // The contrast lane measures a rasterized page image. fal layerize processes images, so feed it
    // imageUrl when provided; otherwise pass pdfUrl through (fal/the lane degrades to a flagged
    // approximation → escalation rather than a fabricated measurement).
    this.appendEvent('routine.started', 'contrast-service', `dispatch contrast facet for ${docId}`);
    const contrast = await this.subAgent(ColorContrastAgent, docId);
    const crow: Assessment = await contrast.measureContrastInline({
      pdfUrl: imageUrl ?? pdfUrl, id: docId, fileName: docId, pagePointWidth,
    });
    this.appendEvent('routine.done', 'contrast-service', `facet returned verdict=${crow.verdict}`);
    this.upsertRow({
      agent: crow.agent, runId: docId, state: crow.state, verdict: crow.verdict,
      needs_human: crow.needs_human, standard_refs: crow.standard_refs, evidence: crow.evidence,
      rationale: crow.rationale, updatedAt: Date.now(),
    });
    this.appendEvent('machine.pre_assessment', crow.agent, `verdict=${crow.verdict} (${crow.rationale})`);
    if (crow.needs_human) this.appendEvent('human.review.requested', crow.agent, crow.rationale);

    // ── Report rollup: gate is WORST-CASE across all domain rows ──
    // A re-audit supersedes any prior gate's SLA. The report finalizes ONLY when every
    // row is a clean machine pass (verdict==='passed' AND !needs_human). Any other state — needs_human,
    // failed, cannot_tell, not_present — keeps the report gated. Gating on needs_human alone would let
    // a `failed`-but-not-gated row finalize the whole report.
    await this.cancelReviewSla();
    // Defense-in-depth: never finalize while ANY workflow is parked. On the inline path
    // gatedWorkflows was just cleared above, so this is belt-and-suspenders (matches the workflow path).
    const anyParked = (this.state.gatedWorkflows ?? []).length > 0;
    const allClean = !anyParked && this.state.rows.every((r) => r.verdict === 'passed' && !r.needs_human);
    if (!allClean) {
      this.setReportGate('pending_review');
      // Durable review SLA on the coordinator (the report-level gate).
      await this.schedule(REVIEW_SLA_SECONDS, 'onReviewSlaElapsed');
    } else {
      this.setReportGate('finalized');
    }
    this.appendEvent('rollup.updated', 'rollup', `report gate=${this.state.gate} (rows: ${this.state.rows.length})`);
    return { docId, report: this.state };
  }

  // ════════════════════════ THE DOMAIN PIPELINE ════════════════════════
  //
  // Start → Audit source PDF → Create HTML → Review PDF → (attestation gate) → End.
  // These are the coordinator step methods the RemediationWorkflow drives via step.do(this.agent.*).
  // Each is a HYBRID of routine + llm per the PIPELINE config; runAudit is FULLY REAL, the rest thin.

  /**
   * Entry: run the full PDF-remediation pipeline as a durable RemediationWorkflow. Resets the report,
   * seeds the step list, then kicks REMEDIATION_WORKFLOW (which calls runAudit/createHtml/reviewPdf
   * in order + opens the attestation gate). Returns the seeded report immediately; the pipeline
   * fills in as steps complete (poll /v2/audit-status). For a synchronous end-to-end result on the lab
   * surface, runPipelineInline() runs the same four steps in-process.
   */
  async runRemediation(input: RemediationParams): Promise<{ docId: string; workflowId: string; report: A11yReportState }> {
    await this.resetPipeline(input);
    // Open the attestation gate NOW (pending_review) — the RemediationWorkflow ALWAYS parks on
    // waitForApproval, so the report must be gated for the whole run (a clean audit must not finalize
    // and strand the parked workflow). Set pipelineArming=true BEFORE runWorkflow so a
    // decideReport() that lands during the runWorkflow await can't finalize over an as-yet-untracked
    // workflow (TOCTOU). The workflow clears arming + tracks its id when it reports
    // 'pipeline.gate-armed' just before parking (onWorkflowProgress). decideReport() then releases it.
    this.setState({ ...this.state, gate: 'pending_review', pipelineArming: true, updatedAt: Date.now() });
    this.appendEvent('human.review.requested', 'pipeline', 'attestation gate open (durable pipeline dispatched)');
    // If scheduling or dispatch throws, the workflow may never exist (and thus never
    // arm/error-callback), which would leave pipelineArming=true forever and defer every decide. Clear
    // arming on a dispatch failure so the gate isn't permanently stuck.
    let workflowId: string;
    try {
      await this.schedule(REVIEW_SLA_SECONDS, 'onReviewSlaElapsed');
      workflowId = await this.runWorkflow('REMEDIATION_WORKFLOW', input);
    } catch (e) {
      this.setState({ ...this.state, pipelineArming: false, updatedAt: Date.now() });
      this.appendEvent('rollup.updated', 'pipeline', `pipeline dispatch failed: ${String(e).slice(0, 200)} — arming cleared, gate stays pending_review (no workflow).`);
      throw e;
    }
    return { docId: input.docId, workflowId, report: this.state };
  }

  async runUploadedRemediation(input: {
    docId: string;
    fileName: string;
    bytes: Uint8Array;
    imageUrl?: string;
    pagePointWidth?: number;
    fixedPdfUrl?: string;
  }): Promise<{ docId: string; workflowId: string; report: A11yReportState }> {
    await this.ctx.storage.put(UPLOADED_PDF_STORAGE_KEY, input.bytes);
    const safeName = input.fileName || 'uploaded.pdf';
    return this.runRemediation({
      docId: input.docId,
      pdfUrl: `uploaded://source/${encodeURIComponent(safeName)}`,
      uploadedPdfStorageKey: UPLOADED_PDF_STORAGE_KEY,
      uploadedFileName: safeName,
      imageUrl: input.imageUrl,
      pagePointWidth: input.pagePointWidth,
      fixedPdfUrl: input.fixedPdfUrl,
    });
  }

  /**
   * Run the pipeline steps in-process (no workflow) and return the completed report. Same step
   * methods (runAudit/createHtml/reviewPdf — each self-persists its slice + its pipeline events) as
   * the durable path, but synchronous so the lab smoke gets the full {audit, html, comparison}
   * back in one call. The audit step opens the attestation gate (worst-case); decideReport() resolves
   * it.
   */
  async runPipelineInline(input: RemediationParams): Promise<{ docId: string; report: A11yReportState }> {
    await this.resetPipeline(input);
    const audit = await this.runAudit(input);            // self-persists pipeline.audit (NOT the gate)
    const html = await this.createHtml(audit);            // self-persists pipeline.html (+ legacy remediated)
    await this.reviewPdf(audit, html);                    // self-persists pipeline.comparison

    // FULL pipeline → ALWAYS open the attestation gate (pending_review), even on a clean audit. This
    // mirrors the durable RemediationWorkflow, which ALWAYS parks on waitForApproval — attestation is an
    // explicit human act, never auto-finalized (a clean auto-finalize would strand the parked
    // workflow with no release path). decideReport(approve|reject) resolves it. The audit's worst-case
    // verdict is surfaced in pipeline.audit.gate for the reviewer; it does not bypass the human gate.
    await this.cancelReviewSla();
    this.setReportGate('pending_review');
    this.appendEvent('human.review.requested', 'pipeline', `attestation gate open (audit-gate=${audit.gate}, failCount=${audit.failCount})`);
    this.appendEvent('rollup.updated', 'pipeline', `report gate=pending_review (full pipeline; failCount=${audit.failCount})`);
    await this.schedule(REVIEW_SLA_SECONDS, 'onReviewSlaElapsed');
    return { docId: input.docId, report: this.state };
  }

  /**
   * Run JUST the Audit step (the first pipeline step) and return the report. This is what
   * /v2/audit-a11y maps to now — the audit step alone, decoupled from find-source/remediate/compare.
   * Resets the pipeline, runs runAudit (which self-persists pipeline.audit + opens the gate), returns
   * the report. The other pipeline slices stay null (only Audit ran).
   */
  async runAuditOnly(input: RemediationParams): Promise<{ docId: string; report: A11yReportState }> {
    await this.resetPipeline(input);
    const audit = await this.runAudit(input); // self-persists pipeline.audit (NOT the report gate)
    // Audit-only path: NO workflow parks, so finalize-on-clean is safe. Worst-case gate from the audit.
    await this.cancelReviewSla();
    this.setReportGate(audit.gate);
    this.appendEvent('rollup.updated', 'pipeline', `report gate=${audit.gate} (audit-only; failCount=${audit.failCount})`);
    if (audit.gate === 'pending_review') await this.schedule(REVIEW_SLA_SECONDS, 'onReviewSlaElapsed');
    return { docId: input.docId, report: this.state };
  }

  /**
   * Durably register the parked RemediationWorkflow + clear the arming flag (closes the round-2/3 TOCTOU
   * close). Called via step.do() from the workflow JUST before it parks on waitForApproval, so the
   * coordinator tracks gatedWorkflows=[{domain:'pipeline',workflowId}] BEFORE any park — decideReport()
   * can then approve/reject this instance. @callable so the workflow can invoke it; idempotent on retry.
   */
  @callable()
  async armPipelineGate(workflowId: string): Promise<void> {
    const gated = [
      ...(this.state.gatedWorkflows ?? []).filter((g) => g.workflowId !== workflowId),
      { domain: 'pipeline', workflowId },
    ];
    this.setState({ ...this.state, gatedWorkflows: gated, pipelineArming: false, updatedAt: Date.now() });
    this.appendEvent('rollup.updated', 'pipeline', `pipeline workflow ${workflowId} parked on attestation gate`);
  }

  /** Reset the report for a fresh pipeline run (clears prior pipeline/steps/rows/events + parked work). */
  private async resetPipeline(input: RemediationParams): Promise<void> {
    // A superseding run must reject + clear any prior parked workflow first (symmetry w/ auditA11y).
    const stillParked = await this.releaseGatedWorkflows('reject', 'superseded by new pipeline run');
    if (stillParked.length > 0) {
      throw new Error(
        `prior_workflow_unreleased: ${stillParked.length} parked workflow(s) (${stillParked.map((g) => g.domain).join(', ')}) refused rejection — resolve before re-running.`,
      );
    }
    await this.cancelReviewSla();
    this.setState({
      ...this.state,
      docId: input.docId,
      pdfUrl: input.pdfUrl,
      fixedPdfUrl: input.fixedPdfUrl,
      gate: 'open',
      pipeline: { audit: null, html: null, remediated: null, comparison: null },
      steps: PIPELINE_STEPS.map((step) => ({ step, status: 'pending' as const })),
      rows: [],
      events: [],
      pendingDomains: [],
      gatedWorkflows: [],
      pipelineArming: false,
      updatedAt: Date.now(),
    });
  }

  /**
   * Step 1 — AUDIT (FULLY REAL). The criteria assessment = the 6 WCAG criteria from wcag_summary.
   * Hybrid of routine + llm (PIPELINE.audit): the byte probe runs ONCE and is shared across the
   * byte-decidable criteria (1.1.1 presence, 1.3.1, 2.4.2, 1.3.2); the contrast facet decides 1.4.3
   * (pixel math, borderline→LLM); the validator facet decides 4.1.2 (dual-oracle reconcile). The VLM
   * layers (1.1.1 quality, 1.3.2 visual) ESCALATE today (deferred VLM call) rather than guess.
   * @callable so the RemediationWorkflow can invoke it via this.agent.runAudit().
   */
  @callable()
  async runAudit(p: RemediationParams): Promise<AuditResult> {
    this.markStep('audit', 'started');
    this.appendEvent('pipeline.audit.started', 'pipeline', `audit ${p.docId}`);

    // ── ROUTINE floor: the deterministic byte probe, run ONCE, shared across criteria (spec §). ──
    // this.audit() fetches the PDF + runs probePdf in-process — the same byte-audit /audit exposes,
    // no extra network hop. (AuditRecord.probe carries tagged/lang/title/figures/tables/verdicts.)
    const rec = p.uploadedPdfStorageKey
      ? await this.auditUploadedPdf(p)
      : await this.audit(p.pdfUrl);
    const probe = rec.probe ?? {};

    const criteria: CriterionFinding[] = [];

    // ── 1.1.1 Text Alternatives — routine probes figure /Alt PRESENCE; quality needs a VLM → escalate. ──
    criteria.push(this.criterion111(probe));

    // ── 1.3.1 Info and Relationships — routine probes tags/StructTreeRoot + table TH. ──
    criteria.push(this.criterion131(probe));

    // ── 1.3.2 Meaningful Sequence — reading order is visual; deterministic = cannot_tell → escalate. ──
    criteria.push(this.criterion132(probe));

    // ── 1.4.3 Contrast (Minimum) — REUSE the ColorContrast facet (src/contrast.ts). Needs image_url +
    // page_point_width; without them the lane degrades to a flagged approximation → escalate. ──
    criteria.push(await this.criterion143(p));

    // ── 2.4.2 Page Titled — routine probes Title + DisplayDocTitle. ──
    criteria.push(this.criterion242(probe));

    // ── 4.1.2 Name, Role, Value — REUSE the Validator facet reconcile (veraPDF+PAC). Single-oracle in
    // the lab (PAC unavailable) → escalate (the moat). ──
    criteria.push(await this.criterion412(p));

    // Worst-case gate: finalize ONLY if every criterion is a clean machine pass (passed && !needs_human).
    const failCount = criteria.filter((c) => c.verdict !== 'passed' || c.needs_human).length;
    const gate: AuditResult['gate'] = failCount === 0 ? 'finalized' : 'pending_review';

    // Mirror each criterion into the legacy specialist-row view too (so /v2/audit-status rows aren't
    // empty on the pipeline path) — keyed by criterion so they don't collide with validator/contrast.
    for (const c of criteria) {
      this.upsertRow({
        agent: `wcag:${c.criterion.split(' ')[0]}`, runId: this.state.docId, state: c.needs_human ? 'input_required' : 'completed',
        verdict: c.verdict, needs_human: c.needs_human, standard_refs: [`WCAG ${c.criterion.split(' ')[0]}`],
        evidence: c.evidence, rationale: c.rationale, updatedAt: Date.now(),
      });
    }

    const result: AuditResult = { criteria, gate, failCount };

    // ── WCAG 2.2 AA rollup — dispatch the WcagAgent facet to fold the criteria just
    // gathered onto the full 55-SC template (grouped by the 11 rule areas). This is the ONE insertion
    // point, so the rollup lands on EVERY audit path (runAuditOnly / runPipelineInline / RemediationWorkflow).
    // FAIL-CLOSED: a rollup RPC error must NEVER reject the audit or change the gate (mirrors the
    // criterion143/criterion412 try/catch). The rollup is READ-ONLY over `criteria` — failCount/gate above
    // are unaffected; it only ADDS report.wcag for the live WCAG report surface. ──
    let wcagRollup: WcagRollup | null = null;
    try {
      const wcag = await this.subAgent(WcagAgent, p.docId);
      const out = await wcag.rollupInline({ id: p.docId, criteria });
      wcagRollup = out.rollup;
      this.appendEvent('rollup.updated', 'wcag', `WCAG 2.2 AA: ${out.rollup.summary.passed}/${out.rollup.summary.total} pass, ${out.rollup.summary.failed} fail, ${out.rollup.summary.needsHuman} need human`);
    } catch (e) {
      this.appendEvent('rollup.updated', 'wcag', `WCAG rollup facet error: ${String(e).slice(0, 200)} (criteria/gate unaffected)`);
    }

    // Self-persist the audit slice (path-agnostic: runs on the coordinator DO whether called inline or
    // from the RemediationWorkflow's step.do()). NOTE: runAudit does NOT itself set the REPORT-level gate
    // — the caller owns that, because the gate decision differs by path:
    //   • audit-only (/v2/audit-a11y → runAuditOnly): finalize on a clean audit (no workflow to park).
    //   • full pipeline (runPipelineInline / RemediationWorkflow): ALWAYS pending_review — the workflow
    //     always parks on waitForApproval, so a clean audit must NOT auto-finalize (else the parked
    //     workflow can never be released). Attestation is always an explicit human act.
    // wcag is additive (read-only over criteria); keep any prior value if the rollup facet errored.
    this.setState({ ...this.state, pipeline: { ...this.state.pipeline, audit: result }, wcag: wcagRollup ?? this.state.wcag, updatedAt: Date.now() });
    this.markStep('audit', 'done');
    this.appendEvent('pipeline.audit.done', 'pipeline', `${criteria.length} criteria, ${failCount} non-pass, audit-gate=${gate}`);

    return result;
  }

  private async auditUploadedPdf(p: RemediationParams): Promise<AuditRecord> {
    if (!p.uploadedPdfStorageKey) throw new Error('uploaded_pdf_storage_key_required');
    const stored = await this.ctx.storage.get(p.uploadedPdfStorageKey);
    const bytes = normalizeStoredBytes(stored);
    if (!bytes) throw new Error('uploaded_pdf_missing_or_invalid');
    return this.auditBytes(p.uploadedFileName || p.pdfUrl, bytes);
  }

  /** 1.1.1 — figure /Alt presence is byte-decidable; QUALITY needs a VLM (deferred) → escalate. */
  private criterion111(probe: any): CriterionFinding {
    const figures = Number(probe.figures ?? 0);
    const withAlt = Number(probe.figuresWithAlt ?? 0);
    const noAlt = figures - withAlt;
    if (figures === 0) {
      return { criterion: '1.1.1 Text Alternatives', via: 'byte-probe', verdict: 'not_present', needs_human: false,
        evidence: [{ kind: 'measurement', detail: 'No tagged Figure elements found in the structure tree.' }],
        rationale: 'No tagged figures → no /Alt to assess at the byte level.' };
    }
    if (noAlt > 0) {
      return { criterion: '1.1.1 Text Alternatives', via: 'byte-probe', verdict: 'failed', needs_human: true,
        evidence: [{ kind: 'measurement', detail: `${noAlt} of ${figures} tagged figures have no /Alt.`, citation: 'probe-figures' }],
        rationale: `${noAlt}/${figures} figures missing /Alt (WCAG 1.1.1 fail at presence level).` };
    }
    // All figures have /Alt PRESENT — but presence ≠ quality. The VLM alt-quality judge (PIPELINE llm)
    // is deferred, so we escalate rather than attest a clean pass on description quality.
    return { criterion: '1.1.1 Text Alternatives', via: 'vlm-escalate', verdict: 'cannot_tell', needs_human: true,
      evidence: [{ kind: 'measurement', detail: `${withAlt}/${figures} figures have /Alt present; description QUALITY not machine-verifiable.`, citation: 'probe-figures' }],
      rationale: 'All figures have /Alt present, but alt-text QUALITY needs a VLM judge (deferred) → human review.' };
  }

  /** 1.3.1 — tags/StructTreeRoot + table TH presence (byte-decidable). */
  private criterion131(probe: any): CriterionFinding {
    const tagged = !!probe.tagged;
    const tables = Number(probe.tables ?? 0);
    const tablesWithTH = Number(probe.tablesWithTH ?? 0);
    const tablesNoTH = tables - tablesWithTH;
    if (!tagged) {
      return { criterion: '1.3.1 Info and Relationships', via: 'byte-probe', verdict: 'failed', needs_human: true,
        evidence: [{ kind: 'validator', detail: `tagged=${tagged}, StructTreeRoot=${!!probe.hasStructRoot}, Marked=${!!probe.marked}` }],
        rationale: 'PDF is untagged (no usable StructTreeRoot) → structure/relationships lost (WCAG 1.3.1 fail).' };
    }
    if (tables > 0 && tablesNoTH > 0) {
      return { criterion: '1.3.1 Info and Relationships', via: 'byte-probe', verdict: 'failed', needs_human: true,
        evidence: [{ kind: 'validator', detail: `${tablesNoTH} of ${tables} tables have no header (TH) cells.`, citation: 'probe-tables' }],
        rationale: `${tablesNoTH}/${tables} tables missing TH headers → cell relationships lost (WCAG 1.3.1 fail).` };
    }
    return { criterion: '1.3.1 Info and Relationships', via: 'byte-probe', verdict: 'passed', needs_human: false,
      evidence: [{ kind: 'validator', detail: `tagged=true; tables=${tables} (all with TH where present).` }],
      rationale: 'Document is tagged and tables (if any) have header cells — WCAG 1.3.1 structure present.' };
  }

  /** 1.3.2 — meaningful sequence is a VISUAL/reading-order judgment; deterministic = cannot_tell → escalate. */
  private criterion132(probe: any): CriterionFinding {
    const tagged = !!probe.tagged;
    return { criterion: '1.3.2 Meaningful Sequence', via: 'vlm-escalate', verdict: 'cannot_tell', needs_human: true,
      evidence: [{ kind: 'measurement', detail: tagged ? 'Tagged; reading-order correctness requires a VLM vs render diff.' : 'Untagged; no defined reading order.' }],
      rationale: tagged
        ? 'Reading order is a visual judgment — VLM vs reading-order pre-assessment is deferred → human review.'
        : 'Untagged document has no defined reading order → human review.' };
  }

  /** 1.4.3 — REUSE the ColorContrast facet (pixel math). Needs image_url + page_point_width else escalate. */
  private async criterion143(p: RemediationParams): Promise<CriterionFinding> {
    // Fail CLOSED: a facet RPC failure must NOT reject the whole audit — it escalates this
    // criterion to a gated cannot_tell so the report still gates (the safe direction for attestation).
    try {
      const contrast = await this.subAgent(ColorContrastAgent, p.docId);
      const row: Assessment = await contrast.measureContrastInline({
        pdfUrl: p.imageUrl ?? p.pdfUrl, id: p.docId, fileName: p.docId, pagePointWidth: p.pagePointWidth,
      });
      return { criterion: '1.4.3 Contrast (Minimum)', via: 'contrast', verdict: row.verdict, needs_human: row.needs_human,
        evidence: row.evidence, rationale: row.rationale };
    } catch (e) {
      return { criterion: '1.4.3 Contrast (Minimum)', via: 'contrast-error', verdict: 'cannot_tell', needs_human: true,
        evidence: [{ kind: 'measurement', detail: `contrast facet error: ${String(e).slice(0, 200)}` }],
        rationale: 'Contrast lane failed (facet error) — escalated for human review (fail-closed).' };
    }
  }

  /** 2.4.2 — Title + DisplayDocTitle (byte-decidable). */
  private criterion242(probe: any): CriterionFinding {
    const title = probe.title ?? null;
    const displayDocTitle = !!probe.displayDocTitle;
    if (!title) {
      return { criterion: '2.4.2 Page Titled', via: 'byte-probe', verdict: 'failed', needs_human: true,
        evidence: [{ kind: 'measurement', detail: 'No document Title in metadata.' }],
        rationale: 'No document Title → window/tab shows the filename (WCAG 2.4.2 fail).' };
    }
    if (!displayDocTitle) {
      return { criterion: '2.4.2 Page Titled', via: 'byte-probe', verdict: 'failed', needs_human: true,
        evidence: [{ kind: 'measurement', detail: `Title="${String(title).slice(0, 80)}" but DisplayDocTitle is not enabled.` }],
        rationale: 'Title set but ViewerPreferences /DisplayDocTitle is off → viewers show the filename (WCAG 2.4.2 fail).' };
    }
    return { criterion: '2.4.2 Page Titled', via: 'byte-probe', verdict: 'passed', needs_human: false,
      evidence: [{ kind: 'measurement', detail: `Title="${String(title).slice(0, 80)}"; DisplayDocTitle=true.` }],
      rationale: 'Document has a Title and DisplayDocTitle is enabled — WCAG 2.4.2 satisfied.' };
  }

  /** 4.1.2 — REUSE the Validator facet reconcile (veraPDF+PAC). Single-oracle → escalate (the moat). */
  private async criterion412(p: RemediationParams): Promise<CriterionFinding> {
    // Fail CLOSED: a facet RPC failure escalates this criterion rather than rejecting the
    // whole audit, so the report still gates.
    try {
      const validator = await this.subAgent(ValidatorAgent, p.docId);
      const row: Assessment = await validator.validateInline({ pdfUrl: p.pdfUrl, id: p.docId, fileName: p.docId });
      return { criterion: '4.1.2 Name, Role, Value', via: 'validator', verdict: row.verdict, needs_human: row.needs_human,
        evidence: row.evidence, rationale: row.rationale };
    } catch (e) {
      return { criterion: '4.1.2 Name, Role, Value', via: 'validator-error', verdict: 'cannot_tell', needs_human: true,
        evidence: [{ kind: 'validator', detail: `validator facet error: ${String(e).slice(0, 200)}` }],
        rationale: 'Validator lane failed (facet error) — escalated for human review (fail-closed).' };
    }
  }

  /**
   * Step 2 — CREATE HTML. Derive a per-failure repair plan and generate a cited, Canvas-safe semantic
   * HTML draft from the audit evidence. This phase supplies the "shadow HTML" the extension can copy or
   * write back into an LMS page; it does not claim the original PDF bytes are fixed.
   *
   * THE V2 REALITY: there is still no callable endpoint that writes a tagged PDF in Worker
   * runtime. A caller-supplied fixedPdfUrl is adopted for the later Review PDF phase, but Create HTML is
   * the browser-usable accessible alternate that exists immediately.
   */
  @callable()
  async createHtml(audit: AuditResult): Promise<HtmlResult> {
    this.markStep('create-html', 'started');
    this.appendEvent('pipeline.create-html.started', 'pipeline');
    const repair_plan: RepairPlanItem[] = audit.criteria
      .filter((c) => c.verdict !== 'passed' || c.needs_human)
      .map((c) => this.repairItemFor(c));
    const fixedPdfUrl = this.state.fixedPdfUrl;
    // Notes/events are echoed into the durable report ledger + event log. Strip any query/
    // fragment (where signed-URL credentials live) before echoing — the full URL stays only in the
    // structured `fixed_pdf` field (the caller's durable ref), not the human-readable surfaces.
    const fixedPdfDisplay = fixedPdfUrl ? redactUrl(fixedPdfUrl) : null;
    const remediated: RemediationResult = fixedPdfUrl
      ? {
          repair_plan,
          status: 'remediated',
          fixed_pdf: fixedPdfUrl,
          note: `Adopted a caller-supplied remediated V2 (tagged) PDF at ${fixedPdfDisplay}. (In-Worker tagged-PDF write is not available — V2 is produced offline by an external Python+Chrome+pikepdf pipeline; the repair plan above is the per-failure spec it implements.)`,
        }
      : {
          repair_plan,
          status: 'candidate',
          fixed_pdf: null,
          note: 'No V2 produced — repair plan derived from audit failures. V2 tagged-PDF write requires an offline pipeline (pikepdf + headless-Chrome generateTaggedPDF + PyMuPDF); there is NO callable remediation endpoint a Worker can invoke. Supply fixedPdfUrl (a pre-built V2) to get a real Compare before→after delta.',
        };

    const rows: HtmlResult['rows'] = audit.criteria.map((c) => ({
      area: c.criterion,
      refs: [`WCAG ${criterionCode(c.criterion)}`],
      status: createHtmlRowStatus(c),
      source: c.needs_human ? 'human' : 'machine',
      evidence: c.evidence.map((e) => e.detail).join(' '),
      rationale: c.rationale,
    }));
    if (repair_plan.length > 0) {
      rows.push({
        area: 'Semantic HTML draft',
        refs: ['WCAG 1.3.1', 'WCAG 1.3.2'],
        status: 'draft',
        source: 'draft',
        evidence: 'Generated a semantic HTML alternate and tag plan from audit evidence. Human review is required before attestation or LMS write-back.',
        rationale: 'Shadow HTML can provide correct DOM reading order in the browser; original PDF reading order changes only after a tagged PDF is emitted and validated.',
      });
    }

    const content_layer: HtmlResult['content_layer'] = [
      {
        id: 'title',
        role: 'heading',
        text: `Accessible HTML draft for ${this.state.docId ?? 'PDF'}`,
        refs: ['WCAG 2.4.2'],
        source: 'audit-evidence',
        needs_human: false,
      },
      ...audit.criteria.map((c, i) => {
        const code = criterionCode(c.criterion);
        return {
          id: `criterion-${code.replace(/\./g, '-')}-${i + 1}`,
          role: htmlRoleForCriterion(code),
          text: `${c.criterion}: ${c.rationale}`,
          refs: [`WCAG ${code}`],
          source: 'audit-evidence' as const,
          needs_human: c.needs_human,
        };
      }),
    ];

    const tag_plan: HtmlResult['tag_plan'] = content_layer.map((item) => ({
      id: `tag-${item.id}`,
      html: item.role === 'heading' ? 'h1' : item.role === 'list' ? 'ul/li' : item.role === 'table' ? 'table/th/td' : 'p',
      pdfTag: pdfTagForRole(item.role),
      sourceId: item.id,
      needs_human: item.needs_human,
    }));

    const html = this.buildAccessibleHtmlDraft(audit, repair_plan, content_layer);
    const htmlResult: HtmlResult = {
      html,
      content_layer,
      tag_plan,
      repair_plan,
      status: audit.failCount > 0 ? 'needs_review' : 'ready_for_review',
      fixed_pdf: fixedPdfUrl ?? null,
      note: fixedPdfUrl
        ? `Created semantic HTML draft and adopted caller-supplied V2 at ${fixedPdfDisplay}.`
        : 'Created semantic HTML draft. No fixed PDF was emitted in Worker runtime; Review PDF will record the blocker unless fixedPdfUrl is supplied.',
      summaryCards: [
        { label: 'Draft blocks', value: content_layer.length, tone: 'neutral' },
        { label: 'Repair items', value: repair_plan.length, tone: repair_plan.length ? 'warn' : 'pass' },
        { label: 'Needs review', value: audit.criteria.filter((c) => c.needs_human).length, tone: audit.criteria.some((c) => c.needs_human) ? 'warn' : 'pass' },
      ],
      rows,
    };

    this.setState({ ...this.state, pipeline: { ...this.state.pipeline, html: htmlResult, remediated }, updatedAt: Date.now() });
    this.markStep('create-html', 'done');
    this.appendEvent('pipeline.create-html.done', 'pipeline', `html_blocks=${content_layer.length} repair_plan=${repair_plan.length}${fixedPdfDisplay ? ` (V2=${fixedPdfDisplay})` : ' (no V2)'}`);
    return htmlResult;
  }

  /**
   * Legacy wrapper retained for older callers/tests. It runs Create HTML if needed and returns the
   * old remediated slice.
   */
  @callable()
  async remediate(audit: AuditResult): Promise<RemediationResult> {
    if (!this.state.pipeline.html) await this.createHtml(audit);
    const remediated = this.state.pipeline.remediated;
    if (!remediated) throw new Error('create_html_missing_remediation_alias');
    this.appendEvent('pipeline.remediate.done', 'pipeline', `legacy alias for create-html; status=${remediated.status}`);
    return remediated;
  }

  private buildAccessibleHtmlDraft(audit: AuditResult, repairPlan: RepairPlanItem[], contentLayer: HtmlResult['content_layer']): string {
    const source = this.state.pdfUrl ? redactUrl(this.state.pdfUrl) : 'source PDF';
    const criteriaItems = audit.criteria.map((c) =>
      `<li><strong>${escapeHtml(c.criterion)}</strong><br><span>${escapeHtml(c.rationale)}</span></li>`,
    ).join('');
    const repairItems = repairPlan.length
      ? repairPlan.map((item) => `<li><strong>${escapeHtml(item.criterion)}</strong><br>${escapeHtml(item.step)}</li>`).join('')
      : '<li>No repair items were generated from the machine audit.</li>';
    const contentItems = contentLayer.slice(1).map((item) =>
      `<section aria-labelledby="${escapeHtml(item.id)}-heading"><h2 id="${escapeHtml(item.id)}-heading">${escapeHtml(item.refs.join(', '))}</h2><p>${escapeHtml(item.text)}</p></section>`,
    ).join('\n');

    return [
      '<article class="a11y-accessible-html" data-a11y-phase="create-html">',
      `  <header><p>Source: ${escapeHtml(source)}</p><h1>Accessible HTML draft</h1></header>`,
      '  <section aria-labelledby="a11y-audit-summary">',
      '    <h2 id="a11y-audit-summary">Audit summary</h2>',
      `    <p>${escapeHtml(audit.failCount)} WCAG checks need review or remediation before attestation.</p>`,
      `    <ul>${criteriaItems}</ul>`,
      '  </section>',
      '  <section aria-labelledby="a11y-repair-plan">',
      '    <h2 id="a11y-repair-plan">Repair plan</h2>',
      `    <ol>${repairItems}</ol>`,
      '  </section>',
      '  <section aria-labelledby="a11y-content-layer">',
      '    <h2 id="a11y-content-layer">Cited content layer</h2>',
      contentItems,
      '  </section>',
      '  <footer><p>This HTML draft is an accessible alternate for browser/LMS delivery. It does not modify the original PDF bytes.</p></footer>',
      '</article>',
    ].join('\n');
  }

  /** Map a failing criterion to a repair-plan item (step text + automation confidence + QA flag). */
  private repairItemFor(c: CriterionFinding): RepairPlanItem {
    const code = c.criterion.split(' ')[0];
    const plan: Record<string, { step: string; automation_confidence: RepairPlanItem['automation_confidence']; human_qa_required: boolean }> = {
      '1.1.1': { step: 'Synthesize candidate /Alt + ActualText for each figure (VLM) for human QA.', automation_confidence: 'medium', human_qa_required: true },
      '1.3.1': { step: 'Add a tagged structure tree (StructTreeRoot + Marked) with headings/paragraphs and table TH from the PDF parse evidence.', automation_confidence: 'high', human_qa_required: true },
      '1.3.2': { step: 'Re-order the structure tree to match the reading-order pre-assessment; human confirms sequence.', automation_confidence: 'low', human_qa_required: true },
      '1.4.3': { step: 'Adjust text/background colors of failing spans to meet the WCAG 1.4.3 minimum, preserving layout.', automation_confidence: 'medium', human_qa_required: true },
      '2.4.2': { step: 'Set document Title metadata and enable ViewerPreferences /DisplayDocTitle.', automation_confidence: 'high', human_qa_required: false },
      '4.1.2': { step: 'Re-tag interactive/role elements so veraPDF UA-1 passes; reconcile against PAC.', automation_confidence: 'medium', human_qa_required: true },
    };
    const entry = plan[code] ?? { step: `Remediate ${c.criterion}.`, automation_confidence: 'low' as const, human_qa_required: true };
    return { criterion: c.criterion, ...entry };
  }

  /**
   * Step 3 — REVIEW PDF. before = the V1 audit non-pass count. When a fixed V2 exists
   * (html.fixed_pdf), RE-RUN the deterministic byte probe on the V2 and set after = the V2 non-pass
   * count. No V2 → after stays null while the report still exposes the Create HTML draft and keeps the
   * human attestation gate open.
   * @callable.
   */
  @callable()
  async reviewPdf(audit: AuditResult, html: HtmlResult): Promise<ComparisonResult> {
    this.markStep('review-pdf', 'started');
    this.appendEvent('pipeline.review-pdf.started', 'pipeline');

    const v2Url = html.fixed_pdf;
    let comparison: ComparisonResult;
    if (v2Url) {
      // Fail CLOSED (symmetry): a V2 re-audit error must NOT reject the whole pipeline — it
      // leaves after=null with the error noted (the safe direction; the before count still stands).
      try {
        const after = await this.reauditV2(v2Url);
        // `before` here is SAME-SCOPE as `after` — count non-pass over the SAME 4 byte-decidable
        // criteria from the V1 audit (1.1.1/1.3.1/1.3.2/2.4.2), NOT audit.failCount (which also includes the
        // contrast + validator lanes that reauditV2 does not re-measure on V2). Apples-to-apples delta.
        const before = this.byteCriteriaNonPass(audit.criteria);
        comparison = {
          validation_delta: {
            before,
            after: after.failCount,
            note: `Re-ran the deterministic byte probe on the remediated V2; after = its non-pass count over the SAME 4 structural/byte criteria (1.1.1-presence, 1.3.1, 1.3.2, 2.4.2) used for before. Δ = ${before - after.failCount} fewer non-pass structural criteria. (1.4.3 contrast + 4.1.2 validator are NOT re-measured on V2, so they are excluded from BOTH sides of this delta.)`,
          },
          after_evidence: after.evidence,
          visual_parity: 'deferred',
        };
      } catch (e) {
        // On error, fall back to the full-audit before (nothing was compared) + after=null.
        comparison = {
          validation_delta: { before: audit.failCount, after: null, note: `V2 re-audit failed (${String(e).slice(0, 160)}) — after not measured; before = the V1 full-audit non-pass count.` },
          visual_parity: 'deferred',
        };
      }
    } else {
      comparison = {
        validation_delta: { before: audit.failCount, after: null, note: `No emitted fixed PDF to validate yet. Create HTML produced ${html.content_layer.length} cited block(s) and ${html.tag_plan.length} tag-plan item(s); supply fixedPdfUrl or run the offline tagged-PDF emitter to measure after.` },
        visual_parity: 'deferred',
      };
    }

    this.setState({ ...this.state, pipeline: { ...this.state.pipeline, comparison }, updatedAt: Date.now() });
    this.markStep('review-pdf', 'done');
    this.appendEvent('pipeline.review-pdf.done', 'pipeline', `before=${comparison.validation_delta.before} after=${comparison.validation_delta.after ?? 'null'} parity=${comparison.visual_parity}`);
    return comparison;
  }

  /** Legacy wrapper retained for older callers/tests. */
  @callable()
  async compare(audit: AuditResult, remediated: RemediationResult): Promise<ComparisonResult> {
    const html = this.state.pipeline.html ?? this.htmlShimFromRemediation(remediated);
    const comparison = await this.reviewPdf(audit, html);
    this.appendEvent('pipeline.compare.done', 'pipeline', `legacy alias for review-pdf; before=${comparison.validation_delta.before} after=${comparison.validation_delta.after ?? 'null'}`);
    return comparison;
  }

  private htmlShimFromRemediation(remediated: RemediationResult): HtmlResult {
    return {
      html: '',
      content_layer: [],
      tag_plan: [],
      repair_plan: remediated.repair_plan,
      status: remediated.status === 'remediated' ? 'ready_for_review' : 'needs_review',
      fixed_pdf: remediated.fixed_pdf,
      note: remediated.note,
      summaryCards: [
        { label: 'Repair items', value: remediated.repair_plan.length, tone: remediated.repair_plan.length ? 'warn' : 'pass' },
      ],
      rows: remediated.repair_plan.map((item) => ({
        area: item.criterion,
        refs: [`WCAG ${criterionCode(item.criterion)}`],
        status: 'review',
        source: 'draft',
        evidence: item.step,
        rationale: item.human_qa_required ? 'Human QA required.' : 'Machine-derived repair item.',
      })),
    };
  }

  /**
   * Re-audit a remediated V2 PDF for the Compare delta.
   *
   * Correctness invariants (3 fixes baked in):
   *  1. PURE probe — uses probeV2() (fetch + probePdf, NO this.audit/auditBytes), so it does NOT write the
   *     'record' storage or touch pipeline.audit/steps/gate. The V1 report state is never clobbered by the
   *     V2 re-audit (compare must not mutate the audited document's ledger).
   *  2. SAME-SEMANTICS `after` — re-runs the BYTE-DECIDABLE criterion methods (criterion111/131/132/242 =
   *     1.1.1-presence / 1.3.1 / 1.3.2 / 2.4.2) on the V2 probe and counts non-pass (verdict!=='passed' ||
   *     needs_human), IDENTICAL to how `before` counts those criteria. 1.4.3 (contrast, needs image) and
   *     4.1.2 (validator, needs network) are NOT re-measured on V2 — so the delta is explicitly SCOPED to
   *     the structural/byte criteria (the ones that actually flip untagged→tagged), and we never report a
   *     fabricated 0 by silently dropping the contrast/validator escalations. Documented in the note + evidence.
   *  3. TIMEOUT — probeV2 wraps the fetch in an AbortController so a stalled V2 URL fails closed (the
   *     caller's try/catch then leaves after=null), never hanging the coordinator DO.
   */
  private async reauditV2(v2Url: string): Promise<{ failCount: number; evidence: Assessment['evidence'] }> {
    const probe = await this.probeV2(v2Url, V2_REAUDIT_TIMEOUT_MS);

    // Re-derive the BYTE-DECIDABLE criteria on the V2 probe (criterion143 contrast / criterion412 validator
    // are intentionally excluded — they need the page image / a network oracle, not re-measured on V2).
    const byteCriteria: CriterionFinding[] = [
      this.criterion111(probe),
      this.criterion131(probe),
      this.criterion132(probe),
      this.criterion242(probe),
    ];
    const nonPass = byteCriteria.filter((c) => c.verdict !== 'passed' || c.needs_human);

    const evidence: Assessment['evidence'] = [
      {
        kind: 'measurement',
        detail: `V2 byte re-audit (structural criteria only): tagged=${!!probe.tagged}, title=${probe.title ? 'set' : 'none'}, lang=${probe.lang ?? 'none'}, score=${probe.score ?? 'n/a'}; ${nonPass.length}/${byteCriteria.length} byte criteria non-pass. (1.4.3 contrast + 4.1.2 validator NOT re-measured on V2 → delta is scoped to structure.)`,
        citation: 'v2-reaudit',
      },
      ...nonPass.slice(0, 8).map((c): Assessment['evidence'][number] => ({ kind: 'validator', detail: `${c.criterion}: ${c.rationale}`, citation: 'v2-reaudit' })),
    ];
    return { failCount: nonPass.length, evidence };
  }

  /**
   * Count non-pass among the 4 BYTE-DECIDABLE criteria (1.1.1/1.3.1/1.3.2/2.4.2) in an audit's criteria
   * list — the SAME scope reauditV2 measures on the V2, so the Compare `before` and `after` are one metric
   * (same-semantics delta). Contrast (1.4.3) + validator (4.1.2) are excluded from both sides.
   */
  private byteCriteriaNonPass(criteria: CriterionFinding[]): number {
    return criteria.filter(
      (c) => BYTE_CRITERIA_SC.has(c.criterion.split(' ')[0]) && (c.verdict !== 'passed' || c.needs_human),
    ).length;
  }

  /**
   * Fetch a PDF URL + run the deterministic byte probe WITHOUT touching DO storage or the report ledger
   * (compare()'s V2 re-audit must not clobber the V1 audit `record`/pipeline.audit). Wrapped
   * in an AbortController timeout so a stalled URL fails closed instead of hanging the coordinator DO.
   */
  private async probeV2(url: string, timeoutMs: number): Promise<any> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'wcag-audit-agent/0.1 (+https://app.example.com)' },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`v2_fetch_failed ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return await probePdf(bytes);
    } finally {
      clearTimeout(t);
    }
  }

  /** Mark a pipeline step's status + timestamps in the step list. */
  private markStep(step: PipelineStep, status: PipelineStepState['status']): void {
    const now = Date.now();
    const steps = this.state.steps.map((s) =>
      s.step === step
        ? { ...s, status, ...(status === 'started' ? { startedAt: now } : {}), ...(status === 'done' ? { doneAt: now } : {}) }
        : s,
    );
    // If the step wasn't seeded (defensive), append it.
    if (!steps.some((s) => s.step === step)) steps.push({ step, status, ...(status === 'started' ? { startedAt: now } : { doneAt: now }) });
    this.setState({ ...this.state, steps, updatedAt: now });
  }

  // ───────── coordinator-owned SpecialistWorkflow path (Routine → Agent → Done) ─────────
  //
  // Same 2-domain report, driven through the ONE shared SpecialistWorkflow instead of the inline
  // subAgent().assess() calls. The event stream now comes from the workflow lifecycle hooks
  // (onWorkflowProgress writes routine.*/agent.* events; onWorkflowComplete writes the domain row +
  // rolls up the gate once every dispatched domain has completed). This is ADDITIVE and flag-gated —
  // the live /v2/audit-a11y default stays on the proven inline path so it can't regress.

  /**
   * Workflow-driven audit entrypoint. Resets the report, then kicks the coordinator-owned
   * SpecialistWorkflow once per domain. Each workflow drives routine→agent→done and reports back via
   * the lifecycle hooks. Returns immediately with the seeded report (rows fill in as workflows
   * complete; poll /v2/audit-status). The coordinator owns the ledger + gate.
   */
  async auditA11yViaWorkflow(input: {
    docId: string;
    pdfUrl: string;
    imageUrl?: string;
    pagePointWidth?: number;
    domains?: DomainName[];
  }): Promise<{ docId: string; dispatched: string[]; report: A11yReportState }> {
    const { docId, pdfUrl, imageUrl, pagePointWidth } = input;
    const domains: DomainName[] = input.domains ?? (['validator', 'contrast-service'] as DomainName[]);

    // A superseding run must REJECT any prior parked workflows first, else an old parked
    // SpecialistWorkflow leaks (the new run may finalize cleanly with no decideReport() to release it).
    // Reject (not approve) — a discarded prior audit shouldn't auto-attest.
    const stillParked = await this.releaseGatedWorkflows('reject', 'superseded by re-audit');
    if (stillParked.length > 0) {
      // A live prior workflow refused rejection. REFUSE to start a new run — otherwise the new run could
      // finalize cleanly (onWorkflowProgress rollup) while the prior workflow stays parked + leaks. The
      // operator must resolve the stuck workflow (retry decide) first. (gatedWorkflows still tracks it.)
      throw new Error(
        `prior_workflow_unreleased: ${stillParked.length} parked workflow(s) (${stillParked.map((g) => g.domain).join(', ')}) refused rejection — resolve before re-auditing.`,
      );
    }

    // Fresh report for this run (clear prior rows/events so a re-audit doesn't accrete). gatedWorkflows
    // is now empty (all prior parked workflows were released above, or there were none).
    await this.cancelReviewSla();
    this.setState({
      ...this.state,
      docId,
      pdfUrl,
      gate: 'open',
      rows: [],
      events: [],
      pendingDomains: [...domains],
      updatedAt: Date.now(),
    });

    for (const domain of domains) {
      // contrast layerizes a rasterized page image; validator takes the PDF.
      const sourceUrl = domain === 'contrast-service' ? imageUrl ?? pdfUrl : pdfUrl;
      await this.runWorkflow('SPECIALIST_WORKFLOW', {
        domain,
        params: { pdfUrl: sourceUrl, id: docId, fileName: docId, imageUrl, pagePointWidth },
      });
    }
    return { docId, dispatched: domains, report: this.state };
  }

  /**
   * Coordinator bridge — routine() seam. The SpecialistWorkflow calls this.agent.domainRoutine();
   * the coordinator dispatches the facet via subAgent(CLS[domain], docId) and returns the
   * deterministic pre-verdict row + whether it's settled + the deterministic detail (so domainDecide
   * can route without re-running the heavy routine). @callable so the workflow can invoke it.
   */
  @callable()
  async domainRoutine(
    domain: string,
    params: AssessParams,
  ): Promise<{ row: Assessment; settled: boolean; detail: unknown }> {
    const facet = await this.specialistFor(domain, String(params.id));
    return facet.routineWithSettle(params);
  }

  /**
   * Coordinator bridge — turn() seam (the LLM-completes step). Called only when the
   * routine didn't settle. Dispatches the same facet and routes the deterministic row through its
   * LLM completion router (the facet + base re-apply the deterministic-authority guard). @callable.
   */
  @callable()
  async domainDecide(domain: string, deterministicRow: Assessment, detail: unknown): Promise<Assessment> {
    const facet = await this.specialistFor(domain, this.state.docId ?? domain);
    return facet.turnRow(deterministicRow, detail);
  }

  /** Resolve the domain class + create the facet under this coordinator. */
  private async specialistFor(domain: string, docId: string) {
    const Cls = (SPECIALIST_CLASSES as Record<string, abstract new (...args: any[]) => unknown>)[domain];
    if (!Cls) throw new Error(`unknown_a11y_domain ${domain}`);
    // subAgent's typed map needs the concrete class; the lookup above is the registry.
    return (await this.subAgent(Cls as any, docId)) as unknown as {
      routineWithSettle: (p: AssessParams) => Promise<{ row: Assessment; settled: boolean; detail: unknown }>;
      turnRow: (row: Assessment, detail: unknown) => Promise<Assessment>;
    };
  }

  /**
   * Lifecycle hook — the SpecialistWorkflow's reportProgress drives the routine/agent lifecycle
   * events, AND (on phase 'row.ready') writes the domain's final row into the ledger + rolls up the report
   * gate once every dispatched domain has reported. Writing on row.ready (before the workflow parks on
   * waitForApproval) is what lets the report show pending_review WITH the rows while the human decides.
   */
  async onWorkflowProgress(workflowName: string, _workflowId: string, progress: unknown): Promise<void> {
    // REMEDIATION_WORKFLOW: the step methods (runAudit/findSource/remediate/compare) self-persist their
    // slice + pipeline events + step status when they run inside step.do(this.agent.*); the parked-id
    // registration is a DURABLE step.do(armPipelineGate) (NOT progress). So the workflow's own
    // reportProgress is purely transient here and intentionally IGNORED (no double-write).
    if (workflowName === 'REMEDIATION_WORKFLOW') return;
    if (workflowName !== 'SPECIALIST_WORKFLOW') return; // ignore per-facet direct workflows
    const p = progress as {
      domain?: string;
      phase?: string;
      detail?: string;
      row?: Assessment;
      workflowId?: string;
      needsHuman?: boolean;
    };
    if (!p?.domain || !p?.phase) return;

    // Intermediate lifecycle events (routine/agent phases).
    const map: Record<string, LedgerEvent['event'] | undefined> = {
      'routine.started': 'routine.started',
      'routine.done': 'routine.done',
      'turn.started': 'turn.started',
      'turn.done': 'turn.done',
    };
    const event = map[p.phase];
    if (event) {
      this.appendEvent(event, p.domain, p.detail);
      return;
    }

    if (p.phase !== 'row.ready' || !p.row) return;
    const row = p.row;

    // Write the domain row + machine.pre_assessment (+ human.review.requested if gated).
    this.upsertRow({
      agent: row.agent, runId: this.state.docId, state: row.state, verdict: row.verdict,
      needs_human: row.needs_human, standard_refs: row.standard_refs, evidence: row.evidence,
      rationale: row.rationale, updatedAt: Date.now(),
    });
    this.appendEvent('machine.pre_assessment', row.agent, `verdict=${row.verdict} (${row.rationale})`);
    if (row.needs_human) this.appendEvent('human.review.requested', row.agent, row.rationale);

    // Track the parked workflow so decideReport() can approve/reject it when the gate resolves. Key on
    // workflowId (NOT domain) so a same-domain re-park can never evict a different still-parked workflow
    // De-dupe by workflowId in case row.ready is re-delivered on a workflow retry.
    if (p.needsHuman && p.workflowId) {
      const wfId = p.workflowId;
      const gated = [
        ...(this.state.gatedWorkflows ?? []).filter((g) => g.workflowId !== wfId),
        { domain: p.domain, workflowId: wfId },
      ];
      this.setState({ ...this.state, gatedWorkflows: gated, updatedAt: Date.now() });
    }

    // Clear this domain from the pending set; roll up only when all dispatched domains have reported.
    const pending = (this.state.pendingDomains ?? []).filter((d) => d !== p.domain);
    this.setState({ ...this.state, pendingDomains: pending, updatedAt: Date.now() });
    if (pending.length > 0) return;

    // All domains reported → worst-case rollup (identical rule to the inline path).
    // defense-in-depth: never finalize while ANY workflow is still parked (gatedWorkflows non-empty) —
    // a clean-looking rollup must not finalize over a parked workflow. (auditA11yViaWorkflow already
    // refuses to start while a prior workflow is unreleased, so this is belt-and-suspenders.)
    await this.cancelReviewSla();
    const anyParked = (this.state.gatedWorkflows ?? []).length > 0;
    const allClean = !anyParked && this.state.rows.every((r) => r.verdict === 'passed' && !r.needs_human);
    if (!allClean) {
      this.setReportGate('pending_review');
      await this.schedule(REVIEW_SLA_SECONDS, 'onReviewSlaElapsed');
    } else {
      this.setReportGate('finalized');
    }
    this.appendEvent('rollup.updated', 'rollup', `report gate=${this.state.gate} (rows: ${this.state.rows.length})`);
  }

  /**
   * Lifecycle hook — a SpecialistWorkflow run closed (after the human gate, if any). The domain row +
   * rollup were already written on the row.ready progress event, so this is a no-op for the shared
   * workflow (kept to satisfy the override + avoid double-writing the ledger).
   */
  async onWorkflowComplete(workflowName: string, workflowId: string, _result?: unknown): Promise<void> {
    // SPECIALIST_WORKFLOW: the domain row + rollup were written on the row.ready progress event — no-op.
    // REMEDIATION_WORKFLOW: the pipeline slices were self-persisted by the step methods; on completion
    // (the run closed AFTER the attestation gate) just drop it from the parked set so a later re-run /
    // decide doesn't think it's still parked.
    if (workflowName === 'REMEDIATION_WORKFLOW') {
      const gated = (this.state.gatedWorkflows ?? []).filter((g) => g.workflowId !== workflowId);
      this.setState({ ...this.state, gatedWorkflows: gated, pipelineArming: false, updatedAt: Date.now() });
    }
  }

  /**
   * Lifecycle hook — a workflow errored. For the REMEDIATION_WORKFLOW, clear pipelineArming + untrack
   * the failed instance so a stuck arming flag can't defer decides forever (round-2 fix: the
   * arming guard must release if the workflow dies before parking). Surface it on the report.
   */
  async onWorkflowError(workflowName: string, workflowId: string, error: string): Promise<void> {
    if (workflowName !== 'REMEDIATION_WORKFLOW') return;
    const gated = (this.state.gatedWorkflows ?? []).filter((g) => g.workflowId !== workflowId);
    this.setState({ ...this.state, gatedWorkflows: gated, pipelineArming: false, updatedAt: Date.now() });
    this.appendEvent('rollup.updated', 'pipeline', `pipeline workflow ${workflowId} errored: ${String(error).slice(0, 200)}`);
  }

  /** Resolve the report-level human gate. The coordinator owns the gate (human.* events). */
  async decideReport(decision: 'approve' | 'reject', note?: string): Promise<A11yReportState> {
    if (this.state.gate !== 'pending_review') {
      // Idempotent / no-op decisions are still recorded but don't fabricate a gate.
      this.appendEvent(decision === 'approve' ? 'human.approved' : 'human.rejected', 'reviewer', note ?? `${decision} (no open gate)`);
      return this.state;
    }
    // TOCTOU: a durable RemediationWorkflow has been dispatched but hasn't yet
    // registered its parked id (pipelineArming). Finalizing now would strand the workflow once it parks.
    // Defer: keep the report gated, leave arming set, let the caller retry once the workflow has armed.
    if (this.state.pipelineArming) {
      this.appendEvent('rollup.updated', 'pipeline', `decide(${decision}) deferred — pipeline workflow still arming (not yet parked); report stays gated, retry decide.`);
      return this.state;
    }
    // Release the parked SpecialistWorkflow runs (the coordinator-owned path) BEFORE flipping the gate,
    // and DO NOT finalize if a live parked workflow couldn't be released — otherwise the report could
    // finalize while a durable workflow stays parked + untracked. releaseGatedWorkflows returns the
    // workflows that genuinely failed to release (still parked); those stay tracked.
    const stillParked = await this.releaseGatedWorkflows(decision, note);
    if (stillParked.length > 0) {
      // Some live workflows refused approve/reject → keep the report gated and surface it. The caller
      // can retry decideReport(); the SLA stays armed. (A "no-op" no-such-instance error is treated as
      // already-resolved and does NOT block — see releaseGatedWorkflows.)
      this.appendEvent(
        'rollup.updated',
        'rollup',
        `decide(${decision}) deferred — ${stillParked.length} parked workflow(s) failed to release (${stillParked.map((g) => g.domain).join(', ')}); report stays gated, retry decide.`,
      );
      return this.state;
    }

    if (decision === 'approve') {
      this.setReportGate('finalized');
      this.appendEvent('human.approved', 'reviewer', note ?? 'approved');
    } else {
      this.setReportGate('rejected');
      this.appendEvent('human.rejected', 'reviewer', note ?? 'rejected');
    }
    // Gate resolved → cancel the report SLA so it can't fire later.
    await this.cancelReviewSla();
    return this.state;
  }

  /**
   * Approve/reject every parked SpecialistWorkflow run. Returns the workflows that genuinely FAILED to
   * release (a live parked instance that threw on approve/reject) so the caller can keep the report
   * gated. An "instance not found / already terminated" error is treated as already-
   * resolved (no longer parked) and is NOT returned as still-parked. Successfully-released + already-
   * resolved workflows are dropped from gatedWorkflows; failed ones stay tracked for a retry.
   */
  private async releaseGatedWorkflows(
    decision: 'approve' | 'reject',
    note?: string,
  ): Promise<Array<{ domain: string; workflowId: string }>> {
    const gated = this.state.gatedWorkflows ?? [];
    if (!gated.length) return [];
    const stillParked: Array<{ domain: string; workflowId: string }> = [];
    for (const g of gated) {
      try {
        if (decision === 'approve') {
          await this.approveWorkflow(g.workflowId, { reason: note ?? 'approved' });
        } else {
          await this.rejectWorkflow(g.workflowId, { reason: note ?? 'rejected' });
        }
      } catch (e) {
        const msg = String(e).toLowerCase();
        const alreadyGone = msg.includes('not found') || msg.includes('does not exist') || msg.includes('terminated') || msg.includes('completed');
        if (!alreadyGone) stillParked.push(g); // a live parked workflow that refused release → keep gated
      }
    }
    // Drop everything except the genuinely-still-parked workflows.
    this.setState({ ...this.state, gatedWorkflows: stillParked, updatedAt: Date.now() });
    return stillParked;
  }

  async getReport(): Promise<A11yReportState> {
    return this.state;
  }

  // ── ledger helpers (pure state mutation on the coordinator) ──

  private appendEvent(event: LedgerEvent['event'], agent: string, detail?: string): void {
    const events = [...this.state.events, { at: Date.now(), event, agent, detail }];
    this.setState({ ...this.state, events, updatedAt: Date.now() });
  }

  private upsertRow(row: ReportRow): void {
    const rows = this.state.rows.filter((r) => r.agent !== row.agent);
    rows.push(row);
    this.setState({ ...this.state, rows, updatedAt: Date.now() });
  }

  private setReportGate(gate: Gate): void {
    this.setState({ ...this.state, gate, updatedAt: Date.now() });
  }
}
