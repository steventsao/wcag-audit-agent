// specialist-workflow.ts — ONE coordinator-owned shared workflow for every a11y domain.
//
// Why COORDINATOR-owned (not facet-owned): a FACET's own this.runWorkflow() resolves the workflow's
// this.agent to the TOP-LEVEL agent (getAgentByName(__agentBinding, name)), NOT the facet instance
// (deepwiki-confirmed, by design). So a shared workflow that needs to reach the facets must be owned
// by the COORDINATOR (A11yAgent) and call into the facets via COORDINATOR BRIDGE methods
// (this.agent.domainRoutine / this.agent.domainDecide), which themselves do subAgent(CLS[domain]).
//
// The run() shape is the assess() lifecycle, generalized across domains:
//   routine  → (settle? done : agent)  → waitForApproval if needs_human → reportComplete
// reportProgress(...) drives the canonical event stream (routine.started/turn.started/...) back through the
// coordinator's onWorkflowProgress hook; reportComplete(...) → onWorkflowComplete writes the domain row
// + the done event into the report ledger. The coordinator owns the ledger + gate; the workflow is the
// durable driver.
import type { WorkflowStepConfig } from 'cloudflare:workers';
import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from 'agents/workflows';
import type { Assessment } from '../a2a';
import type { A11yAgent, Env } from '../a11y-agent';

/** The params a domain run carries: which specialist + the assess() params. */
export interface SpecialistWorkflowParams {
  domain: string;
  params: {
    pdfUrl: string;
    id: string;
    fileName?: string;
    imageUrl?: string;
    pagePointWidth?: number;
  };
}

/**
 * Progress payload — carries the domain so the coordinator's onWorkflowProgress can attribute the
 * lifecycle event to the right specialist row without a workflowId→domain correlation table.
 */
export interface SpecialistProgress {
  domain: string;
  phase: 'routine.started' | 'routine.done' | 'turn.started' | 'turn.done' | 'row.ready';
  detail?: string;
  /**
   * On phase 'row.ready' the final domain row is carried here so the coordinator can write it into
   * the ledger + roll up the gate BEFORE the workflow parks on waitForApproval (so the report shows
   * pending_review WITH the row while the human decides). workflowId lets the coordinator approve/
   * reject this parked workflow when the report gate is resolved.
   */
  row?: Assessment;
  workflowId?: string;
  needsHuman?: boolean;
}

const STEP_CFG: WorkflowStepConfig = {
  retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
};

export class SpecialistWorkflow extends AgentWorkflow<A11yAgent, SpecialistWorkflowParams, SpecialistProgress, Env> {
  async run(event: AgentWorkflowEvent<SpecialistWorkflowParams>, step: AgentWorkflowStep) {
    const { domain, params } = event.payload;

    // ── routine (deterministic) — via the coordinator bridge, which dispatches the facet ──
    await this.reportProgress({ domain, phase: 'routine.started', detail: `dispatch ${domain} facet for ${params.id}` });
    const routine = (await step.do('routine', STEP_CFG, () => this.agent.domainRoutine(domain, params))) as {
      row: Assessment;
      settled: boolean;
      detail: unknown;
    };
    await this.reportProgress({ domain, phase: 'routine.done', detail: `verdict=${routine.row.verdict}` });

    // ── settle? done : agent (LLM completion router) ──
    let row: Assessment = routine.row;
    if (!routine.settled) {
      await this.reportProgress({ domain, phase: 'turn.started', detail: 'routing to turn' });
      row = (await step.do('agent', STEP_CFG, () =>
        this.agent.domainDecide(domain, routine.row, routine.detail),
      )) as Assessment;
      await this.reportProgress({ domain, phase: 'turn.done', detail: `verdict=${row.verdict} needs_human=${row.needs_human}` });
    }

    // ── row ready — hand the FINAL row to the coordinator BEFORE the human gate, so the report shows
    // pending_review WITH the row + the gate opens while the human decides (not after approval). ──
    await this.reportProgress({
      domain,
      phase: 'row.ready',
      detail: `verdict=${row.verdict} needs_human=${row.needs_human}`,
      row,
      workflowId: this.workflowId,
      needsHuman: row.needs_human,
    });

    // ── human gate (durable multi-day wait). The coordinator approves/rejects this parked workflow
    // when the report-level gate is resolved (decideReport → approveSpecialistWorkflows). ──
    if (row.needs_human) {
      await this.waitForApproval(step, { timeout: '7 days' });
    }

    // ── done — the row is already in the ledger (written on row.ready); reportComplete just closes
    // the run. onWorkflowComplete is a no-op for SPECIALIST_WORKFLOW (the ledger write happened on
    // row.ready), so we don't double-write. ──
    await step.reportComplete(row);
    return row;
  }
}
