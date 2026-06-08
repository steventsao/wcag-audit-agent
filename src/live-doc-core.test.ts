import { describe, it, expect } from 'vitest';
import {
  encodeSse,
  filterAfter,
  shortHash,
  blockId,
  idFromTarget,
  applyReplace,
  parseAfter,
  skeletonBlocks,
  renderBody,
  renderChrome,
  renderFrame,
  demoScript,
  CLIENT_JS,
  extractBlocks,
  findElementEnd,
  stripFence,
  applyAppend,
  LANDING_HTML,
  ensureBlockId,
  parseFigureRef,
  renderFigureImg,
  wrapTableBlock,
  base64ToBytes,
  bytesToBase64,
  BRAND,
  BRAND_DARK,
  PUBLIC_SESSION_IDS,
  sha256Hex,
  timingSafeEqual,
  newCreatorToken,
  readCookie,
  sessionCookie,
  safeDownloadFilename,
  renderDownloadHtml,
  renderPrivateNotice,
  liveDocClaimBridgeUrl,
  signFrameToken,
  verifyFrameToken,
  frameCookie,
  newNonce,
  frameCsp,
  chromeCsp,
  hmacSha256,
  type LiveEvent,
  type Block,
  type FigureRef,
} from './live-doc-core';
// (test-only node:fs / node:url imports removed for the standalone repo — BRAND is the source of truth)

const dec = new TextDecoder();

describe('encodeSse', () => {
  it('frames id/event/data and strips seq from the payload', () => {
    const ev: LiveEvent = { seq: 7, type: 'replace', target: '#block-3', html: '<h2 id="block-3">Hi</h2>' };
    const out = dec.decode(encodeSse(ev));
    expect(out).toContain('id: 7\n');
    expect(out).toContain('event: replace\n');
    expect(out).toMatch(/data: \{.*"target":"#block-3".*\}\n\n$/);
    expect(out).not.toContain('"seq"'); // seq travels as the SSE id, not in the JSON body
  });

  it('progress events carry the phase', () => {
    const out = dec.decode(encodeSse({ seq: 1, type: 'progress', phase: 'Structuring' }));
    expect(out).toContain('event: progress\n');
    expect(out).toContain('"phase":"Structuring"');
  });
});

describe('filterAfter', () => {
  const evs: LiveEvent[] = [1, 2, 3, 4].map((n) => ({ seq: n, type: 'progress' }));
  it('returns strictly-after events for replay', () => {
    expect(filterAfter(evs, 2).map((e) => e.seq)).toEqual([3, 4]);
  });
  it('after=0 returns everything; after>=max returns nothing', () => {
    expect(filterAfter(evs, 0)).toHaveLength(4);
    expect(filterAfter(evs, 4)).toHaveLength(0);
  });
});

describe('shortHash / blockId', () => {
  it('is deterministic and 6 chars', () => {
    expect(shortHash('hello')).toBe(shortHash('hello'));
    expect(shortHash('hello')).toHaveLength(6);
    expect(shortHash('hello')).not.toBe(shortHash('world'));
  });
  it('blockId is stable for the same page/order/text (codex failure-mode #3 guard)', () => {
    expect(blockId(1, 2, 'Intro')).toBe(blockId(1, 2, 'Intro'));
    expect(blockId(1, 2, 'Intro')).toMatch(/^block-1-2-[0-9a-z]{6}$/);
    expect(blockId(1, 2, 'Intro')).not.toBe(blockId(1, 3, 'Intro'));
  });
});

