// validator-agent.ts — the ValidatorAgent specialist, refactored onto A11ySpecialistAgent.
//
// Domain: pdfua_validation (veraPDF + PAC reconciliation). The assess() contract maps as:
//   routine()     — run lane A (veraPDF / deterministic byte audit) + lane B (PAC) + reconcileValidators.
//                   This is the heavy, deterministic mechanical work (CONTAINER/HTTP). No LLM.
//   settle()      — a clean both-agree result (needs_human===false) is settled here.
//   turn() — the validator is MOSTLY deterministic; when reconciliation needs a human
//                   (single-oracle / validator disagreement) this turns the bare needs_human into a
//                   reasoned escalation naming the conflicting lanes (the LLM-completes step).
//   getSkills()   — run-verapdf · run-pac · reconcile.
//
// The lightweight brain owns the durable ledger (this.state) + human gate, and OFFLOADS the heavy
// veraPDF/PAC work to ValidatorWorkflow via this.runWorkflow() (the brain never runs validators in
// its own loop). The coordinator dispatches this as a subAgent facet and calls assess() (an RPC return
// crosses the facet boundary cleanly). The class name stays EXACTLY `ValidatorAgent` (DO binding
// VALIDATOR_AGENT kebab-matches it for getAgentByName()/runWorkflow()).
import { reconcileValidators, type Assessment, type ValidatorLane } from '../a2a';
import { A11ySpecialistAgent, type A11ySkill, type AssessParams, type RoutineResult } from '../specialist';

export interface ValidatorParams {
  pdfUrl: string;
  id: string;
  fileName?: string;
}

/** Env for the validator pieces (additive to the existing plain-DO Env). */
export interface ValidatorEnv extends Cloudflare.Env {
  VALIDATOR_AGENT: DurableObjectNamespace<ValidatorAgent>;
  VALIDATOR_WORKFLOW: Workflow;
  /** Service binding to the deployed WCAG Audit Agent (lane A); falls back to ACTOR_AUDIT_URL. */
  PDF_A11Y_AGENT?: Fetcher;
  ACTOR_AUDIT_URL?: string;
  /** PAC/axesSense container endpoint (lane B); absent → single-oracle → human gate. */
  PAC_VALIDATOR_URL?: string;
}

export interface ValidatorState {
  id?: string;
  pdfUrl?: string;
  row?: Assessment;
  gate: 'open' | 'pending_review' | 'finalized' | 'rejected';
  updatedAt?: number;
}

/** The deterministic detail routine() carries forward: the two reconciled validator lanes. */
interface ValidatorDetail {
  verapdf: ValidatorLane;
  pac: ValidatorLane;
}

export class ValidatorAgent extends A11ySpecialistAgent<ValidatorEnv, ValidatorState> {
  initialState: ValidatorState = { gate: 'open' };

  // Domain = the stable row identity in the coordinator's report ledger. The spec's aspirational name
  // is 'pdfua_validation', but the live 2-domain report keys this row as 'validator' (and the
  // reconcileValidators evidence stamps the same) — keep that stable so the report doesn't regress.
  // The domain IS the stamped `agent`; renaming is a separate, deliberate migration.
  readonly domain = 'validator';
  readonly standardRefs = ['PDF/UA-1', 'WCAG'];

  getSkills(): A11ySkill[] {
    return [
      {
        name: 'run-verapdf',
        description: 'Run veraPDF / the deterministic byte audit (lane A) over the PDF.',
        instructions: 'POST the PDF to the deployed WCAG Audit Agent /audit (PDF_A11Y_AGENT binding); read its gate + findings as the veraPDF lane verdict.',
      },
      {
        name: 'run-pac',
        description: 'Run PAC / axesSense Matterhorn checks (lane B) over the PDF.',
        instructions: 'POST the PDF to the PAC validator container (PAC_VALIDATOR_URL); absent → lane unavailable → single-oracle escalation.',
      },
      {
        name: 'reconcile',
        description: 'Reconcile the two validator lanes — a single green is NOT conformance; a disagreement is an auditable human-gate escalation (the moat).',
        instructions: 'reconcileValidators(verapdf, pac): agree→completed; single-oracle or disagreement→input_required (human gate).',
      },
    ];
  }

  // ───────────────────────── assess() contract ─────────────────────────

  /** DETERMINISTIC: run both validator lanes + reconcile (the heavy, no-LLM mechanical work). */
  async routine(p: AssessParams): Promise<RoutineResult<ValidatorDetail>> {
    const params: ValidatorParams = { pdfUrl: p.pdfUrl, id: p.id, fileName: p.fileName };
    this.setState({ ...this.state, id: params.id, pdfUrl: params.pdfUrl, updatedAt: Date.now() });
    const verapdf = await this.fetchLaneA(params);
    const pac = await this.fetchLaneB(params);
    const row = reconcileValidators(verapdf, pac);
    return { row, detail: { verapdf, pac } };
  }

  /** Settle the clean case: both lanes ran and agree (no human needed). Else defer to turn. */
  protected settle(r: RoutineResult): Assessment | null {
    return r.row.needs_human ? null : r.row;
  }

