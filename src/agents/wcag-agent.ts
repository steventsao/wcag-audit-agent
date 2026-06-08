// wcag-agent.ts — the WcagAgent ROLLUP specialist, built on A11ySpecialistAgent.
//
// Domain: wcag (WCAG 2.2 AA). UNLIKE the validator/contrast facets, WcagAgent is a ROLLUP — it does
// NOT measure anything. It CONSUMES the CriterionFinding[] the coordinator already gathered (byte probe
// + contrast facet + validator facet) and folds them onto the full 55-SC WCAG 2.2 A/AA template
// (src/wcag-template.ts), grouped by the 11 rule areas. SCs with no machine oracle this build escalate
// to cannot_tell + needs_human (honest, never guessed); SCs that don't apply to a static PDF are
// not_present (N/A). The assess() contract maps as:
//   routine()  — DETERMINISTIC mapping of p.criteria → per-SC verdicts on the template (NO fetch, NO LLM).
//   settle()   — ALWAYS settles (a rollup has no borderline case to route to an LLM) → turn() unreachable.
//   turn()     — required by the abstract signature; returns the settled row (never called).
//
// The coordinator dispatches it via subAgent(WcagAgent, docId).rollupInline(...) AFTER the producer
// facets, inside runAudit. The class name stays EXACTLY `WcagAgent` (DO binding WCAG_AGENT kebab-matches
// it for getSubAgentByName/getAgentByName). It is READ-ONLY over the audit — it never changes the gate.
import type { Assessment, Evidence } from '../a2a';
import type { CriterionFinding } from '../pipeline';
import { A11ySpecialistAgent, type A11ySkill, type AssessParams, type RoutineResult } from '../specialist';
import { WCAG_22_AA, RULE_AREAS, SC_BY_CODE, type RuleAreaId, type WcagLevel } from '../wcag-template';

/** Stable report-row identity (stamped onto row.agent — distinct from the per-SC `wcag:<code>` mirror rows). */
export const WCAG_DOMAIN = 'wcag';
export const WCAG_STANDARD = 'WCAG 2.2 AA';

export interface WcagEnv extends Cloudflare.Env {
  // Binding name kebab-matches the class (WCAG_AGENT → wcag-agent == WcagAgent) so the agents SDK can
  // auto-derive __agentBinding for getSubAgentByName()/getAgentByName().
  WCAG_AGENT: DurableObjectNamespace<WcagAgent>;
}

/** One template SC folded with the audit evidence that decided it (the unit the live UI renders). */
export interface WcagCriterionVerdict {
  sc: string;
  name: string;
  level: WcagLevel;
  /** Which rule areas list this SC (so the UI can filter per area). */
  areaIds: RuleAreaId[];
  verdict: Assessment['verdict'];
  needs_human: boolean;
  /** 'machine' = a coordinator CriterionFinding decided it; 'human-only' = no machine oracle / N/A. */
  source: 'machine' | 'human-only';
  /** The producing technique when source==='machine' (byte-probe | contrast | validator | vlm-escalate). */
  via?: string;
  rationale: string;
}

/** One rule-area's rollup (the sidebar entry + per-rule evidence view). */
export interface WcagAreaRollup {
  id: RuleAreaId;
  label: string;
  primaryStandard: 'pdfua' | 'wcag';
  verdicts: WcagCriterionVerdict[];
  /** Worst-case over the area's pdfApplicable members. */
  status: 'pass' | 'fail' | 'pending-human-review' | 'n/a';
}

/** The full WCAG 2.2 AA rollup the coordinator persists onto A11yReportState.wcag. */
export interface WcagRollup {
  standard: 'WCAG 2.2 AA';
  areas: WcagAreaRollup[];
  criteria: WcagCriterionVerdict[];
  summary: { total: number; passed: number; failed: number; needsHuman: number; notApplicable: number };
}

export interface WcagState {
  id?: string;
  row?: Assessment;
  rollup?: WcagRollup;
  gate: 'open' | 'pending_review' | 'finalized' | 'rejected';
  updatedAt?: number;
}

