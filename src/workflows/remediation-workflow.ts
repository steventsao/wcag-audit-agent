// remediation-workflow.ts — the PDF accessibility DOMAIN pipeline as a durable AgentWorkflow.
//
// THE REFRAME: this REPLACES the abstract Routine→Turn→Done framing at the report level with the
// business-domain pipeline that mirrors the live three-phase report:
//
//     Start → Audit source PDF → Create HTML → Review PDF → (attestation gate) → End
//
// Each step is a coordinator method (this.agent.* — the workflow's `agent` stub IS the top-level
// A11yAgent, so these run on the coordinator that owns the ledger + gate; the Audit step's facet
// dispatch (validator/contrast subAgents) happens inside runAudit, same as domainRoutine). Between
// steps reportProgress(...) is emitted (transient client-broadcast) for visibility, but the DURABLE
// pipeline event log (pipeline.audit.started/.done, pipeline.create-html.started, …) is written by the
// coordinator STEP METHODS themselves (they self-persist their slice + events when run inside
// step.do(this.agent.*)), so the event log is identical inline vs workflow and the coordinator IGNORES
// REMEDIATION_WORKFLOW progress (no double-write). After Review PDF, a durable step.do(armPipelineGate)
// registers the parked id, then waitForApproval is the durable attestation gate; reportComplete closes
// the run with the full {audit, html, comparison} payload.
//
// `routine` is NOT a phase here — Audit itself is a hybrid of routine + llm (the PIPELINE config makes
// the split explicit). The Routine→settle→turn loop still runs, but DEMOTED to the technique a
// specialist facet executes INSIDE runAudit.
import type { WorkflowStepConfig } from 'cloudflare:workers';
import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from 'agents/workflows';
import type { A11yAgent, Env } from '../a11y-agent';
import type { PipelineStep, AuditResult, HtmlResult, ComparisonResult } from '../pipeline';

/** Params the remediation pipeline carries. */
export interface RemediationParams {
  docId: string;
  pdfUrl: string;
  /** Durable Object storage key containing uploaded PDF bytes for private/local PDFs. */
  uploadedPdfStorageKey?: string;
  /** Original uploaded file name, used in evidence labels and HTML draft source text. */
  uploadedFileName?: string;
  /** Rasterized page image for the contrast lane (fal layerize processes images, not PDFs). */
  imageUrl?: string;
  /** Page width in PostScript points → enables WCAG large-text classification in the contrast lane. */
  pagePointWidth?: number;
  /**
   * Optional URL of a PRE-BUILT remediated V2 (tagged) PDF. There is NO callable endpoint that
   * writes a tagged PDF in-Worker (the V2 is produced offline by an external Python+Chrome+pikepdf
   * remediation pipeline). When the caller supplies one, Create HTML adopts it
   * and Review PDF re-audits it for a REAL before→after delta; absent → HTML alternate +
   * after=null (the honest blocker).
   */
  fixedPdfUrl?: string;
}

/**
 * Progress payload — carries the pipeline step + phase so the coordinator's onWorkflowProgress can
 * write the pipeline event (`pipeline.<step>.started`/`.done`) and flip the step-list status.
 */
export interface RemediationProgress {
  step: PipelineStep;
  phase: 'started' | 'done';
  detail?: string;
}

// Heavy steps (Audit hits fal + veraPDF + VLM). Generous timeout + durable retries so a slow fal /
// container call retries without crashing the agent.
const STEP_CFG: WorkflowStepConfig = {
  retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
};

export class RemediationWorkflow extends AgentWorkflow<A11yAgent, RemediationParams, RemediationProgress, Env> {
  async run(event: AgentWorkflowEvent<RemediationParams>, step: AgentWorkflowStep) {
    const p = event.payload;

    // ── Step 1: Audit (FULLY REAL) — the 6 WCAG criteria via byte-probe + contrast + validator ──
    await this.reportProgress({ step: 'audit', phase: 'started', detail: `audit ${p.docId}` });
    const audit = (await step.do('audit', STEP_CFG, () => this.agent.runAudit(p))) as AuditResult;
    await this.reportProgress({ step: 'audit', phase: 'done', detail: `${audit.criteria.length} criteria, ${audit.failCount} non-pass, gate=${audit.gate}` });

    // ── Step 2: Create HTML (thin-real) — semantic HTML alternate + tag plan from audit evidence ──
    await this.reportProgress({ step: 'create-html', phase: 'started' });
    const html = (await step.do('create-html', STEP_CFG, () => this.agent.createHtml(audit))) as HtmlResult;
    await this.reportProgress({ step: 'create-html', phase: 'done', detail: `html_blocks=${html.content_layer.length} repair_plan=${html.repair_plan.length} status=${html.status}` });

    // ── Step 3: Review PDF (thin-real) — emitted-candidate validation + human gate evidence ──
    await this.reportProgress({ step: 'review-pdf', phase: 'started' });
    const comparison = (await step.do('review-pdf', STEP_CFG, () => this.agent.reviewPdf(audit, html))) as ComparisonResult;
    await this.reportProgress({ step: 'review-pdf', phase: 'done', detail: `before=${comparison.validation_delta.before} after=${comparison.validation_delta.after ?? 'null'} parity=${comparison.visual_parity}` });

    // ── Register this parked workflow id with the coordinator + clear pipelineArming, BEFORE parking.
    // This closes the TOCTOU window: runRemediation set pipelineArming=true so a
    // decideReport() arriving during dispatch couldn't finalize over an untracked workflow; this DURABLE
    // step.do() call to armPipelineGate() tracks gatedWorkflows=[{domain:'pipeline',workflowId}] +
    // clears arming. Using step.do (NOT reportProgress) makes the registration UNAMBIGUOUSLY durable
    // and awaited — it cannot be lost, and the workflow only parks AFTER it has durably landed. ──
    await step.do('register-gate', STEP_CFG, () => this.agent.armPipelineGate(this.workflowId));

    // ── Attestation gate (durable multi-day human wait). The coordinator opened the report gate to
    // pending_review BEFORE dispatch (so the report shows pending_review WITH the pipeline output) and
    // approves/rejects this parked workflow via decideReport(). Attestation is always an explicit human
    // act — a clean audit does NOT auto-finalize. ──
    await this.waitForApproval(step, { timeout: '7 days' });

    // ── End — close the run with the full pipeline payload. ──
    await step.reportComplete({ audit, html, comparison });
    return { audit, html, comparison };
  }
}
