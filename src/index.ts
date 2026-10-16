import { getAgentByName, routeAgentRequest } from 'agents';
import { A11yAgent, type Env, type AuditRecord } from './a11y-agent';
import { UI_HTML } from './ui';
import { ValidatorAgent } from './agents/validator-agent';
import { ValidatorWorkflow } from './workflows/validator-workflow';
import { ColorContrastAgent } from './agents/contrast-agent';
import { WcagAgent } from './agents/wcag-agent';
import { ContrastWorkflow } from './workflows/contrast-workflow';
import { SpecialistWorkflow } from './workflows/specialist-workflow';
import { RemediationWorkflow } from './workflows/remediation-workflow';
import { FigureImageWorkflow } from './workflows/figure-image-workflow';
import { LiveDocAgent } from './live-doc-agent';
import { PdfRasterizer } from './pdf-rasterizer';
import { bytesToBase64, LANDING_HTML, newCreatorToken, sha256Hex, sessionCookie } from './live-doc-core';
import { checkLiveGuestPageLimit } from './live-doc-limits';
import { handleMcp } from './mcp';
import { assertUrlIngestAllowed } from './source-policy';
import {
  bearerMatches, boundedRequest, hashAuditOwnerToken, newAuditOwnerToken,
  MAX_AUDIT_PDF_BYTES, MAX_AUDIT_REQUEST_BYTES, MAX_CONTROL_REQUEST_BYTES,
} from './audit-security';

// ValidatorAgent + ColorContrastAgent (lightweight brains) + their Workflows (durable heavy
// offload) are exported so wrangler registers the DO classes + the Workflows. SpecialistWorkflow
// is the ONE coordinator-owned shared specialist workflow; RemediationWorkflow is the
// DOMAIN PIPELINE (Audit→Remediate→Compare→gate). Additive — the plain-DO A11yAgent surface
// (audit/decide/status, /mcp, /app) is untouched. NOTE: the abstract A11ySpecialistAgent base is
// deliberately NOT exported here (and not registered in wrangler) — only the concrete leaf classes.
// WcagAgent is the ROLLUP specialist — consumes the criteria the coordinator gathered and folds
// them onto the WCAG 2.2 AA template; it has NO workflow lane (synchronous rollupInline RPC).
export { A11yAgent, ValidatorAgent, ValidatorWorkflow, ColorContrastAgent, ContrastWorkflow, SpecialistWorkflow, RemediationWorkflow, WcagAgent, LiveDocAgent, FigureImageWorkflow, PdfRasterizer };

// Env already extends ValidatorEnv (A11yAgent is the coordinator that hosts the validator facet).
type V2Env = Env;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,x-wcag-authenticated-user,x-wcag-live-claim-secret,x-wcag-decision-token',
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS } });
const MAX_UPLOAD_BYTES = MAX_AUDIT_PDF_BYTES;

function summarize(id: string, rec: AuditRecord) {
  return {
    id,
    pdf_url: rec.pdfUrl,
    gate: rec.gate,
    claim_tier: rec.tier,
    finalized: rec.finalized,
    served: rec.finalized, // gate-until-finalized: not served while a human gate is open
    score: rec.probe?.score,
    tagged: rec.probe?.tagged,
    lang: rec.probe?.lang,
    title: rec.probe?.title,
    pages: rec.probe?.pageCount,
    verdicts: rec.probe?.verdicts,
    review_needed: rec.reviewReasons,
    findings: rec.probe?.findings,
    note: rec.note,
  };
}

function stub(env: Env, id: string) {
  return env.A11Y_AGENT.get(env.A11Y_AGENT.idFromName(id)) as unknown as A11yAgent;
}

