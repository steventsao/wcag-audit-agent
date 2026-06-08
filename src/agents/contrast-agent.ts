// contrast-agent.ts — the ColorContrastAgent specialist: WCAG 1.4.3 color contrast,
// refactored onto A11ySpecialistAgent.
//
// Domain: contrast-service (WCAG 1.4.3, fal layerize). The assess() contract maps as:
//   routine()     — call fal ideogram/v3/layerize-text to split text vs background, decode the bg PNG
//                   in-Worker, measure each span's clean text color vs the actual bg pixels it sits on
//                   (worst-case), and compute the deterministic WCAG verdict (contrast.ts, pure). This
//                   is the heavy, deterministic mechanical work (network + CPU). No LLM.
//   settle()      — clean pass / clear fail / not_present are settled deterministically here. Only the
//                   borderline / approximated / no-spans case defers to turn().
//   turn() — the LLM completion router (OpenRouter gemini-2.5-flash): GIVEN the measured spans,
//                   pick the completion action (accept the pre-assessment, or escalate with a SPECIFIC
//                   human question naming the worst span + ratio). It decides next-action, NOT the ratio.
//   getSkills()   — layerize · measure-contrast · prove.
//
// The coordinator dispatches this via subAgent(ColorContrastAgent, docId) + assess() (an RPC return
// crosses the facet boundary cleanly). The durable startContrast()/ContrastWorkflow path backs the
// direct /v2/contrast* surface. The class name stays EXACTLY `ColorContrastAgent` (DO binding
// COLOR_CONTRAST_AGENT kebab-matches it for getAgentByName()/runWorkflow()).
import {
  CONTRAST_AGENT,
  CONTRAST_STANDARD,
  contrastVerdict,
  decodePng,
  isBorderline,
  measureContrast,
  measureContrastApprox,
  spansFromContainers,
  type MeasureResult,
  type RGB,
} from '../contrast';
import type { Assessment } from '../a2a';
import { A11ySpecialistAgent, type A11ySkill, type AssessParams, type RoutineResult } from '../specialist';

export interface ContrastParams {
  pdfUrl: string;
  id: string;
  fileName?: string;
  /** Optional page width in PostScript points → enables WCAG large-text classification. */
  pagePointWidth?: number;
}

export interface ContrastEnv extends Cloudflare.Env {
  // Binding name kebab-matches the class (COLOR_CONTRAST_AGENT → color-contrast-agent) so the agents
  // SDK can auto-derive __agentBinding for getAgentByName()/runWorkflow().
  COLOR_CONTRAST_AGENT: DurableObjectNamespace<ColorContrastAgent>;
  CONTRAST_WORKFLOW: Workflow;
  /** fal.ai key — required for the deterministic layerize lane. */
  FAL_KEY?: string;
  /** OpenRouter key — the LLM-decide (completion-router) step. */
  OPENROUTER_API_KEY?: string;
}

export interface ContrastState {
  id?: string;
  pdfUrl?: string;
  row?: Assessment;
  gate: 'open' | 'pending_review' | 'finalized' | 'rejected';
  updatedAt?: number;
}

/** The deterministic detail routine() carries forward: the full WCAG measurement + page params. */
interface ContrastDetail {
  measurement: MeasureResult;
  pagePointWidth?: number;
}

/** fal layerize-text response (the fields we use). */
interface LayerizeResult {
  image?: { url?: string };
  text_containers?: any[];
}

const FAL_LAYERIZE = 'https://fal.run/fal-ai/ideogram/v3/layerize-text';

// Explicit timeouts + byte caps so a slow/oversized response can't tie up the DO on the
// inline RPC path (which has no step.do timeout). The durable workflow path also wraps these in
// step.do (its own 5-min timeout), so these are belt-and-suspenders there.
const FAL_TIMEOUT_MS = 120_000; // fal layerize is slow (~25-60s/page)
const BG_FETCH_TIMEOUT_MS = 30_000;
const OPENROUTER_TIMEOUT_MS = 30_000;
const MAX_PNG_BYTES = 30 * 1024 * 1024; // 30 MB cap on the bg PNG

/** fetch with an AbortController timeout. */
async function fetchTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Fetch a binary body with a timeout + byte cap. Returns null on non-OK / over-cap.
 * The cap is enforced INCREMENTALLY by streaming the body (not via a post-hoc
 * arrayBuffer()), so a missing/lying content-length or a trickled body can't allocate past maxBytes.
 * The AbortController from fetchTimeout stays armed for the whole streamed read.
 */