describe('idFromTarget / applyReplace', () => {
  it('strips the leading #', () => {
    expect(idFromTarget('#block-9')).toBe('block-9');
    expect(idFromTarget('block-9')).toBe('block-9');
  });
  it('updates the matching block, preserves order', () => {
    const blocks: Block[] = [
      { id: 'block-1', html: '<p id="block-1">a</p>' },
      { id: 'block-2', html: '<p id="block-2">b</p>' },
    ];
    const next = applyReplace(blocks, '#block-2', '<h2 id="block-2">B</h2>');
    expect(next.map((b) => b.id)).toEqual(['block-1', 'block-2']);
    expect(next[1].html).toBe('<h2 id="block-2">B</h2>');
    expect(next[0].html).toBe('<p id="block-1">a</p>'); // untouched
  });
  it('appends when the id is new', () => {
    const next = applyReplace([], '#block-7', '<p id="block-7">x</p>');
    expect(next).toEqual([{ id: 'block-7', html: '<p id="block-7">x</p>' }]);
  });
});

describe('parseAfter', () => {
  const make = (url: string, lastEventId?: string) =>
    new Request(url, lastEventId ? { headers: { 'last-event-id': lastEventId } } : undefined);
  it('prefers Last-Event-ID (reconnect) over the bootstrap ?after=', () => {
    expect(parseAfter(make('https://x/live/a/events?after=5', '9'))).toBe(9);
  });
  it('uses ?after= on initial connect (no Last-Event-ID), else 0', () => {
    expect(parseAfter(make('https://x/live/a/events?after=5'))).toBe(5);
    expect(parseAfter(make('https://x/live/a/events'))).toBe(0);
  });
  it('ignores garbage', () => {
    expect(parseAfter(make('https://x/live/a/events?after=nope'))).toBe(0);
    expect(parseAfter(make('https://x/live/a/events?after=-4'))).toBe(0);
  });
});

describe('skeletonBlocks / renderBody', () => {
  it('emits n stable skeleton ids', () => {
    const b = skeletonBlocks(3);
    expect(b.map((x) => x.id)).toEqual(['block-1', 'block-2', 'block-3']);
    expect(renderBody(b)).toContain('id="block-1"');
  });
});

describe('renderChrome', () => {
  const html = renderChrome({ title: 'Doc & <co>', frameSrc: 'https://content.example.com/s/abc/frame?k=tok' });
  it('is noindex, has a skip link to the iframe, and embeds the content-origin frame in a sandbox', () => {
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('class="a11y-skip" href="#a11y-frame"');
    expect(html).toContain('id="a11y-frame"');
    expect(html).toContain('sandbox="allow-scripts allow-same-origin"');
    expect(html).toContain('src="https://content.example.com/s/abc/frame?k=tok"');
    expect(html).toContain('referrerpolicy="no-referrer"');
  });
  it('is a STATIC shell — no inline streaming client (CSP can be script-src none)', () => {
    expect(html).not.toContain('EventSource');
    expect(html).not.toContain('<main id="a11y-doc"'); // the document lives in the frame, not the chrome
  });
  it('escapes the title (in <title> and the iframe title attr)', () => {
    expect(html).toContain('Doc &amp; &lt;co&gt;');
  });
});

describe('renderFrame', () => {
  const html = renderFrame({
    title: 'Doc & <co>',
    status: 'running',
    bodyHtml: '<p id="block-1">x</p>',
    seq: 12,
    nonce: 'NONCE123',
    eventsPath: '/s/abc/events?k=tok',
  });
  it('is noindex, carries the live region, embedded resume seq + events path, and the generic client', () => {
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('id="a11y-phase"');
    expect(html).toContain('data-a11y-seq="12"');
    expect(html).toContain('data-a11y-events="/s/abc/events?k=tok"');
    expect(html).toContain('<p id="block-1">x</p>');
    expect(html).toContain('EventSource'); // generic client embedded
  });
  it('is DETERMINISTIC light — no prefers-color-scheme dark block (the document never flips with the OS)', () => {
    expect(html).not.toContain('prefers-color-scheme:dark');
    expect(html).toContain('color-scheme:light');
  });
  it('nonces the inline <style> and <script> so a strict CSP can drop unsafe-inline', () => {
    expect(html).toContain('<style nonce="NONCE123">');
    expect(html).toContain('<script nonce="NONCE123">');
  });
  it('shows Ready when done', () => {
    expect(
      renderFrame({ title: 't', status: 'done', bodyHtml: '', nonce: 'n', eventsPath: '/s/x/events' }),
    ).toContain('>Ready</span>');
  });
});

