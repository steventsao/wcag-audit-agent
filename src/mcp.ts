// mcp.ts — the WCAG Audit Agent MCP surface, on the official MCP Apps SDK (ext-apps).
//
// The agent MCP exposes ONE model tool, `view_html`: drop a PDF (by URL)
// and get back the LIVE, streaming, screen-reader-friendly HTML twin of the document — the same
// accessible rendering this worker serves at /s/:id. This mirrors the landing-page `POST /s` flow:
// mint a public LiveDocAgent session, then hand back the progressively-streaming viewer URL.
//
// The legacy audit_document/get_status/decide tools are RETIRED from the MCP surface. Their Durable
// Object RPC (runAuditOnly / getReport / decideReport on A11yAgent) stays in the worker untouched —
// it backs the future `view_html(policy='wcag')` conformance lane and the /v2/* REST routes. One
// product, one verb: PDF → accessible HTML.
import type { Env, AuditRecord } from './a11y-agent';
import { UI_HTML } from './ui';
import { assertUrlIngestAllowed } from './source-policy';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const RESOURCE_URI = 'ui://wcag-audit/findings.html'; // findings report App resource
export const TWIN_RESOURCE_URI = 'ui://wcag-audit/twin.html'; // view_html App resource (streaming twin)
export const APP_MIME = RESOURCE_MIME_TYPE; // 'text/html;profile=mcp-app'
// Default public origins, embedded into the App resources' CSP and the returned viewer URL. These are
// placeholders — override per deployment via the PUBLIC_ORIGIN / PUBLIC_VIEWER_ORIGIN vars (see README).
export const WORKER_ORIGIN = 'https://wcag-audit-agent.example.workers.dev';
export const LIVE_ORIGIN = 'https://wcag-audit-agent.example.workers.dev';

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,mcp-protocol-version,mcp-session-id',
  'access-control-expose-headers': 'mcp-session-id',
};

/** Clone a Response (the transport returns its own) and stamp CORS headers onto it. */
function addCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// LiveDocAgent (per-session) — bound as LIVE_DOC_AGENT in wrangler.toml; mirrors index.ts liveStub().
type LiveEnv = Env & { LIVE_DOC_AGENT: DurableObjectNamespace };
function liveStub(env: Env, sessionId: string): DurableObjectStub {
  const ns = (env as LiveEnv).LIVE_DOC_AGENT;
  return ns.get(ns.idFromName(sessionId));
}

/**
 * The view_html MCP App resource: a thin shell that iframes the public streaming viewer once the host
 * delivers the tool result. SECURITY (mirrors src/ui.ts): never trust the posted payload beyond an
 * allowlisted viewer_url — an embedder that frames this resource could otherwise point the iframe at an
 * arbitrary origin. Require our own twin-payload shape (streaming:true + viewer_url) and only load a URL
 * under this worker's own /s/ prefix.
 */
