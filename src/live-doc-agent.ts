// LiveDocAgent: per-session Durable Object owning a durable, append-only event log, the
// materialized HTML snapshot, and phase status. Parse does NOT run inside the stream handler: the SSE
// handler only tails + replays; the VLM parse runs under ctx.waitUntil (mostly network wait, low CPU),
// appending `append` events as the VLM streams HTML. The browser client (CLIENT_JS) is generic + PDF-agnostic.
import { DurableObject } from 'cloudflare:workers';
import {
  type Block,
  type LiveEvent,
  type FigureRef,
  applyAppend,
  applyReplace,
  base64ToBytes,
  bytesToBase64,
  demoScript,
  encodeSse,
  ensureBlockId,
  filterAfter,
  loadingBlocks,
  parseAfter,
  parseFigureRef,
  sanitizeHtml,
  wrapTableBlock,
  renderBody,
  renderChrome,
  renderFrame,
  renderDownloadHtml,
  renderPrivateNotice,
  safeDownloadFilename,
  skeletonBlocks,
  PUBLIC_SESSION_IDS,
  readCookie,
  sha256Hex,
  timingSafeEqual,
  signFrameToken,
  verifyFrameToken,
  frameCookie,
  newNonce,
  frameCsp,
  chromeCsp,
} from './live-doc-core';
import { streamGeminiHtml } from './gemini-parse';
import { checkLiveGuestPageLimit } from './live-doc-limits';
import { assertUrlIngestAllowed } from './source-policy';

interface LiveEnv {
  GEMINI_API_KEY: string;
  LIVE_DOC_CLAIM_SECRET?: string;
  // Hardening — HMAC key for content-origin frame capability tokens (the chrome→content handoff for
  // private sessions). A wrangler SECRET; if unset, private documents fall back to NOT embedding the frame
  // cross-origin (the gate refuses to mint/verify a token), so it must be set in prod.
  FRAME_SIGN_KEY?: string;
  // Origin that serves the sandboxed document iframe. Defaults to https://content.example.com; overridable
  // for preview/workers.dev environments.
  CONTENT_ORIGIN?: string;
  // Figure-image lane (separate workflow so the text stream is never blocked).
  FIGURE_IMAGE_WORKFLOW: Workflow;
  // PDF stashed here so the figure-image workflow can render crops from this worker's own rasterizer.
  LIVE_PDF_BUCKET: R2Bucket;
}

/** The content origin (untrusted document iframe). Trailing slash trimmed. */
const DEFAULT_CONTENT_ORIGIN = 'https://content.example.com';

type Source =
  | { kind: 'demo' }
  | { kind: 'bytes'; bytes: string }
  | { kind: 'url'; url: string };

interface LiveMeta {
  sessionId: string;
  title: string;
  status: 'idle' | 'running' | 'done' | 'error';
  seq: number;
  step: number;
  createdAt: number;
  phase?: string;
  // Phase 1 privacy. `visibility` defaults to 'private' (guest-only) when absent; `creatorTokenHash` is
  // sha256(rawCookieToken) — set at create for guest sessions, absent for demo/public.
  //   • 'private'  — guest-only: readable solely by the creator cookie; 403 to everyone else.
  //   • 'public'   — durable public sample (hero/demo ids): readable by anyone, edge-cacheable mirror.
  //   • 'unlisted' — capability-URL twin (the MCP `view_html` path): readable by anyone holding the
  //     unguessable /s/:id, but `no-store` + noindex + never edge-cached + no publish affordance. It is the
  //     favored-purpose accessibility view rendered to the requester — ephemeral, NOT a public mirror (see
  //     source-policy.ts). This is what keeps the MCP twin rights-clean.
  visibility?: 'private' | 'public' | 'unlisted';
  creatorTokenHash?: string;
  ownerUserId?: string;
  claimedAt?: number;
}

const MAX_LOG = 2000; // cap the durable log so reconnect/storage stays bounded.
const LIVE_MAX_BYTES = 20 * 1024 * 1024; // hard cap on PDF size (upload + URL fetch) — abuse bound.
const DOWNLOAD_INLINE_CAP = 8 * 1024 * 1024; // cap total figure-crop bytes inlined into a downloaded file.
// Content-origin frame capability token lifetimes. The chrome→frame handoff (?k) is short-lived (exchanged
// immediately for the cookie); the cookie/stream token covers the full stream + EventSource reconnects.
const FRAME_TOKEN_TTL_MS = 2 * 60 * 1000;
const FRAME_COOKIE_TTL_MS = 60 * 60 * 1000;