describe('demoScript', () => {
  it('starts with progress, ends with done, and upgrades a block in place', () => {
    const s = demoScript();
    expect(s[0].type).toBe('progress');
    expect(s[s.length - 1].type).toBe('done');
    const replaces = s.filter((e) => e.type === 'replace');
    expect(replaces.length).toBeGreaterThanOrEqual(4);
    // every replace target id is carried in its html so future replaces still resolve
    for (const r of replaces) {
      expect(r.html).toContain(`id="${idFromTarget(r.target!)}"`);
    }
  });
});

describe('CLIENT_JS', () => {
  it('is framework-free and PDF-agnostic (no pdf/wcag knowledge)', () => {
    expect(CLIENT_JS).toContain('EventSource');
    expect(CLIENT_JS).toContain('appendChild');
    expect(CLIENT_JS.toLowerCase()).not.toContain('pdf');
    expect(CLIENT_JS.toLowerCase()).not.toContain('wcag');
  });
});

describe('stripFence', () => {
  it('removes leading ```html and trailing ``` the VLM may emit', () => {
    expect(stripFence('```html\n<h1>Hi</h1>\n```')).toBe('<h1>Hi</h1>');
    expect(stripFence('<p>plain</p>')).toBe('<p>plain</p>');
  });
});

describe('findElementEnd', () => {
  it('returns the end of a simple complete element', () => {
    const s = '<p>hello</p>rest';
    expect(s.slice(0, findElementEnd(s, 0))).toBe('<p>hello</p>');
  });
  it('handles nested elements (tables) at depth', () => {
    const s = '<table><tr><td>a</td></tr></table>tail';
    expect(s.slice(0, findElementEnd(s, 0))).toBe('<table><tr><td>a</td></tr></table>');
  });
  it('returns -1 for an unterminated element (still streaming)', () => {
    expect(findElementEnd('<table><tr><td>a</td>', 0)).toBe(-1);
    expect(findElementEnd('<p>half', 0)).toBe(-1);
  });
  it('handles a top-level void element', () => {
    const s = '<hr/>after';
    expect(s.slice(0, findElementEnd(s, 0))).toBe('<hr/>');
  });
});

describe('extractBlocks (streaming HTML splitter)', () => {
  it('emits complete top-level blocks, holds the incomplete tail', () => {
    const { blocks, rest } = extractBlocks('<h1>Title</h1>\n<p>Body</p>\n<table><tr><td>x');
    expect(blocks).toEqual(['<h1>Title</h1>', '<p>Body</p>']);
    expect(rest).toContain('<table>'); // unterminated table held back
  });
  it('strips a leading code fence', () => {
    const { blocks } = extractBlocks('```html\n<h1>Hi</h1>\n');
    expect(blocks).toEqual(['<h1>Hi</h1>']);
  });
  it('reassembles across chunk boundaries (the streaming case)', () => {
    let buf = '';
    const got: string[] = [];
    for (const chunk of ['<h2>Sec', 'tion</h2><ul><li>a</li>', '<li>b</li></ul><p>ta', 'il</p>']) {
      buf += chunk;
      const { blocks, rest } = extractBlocks(buf);
      got.push(...blocks);
      buf = rest;
    }
    expect(got).toEqual(['<h2>Section</h2>', '<ul><li>a</li><li>b</li></ul>', '<p>tail</p>']);
    expect(buf.trim()).toBe('');
  });
  it('wraps stray top-level text as <p>', () => {
    const { blocks } = extractBlocks('loose text<h1>H</h1>');
    expect(blocks[0]).toBe('<p>loose text</p>');
    expect(blocks[1]).toBe('<h1>H</h1>');
  });
});

