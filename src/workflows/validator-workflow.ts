// validator-workflow.ts — the "brain never crashes" heavy-offload core.
//
// ValidatorAgent.validate() calls this.runWorkflow('VALIDATOR_WORKFLOW', params); the heavy,
// crash-prone work (veraPDF + PAC validation) runs HERE in durable step.do() calls with retries +
// timeout — a failure in a heavy lane retries durably without touching the Agent DO. Validator
// disagreement → waitForApproval (the human gate). The ledger row is written durably via
// step.mergeAgentState so it survives restarts.
import type { WorkflowStepConfig } from 'cloudflare:workers';
import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from 'agents/workflows';
import { reconcileValidators, type ValidatorLane } from '../a2a';
import type { ValidatorAgent, ValidatorEnv, ValidatorParams } from '../agents/validator-agent';

type ValidatorProgress = { stage: 'validate'; status: 'running' | 'awaiting_human' | 'complete' };

const STEP_CFG: WorkflowStepConfig = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
};

/** Lane A: deterministic byte audit — the deployed WCAG Audit Agent /audit (reused). */
function actorAuditUrl(env: ValidatorEnv): string {
  if (env.PDF_A11Y_AGENT) return 'https://wcag-audit-agent.internal/audit';
  return `${(env.ACTOR_AUDIT_URL || 'https://wcag-audit-agent.example.workers.dev').replace(/\/+$/, '')}/audit`;
}

export class ValidatorWorkflow extends AgentWorkflow<ValidatorAgent, ValidatorParams, ValidatorProgress, ValidatorEnv> {
  async run(event: AgentWorkflowEvent<ValidatorParams>, step: AgentWorkflowStep) {
    const { pdfUrl, id, fileName } = event.payload;
    await this.reportProgress({ stage: 'validate', status: 'running' });

    // Lane A — veraPDF / deterministic byte audit (the deployed actor).
    const verapdf = await step.do('verapdf', STEP_CFG, async (): Promise<ValidatorLane> => {
      const req = new Request(actorAuditUrl(this.env), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ pdf_url: pdfUrl, id, file_name: fileName }),
      });
      const res = this.env.PDF_A11Y_AGENT ? await this.env.PDF_A11Y_AGENT.fetch(req) : await fetch(req);
      if (!res.ok) throw new Error(`verapdf_lane ${res.status}`);
      return (await res.json()) as ValidatorLane;
    });

    // Lane B — PAC / axesSense (heavy Container). Placeholder behind env.PAC_VALIDATOR_URL: degrade
    // to "unavailable" so reconciliation escalates to human (single oracle ≠ attestation).
    const pac = await step.do('pac', STEP_CFG, async (): Promise<ValidatorLane> => {
      if (!this.env.PAC_VALIDATOR_URL) return { available: false };
      const res = await fetch(this.env.PAC_VALIDATOR_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ pdf_url: pdfUrl, id, file_name: fileName }),
      });
      if (!res.ok) throw new Error(`pac_lane ${res.status}`);
      return (await res.json()) as ValidatorLane;
    });

    // Deterministic reconciliation (pure JS) — the controller owns the verdict, not a model.
    // step.do returns Serializable<ValidatorLane>; the shape is JSON-safe so narrow back.
    const row = reconcileValidators(verapdf as ValidatorLane, pac as ValidatorLane);
    await step.mergeAgentState({ row, gate: row.needs_human ? 'pending_review' : 'finalized', updatedAt: Date.now() });

    // Human gate: validator disagreement / single-oracle → durable multi-day wait.
    if (row.needs_human) {
      await this.reportProgress({ stage: 'validate', status: 'awaiting_human' });
      await this.waitForApproval(step, { timeout: '7 days' });
      await step.mergeAgentState({ gate: 'finalized', updatedAt: Date.now() });
    }

    await this.reportProgress({ stage: 'validate', status: 'complete' });
    await step.reportComplete(row);
    return row;
  }
}