async function fetchBounded(url: string, timeoutMs: number, maxBytes: number): Promise<Uint8Array | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length') ?? '0');
    if (len && len > maxBytes) return null;
    if (!res.body) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          return null; // exceeded the cap mid-stream — bail before allocating more
        }
        chunks.push(value);
      }
    }
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.byteLength; }
    return out;
  } finally {
    clearTimeout(t);
  }
}

export class ColorContrastAgent extends A11ySpecialistAgent<ContrastEnv, ContrastState> {
  initialState: ContrastState = { gate: 'open' };

  readonly domain = CONTRAST_AGENT; // 'contrast-service' — the stable report-row identity
  readonly standardRefs = [CONTRAST_STANDARD]; // ['WCAG 1.4.3']

  getSkills(): A11ySkill[] {
    return [
      {
        name: 'layerize',
        description: 'Split the page image into text vs background via fal ideogram/v3/layerize-text.',
        instructions: 'POST image_url to fal layerize-text (FAL_KEY); returns the inpainted bg PNG + text_containers[] (spans w/ clean hex color + bbox + font_size).',
      },
      {
        name: 'measure-contrast',
        description: 'Decode the bg PNG in-Worker and measure each text span vs the ACTUAL bg pixels it sits on (worst-case, 2nd-percentile denoised) → WCAG 2.x contrast ratio.',
        instructions: 'decodePng(bg) → measureContrast(bg, spans, pagePointWidth). Byte-for-byte parity with scripts/layerize_contrast_proof.py. Transparency/decode failure → flagged approximation → escalate.',
      },
      {
        name: 'prove',
        description: 'Emit bbox-cited evidence (worst-case span bbox + ratio + method) for the WCAG 1.4.3 verdict.',
        instructions: 'contrastVerdict(measurement): clean pass→passed; any fail→failed+needs_human; approximated/no-spans→escalate.',
      },
    ];
  }

  // ───────────────────────── assess() contract ─────────────────────────

  /**
   * DETERMINISTIC lane (step 1). fal layerize-text → decode bg PNG → measure per-span
   * contrast vs actual bg pixels → deterministic WCAG verdict. If FAL_KEY is missing or bg decode
   * fails, degrade to the flagged representative-bg approximation (never a fabricated measurement).
   */
  async routine(p: AssessParams): Promise<RoutineResult<ContrastDetail>> {
    const params: ContrastParams = {
      pdfUrl: p.pdfUrl,
      id: p.id,
      fileName: p.fileName,
      pagePointWidth: typeof p.pagePointWidth === 'number' ? p.pagePointWidth : undefined,
    };
    this.setState({ ...this.state, id: params.id, pdfUrl: params.pdfUrl, updatedAt: Date.now() });
    const { measurement } = await this.runDeterministic(params);
    const row = contrastVerdict(measurement);
    return { row, detail: { measurement, pagePointWidth: params.pagePointWidth } };
  }

  /**
   * Settle the clear cases. The deterministic verdict already settled clean pass / clear fail /
   * not_present (a fail is NEVER routed to the LLM — see isBorderline's P1 note). Only the borderline /
   * approximated / no-spans case defers to turn().
   */
  protected settle(r: RoutineResult): Assessment | null {
    const { measurement } = r.detail as ContrastDetail;
    return isBorderline(measurement) ? null : r.row;
  }

  /**
   * LLM-DECIDE completion router (step 3) — adapts the shared turn(r) seam to the
   * existing llmDecideCompletion(row, measurement). Fires only for the borderline/ambiguous case.
   */
  async turn(r: RoutineResult): Promise<Assessment> {
    const { measurement } = r.detail as ContrastDetail;
    return this.llmDecideCompletion(r.row, measurement);
  }

  // ───────────────────── legacy/direct surfaces (preserved) ─────────────────────

  /** Kick the durable contrast workflow; returns immediately with the tracked workflow id. */
  async startContrast(params: ContrastParams): Promise<{ workflowId: string; state: ContrastState }> {
    this.setState({ ...this.state, id: params.id, pdfUrl: params.pdfUrl, gate: 'open', updatedAt: Date.now() });
    const workflowId = await this.runWorkflow('CONTRAST_WORKFLOW', params);
    return { workflowId, state: this.state };
  }

