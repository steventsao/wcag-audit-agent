// Live streamed accessible document surface (SSE event-log).
// PURE, framework-free core so it is unit-testable in plain node (no `cloudflare:workers` import).
// The Durable Object (live-doc-agent.ts) is a thin shell over these functions; the browser client
// (CLIENT_JS) is generic and PDF-agnostic — it only swaps/appends nodes by id.
//
// Engine (goal-mode): a VLM (Gemini) ingests the PDF natively and STREAMS semantic HTML; the runner
// splits complete top-level blocks out of the stream (`extractBlocks`) and emits each as an `append`
// event. The client knows nothing about PDF/VLM — it just renders streamed HTML, like a webpage loading.

export type LiveEventType = 'progress' | 'replace' | 'append' | 'done' | 'error';

/** One durable, addressed event. `seq` is the monotonic event id (also the SSE `id:`). */
export interface LiveEvent {
  seq: number;
  type: LiveEventType;
  /** progress: human phase label (e.g. "Parsing"). */
  phase?: string;
  /** replace: CSS selector of the node to swap, e.g. "#block-3". */
  target?: string;
  /** replace/append: the HTML to swap in / append. */
  html?: string;
  /** error detail. */
  message?: string;
}

/** A rendered block in the server-held snapshot (for the no-JS / reconnect shell). */
export interface Block {
  id: string;
  html: string;
}

const enc = new TextEncoder();

/** SSE wire-frame for one event. `id:` powers EventSource auto-resume via Last-Event-ID. */
export function encodeSse(ev: LiveEvent): Uint8Array {
  const { seq: _seq, ...payload } = ev;
  return enc.encode(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/** Replay filter: events strictly after the client's last-seen seq. */
export function filterAfter(events: LiveEvent[], afterSeq: number): LiveEvent[] {
  return events.filter((e) => e.seq > afterSeq);
}

/** Deterministic 6-char content hash (djb2/base36) — no crypto, stable across runs. */
export function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36).padStart(6, '0').slice(-6);
}

/** Stable coarse block id: page + order + short content hash. */
export function blockId(page: number, order: number, text: string): string {
  return `block-${page}-${order}-${shortHash(text)}`;
}

/** "#block-3" -> "block-3". */
export function idFromTarget(target: string): string {
  return target.startsWith('#') ? target.slice(1) : target;
}

/** Apply a `replace` to the server-held snapshot: update matching block, else append. */
export function applyReplace(blocks: Block[], target: string, html: string): Block[] {
  const id = idFromTarget(target);
  const next = blocks.map((b) => (b.id === id ? { id, html } : b));
  if (!next.some((b) => b.id === id)) next.push({ id, html });
  return next;
}

/** Apply an `append`: drop the loading placeholder (first real content) and push the new block. */
export function applyAppend(blocks: Block[], id: string, html: string): Block[] {
  return [...blocks.filter((b) => b.id !== 'a11y-load'), { id, html }];
}

/**
 * Client's resume point. Last-Event-ID (sent by EventSource on auto-reconnect) wins, so a reconnect
 * never re-replays already-received events; the bootstrap ?after= (the shell's snapshot seq) is the
 * initial-connect fallback. This is what keeps non-idempotent `append` events from duplicating when a
 * completed/partial snapshot is already on screen.
 */
export function parseAfter(req: Request): number {
  const lastId = req.headers.get('last-event-id');
  const q = new URL(req.url).searchParams.get('after');
  const v = lastId ?? q;
  const n = v == null ? 0 : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ));
}

// ── Streaming HTML block splitter ────────────────────────────────────────────────────────────────
// Pull COMPLETE top-level elements out of a growing buffer so each block renders whole (no half-open
// tags flashing on screen). Returns the finished blocks and the leftover (incomplete) tail.

/** Strip a leading ```html / ``` fence and whitespace the VLM may emit despite instructions. */
export function stripFence(s: string): string {
  return s.replace(/^﻿?\s*```(?:html)?\s*/i, '').replace(/\s*```\s*$/i, '');
}

/** Index just past the end of the complete top-level element starting at `start` ('<'), or -1 if incomplete. */
export function findElementEnd(s: string, start: number): number {
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
  tagRe.lastIndex = start;
  let depth = 0;
  let entered = false;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(s))) {
    const whole = m[0];
    const isClose = whole.startsWith('</');
    const selfClose = whole.endsWith('/>') || /^(br|hr|img|input|meta|source|col|area|wbr)$/i.test(m[1]);
    if (!entered) {
      entered = true;
      if (selfClose && !isClose) return m.index + whole.length; // top-level void/self-closing element
    }
    if (isClose) depth -= 1;
    else if (!selfClose) depth += 1;
    if (entered && depth === 0) return m.index + whole.length;
  }
  return -1;
}

/** Split complete top-level blocks from a streaming HTML buffer. Stray top-level text → wrapped <p>. */
export function extractBlocks(buffer: string): { blocks: string[]; rest: string } {
  const blocks: string[] = [];
  let s = stripFence(buffer);
  for (;;) {
    const ws = s.search(/\S/);
    if (ws === -1) {
      s = '';
      break;
    }
    if (ws > 0) s = s.slice(ws);
    if (s[0] !== '<') {
      const lt = s.indexOf('<');
      if (lt === -1) break; // text node not yet terminated — wait for more
      const text = s.slice(0, lt).trim();
      if (text) blocks.push(`<p>${text}</p>`);
      s = s.slice(lt);
      continue;
    }
    const end = findElementEnd(s, 0);
    if (end === -1) break; // element not fully streamed yet
    const block = s.slice(0, end).trim();
    if (block) blocks.push(block);
    s = s.slice(end);
  }
  return { blocks, rest: s };
}

// ── figure images ───────────────────────────────────────────────────────────────────────
// The text stream paints figures as a placeholder `<figure data-bbox>`; a SEPARATE lane later swaps in a
// cropped `<img>` via a generic `replace` event. For that swap to land in BOTH the live DOM (querySelector)
// AND the durable snapshot (applyReplace by id), every appended block must carry a STABLE top-level id.