describe('LANDING_HTML', () => {
  it('is a multipart form posting to /s with both file and url inputs (no-JS works)', () => {
    expect(LANDING_HTML).toContain('action="/s"');
    expect(LANDING_HTML).toContain('enctype="multipart/form-data"');
    expect(LANDING_HTML).toContain('type="file"');
    expect(LANDING_HTML).toContain('name="url"');
    expect(LANDING_HTML).toContain('type="submit"');
  });
  it('uses the Inter Tight display font + the brand wordmark', () => {
    expect(LANDING_HTML).toContain('Inter+Tight');
    expect(LANDING_HTML).toContain('WCAG Audit Agent');
  });
});

// Keep the streamed shell's inlined brand palette internally consistent (valid hex, light + dark).
describe('BRAND palette', () => {
  it('every BRAND and BRAND_DARK token is a valid hex color', () => {
    const color = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d.,\s]+\))$/;
    for (const v of Object.values(BRAND)) expect(v).toMatch(color);
    for (const v of Object.values(BRAND_DARK)) expect(v).toMatch(color);
  });
});

describe('applyAppend', () => {
  it('drops the a11y-load placeholder on first real append', () => {
    const start: Block[] = [{ id: 'a11y-load', html: '<p id="a11y-load">Reading…</p>' }];
    const next = applyAppend(start, 'auto-2', '<h1>Title</h1>');
    expect(next).toEqual([{ id: 'auto-2', html: '<h1>Title</h1>' }]);
  });
  it('appends in order after the placeholder is gone', () => {
    const next = applyAppend([{ id: 'auto-2', html: '<h1>T</h1>' }], 'auto-3', '<p>p</p>');
    expect(next.map((b) => b.id)).toEqual(['auto-2', 'auto-3']);
  });
});

describe('ensureBlockId', () => {
  it('injects the fallback id into a tag that has none', () => {
    const { id, html } = ensureBlockId('<p>hello</p>', 'blk-5');
    expect(id).toBe('blk-5');
    expect(html).toBe('<p id="blk-5">hello</p>');
  });
  it('reuses an existing id rather than injecting', () => {
    const { id, html } = ensureBlockId('<figure id="fig-x" data-bbox="1,2,3,4"><figcaption>c</figcaption></figure>', 'blk-5');
    expect(id).toBe('fig-x');
    expect(html).toContain('id="fig-x"');
    expect(html).not.toContain('blk-5');
  });
  it('injects before existing attributes (preserves them)', () => {
    const { html } = ensureBlockId('<figure data-page="2" data-bbox="10,20,30,40"><figcaption>c</figcaption></figure>', 'blk-9');
    expect(html).toBe('<figure id="blk-9" data-page="2" data-bbox="10,20,30,40"><figcaption>c</figcaption></figure>');
  });
});

describe('parseFigureRef', () => {
  it('extracts page, bbox (Gemini ymin,xmin,ymax,xmax) and caption', () => {
    const fig = parseFigureRef('<figure data-page="3" data-bbox="100,200,800,950"><figcaption>A bar chart of revenue.</figcaption></figure>', 'blk-7');
    expect(fig).toEqual({ id: 'blk-7', page: 3, bbox: [100, 200, 800, 950], caption: 'A bar chart of revenue.' });
  });
  it('defaults page to 1 and strips caption markup', () => {
    const fig = parseFigureRef('<figure data-bbox="0,0,500,500"><figcaption>see <b>fig</b> 2</figcaption></figure>', 'blk-1');
    expect(fig?.page).toBe(1);
    expect(fig?.caption).toBe('see fig 2');
  });
  it('returns null for non-figures and figures lacking a bbox', () => {
    expect(parseFigureRef('<p>not a figure</p>', 'blk-1')).toBeNull();
    expect(parseFigureRef('<figure><figcaption>no bbox</figcaption></figure>', 'blk-1')).toBeNull();
  });
});

