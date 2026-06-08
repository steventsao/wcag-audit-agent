// a2a.ts — the conceptual A2A contract shared by every a11y specialist.
//
// A2A task states are the CONCEPTUAL model; the implementation is native cloudflare/agents
// (runWorkflow / step.do / waitForApproval). This file is pure + deterministic + unit-testable:
// the ledger-row shape every specialist emits, plus the validator reconciliation rule that turns
// "two validators disagree" into a human-gate escalation (the attestation moat).

export type Verdict = 'passed' | 'failed' | 'not_present' | 'cannot_tell';

/** A2A TaskState → our semantics. */
export type A2AState = 'submitted' | 'working' | 'input_required' | 'completed' | 'failed';

export interface Evidence {
  kind: 'bbox' | 'image' | 'measurement' | 'validator';
  page?: number;
  bbox?: number[];
  detail: string;
  citation?: string;
}

/** The universal payload every specialist returns — an A2A-shaped row over the evidence. */
export interface Assessment {
  agent: string;
  standard_refs: string[]; // which rules this evidence speaks to
  state: A2AState;
  verdict: Verdict;
  confidence: number;
  needs_human: boolean;
  evidence: Evidence[];
  rationale: string;
}

/** Minimal shape we read from a validator lane (deployed /audit response, or a PAC container). */
export interface ValidatorLane {
  available?: boolean;
  // the deployed /audit endpoint returns these:
  tagged?: boolean;
  findings?: Array<{ severity?: string; criterion?: string; finding?: string }>;
  gate?: string;
  // a PAC/veraPDF container may return a pass flag + failure list:
  pass?: boolean;
  failures?: string[];
}

function lanePass(lane: ValidatorLane | null | undefined): boolean | null {
  if (!lane || lane.available === false) return null; // lane didn't run → unknown
  if (typeof lane.pass === 'boolean') return lane.pass;
  if (Array.isArray(lane.failures)) return lane.failures.length === 0;
  // The deployed agent's own gate IS its considered verdict — it sets pending_review for non-error
  // cannot_tell conditions (e.g. reading-order), so the gate MUST win over the tagged/error heuristic
  // (else a still-gated doc would reconcile to a clean pass).
  if (lane.gate) return lane.gate === 'finalized';
  // Fallback for a raw validator shape with no gate: pass = tagged AND no error-severity findings.
  const hasError = (lane.findings ?? []).some((f) => f.severity === 'error');
  if (typeof lane.tagged === 'boolean') return lane.tagged && !hasError;
  return null;
}

/**
 * Reconcile two validators (e.g. veraPDF vs PAC/Matterhorn). The moat: a single green is NOT
 * conformance, and a disagreement is an auditable human-gate escalation — never silently resolved.
 */
export function reconcileValidators(
  verapdf: ValidatorLane | null | undefined,
  pac: ValidatorLane | null | undefined,
): Assessment {
  const a = lanePass(verapdf);
  const b = lanePass(pac);
  const evidence: Evidence[] = [
    { kind: 'validator', detail: `veraPDF lane: ${a === null ? 'unavailable' : a ? 'pass' : 'fail'}` },
    { kind: 'validator', detail: `PAC lane: ${b === null ? 'unavailable' : b ? 'pass' : 'fail'}` },
  ];

  // Only one validator ran → cannot attest from a single oracle.
  if (a === null || b === null) {
    const only = a ?? b;
    return {
      agent: 'validator',
      standard_refs: ['PDF/UA-1', 'WCAG'],
      state: 'input_required',
      verdict: only === null ? 'cannot_tell' : only ? 'passed' : 'failed',
      confidence: only === null ? 0 : 0.5,
      needs_human: true,
      evidence,
      rationale: 'Single-validator result is not a conformance attestation; human sign-off required.',
    };
  }

  // Both ran and agree.
  if (a === b) {
    return {
      agent: 'validator',
      standard_refs: ['PDF/UA-1', 'WCAG'],
      state: 'completed',
      verdict: a ? 'passed' : 'failed',
      confidence: 0.95,
      needs_human: false,
      evidence,
      rationale: a ? 'Both validators pass.' : 'Both validators report failures.',
    };
  }

  // Disagreement → the moat: escalate, do not guess.
  return {
    agent: 'validator',
    standard_refs: ['PDF/UA-1', 'WCAG'],
    state: 'input_required',
    verdict: 'cannot_tell',
    confidence: 0.3,
    needs_human: true,
    evidence,
    rationale: 'veraPDF and PAC disagree — auditable human-review escalation (validator-reconciliation moat).',
  };
}