  /**
   * The LLM-completes step for the validator. It is MOSTLY deterministic: reconcileValidators
   * already decided WHY a human is needed (single-oracle vs disagreement) and wrote a rationale. This
   * step turns that bare needs_human into a reasoned, specific completion action — naming the
   * conflicting lanes as the human question — without recomputing the mechanical verdict. (No external
   * LLM call is required for the validator: the deterministic reconciliation already names the
   * conflict precisely; escalating with that conflict IS the completion action. The base's
   * enforceDeterministicAuthority guard keeps the gate closed regardless.)
   */
  async turn(r: RoutineResult): Promise<Assessment> {
    const { verapdf, pac } = r.detail as ValidatorDetail;
    const laneState = (l: ValidatorLane) =>
      l.available === false ? 'unavailable' : typeof l.pass === 'boolean' ? (l.pass ? 'pass' : 'fail') : (l.gate ?? 'ran');
    const question = `Validator reconciliation needs human sign-off (veraPDF lane: ${laneState(verapdf)}, PAC lane: ${laneState(pac)}). ${r.row.rationale}`;
    return {
      ...r.row,
      state: 'input_required',
      needs_human: true,
      rationale: question,
    };
  }

  // ───────────────────── legacy/direct surfaces (preserved) ─────────────────────

  /** Kick the durable validation workflow; returns immediately with the tracked workflow id. */
  async validate(params: ValidatorParams): Promise<{ workflowId: string; state: ValidatorState }> {
    this.setState({ ...this.state, id: params.id, pdfUrl: params.pdfUrl, gate: 'open', updatedAt: Date.now() });
    const workflowId = await this.runWorkflow('VALIDATOR_WORKFLOW', params);
    return { workflowId, state: this.state };
  }

  /**
   * Facet-native synchronous validation (the coordinator path). Now a thin wrapper over the shared
   * assess() loop (routine → settle → turn), so the validator follows the SAME assess() contract
   * as ColorContrastAgent. Sets the durable gate from the returned row (the coordinator owns the
   * report-level gate; this state.gate backs the direct /v2/* status surface). Kept for back-compat
   * with the coordinator's call site.
   */
  async validateInline(params: ValidatorParams): Promise<Assessment> {
    const row = await this.assess({ pdfUrl: params.pdfUrl, id: params.id, fileName: params.fileName });
    this.setState({
      ...this.state,
      row,
      gate: row.needs_human ? 'pending_review' : 'finalized',
      updatedAt: Date.now(),
    });
    return row;
  }

  /** Lane A — deterministic byte audit (the deployed WCAG Audit Agent /audit, reused). */
  private async fetchLaneA(params: ValidatorParams): Promise<ValidatorLane> {
    const req = new Request(this.actorAuditUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ pdf_url: params.pdfUrl, id: params.id, file_name: params.fileName }),
    });
    const res = this.env.PDF_A11Y_AGENT ? await this.env.PDF_A11Y_AGENT.fetch(req) : await fetch(req);
    if (!res.ok) throw new Error(`verapdf_lane ${res.status}`);
    return (await res.json()) as ValidatorLane;
  }

  /** Lane B — PAC/axesSense (heavy Container). Absent → unavailable → single-oracle escalation. */
  private async fetchLaneB(params: ValidatorParams): Promise<ValidatorLane> {
    if (!this.env.PAC_VALIDATOR_URL) return { available: false };
    const res = await fetch(this.env.PAC_VALIDATOR_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ pdf_url: params.pdfUrl, id: params.id, file_name: params.fileName }),
    });
    if (!res.ok) throw new Error(`pac_lane ${res.status}`);
    return (await res.json()) as ValidatorLane;
  }

  private actorAuditUrl(): string {
    if (this.env.PDF_A11Y_AGENT) return 'https://wcag-audit-agent.internal/audit';
    return `${(this.env.ACTOR_AUDIT_URL || 'https://wcag-audit-agent.example.workers.dev').replace(/\/+$/, '')}/audit`;
  }

  async getStatus(): Promise<ValidatorState> {
    return this.state;
  }

  /** Resolve the human gate (validator disagreement / single-oracle). approve → finalized. */
  async decide(workflowId: string, decision: 'approve' | 'reject', reason?: string): Promise<ValidatorState> {
    if (decision === 'approve') {
      await this.approveWorkflow(workflowId, { reason: reason ?? 'approved' });
      // Optimistic: the workflow's post-approval step also merges finalized, but reflect it now so the
      // decide() response isn't stale pending_review.
      this.setState({ ...this.state, gate: 'finalized', updatedAt: Date.now() });
    } else {
      await this.rejectWorkflow(workflowId, { reason: reason ?? 'rejected' });
      this.setState({ ...this.state, gate: 'rejected', updatedAt: Date.now() });
    }
    return this.state;
  }

  // Workflow durably merged the ledger row + gate via step.mergeAgentState; this fires on completion.
  async onWorkflowComplete(_name: string, _instanceId: string, _result?: unknown): Promise<void> {
    if (this.state.gate === 'pending_review') return; // still gated until a human decides
    this.setState({ ...this.state, gate: 'finalized', updatedAt: Date.now() });
  }
}