  /**
   * Facet-native synchronous contrast (the coordinator path). Now a thin wrapper over the shared
   * assess() loop (routine → settle → turn), so the contrast facet follows the SAME assess()
   * contract as the validator. Sets the durable gate from the returned row (the coordinator owns the
   * report-level gate; this state.gate backs the direct /v2/* status surface). Kept for back-compat
   * with the coordinator's call site.
   */
  async measureContrastInline(params: ContrastParams): Promise<Assessment> {
    const row = await this.assess({
      pdfUrl: params.pdfUrl,
      id: params.id,
      fileName: params.fileName,
      pagePointWidth: params.pagePointWidth,
    });
    this.setState({
      ...this.state,
      row,
      gate: row.needs_human ? 'pending_review' : 'finalized',
      updatedAt: Date.now(),
    });
    return row;
  }

  /**
   * DETERMINISTIC lane impl (step 1). fal layerize-text → decode bg PNG → measure per-span
   * contrast vs actual bg pixels. If FAL_KEY is missing or bg decode fails, degrade to the flagged
   * representative-bg approximation (never a fabricated measurement). Called by routine() and reused
   * by the durable ContrastWorkflow via this.agent.runDeterministic().
   */
  async runDeterministic(params: ContrastParams): Promise<{ measurement: MeasureResult }> {
    if (!this.env.FAL_KEY) {
      // No deterministic lane available at all → an empty, approximated measurement that escalates.
      return { measurement: measureContrastApprox([255, 255, 255], [], params.pagePointWidth) };
    }
    // fal HTTP / network errors must NOT abort the request — degrade to a flagged
    // approximation (which escalates) so the coordinator still gets a contrast row + rollup.
    let layerize: LayerizeResult;
    try {
      layerize = await this.fetchLayerize(params.pdfUrl);
    } catch {
      return { measurement: measureContrastApprox([255, 255, 255], [], params.pagePointWidth) };
    }
    const spans = spansFromContainers(layerize.text_containers ?? []);
    const bgUrl = layerize.image?.url;

    if (bgUrl) {
      try {
        const bgRes = await fetchBounded(bgUrl, BG_FETCH_TIMEOUT_MS, MAX_PNG_BYTES);
        if (bgRes) {
          const bg = await decodePng(bgRes);
          return { measurement: measureContrast(bg, spans, params.pagePointWidth) };
        }
      } catch {
        // fall through to approximation
      }
    }
    // Couldn't decode the bg per-pixel → flagged approximation against white (worst plausible bg).
    return { measurement: measureContrastApprox([255, 255, 255], spans, params.pagePointWidth, undefined) };
  }