/** A figure awaiting its cropped image: stable block id + page + Gemini-order bbox + caption (→ <img alt>). */
export interface FigureRef {
  id: string;
  /** 1-based page number. */
  page: number;
  /** [ymin, xmin, ymax, xmax], integers normalized 0–1000 (Gemini-native bbox order). */
  bbox: [number, number, number, number];
  /** figcaption text, used as the <img> alt. */
  caption: string;
}

/**
 * Guarantee the top-level element of an appended block carries an `id` so a later `replace` can target it.
 * Reuses an id the VLM already emitted, else injects `fallbackId`. Returns the id + the html that bears it.
 * (Blocks from `extractBlocks` are trimmed and start with `<`; stray text falls back to the id, html as-is.)
 */
export function ensureBlockId(html: string, fallbackId: string): { id: string; html: string } {
  const open = html.match(/^<([a-zA-Z][\w-]*)\b([^>]*)>/);
  if (!open) return { id: fallbackId, html };
  const existing = open[2].match(/\bid\s*=\s*["']([^"']+)["']/);
  if (existing) return { id: existing[1], html };
  const withId = `<${open[1]} id="${fallbackId}"${open[2]}>` + html.slice(open[0].length);
  return { id: fallbackId, html: withId };
}

/** If `html` is a top-level <figure> carrying data-bbox, extract its FigureRef (else null). */
export function parseFigureRef(html: string, id: string): FigureRef | null {
  const open = html.match(/^<figure\b([^>]*)>/i);
  if (!open) return null;
  const attrs = open[1];
  const bboxRaw = attrs.match(/data-bbox\s*=\s*["']([^"']+)["']/i);
  if (!bboxRaw) return null;
  const nums = bboxRaw[1].split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n));
  if (nums.length !== 4) return null;
  const pageRaw = attrs.match(/data-page\s*=\s*["']?(\d+)/i);
  const page = pageRaw ? Math.max(1, parseInt(pageRaw[1], 10)) : 1;
  const cap = html.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i);
  const caption = cap ? cap[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
  return { id, page, bbox: [nums[0], nums[1], nums[2], nums[3]], caption };
}

/** Wrap a top-level <table> block in a horizontal-scroll container so a wide (many-column) table scrolls
 *  locally instead of forcing the whole page to scroll sideways on a phone. Non-table blocks pass through. */
export function wrapTableBlock(html: string): string {
  return /^\s*<table[\s>]/i.test(html) ? `<div class="a11y-table-scroll">${html}</div>` : html;
}

/** Build the resolved <figure> (cropped image + caption) that replaces a placeholder. Keeps id + bbox. */
export function renderFigureImg(fig: FigureRef, src: string): string {
  const cap = escapeHtml(fig.caption);
  const capHtml = cap ? `<figcaption>${cap}</figcaption>` : '';
  return `<figure id="${fig.id}" data-page="${fig.page}" data-bbox="${fig.bbox.join(',')}">` +
    `<img src="${escapeHtml(src)}" alt="${cap || 'Figure'}" loading="lazy">${capHtml}</figure>`;
}

// (The figure crop is now a REAL cropped PNG produced by this worker's PdfRasterizer container — see
// render-crop.ts + workflows/figure-image-workflow.ts. The earlier SVG-data-URI stub is gone.)

// ── HTML sanitizer (security gate) ─────────────────────────────────────────────────────────
// The streamed blocks come from a VLM reading an UNTRUSTED uploaded/pasted PDF — prompt constraints are
// NOT a security boundary. Every VLM block is run through this allowlist (real HTML parse via the
// Workers-native HTMLRewriter) before it is stored, broadcast, or rendered. Server-built blocks (figures,
// demo) are trusted and skip this.
const SAN_ALLOWED_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'figure', 'figcaption', 'img', 'blockquote', 'pre', 'code',
  'strong', 'em', 'b', 'i', 'u', 's', 'sub', 'sup', 'small', 'mark', 'span', 'br', 'hr', 'a', 'abbr',
]);
// Dropped WITH their contents (executable / embedding / interactive).
const SAN_DROP_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math',
  'link', 'meta', 'base', 'form', 'input', 'button', 'textarea', 'select', 'option',
]);
const SAN_ATTR_ALLOW: Record<string, Set<string>> = {
  // NOT 'id': ids are SERVER-assigned (blk-<seq>) — a VLM-supplied id must never flow into an R2 key, a
  // crop URL, or a querySelector replace target. data-bbox/data-page are re-parsed as numbers downstream.
  '*': new Set(['data-page', 'data-bbox']),
  img: new Set(['src', 'alt', 'loading', 'width', 'height']),
  a: new Set(['href', 'title']),
  th: new Set(['scope', 'colspan', 'rowspan', 'headers']),
  td: new Set(['colspan', 'rowspan', 'headers']),
  col: new Set(['span']),
  colgroup: new Set(['span']),
};
function sanUrlOk(value: string): boolean {
  const s = value.trim().toLowerCase();
  // Allowlist safe schemes only. NO data: — a VLM-supplied data: image would bloat the durable snapshot;
  // our OWN crops are server-added as relative /live/.../fig/ URLs (pass the '/' rule). Also blocks
  // javascript:, vbscript:, data:text/html, etc.
  return s.startsWith('https://') || s.startsWith('http://') || s.startsWith('mailto:') || s.startsWith('#') || s.startsWith('/');
}

/** Allowlist-sanitize one VLM HTML block (Workers HTMLRewriter). Strips disallowed tags/attrs, on* handlers,
 *  styles, and unsafe href/src schemes. Async (HTMLRewriter transforms a Response). Worker runtime only. */
export async function sanitizeHtml(html: string): Promise<string> {
  const rewriter = new HTMLRewriter()
    .on('*', {
      element(el) {
        const tag = el.tagName.toLowerCase();
        if (SAN_DROP_TAGS.has(tag)) {
          el.remove(); // drop element AND its contents
          return;
        }
        if (!SAN_ALLOWED_TAGS.has(tag)) {
          el.removeAndKeepContent(); // unknown wrapper → unwrap, keep text
          return;
        }
        const allow = SAN_ATTR_ALLOW[tag];
        const globalAllow = SAN_ATTR_ALLOW['*'];
        const drop: string[] = [];
        for (const [name, value] of el.attributes) {
          const n = name.toLowerCase();
          if (!(globalAllow.has(n) || (allow && allow.has(n)))) {
            drop.push(name);
            continue;
          }
          if ((n === 'src' && tag === 'img') || (n === 'href' && tag === 'a')) {
            if (!sanUrlOk(value)) drop.push(name);
          }
        }
        for (const n of drop) el.removeAttribute(n);
      },
      comments(c) {
        c.remove();
      },
    });
  return rewriter.transform(new Response(html)).text();
}