/** Read a response body with a hard byte cap, aborting the stream once exceeded. Returns null if too big.
 *  Streaming (not buffer-then-check) so a chunked / no-Content-Length body can't force unbounded work. */
async function readCapped(resp: Response, max: number): Promise<Uint8Array | null> {
  const reader = resp.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  'x-accel-buffering': 'no',
  // No `access-control-allow-origin: *` — every EventSource consumer is SAME-ORIGIN (the content frame tails
  // content.example.com/s/:id/events; the legacy apex shell tails its own origin). A wildcard would make a
  // private stream cross-origin-readable if its URL ever leaked. (Server-side benchmark taps aren't browsers.)
};

interface Subscriber {
  controller: ReadableStreamDefaultController<Uint8Array>;
  lastSent: number;
}

export class LiveDocAgent extends DurableObject<LiveEnv> {
  private subs = new Set<Subscriber>();

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === '/start' && req.method === 'POST') return this.start(req);
    if (path === '/shell') return this.shell(req);
    if (path === '/events') return this.events(req, 'creator');
    if (path === '/claim' && req.method === 'POST') return this.claim(req);
    if (path === '/download') return this.download(req);
    if (path === '/figure-ready' && req.method === 'POST') return this.figureReady(req);
    const figM = path.match(/^\/fig\/([A-Za-z0-9._-]+\.png)$/);
    if (figM && req.method === 'GET') return this.figure(req, figM[1], 'creator');
    // Content-origin (content.example.com) routes — the index.ts router maps them to the `/c/*` internal
    // paths after authenticating the origin, so the DO can tell content-origin requests (frame-token gate)
    // apart from chrome-origin ones (creator-cookie gate). The client can't reach these directly.
    if (path === '/c/frame') return this.frame(req);
    if (path === '/c/events') return this.events(req, 'content');
    const cFigM = path.match(/^\/c\/fig\/([A-Za-z0-9._-]+\.png)$/);
    if (cFigM && req.method === 'GET') return this.figure(req, cFigM[1], 'content');
    return new Response('not found', { status: 404 });
  }

  /**
   * Phase 1 access gate. A read is allowed iff the session is public (explicit `visibility:'public'`, or one
   * of the seeded hero sample ids), `unlisted` (capability-URL: anyone holding the unguessable id may read),
   * OR the request carries the creator cookie whose hash matches. `isCreator` is tracked separately so the
   * shell can show the creator-only "publish" affordance. Constant-time compare; the raw token is never
   * stored or logged. NOTE: `isPublic` stays strictly `visibility:'public'` (+ hero ids) — `unlisted` is
   * allowed-to-read but is NOT public, so it inherits the private cache posture (`no-store`, never a mirror).
   */
  private async gate(req: Request): Promise<{
    allowed: boolean;
    isCreator: boolean;
    /** Effective publicness: explicit visibility:'public' OR a seeded hero sample id. Drives cache headers
     *  (public → cacheable; unlisted/private → no-store) and the shell's private/publish affordances. */
    isPublic: boolean;
    meta: LiveMeta | undefined;
  }> {
    const meta = await this.getMeta();
    const isPublic = meta?.visibility === 'public' || (!!meta && PUBLIC_SESSION_IDS.has(meta.sessionId));
    const isUnlisted = meta?.visibility === 'unlisted';
    let isCreator = false;
    if (meta?.creatorTokenHash) {
      const token = readCookie(req.headers.get('cookie'), 'wcag_sct');
      if (token) isCreator = timingSafeEqual(await sha256Hex(token), meta.creatorTokenHash);
    }
    return { allowed: isPublic || isUnlisted || isCreator, isCreator, isPublic, meta };
  }

  /** The content origin that serves the document iframe (trailing slash trimmed). */
  private contentOrigin(): string {
    return (this.env.CONTENT_ORIGIN || DEFAULT_CONTENT_ORIGIN).replace(/\/+$/, '');
  }

  /**
   * Content-origin access gate (the untrusted document iframe). Public sessions are open. A private session is
   * allowed ONLY with a valid frame capability token: the `wcag_fct` cookie (set on the content origin) or, on
   * the first frame load, a `?k=` token the chrome minted AFTER it verified the creator's `wcag_sct` cookie.
   * The creator cookie itself is host-only to the chrome origin and is never sent here, so it can't be used —
   * isolation is preserved. Returns `setCookieToken` to (re)issue the cookie when authorized via `?k`.
   */
  private async gateContent(req: Request, opts: { allowK: boolean }): Promise<{
    allowed: boolean;
    isPublic: boolean;
    meta: LiveMeta | undefined;
    setCookieToken?: string;
  }> {
    const meta = await this.getMeta();
    const isPublic = meta?.visibility === 'public' || (!!meta && PUBLIC_SESSION_IDS.has(meta.sessionId));
    if (isPublic) return { allowed: true, isPublic: true, meta };
    const key = this.env.FRAME_SIGN_KEY;
    if (!meta || !key) return { allowed: false, isPublic: false, meta };
    const id = meta.sessionId;
    const now = Date.now();
    const cookieTok = readCookie(req.headers.get('cookie'), 'wcag_fct');
    if (cookieTok && (await verifyFrameToken(cookieTok, id, key, now))) {
      return { allowed: true, isPublic: false, meta };
    }
    if (opts.allowK) {
      const k = new URL(req.url).searchParams.get('k') || '';
      if (k && (await verifyFrameToken(k, id, key, now))) {
        // Re-issue a fresh, longer-lived cookie token so subsequent /events + /fig authenticate without ?k.
        const fresh = await signFrameToken(id, now + FRAME_COOKIE_TTL_MS, key);
        return { allowed: true, isPublic: false, meta, setCookieToken: fresh };
      }
    }
    return { allowed: false, isPublic: false, meta };
  }

  private async getMeta(): Promise<LiveMeta | undefined> {
    return this.ctx.storage.get<LiveMeta>('meta');
  }

  /** Snapshot {seq, blocks} is written atomically (one put) so shell() reads a consistent pair: the
   *  embedded resume seq always matches the rendered body, preventing append-replay duplicates. */
  private async getSnap(): Promise<{ seq: number; blocks: Block[] }> {
    return (await this.ctx.storage.get<{ seq: number; blocks: Block[] }>('snap')) ?? { seq: 0, blocks: [] };
  }

  private json(body: unknown, status = 200): Response {
    return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
  }

  private validClaimSecret(req: Request): boolean {
    const expected = this.env.LIVE_DOC_CLAIM_SECRET;
    const provided = req.headers.get('x-wcag-live-claim-secret');
    return Boolean(expected && provided && timingSafeEqual(provided, expected));
  }

  private claimUserId(req: Request): string | null {
    const userId = req.headers.get('x-wcag-authenticated-user')?.trim() || '';
    return /^user_[A-Za-z0-9_-]{1,150}$/.test(userId) ? userId : null;
  }

  /** Attach a private guest-created session to a verified Clerk user. This does NOT publish the document:
   *  visibility stays private, and the original creator cookie is still required to prove possession. */
  private async claim(req: Request): Promise<Response> {
    if (!this.env.LIVE_DOC_CLAIM_SECRET) {
      return this.json({ ok: false, error: 'live_doc_claim_not_configured' }, 503);
    }
    if (!this.validClaimSecret(req)) {
      return this.json({ ok: false, error: 'invalid_claim_secret' }, 401);
    }
    const userId = this.claimUserId(req);
    if (!userId) return this.json({ ok: false, error: 'clerk_user_required' }, 401);

    const { allowed, isCreator, meta } = await this.gate(req);
    if (!meta) return this.json({ ok: false, error: 'not_found' }, 404);
    if (!allowed || !isCreator) return this.json({ ok: false, error: 'creator_cookie_required' }, 403);
    if (meta.ownerUserId && meta.ownerUserId !== userId) {
      return this.json({ ok: false, error: 'already_claimed' }, 409);
    }

    meta.ownerUserId = userId;
    meta.claimedAt = meta.claimedAt ?? Date.now();
    await this.ctx.storage.put('meta', meta);
    return this.json({
      ok: true,
      sessionId: meta.sessionId,
      ownerUserId: meta.ownerUserId,
      visibility: meta.visibility ?? 'private',
    });
  }

  /** Create the session and kick the producer (demo via alarm, real parse via waitUntil). */
  private async start(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as {
      sessionId?: string;
      title?: string;
      source?: Source;
      visibility?: 'private' | 'public' | 'unlisted';
      creatorTokenHash?: string;
    };
    const source: Source = body.source ?? { kind: 'demo' };
    const meta: LiveMeta = {
      sessionId: String(body.sessionId || 'unknown'),
      title: String(body.title || 'Untitled document'),
      status: 'running',
      seq: 0,
      step: 0,
      createdAt: Date.now(),
      phase: 'Starting',
      // Guest sessions are private + carry a creator-token hash; demo/sample creates pass visibility:'public';
      // the MCP view_html path passes 'unlisted' (ephemeral capability-URL twin, never an edge-cached mirror).
      visibility: body.visibility === 'public' ? 'public' : body.visibility === 'unlisted' ? 'unlisted' : 'private',
      creatorTokenHash: typeof body.creatorTokenHash === 'string' ? body.creatorTokenHash : undefined,
    };
    await this.ctx.storage.put('meta', meta);

    if (source.kind === 'demo') {
      await this.ctx.storage.put('snap', { seq: 0, blocks: skeletonBlocks(5) });
      await this.ctx.storage.setAlarm(Date.now() + 300);
    } else {
      await this.ctx.storage.put('snap', { seq: 0, blocks: loadingBlocks() });
      // Record how to re-fetch the PDF for the figure-image lane. URLs are cheap to keep; for
      // uploaded bytes we only mark the kind (the real crop path stashes bytes in R2 at upload time;
      // the scaffold crops with a stub).
      await this.ctx.storage.put('pdfRef', source.kind === 'url' ? { kind: 'url', url: source.url } : { kind: 'bytes' });
      // Run the VLM parse after responding; waitUntil keeps the DO alive for the streamed call.
      this.ctx.waitUntil(this.runVlm(source));
    }
    return Response.json({ ok: true, sessionId: meta.sessionId });
  }

  /** Demo producer (no PDF): play demoScript() one step per alarm tick. */
  async alarm(): Promise<void> {
    let meta = await this.getMeta();
    if (!meta || meta.status !== 'running') return;
    const script = demoScript();
    if (meta.step >= script.length) {
      meta.status = 'done';
      await this.ctx.storage.put('meta', meta);
      return;
    }
    const partial = script[meta.step];
    await this.appendEvent(partial); // bumps seq + persists meta
    meta = (await this.getMeta())!; // re-read after appendEvent to avoid clobbering seq
    meta.step += 1;
    if (partial.type === 'done') meta.status = 'done';
    await this.ctx.storage.put('meta', meta);
    if (partial.type !== 'done') await this.ctx.storage.setAlarm(Date.now() + 650);
  }

  /** Real producer: VLM streams PDF→HTML; emit each complete block as it lands. */
  private async runVlm(source: Source): Promise<void> {
    try {
      await this.appendEvent({ type: 'progress', phase: 'Reading' });
      let pdfBytes: Uint8Array;
      if (source.kind === 'url') {
        const gate = assertUrlIngestAllowed(source.url);
        if (!gate.ok) {
          await this.appendEvent({ type: 'error', message: gate.reason });
          return this.finish('error');
        }
        const resp = await fetch(source.url, { headers: { 'user-agent': 'wcag-audit-agent/1.0 (+app.example.com)', accept: 'application/pdf,*/*' } });
        if (!resp.ok) {
          await this.appendEvent({ type: 'error', message: `Couldn't fetch the PDF (HTTP ${resp.status}).` });
          return this.finish('error');
        }
        const ct = resp.headers.get('content-type') || '';
        // Reject early on a declared oversize, then stream with a hard cap so a chunked / missing
        // Content-Length body can't force unbounded network+memory before rejection.
        if (Number(resp.headers.get('content-length') || '0') > LIVE_MAX_BYTES) {
          await this.appendEvent({ type: 'error', message: `PDF too large (max ${LIVE_MAX_BYTES} bytes).` });
          return this.finish('error');
        }
        const capped = await readCapped(resp, LIVE_MAX_BYTES);
        if (!capped) {
          await this.appendEvent({ type: 'error', message: `PDF too large (max ${LIVE_MAX_BYTES} bytes).` });
          return this.finish('error');
        }
        if (!/pdf/i.test(ct) && capped.subarray(0, 5).join(',') !== '37,80,68,70,45') {
          await this.appendEvent({ type: 'error', message: 'That URL did not return a PDF.' });
          return this.finish('error');
        }
        pdfBytes = capped;
      } else if (source.kind === 'bytes') {
        pdfBytes = base64ToBytes(source.bytes);
      } else {
        return this.finish('error');
      }
      const pageLimit = await checkLiveGuestPageLimit(pdfBytes);
      if (!pageLimit.ok) {
        await this.appendEvent({ type: 'error', message: pageLimit.message });
        return this.finish('error');
      }
      const bytesB64 = source.kind === 'bytes' ? source.bytes : bytesToBase64(pdfBytes);

      await this.appendEvent({ type: 'progress', phase: 'Parsing' });
      // Collect figures as they stream so we can hand them to the figure-image lane after the text lands.
      const figures: FigureRef[] = [];
      await streamGeminiHtml({
        bytesB64,
        apiKey: this.env.GEMINI_API_KEY,
        onBlock: async (raw) => {
          // The VLM read an UNTRUSTED PDF — sanitize every block before it's stored/broadcast/rendered.
          const clean = await sanitizeHtml(raw);
          // Wrap wide tables in a scroll container so they don't force page-level side-scroll on mobile.
          const html = wrapTableBlock(clean);
          const id = await this.appendEvent({ type: 'append', html });
          const fig = parseFigureRef(clean, id);
          if (fig) figures.push(fig);
        },
      });
      // The text page is fully rendered. If there are figures, DON'T signal `done` yet (the client closes
      // the stream on `done`): kick the separate figure lane and let each crop arrive as a `replace`. The
      // workflow posts /figure-ready for EVERY figure (success or fail), draining pendingFigures → finish.
      const sessionId = (await this.getMeta())?.sessionId ?? '';
      if (figures.length && sessionId) {
        // Stash the PDF so the figure lane can render crops from this worker's rasterizer; the workflow
        // deletes it when done. Only written when there ARE figures → no orphan objects.
        const r2Key = `s/${sessionId}.pdf`;
        await this.env.LIVE_PDF_BUCKET.put(r2Key, pdfBytes);
        await this.ctx.storage.put('figures', figures);
        await this.ctx.storage.put('pendingFigures', figures.length);
        await this.appendEvent({ type: 'progress', phase: 'Rendering figures' });
        try {
          await this.env.FIGURE_IMAGE_WORKFLOW.create({ params: { sessionId, r2Key, figures } });
        } catch {
          // dispatch failed → don't hang on "Rendering figures"; clean up the stashed PDF (the workflow
          // that would have deleted it never started) and complete with placeholders in place.
          await this.env.LIVE_PDF_BUCKET.delete(r2Key).catch(() => {});
          await this.finish('done');
        }
      } else {
        await this.finish('done');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.appendEvent({ type: 'error', message: `Parse failed: ${msg.slice(0, 240)}` });
      await this.finish('error');
    }
  }

  /**
   * Append one durable event, update the snapshot, fan out to live subscribers. Manages seq itself.
   * For `append`, injects a STABLE top-level id (`blk-<seq>`) into the html and keys the snapshot block
   * off the SAME id, so a later `replace` (e.g. a figure crop) lands in both the live DOM and the snapshot
   * (fixes an earlier bug where the old `auto-<seq>` snapshot id never matched any id in the html). Returns the
   * appended block's id (empty string for non-append events).
   */
  private async appendEvent(partial: Omit<LiveEvent, 'seq'>): Promise<string> {
    const meta = await this.getMeta();
    if (!meta) return '';
    meta.seq += 1;
    const ev: LiveEvent = { ...partial, seq: meta.seq };
    let appendedId = '';
    if (ev.type === 'append' && ev.html) {
      const assigned = ensureBlockId(ev.html, `blk-${meta.seq}`);
      appendedId = assigned.id;
      ev.html = assigned.html; // persist + broadcast the id-bearing html so a later replace can target it
    }
    await this.ctx.storage.put(`evt:${String(meta.seq).padStart(6, '0')}`, ev);
    let blocks = (await this.getSnap()).blocks;
    if (ev.type === 'replace' && ev.target && ev.html) blocks = applyReplace(blocks, ev.target, ev.html);
    else if (ev.type === 'append' && ev.html) blocks = applyAppend(blocks, appendedId, ev.html);
    // Atomic snapshot: seq and blocks always agree, so the shell's embedded resume point is consistent.
    await this.ctx.storage.put('snap', { seq: meta.seq, blocks });
    if (partial.type === 'progress' && partial.phase) meta.phase = partial.phase;
    await this.ctx.storage.put('meta', meta);
    await this.trimLog(meta.seq);
    this.broadcast(ev);
    return appendedId;
  }

  /**
   * The figure-image lane posts one resolved crop here per figure. We emit it as a generic
   * `replace` (the frontend stays a dumb SSE HTML facade) and drain pendingFigures; when the last figure
   * lands we finally signal `done`. The workflow guarantees one call per figure, so the counter always
   * reaches zero even if some crops fail (those post a caption-only fallback or are simply skipped).
   */
  private async figureReady(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as { figureId?: string; html?: string };
    if (!body.figureId || !body.html) return Response.json({ ok: false }, { status: 400 });
    // Idempotent per figureId: a workflow step retry / duplicate POST must NOT double-decrement the
    // counter (which would finish the stream early and strand later figures).
    const done = (await this.ctx.storage.get<string[]>('figuresDone')) ?? [];
    if (done.includes(body.figureId)) {
      return Response.json({ ok: true, duplicate: true });
    }
    await this.appendEvent({ type: 'replace', target: `#${body.figureId}`, html: body.html });
    done.push(body.figureId);
    await this.ctx.storage.put('figuresDone', done);
    const remaining = Math.max(0, ((await this.ctx.storage.get<number>('pendingFigures')) ?? 1) - 1);
    await this.ctx.storage.put('pendingFigures', remaining);
    if (remaining === 0) await this.finish('done');
    return Response.json({ ok: true, remaining });
  }

  private async finish(status: 'done' | 'error'): Promise<void> {
    const meta = await this.getMeta();
    if (meta) {
      meta.status = status;
      await this.ctx.storage.put('meta', meta);
    }
    await this.appendEvent({ type: 'done' }); // terminal signal so clients stop
    for (const s of this.subs) {
      try {
        s.controller.close();
      } catch {
        /* already closed */
      }
    }
    this.subs.clear();
  }

  private async trimLog(seq: number): Promise<void> {
    if (seq <= MAX_LOG) return;
    const cutoff = seq - MAX_LOG;
    const keys = [...(await this.ctx.storage.list<LiveEvent>({ prefix: 'evt:', end: `evt:${String(cutoff).padStart(6, '0')}` })).keys()];
    if (keys.length) await this.ctx.storage.delete(keys);
  }

  private broadcast(ev: LiveEvent): void {
    const chunk = encodeSse(ev);
    for (const s of this.subs) {
      if (ev.seq > s.lastSent) {
        s.lastSent = ev.seq;
        try {
          s.controller.enqueue(chunk);
        } catch {
          this.subs.delete(s);
        }
      }
    }
  }

  private async listEvents(): Promise<LiveEvent[]> {
    const map = await this.ctx.storage.list<LiveEvent>({ prefix: 'evt:' });
    return [...map.values()].sort((a, b) => a.seq - b.seq);
  }

  /** The reader CHROME (apex/live origin): WCAG Audit Agent header + creator actions, embedding the document in a
   *  sandboxed iframe served from the content origin. Gated: a private session renders only for its creator
   *  (cookie), else a branded 403. For a private creator it mints a short-lived `?k=` the content origin
   *  exchanges for its own cookie; public sessions embed the frame with no token. Private chrome is never cached. */
  private async shell(req: Request): Promise<Response> {
    const { allowed, isCreator, isPublic, meta } = await this.gate(req);
    if (!allowed) {
      return new Response(renderPrivateNotice(), {
        status: 403,
        headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex', 'cache-control': 'no-store' },
      });
    }
    const id = meta?.sessionId ?? '';
    const origin = this.contentOrigin();
    let frameSrc = `${origin}/s/${id}/frame`;
    // Only a private creator needs a capability token (the content origin verifies it, then issues its own
    // cookie). A non-creator never reaches here on a private session (gated above); public frames are open.
    if (!isPublic && isCreator && this.env.FRAME_SIGN_KEY) {
      const k = await signFrameToken(id, Date.now() + FRAME_TOKEN_TTL_MS, this.env.FRAME_SIGN_KEY);
      frameSrc += `?k=${encodeURIComponent(k)}`;
    }
    const html = renderChrome({
      title: meta?.title ?? 'Document',
      frameSrc,
      sessionId: meta?.sessionId,
      isCreator,
      visibility: isPublic ? 'public' : 'private',
      ownerUserId: meta?.ownerUserId,
    });
    const cache = isPublic ? 'public, max-age=30' : 'no-store';
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'x-robots-tag': 'noindex',
        'cache-control': cache,
        'content-security-policy': chromeCsp(origin),
      },
    });
  }

  /** The UNTRUSTED document iframe (content origin). Deterministic-light page + the SSE streaming client, under
   *  a strict nonce CSP and `frame-ancestors` lock. Gated by the frame capability (wcag_fct cookie or first-load
   *  ?k); a fresh ?k is exchanged for the cookie so /events + /fig authenticate without the token in every URL. */
  private async frame(req: Request): Promise<Response> {
    const { allowed, isPublic, meta, setCookieToken } = await this.gateContent(req, { allowK: true });
    if (!allowed) {
      return new Response(renderPrivateNotice(), {
        status: 403,
        headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex', 'cache-control': 'no-store' },
      });
    }
    const id = meta?.sessionId ?? '';
    const snap = await this.getSnap();
    const nonce = newNonce();
    // /events authenticates via the wcag_fct cookie set on THIS response (same-origin to the frame). We do NOT
    // also put a bearer token in the events URL: a long-lived ?k would sit in CF/access logs and be replayable.
    // content.example.com is same-SITE to the chrome origin, so the Lax cookie is sent for the frame's own
    // same-origin SSE subrequest. (The short-lived ?k handoff is used ONLY for the initial /frame load.)
    const eventsPath = `/s/${id}/events`;
    const html = renderFrame({
      title: meta?.title ?? 'Document',
      status: meta?.status ?? 'idle',
      bodyHtml: renderBody(snap.blocks),
      seq: snap.seq,
      nonce,
      eventsPath,
    });
    const headers = new Headers({
      'content-type': 'text/html; charset=utf-8',
      'x-robots-tag': 'noindex',
      'cache-control': isPublic ? 'public, max-age=30' : 'no-store',
      'content-security-policy': frameCsp(nonce),
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    if (setCookieToken && id) {
      headers.append('set-cookie', frameCookie(id, setCookieToken, Math.floor(FRAME_COOKIE_TTL_MS / 1000)));
    }
    return new Response(html, { headers });
  }

  /** Serve a cropped figure PNG from R2, gated by the mode's access rule (creator cookie on the chrome origin,
   *  frame token on the content origin). Private crops are `no-store` (the old index.ts path served them
   *  `immutable` — a private leak); public crops keep the long immutable cache. */
  private async figure(req: Request, name: string, mode: 'creator' | 'content'): Promise<Response> {
    const gated = mode === 'content' ? await this.gateContent(req, { allowK: false }) : await this.gate(req);
    if (!gated.allowed) return new Response('forbidden', { status: 403, headers: { 'cache-control': 'no-store' } });
    const { isPublic, meta } = gated;
    const id = meta?.sessionId;
    if (!id) return new Response('not found', { status: 404 });
    const obj = await this.env.LIVE_PDF_BUCKET.get(`s/${id}/fig/${name}`);
    if (!obj) return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
    const cache = isPublic ? 'public, max-age=31536000, immutable' : 'private, no-store';
    return new Response(obj.body, { headers: { 'content-type': 'image/png', 'cache-control': cache } });
  }

  /** Download the rendered accessible HTML as a static, self-contained file — NO account required (the guest
   *  escape hatch). Same gate as viewing. Figure crops are inlined as data: URIs (bounded) so the file is
   *  portable offline and carries no live link back to a private session's crops. */
  private async download(req: Request): Promise<Response> {
    const { allowed, meta } = await this.gate(req);
    if (!allowed) {
      return new Response(renderPrivateNotice(), {
        status: 403,
        headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex', 'cache-control': 'no-store' },
      });
    }
    const id = meta?.sessionId ?? '';
    const title = meta?.title ?? 'Document';
    const snap = await this.getSnap();
    const body = await this.inlineFigureCrops(renderBody(snap.blocks), id);
    const html = renderDownloadHtml({ title, bodyHtml: body });
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-disposition': `attachment; filename="${safeDownloadFilename(title, id)}"`,
        'x-robots-tag': 'noindex',
        'cache-control': 'no-store',
      },
    });
  }

  /** Replace `/s/<id>/fig/<name>.png` <img> srcs with inline data: URIs read from R2, under a total byte cap.
   *  Over-budget or missing crops have their <img> dropped (caption stays) — never falls back to a private
   *  absolute link. Only this session's own crop URLs are touched. */
  private async inlineFigureCrops(body: string, id: string): Promise<string> {
    if (!id) return body;
    const escId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const imgRe = new RegExp(`<img\\b[^>]*\\bsrc="/s/${escId}/fig/([A-Za-z0-9._-]+\\.png)"[^>]*>`, 'g');
    const names = new Set<string>();
    for (const m of body.matchAll(imgRe)) names.add(m[1]);
    if (!names.size) return body;
    const dataUri = new Map<string, string>();
    let used = 0;
    for (const name of names) {
      const obj = await this.env.LIVE_PDF_BUCKET.get(`s/${id}/fig/${name}`);
      if (!obj) continue;
      const bytes = new Uint8Array(await obj.arrayBuffer());
      if (used + bytes.byteLength > DOWNLOAD_INLINE_CAP) continue; // over budget → drop this image
      used += bytes.byteLength;
      dataUri.set(name, `data:image/png;base64,${bytesToBase64(bytes)}`);
    }
    return body.replace(imgRe, (whole, name: string) => {
      const uri = dataUri.get(name);
      return uri ? whole.replace(`/s/${id}/fig/${name}`, uri) : '';
    });
  }

  /** SSE tail: subscribe, replay events after the client's resume point, then stream live. Gated by the mode's
   *  rule (creator cookie on the chrome origin, frame token on the content origin) so a private session never
   *  leaks its content stream to a non-creator (the shell-only gate would leak via this path). */
  private async events(req: Request, mode: 'creator' | 'content'): Promise<Response> {
    // Content-mode /events is COOKIE-ONLY (allowK: false). The short-lived ?k capability is accepted only on the
    // initial /frame load (which exchanges it for the wcag_fct cookie); no bearer token rides the events URL.
    const gated = mode === 'content' ? await this.gateContent(req, { allowK: false }) : await this.gate(req);
    if (!gated.allowed) return new Response('forbidden', { status: 403, headers: { 'cache-control': 'no-store' } });
    const isPublic = gated.isPublic;
    const after = parseAfter(req);
    const sub: Subscriber = { controller: undefined as unknown as ReadableStreamDefaultController<Uint8Array>, lastSent: after };
    const textEnc = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        sub.controller = controller;
        controller.enqueue(textEnc.encode('retry: 2000\n: connected\n\n'));
        this.subs.add(sub); // subscribe BEFORE replay; lastSent dedups any overlap during the await
        for (const ev of filterAfter(await this.listEvents(), after)) {
          if (ev.seq > sub.lastSent) {
            sub.lastSent = ev.seq;
            controller.enqueue(encodeSse(ev));
          }
        }
        const meta = await this.getMeta();
        if (meta?.status === 'done' || meta?.status === 'error') {
          controller.close();
          this.subs.delete(sub);
        }
      },
      cancel: () => {
        this.subs.delete(sub);
      },
    });

    // Private streams carry document content → never cache. Public (samples/demo) keep the SSE revalidate hint.
    return new Response(stream, {
      headers: { ...SSE_HEADERS, 'cache-control': isPublic ? 'no-cache, no-transform' : 'no-store, no-transform' },
    });
  }
}