// LiveDocAgent stub (per-session). Bound as LIVE_DOC_AGENT in wrangler.toml.
type LiveEnv = Env & { LIVE_DOC_AGENT: DurableObjectNamespace };
function liveStub(env: Env, sessionId: string): DurableObjectStub {
  const ns = (env as LiveEnv).LIVE_DOC_AGENT;
  return ns.get(ns.idFromName(sessionId));
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/^data:application\/pdf;base64,/, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function parseUploadedPdfRequest(req: Request): Promise<{
  docId: string;
  fileName: string;
  bytes: Uint8Array;
  imageUrl?: string;
  pagePointWidth?: number;
  fixedPdfUrl?: string;
}> {
  const contentLength = Number(req.headers.get('content-length') || 0);
  if (contentLength > MAX_UPLOAD_BYTES + 1_000_000) throw new Error(`upload_too_large: max ${MAX_UPLOAD_BYTES} bytes`);

  const contentType = req.headers.get('content-type') || '';
  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData();
    const fileValue = (form.get('file') || form.get('pdf')) as unknown;
    if (!fileValue || typeof fileValue === 'string' || typeof (fileValue as Blob).arrayBuffer !== 'function') {
      throw new Error('file field required');
    }
    const file = fileValue as Blob & { name?: string };
    if (file.size > MAX_UPLOAD_BYTES) throw new Error(`upload_too_large: max ${MAX_UPLOAD_BYTES} bytes`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    return {
      docId: String(form.get('id') || `upload-${crypto.randomUUID()}`),
      fileName: String(form.get('file_name') || file.name || 'uploaded.pdf'),
      bytes,
      imageUrl: typeof form.get('image_url') === 'string' ? String(form.get('image_url')) : undefined,
      pagePointWidth: pagePointWidthOf({ page_point_width: form.get('page_point_width') }),
      fixedPdfUrl: typeof form.get('fixed_pdf_url') === 'string' ? String(form.get('fixed_pdf_url')) : undefined,
    };
  }

  const body = (await req.json().catch(() => ({}))) as any;
  const pdfBase64: string | undefined = body.pdf_base64 ?? body.pdfBase64 ?? undefined;
  if (!pdfBase64) throw new Error('file or pdf_base64 required');
  const bytes = base64ToBytes(pdfBase64);
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error(`upload_too_large: max ${MAX_UPLOAD_BYTES} bytes`);
  const fileName = body.file_name || body.fileName || 'uploaded.pdf';
  return {
    docId: String(body.id || `upload-${crypto.randomUUID()}`),
    fileName,
    bytes,
    imageUrl: body.image_url ?? undefined,
    pagePointWidth: pagePointWidthOf(body),
    fixedPdfUrl: body.fixed_pdf_url ?? undefined,
  };
}

/** Coerce a page-point-width body value to a positive finite number, else undefined (guards against NaN). */
function pagePointWidthOf(body: any): number | undefined {
  if (body.page_point_width == null) return undefined;
  const n = Number(body.page_point_width);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    // ── CONTENT ORIGIN (content.example.com): serves ONLY the sandboxed document iframe
    // (/s/:id/frame), its SSE stream (/s/:id/events), and figure crops (/s/:id/fig/*.png) — nothing else (no
    // landing, no create, no chrome, no /mcp, no /app). These map to the DO's `/c/*` internal paths so the DO
    // applies the FRAME-TOKEN gate (cookie/?k), not the creator-cookie gate. The hostname is authoritative (a
    // dedicated CF route), so the client can't forge the content-mode handlers. Any other path → back to apex.
    const contentHost = ((): string => {
      try {
        return new URL((env as unknown as { CONTENT_ORIGIN?: string }).CONTENT_ORIGIN || 'https://content.example.com').hostname;
      } catch {
        return 'content.example.com';
      }
    })();
    if (url.hostname === contentHost) {
      const cFrame = path.match(/^\/s\/([^/]+)\/frame$/);
      if (cFrame && req.method === 'GET') {
        return liveStub(env, cFrame[1]).fetch(new Request(`https://do/c/frame${url.search}`, { headers: req.headers }));
      }
      const cEvents = path.match(/^\/s\/([^/]+)\/events$/);
      if (cEvents && req.method === 'GET') {
        return liveStub(env, cEvents[1]).fetch(new Request(`https://do/c/events${url.search}`, { headers: req.headers }));
      }
      const cFig = path.match(/^\/s\/([^/]+)\/fig\/([A-Za-z0-9._-]+\.png)$/);
      if (cFig && req.method === 'GET') {
        return liveStub(env, cFig[1]).fetch(new Request(`https://do/c/fig/${cFig[2]}`, { headers: req.headers }));
      }
      // Stray request on the content origin → bounce to the real app (the chrome lives on the apex).
      return Response.redirect(`https://app.example.com${path}`, 302);
    }

    // The public /s and MCP twin-rendering product has separate guest limits. Audit records,
    // attestations, lab workflows, and Agent SDK state require a server-side credential.
    const privateApi = path === '/audit' || path === '/decide' || path === '/status'
      || path.startsWith('/v2/') || path.startsWith('/agents/');
    if (privateApi) {
      if (!env.AUDIT_API_TOKEN) return json({ error: 'audit_api_not_configured' }, 503);
      if (!(await bearerMatches(req, env.AUDIT_API_TOKEN))) return json({ error: 'unauthorized' }, 401);
      if (req.method === 'POST' && !path.startsWith('/agents/')) {
        const max = path === '/audit' || path === '/v2/remediate-upload-wf'
          ? MAX_AUDIT_REQUEST_BYTES : MAX_CONTROL_REQUEST_BYTES;
        try { req = await boundedRequest(req, max); }
        catch { return json({ error: 'request_too_large' }, 413); }
      }
    }

    if (path === '/mcp') {
      if (req.method === 'POST') {
        try { req = await boundedRequest(req, MAX_CONTROL_REQUEST_BYTES); }
        catch { return json({ error: 'request_too_large' }, 413); }
      }
      return handleMcp(req, env);
    }
    if (path === '/app') return new Response(UI_HTML.replaceAll('__WORKER_ORIGIN__', url.origin), { headers: { 'content-type': 'text/html; charset=utf-8', ...CORS } });

    // ── Live streamed accessible document surface (/s scheme) ───────────────────────────────
    // Landing UI (drop a PDF / paste a URL). Served at /s (no id), /new, and the worker root. A front-end
    // host may proxy /s/* here via a service binding so /s/:id is reachable under the public origin.
    const landing = () => new Response(LANDING_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', ...CORS } });
    if ((path === '/new' || path === '/s') && req.method === 'GET') return landing();
    // Apex renders the same live audit UI as /app and /ui (a bare-domain visit shouldn't 404 or land on a
    // different surface — reviewers may hit the root).
    if (path === '/' && req.method === 'GET' && (req.headers.get('accept') || '').includes('text/html'))
      return new Response(UI_HTML.replaceAll('__WORKER_ORIGIN__', url.origin), { headers: { 'content-type': 'text/html; charset=utf-8', ...CORS } });

    // POST /s {url?,title?} → 303 /s/:sessionId (feels like a normal redirect to a webpage).
    // GET /s/:id           → progressively-streaming HTML shell (latest durable snapshot; noindex).
    // GET /s/:id/events    → SSE event log (replay via ?after=/Last-Event-ID, then live tail).
    // GET /s/:id/fig/:n.png → R2-served cropped figure image.
    // GET /s/demo          → clickable synthetic demo (no PDF). MUST precede the /s/:id matcher below.
    if (path === '/s/demo' && req.method === 'GET') {
      const rl = (env as unknown as { SESSIONS_RATELIMIT?: { limit(o: { key: string }): Promise<{ success: boolean }> } }).SESSIONS_RATELIMIT;
      if (!rl) return json({ error: 'session_rate_limit_not_configured' }, 503);
      const { success } = await rl.limit({ key: req.headers.get('cf-connecting-ip') || 'anon' });
      if (!success) return json({ error: 'Too many requests — please wait a moment.' }, 429);
      const sessionId = crypto.randomUUID();
      // The demo mints a fresh UUID per hit and has no creator cookie, so it must be PUBLIC (a static
      // allowlist can't cover a per-hit id) — else it would self-403 under the private-by-default gate.
      await liveStub(env, sessionId).fetch(
        new Request('https://do/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, title: url.searchParams.get('title') || 'Live demo document', visibility: 'public' }),
        }),
      );
      return new Response(null, { status: 303, headers: { location: `/s/${sessionId}`, ...CORS } });
    }
    if (path === '/s' && req.method === 'POST') {
      // Abuse bound: unauthenticated create triggers Gemini + container compute. Per-IP rate limit.
      const rl = (env as unknown as { SESSIONS_RATELIMIT?: { limit(o: { key: string }): Promise<{ success: boolean }> } }).SESSIONS_RATELIMIT;
      if (!rl) return json({ error: 'session_rate_limit_not_configured' }, 503);
      const ip = req.headers.get('cf-connecting-ip') || 'anon';
      const { success } = await rl.limit({ key: ip });
      if (!success) return json({ error: 'Too many requests — please wait a moment.' }, 429);
      const LIVE_MAX_BYTES = 20 * 1024 * 1024;
      const contentType = req.headers.get('content-type') || '';
      // Stream-cap the body even when Content-Length is absent or forged, before formData/json parsing.
      try {
        req = await boundedRequest(req, contentType.includes('multipart/form-data')
          ? LIVE_MAX_BYTES + 1024 * 1024 : MAX_CONTROL_REQUEST_BYTES);
      } catch { return json({ error: `request too large (max ${LIVE_MAX_BYTES} bytes)` }, 413); }
      let source: { kind: 'bytes'; bytes: string } | { kind: 'url'; url: string };
      let title: string;
      if (contentType.includes('multipart/form-data')) {
        const form = await req.formData();
        const fileValue = (form.get('file') || form.get('pdf')) as unknown;
        const file = fileValue && typeof (fileValue as Blob).arrayBuffer === 'function' ? (fileValue as Blob & { name?: string }) : null;
        const urlField = typeof form.get('url') === 'string' ? String(form.get('url')).trim() : '';
        if (file && file.size > 0) {
          if (file.size > LIVE_MAX_BYTES) return json({ error: `file too large (max ${LIVE_MAX_BYTES} bytes)` }, 413);
          const bytes = new Uint8Array(await file.arrayBuffer());
          const pageLimit = await checkLiveGuestPageLimit(bytes);
          if (!pageLimit.ok) {
            return json(
              {
                error: pageLimit.message,
                code: 'live_page_limit_exceeded',
                page_count: pageLimit.pageCount,
                max_pages: pageLimit.maxPages,
              },
              413,
            );
          }
          source = { kind: 'bytes', bytes: bytesToBase64(bytes) };
          title = String(form.get('title') || file.name || 'Uploaded PDF');
        } else if (urlField) {
          source = { kind: 'url', url: urlField };
          title = String(form.get('title') || 'Document');
        } else {
          return json({ error: 'attach a PDF file or provide a url' }, 400);
        }
      } else {
        const body = (await req.json().catch(() => ({}))) as { url?: string; title?: string };
        if (!body.url) return json({ error: 'provide a PDF file (multipart) or {url} (json)' }, 400);
        source = { kind: 'url', url: String(body.url) };
        title = String(body.title || 'Document');
      }
      const sessionId = crypto.randomUUID();
      // Phase 1 privacy: mint a creator capability token, store only its hash on the DO, and hand the raw
      // token back as an httpOnly, path-scoped cookie on the 303. The creator's browser replays it on
      // /s/<id>* → recognized as the owner; everyone else gets the private 403. Token never in URL/body/logs.
      const rawToken = newCreatorToken();
      const creatorTokenHash = await sha256Hex(rawToken);
      await liveStub(env, sessionId).fetch(
        new Request('https://do/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, title, source, visibility: 'private', creatorTokenHash }),
        }),
      );
      return new Response(null, {
        status: 303,
        headers: { location: `/s/${sessionId}`, 'set-cookie': sessionCookie(sessionId, rawToken), ...CORS },
      });
    }
    const claimMatch = path.match(/^\/s\/([^/]+)\/claim$/);
    if (claimMatch && req.method === 'POST') {
      return liveStub(env, claimMatch[1]).fetch(new Request('https://do/claim', { method: 'POST', headers: req.headers }));
    }
    // Cropped figure images: stored in R2 by the figure-image workflow. Served THROUGH the DO so the
    // private-session gate applies (it bypassed the DO before → private crops leaked with an immutable cache).
    const figMatch = path.match(/^\/s\/([^/]+)\/fig\/([A-Za-z0-9._-]+\.png)$/);
    if (figMatch && req.method === 'GET') {
      return liveStub(env, figMatch[1]).fetch(new Request(`https://do/fig/${figMatch[2]}`, { headers: req.headers }));
    }
    // Download the rendered accessible HTML as a static file (no account needed) — gated like the viewer.
    const dlMatch = path.match(/^\/s\/([^/]+)\/download$/);
    if (dlMatch && req.method === 'GET') {
      return liveStub(env, dlMatch[1]).fetch(new Request('https://do/download', { headers: req.headers }));
    }
    const liveMatch = path.match(/^\/s\/([^/]+?)(\/events)?$/);
    if (liveMatch && req.method === 'GET') {
      const sessionId = liveMatch[1];
      const isEvents = Boolean(liveMatch[2]);
      const target = isEvents ? `https://do/events${url.search}` : 'https://do/shell';
      return liveStub(env, sessionId).fetch(new Request(target, { headers: req.headers }));
    }

    if (path === '/' || path === '/health') {
      return json({
        service: 'wcag-audit-agent',
        ok: true,
        what: 'Per-document accessibility audit agent (deterministic byte-level audit + human-gate). One Durable Object per document.',
        private_api: 'Bearer token required for /audit, /decide, /status, /v2/*, and /agents/*; /decide also requires the audit owner capability.',
        endpoints: {
          'POST /audit': '{ pdf_url, id? } → run audit, returns gate/tier/findings and one-time owner_token',
          'POST /decide': '{ id, decision: approve|reject, note? } + x-wcag-decision-token → resolve the human gate',
          'GET /status?id=': 'current gate/tier/findings for a document',
          'POST /mcp': 'MCP server (JSON-RPC): public view_html tool with guest rate limit',
          'GET /app?id=': 'findings reviewer UI (also the MCP App resource)',
          'GET /v2/ping-facet?id=': 'facets pre-flight: prove ctx.facets/ctx.exports enabled (subAgent round-trip)',
          'POST /v2/remediate': '{ pdf_url, image_url?, page_point_width?, fixed_pdf_url?, id? } → run the FULL PDF-remediation pipeline (Audit→Remediate→Compare→gate) in-process; returns the completed pipeline report. image_url+page_point_width enable real WCAG 1.4.3 contrast; fixed_pdf_url (a pre-built tagged V2) enables a real Compare before→after delta',
          'POST /v2/remediate-wf': '{ pdf_url, image_url?, page_point_width?, fixed_pdf_url?, id? } → SAME pipeline driven through the durable RemediationWorkflow; returns immediately with the seeded report, poll /v2/audit-status',
          'POST /v2/remediate-upload-wf': 'multipart { file, id?, file_name? } or JSON { pdf_base64, id?, file_name? } → stores uploaded PDF bytes on the A11yAgent, then starts the SAME durable workflow',
          'POST /v2/audit-a11y': '{ pdf_url, image_url?, page_point_width?, id? } → run JUST the Audit step (the 6 WCAG criteria via byte-probe + contrast + validator facets); returns the report with pipeline.audit',
          'POST /v2/audit-a11y-wf': '{ pdf_url, image_url?, page_point_width?, id? } → the 2-domain specialist report driven through the coordinator-owned SpecialistWorkflow (routine→agent→done); returns immediately, poll /v2/audit-status',
          'GET /v2/audit-status?id=': 'coordinator report ledger (pipeline + steps + rows + event log + gate)',
          'POST /v2/audit-decide': '{ id, decision: approve|reject, note? } → resolve the report-level human/attestation gate',
          'POST /v2/contrast': '{ image_url|pdf_url, page_point_width?, id? } → ColorContrastAgent durable workflow (WCAG 1.4.3); returns workflow id',
          'GET /v2/contrast-status?id=': 'ColorContrastAgent ledger row + gate',
          'POST /v2/contrast-decide': '{ id, workflow_id, decision, note? } → resolve the contrast human gate',
        },
      });
    }

    if (path === '/audit' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as any;
      const pdfUrl: string | undefined = body.pdf_url ?? url.searchParams.get('pdf_url') ?? undefined;
      const pdfBase64: string | undefined = body.pdf_base64 ?? body.pdfBase64 ?? undefined;
      if (!pdfUrl && !pdfBase64) return json({ error: 'pdf_url or pdf_base64 required' }, 400);
      if (pdfBase64 && (typeof pdfBase64 !== 'string' || pdfBase64.length > Math.ceil(MAX_AUDIT_PDF_BYTES * 4 / 3) + 64)) {
        return json({ error: 'pdf_too_large' }, 413);
      }
      if (pdfUrl) {
        // The fetcher rechecks every redirect hop and caps time and response bytes.
        const gate = assertUrlIngestAllowed(pdfUrl);
        if (!gate.ok) return json({ error: `Cannot fetch this URL: ${gate.reason}` }, 400);
      }
      const id: string = body.id ?? pdfUrl ?? body.file_name ?? crypto.randomUUID();
      try {
        const ownerToken = newAuditOwnerToken();
        const ownerTokenHash = await hashAuditOwnerToken(ownerToken);
        const uploadedBytes = pdfBase64 ? base64ToBytes(pdfBase64) : undefined;
        if (uploadedBytes && uploadedBytes.byteLength > MAX_AUDIT_PDF_BYTES) return json({ error: 'pdf_too_large' }, 413);
        const rec = pdfBase64
          ? await stub(env, id).auditBytes(body.file_name || id, uploadedBytes as Uint8Array, ownerTokenHash)
          : await stub(env, id).audit(pdfUrl as string, ownerTokenHash);
        return json({ ...summarize(id, rec), owner_token: ownerToken });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    if (path === '/decide' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as any;
      const id: string | undefined = body.id;
      if (!id) return json({ error: 'id required' }, 400);
      const ownerToken = req.headers.get('x-wcag-decision-token');
      if (!ownerToken || !/^[0-9a-f]{64}$/.test(ownerToken)) return json({ error: 'decision_token_required' }, 403);
      const decision = body.decision === 'reject' ? 'reject' : 'approve';
      try {
        const rec = await stub(env, id).decide(decision, body.note, await hashAuditOwnerToken(ownerToken));
        return json(summarize(id, rec));
      } catch (e) {
        if (String(e).includes('not_authorized')) return json({ error: 'not_authorized' }, 403);
        return json({ error: String(e) }, 500);
      }
    }

    if (path === '/status') {
      const id = url.searchParams.get('id');
      if (!id) return json({ error: 'id required' }, 400);
      const rec = await stub(env, id).status();
      return rec ? json(summarize(id, rec)) : json({ error: 'not_found' }, 404);
    }

    // ── ValidatorAgent surface (additive; native cloudflare/agents) ──
    // Lab workflows share the private API token gate above. A product rollout should still bind
    // decisions to an authenticated user or service identity before issuing real attestations.
    if (path === '/v2/validate' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as any;
      const pdfUrl: string | undefined = body.pdf_url;
      if (!pdfUrl) return json({ error: 'pdf_url required' }, 400);
      const id: string = body.id ?? pdfUrl;
      try {
        const agent = await getAgentByName((env as V2Env).VALIDATOR_AGENT, id);
        const out = await agent.validate({ pdfUrl, id, fileName: body.file_name });
        return json({ id, ...out });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    if (path === '/v2/status') {
      const id = url.searchParams.get('id');
      if (!id) return json({ error: 'id required' }, 400);
      const agent = await getAgentByName((env as V2Env).VALIDATOR_AGENT, id);
      return json({ id, ...(await agent.getStatus()) });
    }

    if (path === '/v2/decide' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as any;
      if (!body.id || !body.workflow_id) return json({ error: 'id and workflow_id required' }, 400);
      const decision = body.decision === 'reject' ? 'reject' : 'approve';
      const agent = await getAgentByName((env as V2Env).VALIDATOR_AGENT, body.id);
      return json({ id: body.id, ...(await agent.decide(body.workflow_id, decision, body.note)) });
    }

    // ── A11yAgent COORDINATOR surface (two-layer facet topology) ──
    // The coordinator (per-document A11yAgent) dispatches the ValidatorAgent facet via
    // this.subAgent() and owns the a11y report ledger. The private API gate applies to /v2/*.

    // Facets pre-flight smoke: proves ctx.facets/ctx.exports are enabled on this runtime.
    if (path === '/v2/ping-facet') {
      const id = url.searchParams.get('id') || 'preflight';
      try {
        return json({ id, ...(await stub(env, id).pingFacet()) });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // ── the PDF-remediation DOMAIN PIPELINE (Audit→Remediate→Compare→gate) ──
    // POST /v2/remediate runs the full pipeline in-process and returns the completed pipeline report.
    // The private API gate applies here; product identity/authorization is still needed for attestations.
    if (path === '/v2/remediate' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as any;
      const pdfUrl: string | undefined = body.pdf_url;
      if (!pdfUrl) return json({ error: 'pdf_url required' }, 400);
      const docId: string = body.id ?? pdfUrl;
      const imageUrl: string | undefined = body.image_url ?? undefined;
      const pagePointWidth = pagePointWidthOf(body);
      const fixedPdfUrl: string | undefined = body.fixed_pdf_url ?? undefined;
      try {
        return json(await stub(env, docId).runPipelineInline({ docId, pdfUrl, imageUrl, pagePointWidth, fixedPdfUrl }));
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // The SAME pipeline driven through the durable RemediationWorkflow. Returns immediately with the
    // seeded report; the pipeline slices fill in as the workflow's steps complete (poll /v2/audit-status).
    if (path === '/v2/remediate-wf' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as any;
      const pdfUrl: string | undefined = body.pdf_url;
      if (!pdfUrl) return json({ error: 'pdf_url required' }, 400);
      const docId: string = body.id ?? pdfUrl;
      const imageUrl: string | undefined = body.image_url ?? undefined;
      const pagePointWidth = pagePointWidthOf(body);
      const fixedPdfUrl: string | undefined = body.fixed_pdf_url ?? undefined;
      try {
        return json(await stub(env, docId).runRemediation({ docId, pdfUrl, imageUrl, pagePointWidth, fixedPdfUrl }));
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    if (path === '/v2/remediate-upload-wf' && req.method === 'POST') {
      try {
        const upload = await parseUploadedPdfRequest(req);
        return json(await stub(env, upload.docId).runUploadedRemediation(upload));
      } catch (e) {
        return json({ error: String(e) }, String(e).includes('required') ? 400 : 500);
      }
    }

    // /v2/audit-a11y now runs JUST the Audit step (the 6 WCAG criteria) — decoupled from the rest of
    // the pipeline. Returns the report with pipeline.audit populated (other slices null).
    if (path === '/v2/audit-a11y' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as any;
      const pdfUrl: string | undefined = body.pdf_url;
      if (!pdfUrl) return json({ error: 'pdf_url required' }, 400);
      const docId: string = body.id ?? pdfUrl;
      const imageUrl: string | undefined = body.image_url ?? undefined;
      const pagePointWidth = pagePointWidthOf(body);
      try {
        return json(await stub(env, docId).runAuditOnly({ docId, pdfUrl, imageUrl, pagePointWidth }));
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // The SAME 2-domain report, driven through the coordinator-owned SpecialistWorkflow
    // (routine→agent→done via lifecycle hooks) instead of the inline subAgent().assess() path. Returns
    // immediately with the seeded report; rows fill in as the workflows complete (poll /v2/audit-status).
    if (path === '/v2/audit-a11y-wf' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as any;
      const pdfUrl: string | undefined = body.pdf_url;
      if (!pdfUrl) return json({ error: 'pdf_url required' }, 400);
      const docId: string = body.id ?? pdfUrl;
      const imageUrl: string | undefined = body.image_url ?? undefined;
      const pagePointWidth = pagePointWidthOf(body);
      try {
        return json(await stub(env, docId).auditA11yViaWorkflow({ docId, pdfUrl, imageUrl, pagePointWidth }));
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    if (path === '/v2/audit-status') {
      const id = url.searchParams.get('id');
      if (!id) return json({ error: 'id required' }, 400);
      try {
        return json({ docId: id, report: await stub(env, id).getReport() });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // Conversational surface: ask the A11yAgent about this document's audit. The agent appends the user turn,
    // sets `thinking`, composes a grounded Gemini reply, and appends it — every step a setState broadcast, so
    // the live UI (WebSocket subscribe + poll fallback) shows message → thinking → reply. Private API gated.
    if (path === '/v2/chat' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { id?: string; text?: string };
      const id = String(body.id ?? '').trim();
      const text = String(body.text ?? '').trim();
      if (!id || !text) return json({ error: 'id and text required' }, 400);
      try {
        return json({ docId: id, report: await stub(env, id).chat(text) });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    if (path === '/v2/audit-decide' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as any;
      if (!body.id) return json({ error: 'id required' }, 400);
      const decision = body.decision === 'reject' ? 'reject' : 'approve';
      try {
        return json({ docId: body.id, report: await stub(env, body.id).decideReport(decision, body.note) });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // ── ColorContrastAgent direct surface (durable workflow, WCAG 1.4.3) ──
    // Backs the standalone contrast lane (the coordinator uses the inline RPC instead). Private API gated.
    if (path === '/v2/contrast' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as any;
      const imageUrl: string | undefined = body.image_url ?? body.pdf_url;
      if (!imageUrl) return json({ error: 'image_url or pdf_url required' }, 400);
      const id: string = body.id ?? imageUrl;
      const pagePointWidth = pagePointWidthOf(body);
      try {
        const agent = await getAgentByName((env as V2Env).COLOR_CONTRAST_AGENT, id);
        const out = await agent.startContrast({ pdfUrl: imageUrl, id, fileName: body.file_name, pagePointWidth });
        return json({ id, ...out });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    if (path === '/v2/contrast-status') {
      const id = url.searchParams.get('id');
      if (!id) return json({ error: 'id required' }, 400);
      const agent = await getAgentByName((env as V2Env).COLOR_CONTRAST_AGENT, id);
      return json({ id, ...(await agent.getStatus()) });
    }

    if (path === '/v2/contrast-decide' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as any;
      if (!body.id || !body.workflow_id) return json({ error: 'id and workflow_id required' }, 400);
      const decision = body.decision === 'reject' ? 'reject' : 'approve';
      const agent = await getAgentByName((env as V2Env).COLOR_CONTRAST_AGENT, body.id);
      return json({ id: body.id, ...(await agent.decide(body.workflow_id, decision, body.note)) });
    }

    // ── Live report viewer (standalone lab UI) — binds to the A11yAgent's state, not the workflow. ──
    if (path === '/ui') {
      return new Response(UI_HTML.replaceAll('__WORKER_ORIGIN__', url.origin), { headers: { 'content-type': 'text/html; charset=utf-8', ...CORS } });
    }

    // ── Agent SDK routing: exposes /agents/a11y-agent/:id (WebSocket + HTTP) so AgentClient/useAgent
    // can subscribe to the live report state (setState broadcasts). Fallback AFTER the custom routes. ──
    const agentResp = await routeAgentRequest(req, env);
    if (agentResp) return agentResp;

    return json({ error: 'not_found', path }, 404);
  },
};
