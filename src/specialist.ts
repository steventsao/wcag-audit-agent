// specialist.ts — the SHARED a11y-specialist abstraction.
//
// Both working specialists (ValidatorAgent = pdfua_validation, ColorContrastAgent = color_contrast)
// follow the SAME assess() contract: deterministic mechanical work FIRST (`routine`), then settle the
// clear pass/fail cases (`settle`), and only route the genuinely ambiguous case to the LLM
// completion router (`turn`). This file factors that loop into one base so the two leaf
// agents share it without re-implementing the orchestration, the domain/standard-ref stamping, the
// state persistence, or — critically — the P1 guard that an LLM can NEVER clear a deterministic
// fail/approximation.
//
// Design constraints (hard-won, do not relitigate):
//  - The ABSTRACT base must NOT be exported as a DO class or registered in wrangler. Only the CONCRETE
//    leaf classes (ValidatorAgent, ColorContrastAgent) keep their exact names + DO bindings, because
//    the agents SDK resolves a facet child by `getAgentByName(__agentBinding, name)` which kebab-matches
//    the EXACT class name. Subclassing keeps each leaf's own name; the base is type/impl only.
//  - assess() is the @callable facet contract the coordinator dispatches via subAgent(Cls, docId).
//    Its return (a Assessment) crosses the facet boundary cleanly (a facet's runWorkflow/mergeAgentState
//    would reach the TOP-LEVEL agent, not the facet — so assess is a synchronous RPC, not a workflow).
import { Agent, callable } from 'agents';
import type { Assessment } from './a2a';

// ───────────────────────── shared types ─────────────────────────

/** A named skill a specialist exposes. tools' execute() may hit container/browser/apify/API. */
export interface A11ySkill {
  name: string;
  description: string;
  /** Optional system-prompt fragment / playbook text for this skill. */
  instructions?: string;
  /**
   * AI-SDK-shaped tool definitions (`tool({description, inputSchema, execute?, needsApproval})`).
   * Unconstrained: an execute() may call the heavy Container / fal / OpenRouter / Apify / any API.
   * Kept as unknown[] here so each specialist can carry its own tool shapes without the base
   * depending on a specific AI-SDK version; the base only flat-maps these into turn's toolset.
   */
  tools?: unknown[];
}

/**
 * The deterministic output of a specialist's `routine()`. Carries the pre-assessment Assessment the
 * deterministic layer produced PLUS the raw measurement payload so `settle()`/`turn()` can
 * reason over the same evidence without re-running the heavy work.
 */
export interface RoutineResult<TDetail = unknown> {
  /** The deterministic pre-verdict row (verdict/evidence already computed from bytes/pixels/validators). */
  row: Assessment;
  /** The raw deterministic detail (MeasureResult for contrast, the two validator lanes for the validator). */
  detail: TDetail;
}

/** Per-specialist parameters the facet's assess() accepts (each leaf narrows this). */
export interface AssessParams {
  pdfUrl: string;
  id: string;
  fileName?: string;
  [k: string]: unknown;
}

/**
 * The @callable facet contract every A11y<Area>Agent honors. The coordinator dispatches a specialist
 * via subAgent(Cls, docId) and calls assess() (the assess() loop); getSkills() advertises the specialist's
 * playbook; routine()/turn() are the seams assess() composes (and the durable Workflow reuses).
 */
export interface A11ySpecialist {
  getSkills(): A11ySkill[];
  assess(p: AssessParams): Promise<Assessment>;
  routine(p: AssessParams): Promise<RoutineResult>;
  turn(r: RoutineResult): Promise<Assessment>;
}

// ───────────────────────── the shared base ─────────────────────────

/**
 * A11ySpecialistAgent — the shared base for every a11y specialist facet. Concrete leaves implement
 * the four deterministic seams (domain/standardRefs/getSkills/routine/settle/turn); the base
 * owns the assess() loop, the domain/standard-ref stamping, the state persistence, and the P1 safety
 * guard. NEVER exported as a DO / registered in wrangler — abstract, no own DO binding.
 */