const TWIN_VIEW_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Accessible HTML twin</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%}
body{font-family:system-ui,-apple-system,sans-serif;color:#1f1f1f;background:#fff;display:flex;flex-direction:column}
#bar{display:flex;align-items:center;gap:.75rem;padding:.5rem .75rem;border-bottom:1px solid #e3e3dd;font-size:.85rem;color:#6f6f68}
#bar b{color:#1f1f1f}
#open{margin-left:auto;color:#2563eb;text-decoration:none}
#open:hover{text-decoration:underline}
#msg{padding:2rem;color:#6f6f68}
#frame{flex:1;width:100%;border:0}
</style>
</head>
<body>
<div id="bar"><b>Accessible HTML twin</b><span id="sub">streaming…</span><a id="open" href="#" target="_blank" rel="noopener" hidden>Open in new tab ↗</a></div>
<div id="msg">Waiting for the document to start streaming…</div>
<iframe id="frame" title="Accessible HTML rendering of the document" hidden></iframe>
<script>
(function(){
  var ALLOW = ["__LIVE_ORIGIN__","__WORKER_ORIGIN__"];
  var bound = false;
  function allowed(u){ if(typeof u!=="string") return false; for(var i=0;i<ALLOW.length;i++){ if(u.indexOf(ALLOW[i]+"/s/")===0) return true; } return false; }
  function show(u){
    if(bound) return; bound = true;
    var f = document.getElementById("frame"); f.src = u; f.hidden = false;
    var o = document.getElementById("open"); o.href = u; o.hidden = false;
    document.getElementById("sub").textContent = "live";
    document.getElementById("msg").hidden = true;
  }
  // MCP App host bridge: the host delivers the tool result (structuredContent) via postMessage.
  window.addEventListener("message", function(e){
    var p = e.data; if(!p || typeof p!=="object") return;
    var sc = p.structuredContent || (p.result && p.result.structuredContent) || (p.toolResult && p.toolResult.structuredContent) || (p.params && p.params.structuredContent);
    if(!sc || typeof sc!=="object") return;
    if(sc.streaming!==true || typeof sc.viewer_url!=="string") return; // must look like our twin payload
    if(allowed(sc.viewer_url)) show(sc.viewer_url);
  });
})();
</script>
</body>
</html>`;

/**
 * Build a fresh McpServer per request (stateless Streamable HTTP — the CF-Worker pattern). Registers the
 * single `view_html` tool + its streaming-twin App resource. The legacy findings resource stays registered
 * for backward compatibility, but no tool points at it anymore.
 */
export function createA11yMcpServer(env: Env, clientIp?: string): McpServer {
  // Resolve the public origins for this deployment — the embedded App resources need absolute URLs for
  // their CSP and the returned viewer link. Override via vars; fall back to the example defaults.
  const e = env as Env & { PUBLIC_ORIGIN?: string; PUBLIC_VIEWER_ORIGIN?: string };
  const workerOrigin = e.PUBLIC_ORIGIN || WORKER_ORIGIN;
  const liveOrigin = e.PUBLIC_VIEWER_ORIGIN || e.PUBLIC_ORIGIN || LIVE_ORIGIN;

  const server = new McpServer(
    { name: 'wcag-audit-agent', version: '0.2.0', title: 'WCAG Audit Agent' },
    {
      instructions:
        'Turn a PDF into an accessible, screen-reader-friendly HTML twin. Call view_html with a public PDF URL; it returns a live viewer URL that progressively streams semantic HTML (headings, lists, tables, figure alt text) as the document is parsed.',
    },
  );

  // CSP: the App resource iframes the public viewer, which itself opens an SSE stream back to the origin.
  // Both viewer origins must be reachable for the frame load and its event stream.
  const twinUiMeta = {
    ui: {
      prefersBorder: false,
      csp: {
        connectDomains: [liveOrigin, workerOrigin],
        resourceDomains: [liveOrigin, workerOrigin],
      },
    },
  };

  registerAppTool(
    server,
    'view_html',
    {
      title: 'View a PDF as accessible HTML',
      description:
        'Drop a PDF (by public URL) and get back a LIVE, streaming, screen-reader-friendly HTML twin of the document. Returns a viewer_url that progressively streams semantic HTML (headings, lists, tables, figure alt text) as the page is parsed, plus an SSE events_url and a static download_url. Use this to make any PDF readable by assistive tech. (Reserved: policy="wcag" will add the WCAG 2.2 AA / PDF-UA / Section 508 conformance audit — not yet implemented.)',
      inputSchema: {
        pdf_url: z.string().url(),
        title: z.string().optional(),
        // Forward-compatible lane. Today only the default twin render runs; "wcag" is reserved.
        policy: z.enum(['none', 'wcag']).optional(),
      },
      _meta: { ui: { resourceUri: TWIN_RESOURCE_URI } },
    },
    async ({ pdf_url, title, policy }): Promise<CallToolResult> => {
      // Content-rights pre-gate. Refuse license/permission-gated sources and
      // non-http(s) / access-control-defeating URLs at the tool boundary, with an actionable message —
      // rather than minting a session that would only error mid-stream. runVlm re-checks defensively, but
      // surfacing the verdict here keeps the rights gate visible to the agent.
      const gate = assertUrlIngestAllowed(pdf_url);
      if (!gate.ok) {
        return { isError: true, content: [{ type: 'text', text: `Cannot render this URL: ${gate.reason}` }] };
      }

      // Abuse bound. view_html is unauthenticated at the /mcp endpoint and each call triggers a
      // Gemini parse + figure workflow + R2 writes — same cost as POST /s, which is per-IP rate-limited.
      // Mirror that guard here (the mint bypasses the index.ts /s handler), keyed on the proxied client IP.
      const rl = (env as unknown as { SESSIONS_RATELIMIT?: { limit(o: { key: string }): Promise<{ success: boolean }> } }).SESSIONS_RATELIMIT;
      if (rl) {
        const { success } = await rl.limit({ key: clientIp || 'anon' });
        if (!success) {
          return { isError: true, content: [{ type: 'text', text: 'Too many requests — please wait a moment before rendering another document.' }] };
        }
      }

      // Mint an UNLISTED live-twin session — readable by anyone holding the unguessable /s/:id (the MCP host
      // has no creator cookie to gate on), but `no-store` + noindex + never edge-cached: an ephemeral
      // accessibility view rendered to the requester, NOT a public mirror. This is the rights-clean posture:
      // public-URL view = ephemeral/unauth; only upload/persist
      // crosses into Clerk. Mirrors index.ts POST /s, but POST /s mints 'public' for the demo sample.
      const sessionId = crypto.randomUUID();
      await liveStub(env, sessionId).fetch(
        new Request('https://do/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            title: title || 'Accessible document',
            source: { kind: 'url', url: pdf_url },
            visibility: 'unlisted',
          }),
        }),
      );

      const viewerUrl = `${liveOrigin}/s/${sessionId}`;
      const structuredContent = {
        session_id: sessionId,
        pdf_url,
        viewer_url: viewerUrl,
        events_url: `${viewerUrl}/events`,
        download_url: `${viewerUrl}/download`,
        streaming: true,
      };

      const wcagNote =
        policy === 'wcag'
          ? '\n\nNote: policy="wcag" (the WCAG 2.2 AA / PDF-UA / Section 508 conformance lane) is not implemented yet — rendering the accessible HTML twin only.'
          : '';

      return {
        content: [
          {
            type: 'text',
            text: `Streaming accessible HTML twin of ${pdf_url}:\n${viewerUrl}\n(live SSE stream: ${viewerUrl}/events · download: ${viewerUrl}/download)${wcagNote}`,
          },
        ],
        structuredContent,
      };
    },
  );

  // view_html's streaming-twin App resource. Inject the resolved origins into the embedded HTML.
  const twinHtml = TWIN_VIEW_HTML.replaceAll('__LIVE_ORIGIN__', liveOrigin).replaceAll('__WORKER_ORIGIN__', workerOrigin);
  registerAppResource(
    server,
    'Accessible HTML twin',
    TWIN_RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE, _meta: twinUiMeta },
    async (): Promise<ReadResourceResult> => ({
      contents: [{ uri: TWIN_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: twinHtml, _meta: twinUiMeta }],
    }),
  );

  // Findings report App resource (the WCAG rule-area evidence UI). Registered alongside the twin resource
  // but not advertised by a tool — the /v2/* REST routes drive it directly.
  const findingsUiMeta = {
    ui: { prefersBorder: false, csp: { connectDomains: [workerOrigin], resourceDomains: [workerOrigin] } },
  };
  const findingsHtml = UI_HTML.replaceAll('__WORKER_ORIGIN__', workerOrigin);
  registerAppResource(
    server,
    'WCAG accessibility report',
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE, _meta: findingsUiMeta },
    async (): Promise<ReadResourceResult> => ({
      contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: findingsHtml, _meta: findingsUiMeta }],
    }),
  );

  return server;
}

/** POST /mcp — stateless Streamable HTTP. GET = landing page; DELETE = 204; others = 405. */
export async function handleMcp(req: Request, env: Env): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method === 'GET') {
    return addCors(new Response('wcag-audit-agent MCP — POST JSON-RPC over Streamable HTTP. Tool: view_html (PDF → streaming accessible HTML twin). App: ui://wcag-audit/twin.html', { headers: { 'content-type': 'text/plain; charset=utf-8' } }));
  }
  if (req.method === 'DELETE') return addCors(new Response(null, { status: 204 }));
  if (req.method !== 'POST') return addCors(Response.json({ error: 'Method not allowed' }, { status: 405 }));

  const server = createA11yMcpServer(env, req.headers.get('cf-connecting-ip') || undefined);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  let parsedBody: unknown;
  try {
    parsedBody = await req.json();
  } catch {
    return addCors(Response.json({ error: 'Invalid JSON' }, { status: 400 }));
  }

  const response = await transport.handleRequest(req, { parsedBody });
  if (!response) return addCors(Response.json({ error: 'No response from MCP transport' }, { status: 500 }));
  return addCors(response);
}

// AuditRecord is still imported for the legacy /audit summary type elsewhere; re-export not needed here.
export type { AuditRecord };