// ── base64 (Workers: btoa on a binary string; chunked to avoid call-stack blowups on big PDFs) ─────
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Decode a base64 string to raw bytes (atob → Uint8Array). Inverse of bytesToBase64. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Phase 1: private-by-default sessions (guest privacy) ────────────────────────────────────────────
// A session is PRIVATE to the anonymous browser that created it until (Phase 2) a signed-in user publishes
// it. The creator is recognized by an httpOnly cookie holding a random token; the DO stores only its hash.
// These helpers are pure (Web Crypto is available in Workers AND node/vitest) so the gate is unit-testable.

/** Public, anyone-can-view sessions: the 4 pre-rendered hero samples on the marketing home (they're embedded
 *  in public iframes, so they MUST bypass the creator-cookie gate). `/s/demo` is NOT here — it mints a fresh
 *  UUID per hit, so it is created `visibility:'public'` at start instead (a static id list can't cover it).
 *  Keep in sync if the hero samples change. */
export const PUBLIC_SESSION_IDS = new Set<string>([
  'e78147bd-4c5d-4c78-bf72-35472c7ec7e8', // IEA clean-energy chart
  '8eda3b85-5383-465f-81b4-21c0fd8c7495', // World Inequality report
  '088a8170-2e0f-495e-8de7-2578695af3d6', // arXiv: Conditional GANs
  'd41ddd75-2f7f-45b8-a751-bf9deac4340b', // OECD Health at a Glance
]);

/** Hex SHA-256 of a string (Web Crypto). The DO stores sha256(token), never the raw token. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string compare (equal-length hex). Avoids leaking the match position via early-exit. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** A fresh creator capability token: 32 random bytes, base64url (URL/cookie-safe, no padding). */
export function newCreatorToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Read one cookie value from a Cookie header (returns undefined if absent). */
export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** The Set-Cookie value for a session's creator token: httpOnly + Secure + SameSite=Lax + host-only (NO
 *  Domain=) + Path scoped to just this session + 30d. The raw token rides in the cookie; only its hash is
 *  stored server-side. Path-scoping means the cookie is only sent to /s/<id>* — minimal exposure. */
export function sessionCookie(id: string, rawToken: string): string {
  return `wcag_sct=${rawToken}; HttpOnly; Secure; SameSite=Lax; Path=/s/${id}; Max-Age=2592000`;
}

// ── Content-origin frame capability ─────────────────────────────────────────────
// The document is rendered in an iframe served from a SEPARATE origin (content.example.com) so untrusted
// VLM HTML is isolated from the apex app. The chrome (on the apex/live origin) already proved the viewer is
// the creator via the wcag_sct cookie; it mints a short-lived, session-bound HMAC token and embeds it in the
// iframe URL (`?k=`). The content origin verifies the token, then sets its OWN host-only cookie (wcag_fct) so
// the streamed /events + /fig requests authenticate without the token in every URL. The HMAC key never leaves
// the worker; the token is a bearer capability scoped to one session id and time-boxed.

/** base64url HMAC-SHA256(key, msg) — Web Crypto (available in Workers AND node/vitest), so unit-testable. */
export async function hmacSha256(key: string, msg: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(msg));
  return bytesToBase64(new Uint8Array(sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mint a frame token `<expEpochMs>.<sig>` binding the session id + expiry under the signing key. */
export async function signFrameToken(sessionId: string, expEpochMs: number, key: string): Promise<string> {
  const sig = await hmacSha256(key, `${sessionId}.${expEpochMs}`);
  return `${expEpochMs}.${sig}`;
}

/** Verify a frame token: well-formed, unexpired (exp > now), and the signature matches THIS session id.
 *  Constant-time signature compare; any malformed/expired/tampered token is rejected. */
export async function verifyFrameToken(token: string, sessionId: string, key: string, nowMs: number): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const exp = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(exp) || exp < nowMs || !sig) return false;
  const expected = await hmacSha256(key, `${sessionId}.${exp}`);
  return sig.length === expected.length && timingSafeEqual(sig, expected);
}

/** Set-Cookie for the content origin's frame token: host-only (NO Domain=), Path-scoped to this session,
 *  HttpOnly + Secure + SameSite=Lax. content.example.com is SAME-SITE to example.com (shared eTLD+1), so a
 *  Lax cookie is still sent for the iframe's same-origin /events + /fig subrequests — no third-party-cookie
 *  blocking (which only targets cross-SITE). */
export function frameCookie(id: string, token: string, maxAgeSec = 3600): string {
  return `wcag_fct=${token}; HttpOnly; Secure; SameSite=Lax; Path=/s/${id}; Max-Age=${maxAgeSec}`;
}

/** A per-response CSP nonce (16 random bytes, base64url). The frame's inline <style>/<script> carry it; a
 *  sanitizer-bypass inline <script> (no nonce) is then blocked by the nonce-based CSP. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Hosts allowed to embed the content frame (our own chrome origins). Anyone else is refused by
 *  `frame-ancestors`, so a third-party site can't iframe a private document for clickjacking/exfil. */
// Allowed embedders of the sandboxed document iframe. Override per deployment (these are placeholders).
export const FRAME_ANCESTORS = 'https://app.example.com https://live.example.com';

/** Strict nonce-based CSP for the UNTRUSTED content origin. default-src 'none' denies everything not listed;
 *  only the nonce'd inline style/script run; images are same-origin/data/https; the SSE connects same-origin;
 *  the frame may only be embedded by our chrome. This is the security backstop behind the HTML sanitizer. */