describe('figure placeholder → image round-trip (codex blocker guard)', () => {
  it('a streamed figure gets a stable id that a later replace targets in the snapshot', () => {
    // 1. figure streams in as a placeholder; server assigns a stable id (no id in the VLM html).
    const raw = '<figure data-page="1" data-bbox="120,80,820,900"><figcaption>Annual deployment chart.</figcaption></figure>';
    const { id, html: placeholderHtml } = ensureBlockId(raw, 'blk-4');
    let blocks = applyAppend([{ id: 'a11y-load', html: '<p id="a11y-load">…</p>' }], id, placeholderHtml);
    expect(blocks).toEqual([{ id: 'blk-4', html: placeholderHtml }]);
    expect(placeholderHtml).toContain('id="blk-4"');

    // 2. the figure lane parses the ref off the raw html + the assigned id, renders the cropped <img>.
    const fig = parseFigureRef(raw, id) as FigureRef;
    const resolved = renderFigureImg(fig, 'https://res.example.com/crop.png');
    expect(resolved).toContain('id="blk-4"');
    expect(resolved).toContain('<img src="https://res.example.com/crop.png" alt="Annual deployment chart."');

    // 3. the replace targets #blk-4 and actually swaps the snapshot block (no duplicate append).
    blocks = applyReplace(blocks, `#${id}`, resolved);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ id: 'blk-4', html: resolved });
  });
});

describe('wrapTableBlock (mobile — wide tables scroll locally)', () => {
  it('wraps a top-level table in a scroll container', () => {
    expect(wrapTableBlock('<table><tr><td>x</td></tr></table>')).toBe('<div class="a11y-table-scroll"><table><tr><td>x</td></tr></table></div>');
  });
  it('leaves non-table blocks untouched (no page-level side-scroll regression for text)', () => {
    expect(wrapTableBlock('<p>hi</p>')).toBe('<p>hi</p>');
    expect(wrapTableBlock('<figure data-bbox="1,2,3,4"><figcaption>c</figcaption></figure>')).toBe('<figure data-bbox="1,2,3,4"><figcaption>c</figcaption></figure>');
  });
});

describe('base64ToBytes / bytesToBase64 round-trip', () => {
  it('round-trips arbitrary bytes (PDF stash → workflow read)', () => {
    const bytes = new Uint8Array([0, 1, 2, 37, 80, 68, 70, 255, 128, 64]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });
});

// ── Phase 1: private-by-default guest sessions ──────────────────────────────────────────────────────
describe('PUBLIC_SESSION_IDS', () => {
  it('contains exactly the 4 hero sample ids (must match marketing-home SAMPLE_DOCS)', () => {
    expect(PUBLIC_SESSION_IDS.size).toBe(4);
    expect(PUBLIC_SESSION_IDS.has('e78147bd-4c5d-4c78-bf72-35472c7ec7e8')).toBe(true);
    expect(PUBLIC_SESSION_IDS.has('d41ddd75-2f7f-45b8-a751-bf9deac4340b')).toBe(true);
    expect(PUBLIC_SESSION_IDS.has(crypto.randomUUID())).toBe(false);
  });
});

describe('sha256Hex / timingSafeEqual (creator-token gate)', () => {
  it('hashes deterministically to 64 hex chars', async () => {
    const h = await sha256Hex('hello');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex('hello')).toBe(h);
    expect(await sha256Hex('hellp')).not.toBe(h);
  });
  it('constant-time compare: equal true, any diff false, length-mismatch false', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true);
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
  it('a cookie token verifies against its stored hash; a forged one does not', async () => {
    const token = newCreatorToken();
    const stored = await sha256Hex(token);
    expect(timingSafeEqual(await sha256Hex(token), stored)).toBe(true);
    expect(timingSafeEqual(await sha256Hex(newCreatorToken()), stored)).toBe(false);
  });
});

describe('newCreatorToken', () => {
  it('is URL/cookie-safe base64url and unguessable (distinct each call)', () => {
    const a = newCreatorToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/); // no +,/,= — safe in a Set-Cookie value
    expect(a.length).toBeGreaterThanOrEqual(43); // 32 bytes → ~43 base64url chars
    expect(a).not.toBe(newCreatorToken());
  });
});