export class WcagAgent extends A11ySpecialistAgent<WcagEnv, WcagState> {
  initialState: WcagState = { gate: 'open' };

  readonly domain = WCAG_DOMAIN; // 'wcag'
  readonly standardRefs = [WCAG_STANDARD]; // ['WCAG 2.2 AA']

  getSkills(): A11ySkill[] {
    return [
      {
        name: 'map-criteria',
        description: 'Fold the coordinator’s CriterionFinding[] onto the 55-SC WCAG 2.2 A/AA template, grouped by the 11 rule areas. Consumes evidence; re-measures nothing.',
        instructions: 'buildRollup(criteria): for each WcagSc, if !pdfApplicable → not_present (N/A); else if a CriterionFinding matches the SC code → use its verdict/needs_human/via (source=machine); else → cannot_tell + needs_human (source=human-only).',
      },
      {
        name: 'escalate-human-only',
        description: 'Template SCs with no machine oracle this build (e.g. 1.4.1 Use of Color, 3.1.1 Language of Page) escalate to cannot_tell + needs_human rather than guessing — the attestation gate signs them off.',
        instructions: 'A machine PASS is only ever a pre-assessment; the rollup never auto-attests a human-only SC. Worst-case area status: any fail → fail; any needs_human → pending-human-review; all applicable clean → pass; no applicable members → n/a.',
      },
    ];
  }

  // ───────────────────────── assess() contract (rollup = fully deterministic) ─────────────────────────

  /**
   * DETERMINISTIC mapping (step 1) — NOT a probe. Reads the coordinator's already-gathered
   * CriterionFinding[] off AssessParams.criteria (the base allows extra fields) and folds them onto the
   * WCAG template. No fetch, no LLM, no re-measurement. Persists the grouped rollup to state so
   * rollupInline (and the live UI over the WebSocket) can read report.wcag.areas.
   */
  async routine(p: AssessParams): Promise<RoutineResult<WcagRollup>> {
    const raw = p.criteria; // AssessParams has an index signature, so this is `unknown` (the coordinator passes it)
    const criteria = (Array.isArray(raw) ? raw : []) as CriterionFinding[];
    const rollup = this.buildRollup(criteria);
    this.setState({ ...this.state, id: p.id, rollup, updatedAt: Date.now() });
    return { row: this.rollupRow(rollup), detail: rollup };
  }

  /** A rollup is fully deterministic — always settle (clean pass / fail / needs-human all decided here). */
  protected settle(r: RoutineResult): Assessment | null {
    return r.row;
  }

  /** Required by the abstract signature; never reached because settle() always settles. No LLM call. */
  async turn(r: RoutineResult): Promise<Assessment> {
    return r.row;
  }

  // ───────────────────── coordinator inline entry (mirrors measureContrastInline) ─────────────────────

  /**
   * The coordinator's synchronous rollup entry, dispatched via subAgent(WcagAgent, docId).rollupInline().
   * Runs the shared assess() loop (routine→settle) which persists state.row + state.rollup, sets the
   * facet's own durable gate from the row (the COORDINATOR owns the report-level gate; this state.gate
   * only backs an optional direct /v2 status surface), and returns BOTH the rollup row and the grouped
   * rollup for the report ledger.
   */
  async rollupInline(p: { id: string; criteria: CriterionFinding[] }): Promise<{ row: Assessment; rollup: WcagRollup }> {
    const row = await this.assess({ pdfUrl: '', id: p.id, criteria: p.criteria });
    const rollup = this.state.rollup ?? this.buildRollup(p.criteria);
    this.setState({ ...this.state, gate: row.needs_human ? 'pending_review' : 'finalized', updatedAt: Date.now() });
    return { row, rollup };
  }

  async getStatus(): Promise<WcagState> {
    return this.state;
  }

  // ───────────────────────── the deterministic rollup ─────────────────────────