  /**
   * LLM-DECIDE completion router (step 3). Given the deterministic row + measured spans,
   * the LLM picks the COMPLETION ACTION for the borderline case: accept the machine pre-assessment,
   * or escalate (needs_human) with a SPECIFIC question naming the worst span + its ratio. It returns
   * a *patched* row (verdict/needs_human/rationale may change to a completion action) but NEVER
   * recomputes a contrast ratio — the deterministic measurement stays authoritative. If OpenRouter
   * is unavailable or errors, we conservatively escalate (the safe default for an attestation moat).
   */
  async llmDecideCompletion(row: Assessment, m: MeasureResult): Promise<Assessment> {
    const worst = m.worst;
    const spanFacts = m.spans
      .slice(0, 20)
      .map((s) => `- "${s.text}" ${s.textColor} worst=${s.worstRatio}:1 needs=${s.threshold}:1 ${s.passes ? 'PASS' : 'FAIL'}`)
      .join('\n');
    const fallbackEscalate = (reason: string): Assessment => ({
      ...row,
      state: 'input_required',
      needs_human: true,
      rationale: `${row.rationale} ${reason}`.trim(),
    });

    if (!this.env.OPENROUTER_API_KEY) {
      return fallbackEscalate('LLM-decide unavailable (no OPENROUTER_API_KEY) → escalated for human review.');
    }

    const system =
      'You are a WCAG 1.4.3 color-contrast completion router for a PDF accessibility audit. ' +
      'The contrast RATIOS below are already measured deterministically (text color vs actual background pixels, worst-case) — you MUST NOT change, recompute, or second-guess them. ' +
      'Your ONLY job is to decide the COMPLETION ACTION for a borderline/ambiguous measurement: ' +
      'either accept it as a machine pre-assessment, or escalate it to a human reviewer. ' +
      'Escalate when the measurement is approximate, when the worst span sits near its threshold, or when text over a busy raster background makes the per-pixel separation unreliable. ' +
      'When you escalate, write a SPECIFIC question that names the failing/borderline span and its ratio. ' +
      'Respond ONLY with strict JSON: {"action":"accept"|"escalate","verdict":"passed"|"failed"|"cannot_tell","human_question":string}.';
    const user =
      `Measurement method: ${m.method}\n` +
      `approximated: ${m.approximated}\n` +
      `min worst-case ratio: ${m.minWorstRatio}:1\n` +
      (worst ? `worst span: "${worst.text}" ${worst.textColor} ${worst.worstRatio}:1 needs ${worst.threshold}:1${worst.largeText ? ' (large text)' : ''}\n` : '') +
      `spans:\n${spanFacts}\n\n` +
      `Deterministic pre-verdict: ${row.verdict}. Decide the completion action.`;

    try {
      const res = await fetchTimeout('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.env.OPENROUTER_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'google/gemini-2.5-flash',
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      }, OPENROUTER_TIMEOUT_MS);
      if (!res.ok) return fallbackEscalate(`LLM-decide HTTP ${res.status} → escalated.`);
      const data = (await res.json()) as any;
      const content = data?.choices?.[0]?.message?.content ?? '{}';
      const decision = JSON.parse(content) as { action?: string; verdict?: string; human_question?: string };

      // The LLM may ONLY clear the human gate for a genuine, fully-measured borderline
      // PASS. It can never downgrade a deterministic fail / approximation / empty-spans escalation to
      // no-human — the deterministic verdict stays authoritative. An `accept` on anything other than a
      // clean measured pass is treated as escalate (safe direction for the attestation moat).
      const acceptable = row.verdict === 'passed' && !m.approximated && m.spans.length > 0;
      if (decision.action === 'accept' && acceptable) {
        // Accept the machine pre-assessment as-is (no human gate). Keep the deterministic verdict.
        return {
          ...row,
          state: 'completed',
          needs_human: false,
          rationale: `${row.rationale} (LLM-decide: accepted machine pre-assessment.)`,
        };
      }
      if (decision.action === 'accept' && !acceptable) {
        return fallbackEscalate(`LLM-decide returned accept on a non-pass/approximate measurement (verdict=${row.verdict}, approximated=${m.approximated}) → escalated (deterministic verdict authoritative).`);
      }
      // Escalate with the model's specific question (default if it omitted one).
      const q = decision.human_question || (worst
        ? `Confirm the contrast of "${worst.text}" (${worst.worstRatio}:1, needs ${worst.threshold}:1).`
        : 'Confirm the borderline contrast measurement.');
      return {
        ...row,
        state: 'input_required',
        needs_human: true,
        rationale: `${row.rationale} (LLM-decide: escalate — ${q})`,
      };
    } catch (e) {
      return fallbackEscalate(`LLM-decide error (${String(e)}) → escalated.`);
    }
  }

  /** fal ideogram/v3/layerize-text — split text vs background. Synchronous fal.run endpoint. */
  private async fetchLayerize(imageUrlOrPdf: string): Promise<LayerizeResult> {
    const res = await fetchTimeout(FAL_LAYERIZE, {
      method: 'POST',
      headers: {
        authorization: `Key ${this.env.FAL_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ image_url: imageUrlOrPdf }),
    }, FAL_TIMEOUT_MS);
    if (!res.ok) throw new Error(`fal_layerize ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as LayerizeResult;
  }

  async getStatus(): Promise<ContrastState> {
    return this.state;
  }

  /** Resolve the human gate (borderline escalation). approve → finalized. */
  async decide(workflowId: string, decision: 'approve' | 'reject', reason?: string): Promise<ContrastState> {
    if (decision === 'approve') {
      await this.approveWorkflow(workflowId, { reason: reason ?? 'approved' });
      this.setState({ ...this.state, gate: 'finalized', updatedAt: Date.now() });
    } else {
      await this.rejectWorkflow(workflowId, { reason: reason ?? 'rejected' });
      this.setState({ ...this.state, gate: 'rejected', updatedAt: Date.now() });
    }
    return this.state;
  }

  async onWorkflowComplete(_name: string, _instanceId: string, _result?: unknown): Promise<void> {
    if (this.state.gate === 'pending_review') return;
    this.setState({ ...this.state, gate: 'finalized', updatedAt: Date.now() });
  }
}

// re-export for callers needing the agent type's RGB helper
export type { RGB };