describe('readCookie', () => {
  it('extracts a value, trims, returns undefined when absent', () => {
    expect(readCookie('a=1; wcag_sct=TOKEN123; b=2', 'wcag_sct')).toBe('TOKEN123');
    expect(readCookie('wcag_sct=xyz', 'wcag_sct')).toBe('xyz');
    expect(readCookie('a=1; b=2', 'wcag_sct')).toBeUndefined();
    expect(readCookie(null, 'wcag_sct')).toBeUndefined();
  });
});

describe('sessionCookie', () => {
  it('is httpOnly, Secure, SameSite=Lax, host-only (no Domain=), path-scoped to the session', () => {
    const c = sessionCookie('abc-123', 'RAWTOKEN');
    expect(c).toContain('wcag_sct=RAWTOKEN');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Path=/s/abc-123');
    expect(c).not.toMatch(/Domain=/i); // host-only — never a parent-domain cookie
  });
});

describe('safeDownloadFilename (Content-Disposition — no header injection)', () => {
  it('strips CR/LF/quotes/semicolons and path chars, keeps a readable slug', () => {
    expect(safeDownloadFilename('Annual Report 2024', 'id12345678')).toBe('Annual-Report-2024.html');
    const evil = safeDownloadFilename('a"; rm -rf /\r\nSet-Cookie: x=1', 'id12345678');
    expect(evil).not.toMatch(/["\r\n;]/);
    expect(evil.endsWith('.html')).toBe(true);
  });
  it('falls back to a fixed name when the title has no usable chars', () => {
    expect(safeDownloadFilename('！！！', 'abcdef0123')).toBe('a11y-document-abcdef01.html');
    expect(safeDownloadFilename('', 'abcdef0123')).toBe('a11y-document-abcdef01.html');
  });
});

describe('renderChrome action bar (Phase 1 privacy)', () => {
  const fs = 'https://content.example.com/s/sess-9/frame';
  it('creator of a private session sees the Private pill, Download, and Sign-up-to-publish', () => {
    const html = renderChrome({ title: 't', frameSrc: fs, sessionId: 'sess-9', isCreator: true, visibility: 'private' });
    expect(html).toContain('href="/s/sess-9/download"');
    expect(html).toContain('Private — only you');
    expect(html).toContain('Sign up to publish');
    expect(html).toContain(`href="${liveDocClaimBridgeUrl('sess-9')}"`);
    expect(html).not.toContain('href="https://app.example.com/sign-up"');
  });
  it('claim bridge URL is stable and URL-encodes the session id', () => {
    expect(liveDocClaimBridgeUrl('sess-9')).toBe('/live-docs/sess-9/claim');
    expect(liveDocClaimBridgeUrl('space id')).toBe('/live-docs/space%20id/claim');
  });
  it('creator of an already claimed private session sees saved state, not the sign-up CTA', () => {
    const html = renderChrome({
      title: 't',
      frameSrc: fs,
      sessionId: 'sess-9',
      isCreator: true,
      visibility: 'private',
      ownerUserId: 'user_123',
    });
    expect(html).toContain('Saved to account');
    expect(html).not.toContain('Sign up to publish');
  });
  it('a non-creator (public hero-sample preview) sees a CLEAN shell — no action bar at all', () => {
    const html = renderChrome({ title: 't', frameSrc: fs, sessionId: 'sess-9', isCreator: false, visibility: 'public' });
    expect(html).not.toContain('<div class="a11y-actions">');
    expect(html).not.toContain('/download');
    expect(html).not.toContain('Sign up to publish');
  });
  it('with no sessionId (old callers/tests) there is no action bar at all', () => {
    const html = renderChrome({ title: 't', frameSrc: fs });
    expect(html).not.toContain('<div class="a11y-actions">'); // the rendered bar (the CSS class always exists)
    expect(html).not.toContain('/download');
  });
});

describe('frame capability tokens (content-origin handoff)', () => {
  const KEY = 'test-signing-key-please-rotate';
  const ID = 'sess-abc';
  it('signs + verifies a token bound to the session id and expiry', async () => {
    const now = 1_000_000;
    const tok = await signFrameToken(ID, now + 60_000, KEY);
    expect(await verifyFrameToken(tok, ID, KEY, now)).toBe(true);
  });
  it('rejects an expired token', async () => {
    const tok = await signFrameToken(ID, 1_000_000, KEY);
    expect(await verifyFrameToken(tok, ID, KEY, 1_000_001)).toBe(false);
  });
  it('rejects a token minted for a DIFFERENT session id (no cross-session replay)', async () => {
    const now = 1_000_000;
    const tok = await signFrameToken(ID, now + 60_000, KEY);
    expect(await verifyFrameToken(tok, 'other-session', KEY, now)).toBe(false);
  });
  it('rejects a tampered signature and a wrong key', async () => {
    const now = 1_000_000;
    const tok = await signFrameToken(ID, now + 60_000, KEY);
    expect(await verifyFrameToken(tok.slice(0, -2) + 'xy', ID, KEY, now)).toBe(false);
    expect(await verifyFrameToken(tok, ID, 'different-key', now)).toBe(false);
  });
  it('rejects malformed tokens without throwing', async () => {
    for (const bad of ['', 'nodot', '.', 'abc.', 'notanumber.sig']) {
      expect(await verifyFrameToken(bad, ID, KEY, 1_000_000)).toBe(false);
    }
  });
  it('hmacSha256 is deterministic and key-sensitive', async () => {
    expect(await hmacSha256(KEY, 'msg')).toBe(await hmacSha256(KEY, 'msg'));
    expect(await hmacSha256(KEY, 'msg')).not.toBe(await hmacSha256('other', 'msg'));
  });
  it('frameCookie is httpOnly, Secure, SameSite=Lax, host-only, path-scoped to the session', () => {
    const c = frameCookie(ID, 'TOK', 3600);
    expect(c).toContain('wcag_fct=TOK');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain(`Path=/s/${ID}`);
    expect(c).not.toContain('Domain='); // host-only — not shared across subdomains
  });
});

describe('content-origin CSP', () => {
  it('frame CSP is nonce-based, denies by default, and locks frame-ancestors to our chrome', () => {
    const csp = frameCsp('NONCE');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-NONCE'");
    expect(csp).toContain('https://app.example.com'); // frame-ancestors allows the apex chrome
    expect(csp).not.toContain("'unsafe-inline'");
  });
  it('chrome CSP runs no script and may only frame the content origin', () => {
    const csp = chromeCsp('https://content.example.com');
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain('frame-src https://content.example.com');
    expect(csp).toContain("frame-ancestors 'self'");
  });
  it('newNonce returns a non-empty url-safe token, fresh each call', () => {
    const a = newNonce();
    const b = newNonce();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
  });
});

describe('renderDownloadHtml', () => {
  it('is a static, self-contained doc — no SSE client, no progress bar, noindex', () => {
    const html = renderDownloadHtml({ title: 'My <Doc>', bodyHtml: '<h1>Hi</h1><p>body</p>' });
    expect(html).toContain('<h1>Hi</h1>');
    expect(html).toContain('My &lt;Doc&gt;'); // title escaped
    expect(html).toContain('noindex');
    expect(html).not.toContain('EventSource'); // no live client phones home
    expect(html).not.toContain('a11y-bar'); // no streaming progress bar
  });
});

describe('renderPrivateNotice', () => {
  it('is a branded, noindex 403 page that does not leak content', () => {
    const html = renderPrivateNotice();
    expect(html).toContain('This document is private');
    expect(html).toContain('noindex');
    expect(html).toContain('example.com/s');
  });
});