  /** Fold CriterionFinding[] onto the 55-SC template, grouped by the 11 rule areas. Pure + deterministic. */
  private buildRollup(criteria: CriterionFinding[]): WcagRollup {
    const bySc = new Map<string, CriterionFinding>();
    for (const c of criteria) bySc.set(c.criterion.split(' ')[0], c); // "1.4.3 Contrast (Minimum)" → "1.4.3"

    const verdicts: WcagCriterionVerdict[] = WCAG_22_AA.map((sc) => {
      const areaIds = RULE_AREAS.filter((a) => a.scRefs.includes(sc.sc)).map((a) => a.id);
      if (!sc.pdfApplicable) {
        return { sc: sc.sc, name: sc.name, level: sc.level, areaIds, verdict: 'not_present' as const, needs_human: false, source: 'human-only' as const, rationale: sc.pdfReason };
      }
      const found = bySc.get(sc.sc);
      if (found) {
        return { sc: sc.sc, name: sc.name, level: sc.level, areaIds, verdict: found.verdict, needs_human: found.needs_human, source: 'machine' as const, via: found.via, rationale: found.rationale };
      }
      // pdfApplicable but no machine oracle this build → honest escalation (never a guessed pass).
      return { sc: sc.sc, name: sc.name, level: sc.level, areaIds, verdict: 'cannot_tell' as const, needs_human: true, source: 'human-only' as const, rationale: sc.checkNote };
    });

    const byCode = new Map(verdicts.map((v) => [v.sc, v]));
    const areas: WcagAreaRollup[] = RULE_AREAS.map((area) => {
      const members = area.scRefs.map((code) => byCode.get(code)).filter((v): v is WcagCriterionVerdict => Boolean(v));
      const applicable = members.filter((m) => SC_BY_CODE.get(m.sc)?.pdfApplicable);
      let status: WcagAreaRollup['status'];
      if (applicable.length === 0) status = 'n/a';
      else if (applicable.some((m) => m.verdict === 'failed')) status = 'fail';
      else if (applicable.some((m) => m.needs_human)) status = 'pending-human-review';
      else status = 'pass';
      return { id: area.id, label: area.label, primaryStandard: area.primaryStandard, verdicts: members, status };
    });

    let passed = 0, failed = 0, needsHuman = 0, notApplicable = 0;
    for (const v of verdicts) {
      if (!SC_BY_CODE.get(v.sc)?.pdfApplicable) notApplicable++;
      else if (v.verdict === 'failed') failed++;
      else if (v.needs_human) needsHuman++;
      else passed++; // clean pass or machine not_present (feature trivially absent)
    }

    return {
      standard: 'WCAG 2.2 AA',
      areas,
      criteria: verdicts,
      summary: { total: verdicts.length, passed, failed, needsHuman, notApplicable },
    };
  }

  /** Roll the per-SC verdicts into ONE Assessment (the facet's row) — worst-case verdict + bbox-free citations. */
  private rollupRow(rollup: WcagRollup): Assessment {
    const { passed, failed, needsHuman, notApplicable, total } = rollup.summary;
    const needs_human = failed > 0 || needsHuman > 0;
    const verdict: Assessment['verdict'] = failed > 0 ? 'failed' : needsHuman > 0 ? 'cannot_tell' : 'passed';
    const nonPass = rollup.criteria
      .filter((v) => v.source !== 'human-only' || v.verdict === 'cannot_tell')
      .filter((v) => v.verdict === 'failed' || v.needs_human)
      .slice(0, 12);
    const evidence: Evidence[] = nonPass.map((v) => ({
      kind: 'validator',
      detail: `${v.sc} ${v.name}: ${v.verdict}${v.needs_human ? ' (needs human review)' : ''} — ${v.rationale}`.slice(0, 300),
      citation: v.sc,
    }));
    return {
      agent: WCAG_DOMAIN,
      standard_refs: [WCAG_STANDARD],
      state: needs_human ? 'input_required' : 'completed',
      verdict,
      confidence: failed > 0 ? 0.9 : needsHuman > 0 ? 0.5 : 0.95,
      needs_human,
      evidence,
      rationale: `WCAG 2.2 AA rollup over ${total} SC: ${passed} pass, ${failed} fail, ${needsHuman} need human review, ${notApplicable} N/A for static PDF.`,
    };
  }
}
