// contrast-workflow.ts — the durable "brain never crashes" heavy-offload for ColorContrastAgent.
//
// The assess() shape, deterministic-first → LLM-completes:
//   step 1  'measure-contrast' — fal layerize-text + bg PNG decode + per-span WCAG measurement
//           (the heavy, crash-prone network/CPU work, with retries + timeout).
//   step 2  branch — a clear pass / clear fail from the deterministic measurement is settled here.
//   step 3  'llm-decide' — only the borderline/approximated case asks the LLM for the completion
//           action (accept pre-assessment vs escalate with a specific human question).
//   step 4  reportComplete / waitForApproval per the decision.
//
// ContrastAgent.startContrast() runs this via this.runWorkflow('CONTRAST_WORKFLOW', params); it backs
// the direct /v2/contrast* surface. The coordinator path uses the synchronous measureContrastInline()
// RPC instead (a facet's runWorkflow()+mergeAgentState reaches the TOP-LEVEL agent, not the facet).
import type { WorkflowStepConfig } from 'cloudflare:workers';
import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from 'agents/workflows';
import { contrastVerdict, isBorderline, type MeasureResult } from '../contrast';
import type { Assessment } from '../a2a';
import type { ColorContrastAgent, ContrastEnv, ContrastParams } from '../agents/contrast-agent';

type ContrastProgress = { stage: 'contrast'; status: 'running' | 'awaiting_human' | 'complete' };

const STEP_CFG: WorkflowStepConfig = {
  retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
};

export class ContrastWorkflow extends AgentWorkflow<ColorContrastAgent, ContrastParams, ContrastProgress, ContrastEnv> {
  async run(event: AgentWorkflowEvent<ContrastParams>, step: AgentWorkflowStep) {
    await this.reportProgress({ stage: 'contrast', status: 'running' });

    // step 1 — DETERMINISTIC measurement (fal layerize + bg decode + per-span contrast).
    const { measurement } = (await step.do('measure-contrast', STEP_CFG, () =>
      this.agent.runDeterministic(event.payload),
    )) as { measurement: MeasureResult };

    let row: Assessment = contrastVerdict(measurement);

    // step 2/3 — clear pass / clear fail are settled; the borderline case asks the LLM what to do.
    if (isBorderline(measurement)) {
      row = (await step.do('llm-decide', STEP_CFG, () => this.agent.llmDecideCompletion(row, measurement))) as Assessment;
    }

    await step.mergeAgentState({ row, gate: row.needs_human ? 'pending_review' : 'finalized', updatedAt: Date.now() });

    // step 4 — open the human gate on escalation (durable multi-day wait).
    if (row.needs_human) {
      await this.reportProgress({ stage: 'contrast', status: 'awaiting_human' });
      await this.waitForApproval(step, { timeout: '7 days' });
      await step.mergeAgentState({ gate: 'finalized', updatedAt: Date.now() });
    }

    await this.reportProgress({ stage: 'contrast', status: 'complete' });
    await step.reportComplete(row);
    return row;
  }
}
