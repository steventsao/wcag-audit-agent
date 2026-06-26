# The app is the agent

An exploration: **what if a web app's UI is just a live projection of one agent's state?**

This is the WCAG Audit Agent (deployed as `okra-a11y-agent`) with every region of the UI
color-coded to the agent that produces it. Nothing here is a static page — each pixel is a
read of some agent's state, pushed live.

![The app is the agent — 60s tour](the-app-is-the-agent-60s.gif)

> 60s walkthrough. Full-quality MP4: [`the-app-is-the-agent-60s.mp4`](the-app-is-the-agent-60s.mp4).
> Still frame: [`agents-color-coded.png`](agents-color-coded.png). Re-render against any
> `?id=` with [`render-tour.mjs`](render-tour.mjs) (Playwright → ffmpeg).

## The pieces

| Region in the UI | Owning agent | What it is |
|---|---|---|
| Title, live-connection badge, phase tabs, **human-review gate**, event log | **`A11yAgent`** (`src/a11y-agent.ts`) | The **coordinator** — one Durable Object per document. Owns the report state, the pipeline, the durable event log, and the gate. |
| Standards dropdown, rule-area sidebar, the per-criterion **rollup** | **`WcagAgent`** (`src/agents/wcag-agent.ts`) | Maps gathered evidence onto the WCAG 2.2 AA template (11 rule areas, per-SC verdicts). |
| Reading Order / Table Semantics / Tag Structure rows | **`ValidatorAgent`** (`src/agents/validator-agent.ts`) | Facet agent. Reconciles the PDF StructTree / tagging — evidence a vision model literally cannot see. |
| Color Contrast row (WCAG 1.4.3) | **`ColorContrastAgent`** (`src/agents/contrast-agent.ts`) | Facet agent. Measures contrast against the **real background pixels** (fal layerize), not guesses. |
| The "Create HTML" phase → the accessible HTML twin | **`LiveDocAgent`** (`src/live-doc-agent.ts`) | Per-session DO that streams a semantic HTML rendering block-by-block over SSE. |
| Phase progression (the durable lanes behind it) | **Workflows** (`src/workflows/*`) | Retryable Audit → Remediate → Compare lanes; survive restarts. |

## Using `cloudflare/agents` to represent UI state

The whole app is built on one move from the [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/):

```
class A11yAgent extends Agent<Env, ReportState> {
  // a tool / endpoint mutates state:
  this.setState(next)   // 1. persists to the DO's SQLite   2. broadcasts to every connected client
}
```

`setState` is both the database write **and** the realtime push. The UI (`src/ui.ts`, served at
`/app`, `/ui`, and as a `ui://` MCP App resource) holds no source of truth of its own — it
subscribes to the agent and re-renders on every push (`AgentClient onStateUpdate`, with a status
poll as fallback). So:

- **One `setState`, every surface.** The same state lights up a browser tab, an MCP host
  (Claude Desktop / Codex) rendering the `ui://` resource, and a native iOS client — no per-surface
  glue, no manual refresh. What you see in the GIF is literally the agent's state, projected.
- **The DO is the single writer.** Only the agent mutates its own state; everyone else reads. That's
  the actor model applied to a product surface — no split-brain between "the app" and "the agent."
- **State is durable + self-describing.** Pipeline phase, per-SC verdicts, the event log, the gate
  decision all live in one DO's state, addressable by `id`. The UI is a pure function of it.

The bet: there are no more "sites with a backend" — there's an agent, and the UI is one of its outputs.

## Why specialized agents (and not one big one)

The interesting design question isn't "can one agent render the UI" — it's **why this app is a
coordinator plus a cast of specialists.** That's deliberate:

1. **The work is heterogeneous, with different runtimes and trust.** Reading a PDF's StructTree is
   pure byte inspection; measuring 1.4.3 contrast needs real rendered pixels (a `fal` call); the HTML
   twin is a streaming VLM; figure crops need a MuPDF container. Folding all of that into one agent
   makes a monolith that's impossible to reason about, retry, or sandbox. Each facet is the *right
   shape for its job* — some deterministic and isolate-safe, some networked and stateful.

2. **Delegation keeps the coordinator's context lean.** When `A11yAgent` hands a task to a facet, the
   facet carries its own state and context; the coordinator doesn't drown in the details of contrast
   math or StructTree parsing. Delegation is as much for the *parent* (a clean, small context) as for
   the child — that's what lets the design nest without blowing up.

3. **Independent agents can disagree — and that disagreement is the moat.** A machine `PASS` here is
   only ever a *pre-assessment*. Facets emit independent assessments (`src/a2a.ts`); when validators
   disagree, the coordinator **escalates to a human gate** rather than papering over it. A single
   mega-agent can't adversarially check itself — you need genuinely separate agents whose conflict is
   meaningful signal. Nothing is attested until a human resolves the gate: **Audited → Remediated →
   Attested.**

4. **Deterministic and probabilistic work stay separated on purpose.** The byte-level audit
   (`pdf-lib`) and pure detectors are deterministic — no LLM, no guessing — so their verdicts are
   trustworthy precisely because they *aren't* a vision model. The VLM does the parts vision is good
   at (the semantic twin). Mixing them would launder a guess into a "fact."

5. **Two layers, by design — `Detector` vs `Specialist`.** The pure measurement step (the math, the
   tag check) is isolate-hostable and could even be a runtime-installed plugin; the *orchestration*
   around it (state, retries, the human gate) is a stateful facet agent that wraps it. That split is
   why some checks are simple functions and others are full agents — and it's where the design can
   grow (new pure detectors plug in; heavy facets stay hand-written).

6. **Specialists can level up independently.** Seniority = number of human-approved runs: a junior
   facet is gated at every step, a senior one runs autonomously until it drifts. You can't grant
   autonomy per-capability if it's all one agent.

## Try it

```bash
curl -sX POST https://okra-a11y-agent.steventsao.workers.dev/audit \
  -H 'content-type: application/json' \
  -d '{"pdf_url":"https://arxiv.org/pdf/1411.1784","id":"demo"}'
# then open https://okra-a11y-agent.steventsao.workers.dev/app?id=demo and watch the agents fill it in
```
