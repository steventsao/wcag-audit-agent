# WCAG Audit Agent

A **Cloudflare Worker** that turns any PDF into a live, screen-reader-friendly **accessible HTML twin** and runs a **WCAG 2.2 AA / PDF-UA** audit behind a **durable human-review gate** — built on the [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/) + [Workflows](https://developers.cloudflare.com/workflows/).

It pairs two things single-shot tools get wrong:

- **A deterministic byte-level audit** (via `pdf-lib`): is the PDF tagged? does it declare `/Lang`? a document title / `DisplayDocTitle`? do `/Figure`s carry `/Alt`? do `/Table`s have `/TH`? what StructTree roles exist? These are the exact criteria a vision model **cannot** see — tags are invisible in rendered pixels.
- **A live, streaming accessible rendering** of the document (a VLM emits semantic HTML — headings, lists, tables, figure alt text — which streams into the browser block-by-block over SSE).

A machine `PASS` is only ever a **pre-assessment**. Nothing is attested until a human resolves the gate: **Audited → Remediated → Attested**.

> ⚠️ This is a reference implementation extracted for open source. The audit and attestation API requires `AUDIT_API_TOKEN`; real conformance attestations still need a product identity and reviewer authorization layer.

## Demo

The core user flow — drop a PDF → deterministic byte audit → WCAG 2.2 AA rollup → human review gate → **Attested**:

![WCAG audit + human-gate user flow](hyperframes/wcag-audit-flow.gif)

> The source composition lives in [`hyperframes/`](hyperframes/) (HyperFrames HTML).

## Architecture

```
                         ┌─────────────────────────────────────────────┐
   PDF (url / upload) →  │  A11yAgent  (coordinator Durable Object)     │
                         │  owns: report state · pipeline · event log · │
                         │        the human-review gate                 │
                         └───────┬───────────────┬───────────────┬──────┘
                          facets │               │ workflows     │
              ┌──────────────────┼───────────────┼───────────────┼─────────────────┐
              ▼                  ▼               ▼               ▼                 ▼
       ValidatorAgent    ColorContrastAgent   WcagAgent    SpecialistWorkflow  RemediationWorkflow
       (structure /      (WCAG 1.4.3 via      (2.2 AA      (shared domain      (Audit→Remediate→
        StructTree)       fal layerize)        rollup)      driver)             Compare→gate)

   LiveDocAgent (per-session DO)  →  streams the accessible HTML twin over SSE
   FigureImageWorkflow + PdfRasterizer (MuPDF container)  →  real bbox figure crops
```

- **`A11yAgent`** (`src/a11y-agent.ts`) — the coordinator. One Durable Object per document. Owns the report, pipeline state, the durable event log, and the human gate.
- **Facet agents** (`src/agents/*`) — `ValidatorAgent` (structural reconciliation), `ColorContrastAgent` (WCAG 1.4.3 contrast, measured against real background pixels), `WcagAgent` (maps gathered evidence onto the WCAG 2.2 AA template, grouped by 11 rule areas).
- **Workflows** (`src/workflows/*`) — durable, retryable lanes: validator, contrast, a shared specialist driver, the remediation domain pipeline, and the figure-image lane.
- **Live twin** — `LiveDocAgent` (`src/live-doc-agent.ts`) holds the per-session SSE event log + HTML snapshot; `src/live-doc-core.ts` is the pure, framework-free core (unit-tested in plain Node). `PdfRasterizer` is this worker's own MuPDF container for real figure crops.
- **Deterministic probe** — `src/probe.mjs` (pdf-lib) does the byte-level audit.
- **UI** — `src/ui.ts` is a self-contained WCAG report (polls the worker for live state); `src/mcp.ts` exposes it (and the streaming twin) as MCP App resources.

## Endpoints

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/` | — | health + endpoint list |
| POST | `/audit` | `{ pdf_url, id? }` or `{ pdf_base64, file_name?, id? }` | run audit → gate / tier / findings + one-time `owner_token` |
| POST | `/decide` | `{ id, decision: approve\|reject, note? }` + `x-wcag-decision-token` | resolve the human gate |
| GET | `/status?id=` | — | current gate / tier / findings |
| GET | `/app?id=` · `/ui?id=` | — | the live WCAG report UI |
| POST | `/mcp` | JSON-RPC | MCP `view_html` tool + App resources |
| POST | `/v2/audit-a11y` | `{ pdf_url, image_url?, id? }` | audit step with WCAG rollup |
| POST | `/v2/remediate-wf` | `{ pdf_url, id? }` | durable Audit→Remediate→Compare workflow (poll `/v2/audit-status?id=`) |
| GET/POST | `/s`, `/s/:id` | (form / multipart) | live accessible-HTML twin: drop a PDF, watch it stream |

Set `AUDIT_API_TOKEN` as a Worker secret and call these routes from a trusted server. Send it as
`Authorization: Bearer <token>`; never embed it in browser code. Save the `owner_token` returned by
`/audit` securely and send it as `x-wcag-decision-token` to `/decide`. The capability changes each
time an ID is re-audited. Existing records need a new audit before they can be decided. The static
`/app` and `/ui` report pages make direct browser calls and will need a trusted proxy before they can
use the private endpoints.

## Quickstart

**Prerequisites:** Node 18+, a Cloudflare account (`wrangler login`), a Google Gemini API key, and Docker (for the `PdfRasterizer` container build on deploy).

```bash
npm install

# secrets — local dev
cp .dev.vars.example .dev.vars     # then fill in GEMINI_API_KEY (+ optional FAL_KEY, FRAME_SIGN_KEY)

npm test          # vitest — pure-core unit tests, no network
npm run typecheck # tsc --noEmit

# production secrets
wrangler secret put GEMINI_API_KEY
wrangler secret put FRAME_SIGN_KEY     # required in prod (private-session frame capability)
wrangler secret put FAL_KEY            # optional (WCAG 1.4.3 contrast lane)
wrangler secret put AUDIT_API_TOKEN    # required for private audit/attestation API

npm run deploy    # wrangler deploy  (builds the MuPDF container — needs Docker running)
```

### Configuration

The embedded MCP App resources need absolute origins. They default to a placeholder; set your own (in `wrangler.toml` `[vars]` or as secrets):

- `PUBLIC_ORIGIN` — the worker's public origin.
- `PUBLIC_VIEWER_ORIGIN` — the streaming-twin viewer origin (defaults to `PUBLIC_ORIGIN`).
- `CONTENT_ORIGIN` — the **isolated** host that serves only the sandboxed document iframe. Keeping it on a separate (same-site) hostname is a security boundary: untrusted VLM-rendered HTML can't reach the main app's DOM/cookies even if the sanitizer is bypassed.

See `wrangler.toml` for the example routes/vars and the full secret list.

## How the human gate works

Every criterion is tagged with its source — `machine` (deterministic or measured) or `human review`. The report carries a `gate` (`open` → `pending_review` → `finalized` / `rejected`). The UI surfaces **Approve · attest** / **Reject** only while a gate is open. This keeps a machine `PASS` honestly labeled as a pre-assessment until a human signs off — the posture accessibility attestations actually require.

## Tests

`npm test` runs the `vitest` suite over `src/live-doc-core.ts` (the pure core: SSE framing, the streaming block splitter, HTML sanitizer, the frame-capability HMAC tokens, cookie handling) and `src/source-policy.ts` (the SSRF guard for ingested URLs). No network or Cloudflare runtime needed.

## Security & limitations

This is a **reference implementation**. An independent review flagged the following — all are fine for
local / lab use but **must be addressed before any production deployment** that issues real attestations:

- **Private audit API.** `/audit`, `/decide`, `/status`, `/v2/*`, and `/agents/*` fail closed when
  `AUDIT_API_TOKEN` is unset and otherwise require a bearer token. `/decide` also requires the
  capability returned by the matching `/audit`; previously stored records need a new audit. The `/v2/*`
  decision paths currently trust the server credential, so a product gateway must enforce reviewer
  authorization per report before using them for attestations.
- **Bounded PDF ingest.** The `/audit` and live `/s` URL fetches check each redirect, time out after
  15 seconds, and stream at most 20 MiB. Request bodies are capped before JSON/multipart parsing.
  Public `/s` and `/mcp` creation fails closed if the rate-limit binding is missing. DNS rebinding
  remains a risk in Workers, and authenticated `/v2/*` validator/contrast URL fetch paths require
  further source review.
- **Configure your origins.** `FRAME_ANCESTORS` (`src/live-doc-core.ts`) and the `PUBLIC_ORIGIN` /
  `PUBLIC_VIEWER_ORIGIN` / `CONTENT_ORIGIN` values ship as `example.com` placeholders. Set them to your
  real hostnames or the content iframe's CSP will block it.

## License

[MIT](LICENSE)