export abstract class A11ySpecialistAgent<Env extends Cloudflare.Env, State extends { row?: Assessment }>
  extends Agent<Env, State>
  implements A11ySpecialist
{
  /** Stable domain name, stamped onto every row's `agent` field (e.g. 'pdfua_validation'). */
  abstract readonly domain: string;
  /** Standard references this specialist's evidence speaks to, stamped onto `standard_refs`. */
  abstract readonly standardRefs: string[];

  /** The specialist's skills (playbook + heavy-tool definitions). */
  abstract getSkills(): A11ySkill[];

  /** DETERMINISTIC measurement (step 1). Bytes / validators / pixels — no LLM, no guess. */
  abstract routine(p: AssessParams): Promise<RoutineResult>;

  /**
   * Settle the clear cases (step 2). Return a finished Assessment when the deterministic result
   * is unambiguous (clean pass / hard fail). Return null to defer to turn() (the LLM router).
   */
  protected abstract settle(r: RoutineResult): Assessment | null;

  /**
   * LLM completion router (step 3). Given the deterministic RoutineResult, pick the COMPLETION
   * ACTION — accept the pre-assessment, or escalate (needs_human) with a SPECIFIC question. It MUST
   * NOT recompute a mechanical verdict; the base additionally guards that it can't clear a fail.
   */
  abstract turn(r: RoutineResult): Promise<Assessment>;

  /**
   * The assess() loop — the @callable facet contract. Deterministic routine FIRST → settle clear cases →
   * else route to turn. The result is stamped (agent=domain, standard_refs=standardRefs),
   * persisted to state.row, and returned as the RPC value (crosses the facet boundary cleanly).
   */
  @callable()
  async assess(p: AssessParams): Promise<Assessment> {
    const routine = await this.routine(p);
    const settled = this.settle(routine);

    let row: Assessment;
    if (settled) {
      row = settled;
    } else {
      const decided = await this.turn(routine);
      // P1 GUARD (preserve contrast's deterministic-authority): turn can NEVER clear a
      // deterministic fail/approximation. If the deterministic pre-verdict was a fail (or otherwise
      // not a clean pass) and the LLM tried to drop the human gate, force it back to needs_human.
      row = this.enforceDeterministicAuthority(routine.row, decided);
    }

    const stamped = this.stamp(row);
    // Persist last row durably so the direct /v2/* status surface + re-reads see it.
    this.setState({ ...this.state, row: stamped });
    return stamped;
  }

  /**
   * Facet-boundary-safe routine+settle split for the coordinator-owned SpecialistWorkflow. Runs the
   * deterministic routine() and the settle() decision, returning BOTH the (stamped) pre-verdict row
   * and whether it's settled. The workflow uses this so routine and turn land in separate
   * durable step.do() calls. `settled=true` → the workflow completes with `row`; `settled=false` →
   * the workflow calls turnRow(row) next.
   *
   * Returns the deterministic RoutineResult.detail too, so turnRow() can re-derive it without
   * re-running the heavy routine (the LLM router needs the measurement/lanes). Kept JSON-serializable
   * (it crosses the facet boundary as an RPC value).
   */
  async routineWithSettle(p: AssessParams): Promise<{ row: Assessment; settled: boolean; detail: unknown }> {
    const routine = await this.routine(p);
    const settled = this.settle(routine);
    if (settled) {
      const stamped = this.stamp(settled);
      this.setState({ ...this.state, row: stamped });
      return { row: stamped, settled: true, detail: routine.detail };
    }
    // Not settled → return the (stamped) deterministic pre-verdict; the workflow will call turn.
    return { row: this.stamp(routine.row), settled: false, detail: routine.detail };
  }

  /**
   * Facet-boundary-safe turn for the workflow's second step. Takes the deterministic detail
   * back (from routineWithSettle) so the LLM router reasons over the same measurement without
   * re-running the heavy routine. Applies the same base deterministic-authority guard + stamping +
   * state persistence as assess().
   */
  async turnRow(deterministicRow: Assessment, detail: unknown): Promise<Assessment> {
    const decided = await this.turn({ row: deterministicRow, detail });
    const guarded = this.enforceDeterministicAuthority(deterministicRow, decided);
    const stamped = this.stamp(guarded);
    this.setState({ ...this.state, row: stamped });
    return stamped;
  }

  /** Stamp the shared identity fields so a leaf can't drift its agent/standard_refs out of band. */
  protected stamp(row: Assessment): Assessment {
    return { ...row, agent: this.domain, standard_refs: this.standardRefs };
  }

  /**
   * The base-level deterministic-authority guard. A clean deterministic PASS may have its human gate
   * cleared by turn (a genuine borderline-PASS accept). Anything else — a deterministic fail,
   * a cannot_tell, a not_present, an approximation — can only be confirmed or escalated; the LLM may
   * NOT downgrade it to no-human. (Belt-and-suspenders with each leaf's own guard.)
   */
  protected enforceDeterministicAuthority(deterministic: Assessment, decided: Assessment): Assessment {
    const cleanPass = deterministic.verdict === 'passed';
    if (!cleanPass && decided.needs_human === false) {
      return {
        ...decided,
        state: 'input_required',
        needs_human: true,
        rationale:
          `${decided.rationale} (base guard: deterministic verdict '${deterministic.verdict}' is not a clean pass — LLM cannot clear the human gate; escalated.)`.trim(),
      };
    }
    return decided;
  }
}