export function frameCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}' https://fonts.googleapis.com`,
    'font-src https://fonts.gstatic.com',
    // 'self' (our own /s/:id/fig crops) + data: only. NOT https: — that would let untrusted VLM HTML beacon a
    // private viewer's request to an attacker-controlled image host. Our figures are always self-origin crops.
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${FRAME_ANCESTORS}`,
  ].join('; ');
}

/** CSP for the trusted CHROME page: it runs NO inline script (static shell), may only frame the content
 *  origin, and may itself only be framed by our own origins. Other directives left unset (permissive) so the
 *  logo/fonts keep loading without risk of breakage. */
export function chromeCsp(contentOrigin: string): string {
  return [
    "script-src 'none'",
    `frame-src ${contentOrigin}`,
    "frame-ancestors 'self'",
    "base-uri 'none'",
  ].join('; ');
}

/** ASCII-safe attachment filename for Content-Disposition (title is user-controlled → strip CR/LF/";/quotes
 *  and any path chars, length-cap; fall back to a fixed name). Prevents header injection. */
export function safeDownloadFilename(title: string, id: string): string {
  const base = (title || '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9 _.-]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return `${base || `a11y-document-${id.slice(0, 8)}`}.html`;
}

// ── snapshot bodies ───────────────────────────────────────────────────────────────────────────────
export function skeletonBlocks(n = 5): Block[] {
  return Array.from({ length: n }, (_v, i) => ({
    id: `block-${i + 1}`,
    html: `<section id="block-${i + 1}" class="a11y-skel" aria-hidden="true">&nbsp;</section>`,
  }));
}

/** VLM first-paint: a single placeholder removed as soon as the first real block streams in. */
export function loadingBlocks(): Block[] {
  return [{ id: 'a11y-load', html: '<p id="a11y-load" class="a11y-load">Reading the document…</p>' }];
}

export function renderBody(blocks: Block[]): string {
  return blocks.map((b) => b.html).join('\n      ');
}

// Generic, PDF-agnostic browser client: opens the SSE stream and renders streamed HTML (append/replace).
// EventSource auto-reconnects and resends Last-Event-ID, so the server replays missed events for free.
export const CLIENT_JS = [
  '(function(){',
  "  var doc=document.getElementById('a11y-doc');",
  "  var after=(doc&&doc.getAttribute('data-a11y-seq'))||'0';",
  // The document is now served at /s/:id/frame, so the events endpoint can't be derived by appending
  // '/events' to the path. The server renders the exact same-origin events path into data-a11y-events;
  // fall back to the legacy sibling-path derivation for the old same-page shell.
  "  var ep=(doc&&doc.getAttribute('data-a11y-events'))||(location.pathname.replace(/\\/$/,'')+'/events');",
  "  var src=ep+(ep.indexOf('?')<0?'?':'&')+'after='+after;",
  '  var es=new EventSource(src);',
  '  function frag(html){var t=document.createElement(\"template\");t.innerHTML=(html||\"\").trim();return t.content;}',
  '  function append(html){var ld=document.getElementById(\"a11y-load\");if(ld)ld.remove();if(doc)doc.appendChild(frag(html));}',
  '  function swap(target,html){var el=document.querySelector(target);if(!el)return;var n=frag(html).firstElementChild;if(n)el.replaceWith(n);}',
  "  var bar=document.getElementById('a11y-bar'),prog=8;",
  '  function bump(s){if(!bar)return;prog=Math.min(92,prog+(92-prog)*(s||0.14));bar.style.width=prog+\"%\";}',
  '  function finish(){if(trickle){clearInterval(trickle);trickle=null;}if(bar){bar.style.width=\"100%\";setTimeout(function(){bar.style.opacity=\"0\";},350);}}',
  '  var trickle=setInterval(function(){bump(0.04);},700);',
  "  es.addEventListener('append',function(e){var d=JSON.parse(e.data);append(d.html);bump();});",
  "  es.addEventListener('replace',function(e){var d=JSON.parse(e.data);swap(d.target,d.html);bump(0.05);});",
  "  es.addEventListener('progress',function(e){bump();});",
  "  es.addEventListener('done',function(){var p=document.getElementById('a11y-phase');if(p)p.textContent='Ready';finish();es.close();});",
  "  es.addEventListener('error',function(e){if(e&&e.data){try{var d=JSON.parse(e.data);append('<p class=\"a11y-err\" role=\"alert\">'+(d.message||'Something went wrong')+'</p>');finish();es.close();}catch(_){}}});",
  '})();',
].join('\n');

// Brand palette (surface + typography) inlined into the streamed shell, which can't import an external
// stylesheet. A vitest test (`BRAND palette`) checks every value is a valid hex color.
export const BRAND = {
  paper: '#FCFBF8', // surface.page
  raised: '#ffffff', // surface.raised
  sunk: '#F4F2EA', // surface.sunk
  ink: '#1A1A15', // surface.ink
  inkSoft: '#57544A', // surface.inkSoft
  inkMute: '#8C8779', // surface.inkMute
  line: '#E8E4D8', // surface.line
  accent: '#1F7A4C', // surface.accent / brand.iris
  accentText: '#175A38', // surface.accentText
  accentTint: '#E6F2EA', // surface.accentTint
  accentHover: '#19663F', // brand.irisHover
  dangerText: '#B72E49', // surface.dangerText
  dangerTint: '#FFF0F3', // surface.dangerTint
} as const;
// Dark-mode values (tokens.json darkHex). Emitted as CSS vars under a prefers-color-scheme query so the
// streamed viewer follows the OS light/dark theme. Pinned to tokens.json by the same parity test.
export const BRAND_DARK = {
  paper: '#121211', raised: '#1B1B19', sunk: '#0D0D0C',
  ink: '#F3F2EE', inkSoft: '#C5C3BC', inkMute: '#8B8880',
  line: 'rgba(243,242,238,0.12)', accent: '#5BB47E', accentText: '#A8E0BE',
  accentTint: 'rgba(91,180,126,0.16)', accentHover: '#6FC290',
  dangerText: '#FFB8C6', dangerTint: 'rgba(255,138,161,0.14)',
} as const;
const okVars = (b: Record<string, string>) =>
  `--ok-paper:${b.paper};--ok-raised:${b.raised};--ok-sunk:${b.sunk};--ok-ink:${b.ink};` +
  `--ok-ink-soft:${b.inkSoft};--ok-ink-mute:${b.inkMute};--ok-line:${b.line};--ok-accent:${b.accent};` +
  `--ok-accent-text:${b.accentText};--ok-accent-tint:${b.accentTint};--ok-accent-hover:${b.accentHover};` +
  `--ok-danger-text:${b.dangerText};--ok-danger-tint:${b.dangerTint}`;
// Light defaults + a dark override (follows OS theme). `color-scheme: light dark` adapts form controls/scrollbars.
// THEME_VARS is for the CHROME (outer reader frame) — it stays theme-aware.
const THEME_VARS = `:root{color-scheme:light dark;${okVars(BRAND)}}@media (prefers-color-scheme:dark){:root{${okVars(BRAND_DARK)}}}`;
// FRAME_VARS is for the embedded DOCUMENT — DETERMINISTIC light-only (no prefers-color-scheme). The twin is
// "paper": it must render identically regardless of the viewer's OS theme, so the document never flips to dark.
// (Dark mode lives in the chrome around it, like a white page inside a dark-themed PDF reader.)
const FRAME_VARS = `:root{color-scheme:light;${okVars(BRAND)}}`;
const WCAG_FONTS =
  '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Inter+Tight:wght@500;600;700&display=swap">';
const SANS = "'Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif";
const DISPLAY = "'Inter Tight','Inter',ui-sans-serif,system-ui,sans-serif";

export function liveDocClaimBridgeUrl(sessionId: string): string {
  return `/live-docs/${encodeURIComponent(sessionId)}/claim`;
}

// CHROME_CSS styles the OUTER reader frame (header + actions + the document iframe). Theme-aware (THEME_VARS),
// so the app shell follows OS dark/light — while the embedded document (FRAME_CSS) stays deterministically light.
const CHROME_CSS = `
  ${THEME_VARS}
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;display:flex;flex-direction:column;overflow:hidden;background:var(--ok-paper);color:var(--ok-ink);font:16px/1.65 ${SANS}}
  .a11y-skip{position:absolute;left:-999px;top:0;background:var(--ok-accent);color:#fff;padding:8px 12px;z-index:10;border-radius:0 0 6px 0}
  .a11y-skip:focus{left:8px;top:8px}
  header.a11y-top{flex:none;background:var(--ok-paper);border-bottom:1px solid var(--ok-line);padding:10px 18px;font:600 14px/1.2 ${SANS};display:flex;align-items:center;gap:9px}
  header.a11y-top img{height:22px;width:22px;border-radius:5px;display:block}
  header.a11y-top .a11y-actions{margin-left:auto;display:flex;align-items:center;gap:8px}
  .a11y-private{display:inline-flex;align-items:center;gap:5px;font:600 11.5px/1 ${SANS};color:var(--ok-ink-mute);white-space:nowrap}
  .a11y-act{display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 11px;border-radius:7px;font:600 12.5px/1 ${SANS};text-decoration:none;border:1px solid var(--ok-line);color:var(--ok-ink-soft);background:var(--ok-raised);white-space:nowrap}
  .a11y-act:hover{border-color:var(--ok-accent);color:var(--ok-accent-text)}
  .a11y-act-primary{background:var(--ok-accent);border-color:var(--ok-accent);color:#fff}
  .a11y-act-primary:hover{background:var(--ok-accent-hover);color:#fff}
  @media (max-width:560px){header.a11y-top .a11y-private{display:none}}
  /* The document pane: fills the viewport below the header and scrolls internally. Hardcoded paper bg (not the
     themeable var) so there's no dark flash before the deterministic-light frame paints. */
  .a11y-frame{flex:1 1 auto;min-height:0;width:100%;border:0;background:${BRAND.paper};display:block}
`;

// FRAME_CSS styles the EMBEDDED document (served from the content origin). Deterministic light-only (FRAME_VARS,
// no prefers-color-scheme) — the "paper" twin never flips with the OS theme. Carries the streaming UI (progress
// bar, skeleton, figure placeholder) since the SSE client now runs inside the frame.
const FRAME_CSS = `
  ${FRAME_VARS}
  *{box-sizing:border-box}
  body{margin:0;background:var(--ok-paper);color:var(--ok-ink);font:16px/1.65 ${SANS}}
  #a11y-bar-wrap{height:2px;background:var(--ok-line)}
  #a11y-bar{height:2px;width:8%;background:var(--ok-accent);transition:width .5s ease,opacity .4s ease}
  .a11y-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
  main{max-width:780px;margin:0 auto;padding:30px 24px 88px}
  main h1{font:700 30px/1.18 ${DISPLAY};color:var(--ok-ink);letter-spacing:-.02em;margin:20px 0 12px}
  main h2{font:600 21px/1.25 ${DISPLAY};color:var(--ok-ink);letter-spacing:-.01em;margin:26px 0 10px}
  main h3{font:600 17px/1.3 ${DISPLAY};color:var(--ok-ink);margin:20px 0 8px}
  main p{margin:0 0 13px}
  main a{color:var(--ok-accent-text)}
  main ul,main ol{margin:0 0 13px 22px}
  main table{border-collapse:collapse;margin:14px 0;width:100%;font-size:14px}
  main th,main td{border:1px solid var(--ok-line);padding:7px 11px;text-align:left;vertical-align:top}
  main thead th{background:var(--ok-sunk)}
  main caption{text-align:left;font-weight:600;margin-bottom:6px;color:var(--ok-ink-soft)}
  main figure{margin:16px 0}
  main figcaption{font:13px/1.45 ${SANS};color:var(--ok-ink-mute);margin-top:7px}
  main img{max-width:100%;height:auto;border-radius:6px}
  main code,main pre{font-family:'Source Code Pro',ui-monospace,monospace}
  footer.a11y-foot{border-top:1px solid var(--ok-line);padding:18px 24px;color:var(--ok-ink-mute);font:13px/1.5 ${SANS};text-align:center}
  footer.a11y-foot a{color:var(--ok-ink-mute)}
  /* mobile — wide tables scroll INSIDE a container (wrapTableBlock) instead of forcing page-level scroll;
     long tokens/URLs/code wrap or scroll locally. */
  main .a11y-table-scroll{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;margin:14px 0}
  main .a11y-table-scroll table{margin:0;width:max-content;min-width:100%}
  main p,main li,main dd,main th,main td,main figcaption,main a{overflow-wrap:anywhere}
  main pre{max-width:100%;overflow-x:auto;white-space:pre}
  main code{overflow-wrap:anywhere}
  main pre code{overflow-wrap:normal}
  /* a figure with a bbox but no image yet (its crop is rendering in the figure lane). */
  main figure[data-bbox]:not(:has(img)){min-height:120px;display:flex;align-items:center;justify-content:center;border:1px dashed var(--ok-line);border-radius:8px;color:var(--ok-ink-mute);font:13px ${SANS}}
  main figure[data-bbox]:not(:has(img)) figcaption{display:none}
  main figure[data-bbox]:not(:has(img))::before{content:"Rendering figure…"}
  .a11y-load{color:var(--ok-ink-mute);font-style:italic}
  .a11y-err{color:var(--ok-danger-text);background:var(--ok-danger-tint);border:1px solid var(--ok-line);border-radius:6px;padding:10px 12px;font:14px/1.5 ${SANS}}
  .a11y-skel{height:18px;margin:10px 0;border-radius:4px;background:linear-gradient(90deg,var(--ok-sunk),var(--ok-paper),var(--ok-sunk));background-size:200% 100%;animation:a11y-shimmer 1.4s linear infinite}
  @keyframes a11y-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
  @media (prefers-reduced-motion:reduce){.a11y-skel{animation:none}#a11y-bar{transition:none}}
`;

/** The OUTER reader chrome (apex/live origin): the WCAG Audit Agent header + creator action bar, embedding the document in a
 *  sandboxed iframe whose src is the content-origin frame. Theme-aware. The document content/streaming lives in
 *  the iframe (renderFrame) — the chrome is static (no inline script), so its CSP can be `script-src 'none'`. */
export function renderChrome(opts: {
  title: string;
  /** Full URL of the content-origin document frame, incl. any `?k=` capability token for a private session. */
  frameSrc: string;
  /** Phase 1 privacy: the action bar. `sessionId` enables the Download link; a private session whose viewer is
   *  the creator also gets the "Sign up to publish" CTA + a "Private" pill. Defaults keep old callers/tests
   *  (no sessionId) action-bar-free. */
  sessionId?: string;
  isCreator?: boolean;
  visibility?: 'private' | 'public';
  ownerUserId?: string;
}): string {
  const visibility = opts.visibility ?? 'public';
  // The action bar is CREATOR-ONLY: the guest who made the session gets Download (the no-account escape hatch)
  // + a private pill / publish CTA. Non-creators (incl. the public hero-sample preview iframes) stay clean.
  const creatorPrivate = Boolean(opts.isCreator) && visibility === 'private';
  const claimedPrivate = creatorPrivate && Boolean(opts.ownerUserId);
  const actions = opts.sessionId && opts.isCreator
    ? `<div class="a11y-actions">` +
        (creatorPrivate
          ? `<span class="a11y-private" title="${claimedPrivate ? 'Saved to your WCAG Audit Agent account.' : 'Only you can see this — until you publish it.'}">🔒 ${claimedPrivate ? 'Saved to account' : 'Private — only you'}</span>`
          : '') +
        `<a class="a11y-act" href="/s/${opts.sessionId}/download" download>Download HTML</a>` +
        (creatorPrivate && !claimedPrivate
          ? `<a class="a11y-act a11y-act-primary" href="${liveDocClaimBridgeUrl(opts.sessionId)}">Sign up to publish</a>`
          : '') +
      `</div>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${escapeHtml(opts.title)} · WCAG Audit Agent</title>
  ${WCAG_FONTS}
  <style>${CHROME_CSS}</style>
</head>
<body>
  <a class="a11y-skip" href="#a11y-frame">Skip to document</a>
  <header class="a11y-top">
    <span class="wm">WCAG Audit Agent</span>
    ${actions}
  </header>
  <iframe id="a11y-frame" class="a11y-frame" src="${escapeHtml(opts.frameSrc)}" title="Accessible document: ${escapeHtml(opts.title)}" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" loading="eager"></iframe>
</body>
</html>`;
}

/** The document-only page rendered INSIDE the content-origin iframe: deterministic light theme + the generic
 *  SSE streaming client. `eventsPath` is the URL (same-origin to the content frame) the client tails; `nonce`
 *  authorizes the inline <style>/<script> under the frame's strict nonce-based CSP. */
export function renderFrame(opts: {
  title: string;
  status: string;
  bodyHtml: string;
  seq?: number;
  nonce: string;
  eventsPath: string;
}): string {
  // No technical phase labels in the UI — the moving bar IS the indicator (like a real page load). Keep a
  // generic screen-reader cue only (this is an accessibility product); the streamed content is the real signal.
  const srLabel = opts.status === 'done' ? 'Ready' : 'Loading…';
  const seq = opts.seq ?? 0;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${escapeHtml(opts.title)}</title>
  ${WCAG_FONTS}
  <style nonce="${opts.nonce}">${FRAME_CSS}</style>
</head>
<body>
  <div id="a11y-bar-wrap"><div id="a11y-bar"></div></div>
  <span id="a11y-phase" class="a11y-sr" aria-live="polite">${escapeHtml(srLabel)}</span>
  <main id="a11y-doc" data-a11y-seq="${seq}" data-a11y-events="${escapeHtml(opts.eventsPath)}">
      ${opts.bodyHtml}
  </main>
  <footer class="a11y-foot">An accessible web page rendered from your PDF by <a href="https://example.com">WCAG Audit Agent</a>.</footer>
  <noscript><p style="max-width:780px;margin:0 auto;padding:0 24px;color:var(--ok-ink-mute)">Live updates need JavaScript. <a href="">Refresh</a> for the latest version.</p></noscript>
  <script nonce="${opts.nonce}">${CLIENT_JS}</script>
</body>
</html>`;
}

// Compact, self-contained content CSS for the downloadable static HTML (no streaming/skeleton/progress-bar
// rules, no figure "Rendering…" placeholder, no Google-Fonts link — a downloaded file must render offline).
const DOWNLOAD_CSS = `
  ${THEME_VARS}
  *{box-sizing:border-box}
  body{margin:0;background:var(--ok-paper);color:var(--ok-ink);font:16px/1.65 ${SANS}}
  main{max-width:780px;margin:0 auto;padding:40px 24px 64px}
  h1{font:700 30px/1.18 ${DISPLAY};letter-spacing:-.02em;margin:20px 0 12px}
  h2{font:600 21px/1.25 ${DISPLAY};letter-spacing:-.01em;margin:26px 0 10px}
  h3{font:600 17px/1.3 ${DISPLAY};margin:20px 0 8px}
  p{margin:0 0 13px}
  a{color:var(--ok-accent-text)}
  ul,ol{margin:0 0 13px 22px}
  table{border-collapse:collapse;margin:14px 0;width:100%;font-size:14px}
  th,td{border:1px solid var(--ok-line);padding:7px 11px;text-align:left;vertical-align:top}
  thead th{background:var(--ok-sunk)}
  caption{text-align:left;font-weight:600;margin-bottom:6px;color:var(--ok-ink-soft)}
  figure{margin:16px 0}
  figcaption{font:13px/1.45 ${SANS};color:var(--ok-ink-mute);margin-top:7px}
  img{max-width:100%;height:auto;border-radius:6px}
  pre{max-width:100%;overflow-x:auto;white-space:pre;font-family:ui-monospace,monospace}
  code{font-family:ui-monospace,monospace;overflow-wrap:anywhere}
  .a11y-table-scroll{max-width:100%;overflow-x:auto;margin:14px 0}
  .a11y-table-scroll table{margin:0;width:max-content;min-width:100%}
  p,li,dd,th,td,figcaption,a{overflow-wrap:anywhere}
  footer{border-top:1px solid var(--ok-line);max-width:780px;margin:0 auto;padding:18px 24px;color:var(--ok-ink-mute);font:13px/1.5 ${SANS}}
  footer a{color:var(--ok-ink-mute)}
`;

/** The downloadable accessible HTML: a static, self-contained snapshot (no live SSE client, no progress bar,
 *  no claim affordance). `bodyHtml` already has figure crops inlined as data: URIs by the caller (DO), so the
 *  file is portable offline. The guest's own accessibility artifact — no account required to download. */
export function renderDownloadHtml(opts: { title: string; bodyHtml: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(opts.title)}</title>
<style>${DOWNLOAD_CSS}</style>
</head>
<body>
  <main>
      ${opts.bodyHtml}
  </main>
  <footer>Rendered from a PDF by <a href="https://example.com">WCAG Audit Agent</a>.</footer>
</body>
</html>`;
}

/** Branded 403 for a private session viewed without the creator cookie (or with a stale/mismatched one). */
export function renderPrivateNotice(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Private document · WCAG Audit Agent</title>
${WCAG_FONTS}
<style>
  ${THEME_VARS}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;background:var(--ok-paper);color:var(--ok-ink);font:16px/1.6 ${SANS};display:flex;flex-direction:column}
  header{padding:14px 20px;border-bottom:1px solid var(--ok-line);display:flex;align-items:center;gap:9px}
  header img{height:24px;width:24px;border-radius:6px;display:block}
  main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:48px 24px;max-width:560px;margin:0 auto}
  .lk{font-size:34px;margin-bottom:6px}
  h1{font:700 26px/1.2 ${DISPLAY};letter-spacing:-.02em;margin:0 0 10px;color:var(--ok-ink)}
  p{color:var(--ok-ink-mute);margin:0 0 22px;max-width:42ch}
  .btn{display:inline-flex;align-items:center;gap:6px;height:44px;padding:0 18px;border-radius:8px;background:var(--ok-accent);color:#fff;font:600 15px/1 ${SANS};text-decoration:none}
  .btn:hover{background:var(--ok-accent-hover)}
</style>
</head>
<body>
  <header><span class="wm">WCAG Audit Agent</span></header>
  <main>
    <div class="lk" aria-hidden="true">🔒</div>
    <h1>This document is private</h1>
    <p>Only the person who created it can view it. If that's you, open it in the same browser you uploaded it from.</p>
    <a class="btn" href="https://example.com/s">Turn your own PDF into a page →</a>
  </main>
</body>
</html>`;
}

// ── VLM engine config ─────────────────────────────────────────────────────────────────────────────
// gemini-3-flash-preview @ thinkingLevel=low → ~1.4s time-to-first-token, native PDF input, streams HTML.
export const GEMINI_MODEL = 'gemini-3-flash-preview';
export const VLM_PROMPT =
  'Convert this PDF into a clean, semantic HTML web page. Output ONLY HTML block elements ' +
  '(<h1>,<h2>,<h3>,<p>,<ul>,<ol>,<table> with <thead>/<tbody>/<th scope>, <figure>) in natural reading ' +
  'order. No <html>/<head>/<body> wrapper, no markdown code fences, no page headers/footers/page-numbers. ' +
  'Faithfully preserve headings, lists, and tables. ' +
  // figures: emit page + bbox so a separate lane can crop the region into an <img>. The bbox is
  // Gemini-native order/space: four integers 0–1000 normalized to the page as ymin,xmin,ymax,xmax. Keep
  // every block TOP-LEVEL (no <div> wrappers, no nesting) so the stream splitter paints blocks as they land.
  'For every chart, graph, diagram, map, photo or other figure, emit a top-level ' +
  '<figure data-page="P" data-bbox="ymin,xmin,ymax,xmax"> whose <figcaption> describes the figure in one ' +
  'informative sentence usable as alt text. P is the 1-based page number; ymin,xmin,ymax,xmax are four ' +
  'integers 0–1000 normalized to the page (Gemini bbox order). If a chart has underlying data, ALSO emit ' +
  'the data as a following <table>. Do NOT wrap blocks in <div> and do NOT nest figures. ' +
  'Start immediately with the first block.';

// ── Landing page ──────────────────────────────────────────────────────────────────────────────────
// Drop a PDF or paste a URL → POST /s (multipart) → 303 /s/:id. Works with no JS (native form submit
// follows the 303); JS adds drag-drop + auto-submit-on-pick + an "Uploading…" state.
export const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WCAG Audit Agent — turn any PDF into a readable web page</title>
${WCAG_FONTS}
<style>
  ${THEME_VARS}
  *{box-sizing:border-box}
  body{margin:0;background:var(--ok-paper);color:var(--ok-ink);font:16px/1.6 ${SANS};display:flex;min-height:100vh;flex-direction:column}
  header{padding:14px 20px;border-bottom:1px solid var(--ok-line);display:flex;align-items:center;gap:9px}
  header img{height:24px;width:24px;border-radius:6px;display:block}
  header .wm{font-weight:700;letter-spacing:-.01em}
  main{flex:1;width:100%;max-width:640px;margin:0 auto;padding:56px 24px}
  h1{font:700 clamp(28px,5vw,40px)/1.1 ${DISPLAY};letter-spacing:-.02em;margin:0 0 12px;color:var(--ok-ink)}
  .sub{color:var(--ok-ink-mute);font-size:18px;margin:0 0 32px}
  form{margin:0}
  .drop{border:2px dashed var(--ok-line);border-radius:14px;padding:40px 24px;text-align:center;background:var(--ok-raised);transition:border-color .2s,background .2s;cursor:pointer}
  .drop.on{border-color:var(--ok-accent);background:var(--ok-accent-tint)}
  .ico{font-size:28px;color:var(--ok-ink-mute);margin-bottom:10px}
  .btn{appearance:none;border:0;border-radius:8px;background:var(--ok-accent);color:#fff;font:600 15px/1 ${SANS};padding:12px 20px;min-height:44px;cursor:pointer}
  .btn:hover{background:var(--ok-accent-hover)}
  .muted{color:var(--ok-ink-mute);font-size:14px;margin:10px 0 0}
  .orrow{display:flex;align-items:center;gap:12px;color:var(--ok-ink-mute);font-size:13px;margin:22px 0}
  .orrow:before,.orrow:after{content:"";height:1px;background:var(--ok-line);flex:1}
  .urlrow{display:flex;gap:10px}
  .inp{flex:1;border:1px solid var(--ok-line);border-radius:8px;padding:12px 14px;min-height:44px;background:var(--ok-raised);color:var(--ok-ink);font:15px/1.2 ${SANS}}
  .inp:focus{outline:2px solid var(--ok-accent);outline-offset:0;border-color:var(--ok-accent)}
  .ex{margin-top:32px;color:var(--ok-ink-mute);font-size:13px}
  .ex a{color:var(--ok-accent-text)}
</style>
</head>
<body>
  <header><span class="wm">WCAG Audit Agent</span></header>
  <main>
    <h1>Turn any PDF into a readable web page</h1>
    <p class="sub">Drop a PDF or paste a public URL — it streams in as a clean, accessible HTML page, figures and all.</p>
    <form id="f" method="POST" action="/s" enctype="multipart/form-data">
      <div id="drop" class="drop">
        <input id="file" type="file" name="file" accept="application/pdf,.pdf" hidden>
        <div class="ico" aria-hidden="true">⬆</div>
        <button type="button" id="pick" class="btn">Upload a PDF</button>
        <p class="muted">or drag &amp; drop a PDF here, up to 50 pages</p>
      </div>
      <div class="orrow"><span>or paste a PDF URL</span></div>
      <div class="urlrow">
        <input type="url" name="url" id="url" class="inp" placeholder="https://arxiv.org/pdf/1411.1784">
        <button type="submit" class="btn">Open</button>
      </div>
      <p id="status" class="muted" aria-live="polite"></p>
    </form>
    <p class="ex">Or <a href="/s/demo">watch a demo load</a>.</p>
  </main>
  <script>
  (function(){
    var f=document.getElementById('f'),file=document.getElementById('file'),pick=document.getElementById('pick'),
        drop=document.getElementById('drop'),status=document.getElementById('status'),url=document.getElementById('url');
    function go(fd){status.textContent='Uploading…';fetch('/s',{method:'POST',body:fd}).then(function(r){if(!r.ok){return r.json().catch(function(){return{};}).then(function(b){throw new Error(typeof b.error==='string'?b.error:'Upload failed ('+r.status+')');});}location.href=r.url;}).catch(function(e){status.textContent=e&&e.message?e.message:'Something went wrong — try again.';});}
    pick.addEventListener('click',function(){file.click();});
    drop.addEventListener('click',function(e){if(e.target===drop||e.target.className==='ico')file.click();});
    file.addEventListener('change',function(){if(file.files&&file.files[0]){var fd=new FormData();fd.append('file',file.files[0]);go(fd);}});
    ['dragover','dragenter'].forEach(function(ev){drop.addEventListener(ev,function(e){e.preventDefault();drop.classList.add('on');});});
    ['dragleave','dragend','drop'].forEach(function(ev){drop.addEventListener(ev,function(e){e.preventDefault();drop.classList.remove('on');});});
    drop.addEventListener('drop',function(e){var dt=e.dataTransfer;if(dt&&dt.files&&dt.files[0]){var fd=new FormData();fd.append('file',dt.files[0]);go(fd);}});
    f.addEventListener('submit',function(e){if(file.files&&file.files[0])return;var u=url.value.trim();if(!u)return;e.preventDefault();var fd=new FormData();fd.append('url',u);go(fd);});
  })();
  </script>
</body>
</html>`;

/** Slice-1 demo phase runner (no PDF): a fixed script played one step per tick. Kept for /sessions/new. */
export function demoScript(): Array<Omit<LiveEvent, 'seq'>> {
  return [
    { type: 'progress', phase: 'Reading' },
    { type: 'replace', target: '#block-1', html: '<h1 id="block-1">Sample Document Title</h1>' },
    { type: 'replace', target: '#block-2', html: '<p id="block-2">This block arrived first as native text — the page is readable before structure lands.</p>' },
    { type: 'progress', phase: 'Structuring' },
    { type: 'replace', target: '#block-3', html: '<h2 id="block-3">Section heading (upgraded in place from plain text)</h2>' },
    { type: 'replace', target: '#block-4', html: '<table id="block-4"><caption>Quarterly figures</caption><thead><tr><th scope="col">Quarter</th><th scope="col">Value</th></tr></thead><tbody><tr><th scope="row">Q1</th><td>100</td></tr><tr><th scope="row">Q2</th><td>140</td></tr></tbody></table>' },
    { type: 'progress', phase: 'Done' },
    { type: 'done' },
  ];
}
