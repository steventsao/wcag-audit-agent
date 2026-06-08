// contrast.ts — the deterministic WCAG 1.4.3 core for ColorContrastAgent.
//
// Pure + deterministic + unit-testable (no network, no DO). Two halves:
//  (1) the WCAG 2.x relative-luminance contrast formula (mirrors scripts/layerize_contrast_proof.py
//      line-for-line so the Worker verdict matches the offline pixel-proof), and
//  (2) a minimal in-Worker PNG decoder (chunk parse → DecompressionStream('deflate') inflate →
//      PNG scanline un-filter) so we can sample the ACTUAL background pixels under each text span —
//      the "by definition" method, not an approximation. Workers expose DecompressionStream natively
//      (Web Standard, no nodejs_compat needed); PNG IDAT is a zlib/deflate stream, so this is the
//      rigorous path. Handles the fal layerize-text bg output: 8-bit, color-type 2 (RGB) or 6 (RGBA),
//      no interlace (verified against the fal ideogram/v3/layerize-text bg.png shape).
//
// If the bg PNG can't be decoded (paletted / 16-bit / interlaced / inflate failure), we DO NOT fake
// a measurement — we fall back to a representative-bg approximation flagged in the row's rationale so
// the coordinator escalates rather than silently passing (see measureContrast()).
import type { Evidence, Assessment } from './a2a';

// ───────────────────────── WCAG 2.x relative luminance + contrast ─────────────────────────

export type RGB = [number, number, number];

export function hexToRgb(h: string): RGB {
  const s = h.replace(/^#/, '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function lin(c: number): number {
  const x = c / 255;
  return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

export function luminance([r, g, b]: RGB): number {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio (1..21) between two colors. Order-independent. */
export function contrastRatio(c1: RGB, c2: RGB): number {
  const a = luminance(c1);
  const b = luminance(c2);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

// ───────────────────────── minimal in-Worker PNG decoder ─────────────────────────

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, row-major, 4 bytes/pixel. */
  data: Uint8Array;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

async function inflate(deflated: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate'); // PNG IDAT is a zlib stream
  const stream = new Response(deflated).body!.pipeThrough(ds);
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  return out;
}

/**
 * Decode an 8-bit, non-interlaced PNG (color type 2 RGB or 6 RGBA) to RGBA.
 * Throws on any shape we don't handle so the caller falls back to approximation
 * (never a fabricated measurement).
 */
export async function decodePng(bytes: Uint8Array): Promise<DecodedImage> {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i += 1) if (bytes[i] !== SIG[i]) throw new Error('not_a_png');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Uint8Array[] = [];

  while (off < bytes.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const dataStart = off + 8;
    if (type === 'IHDR') {
      width = dv.getUint32(dataStart);
      height = dv.getUint32(dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      interlace = bytes[dataStart + 12];
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(dataStart, dataStart + len));
    } else if (type === 'IEND') {
      break;
    }
    off = dataStart + len + 4; // +4 CRC
  }

  if (bitDepth !== 8) throw new Error(`png_bitdepth_${bitDepth}`);
  if (interlace !== 0) throw new Error('png_interlaced');
  if (colorType !== 2 && colorType !== 6) throw new Error(`png_colortype_${colorType}`);
  const channels = colorType === 6 ? 4 : 3;

  // Concat IDAT chunks then inflate the zlib stream.
  let total = 0;
  for (const c of idat) total += c.length;
  const z = new Uint8Array(total);
  { let p = 0; for (const c of idat) { z.set(c, p); p += c.length; } }
  const raw = await inflate(z);

  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('png_truncated');

  // Un-filter scanlines (PNG filter types 0..4) in place into a contiguous buffer.
  const recon = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const srcRow = y * (stride + 1) + 1;
    const dstRow = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[srcRow + x];
      const a = x >= channels ? recon[dstRow + x - channels] : 0; // left
      const b = y > 0 ? recon[dstRow - stride + x] : 0; // up
      const c = x >= channels && y > 0 ? recon[dstRow - stride + x - channels] : 0; // up-left
      let v: number;
      switch (filter) {
        case 0: v = rawByte; break;
        case 1: v = rawByte + a; break;
        case 2: v = rawByte + b; break;
        case 3: v = rawByte + ((a + b) >> 1); break;
        case 4: v = rawByte + paeth(a, b, c); break;
        default: throw new Error(`png_filter_${filter}`);
      }
      recon[dstRow + x] = v & 0xff;
    }
  }

  // Expand to RGBA.
  const out = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i += 1) {
    const s = i * channels;
    out[j++] = recon[s];
    out[j++] = recon[s + 1];
    out[j++] = recon[s + 2];
    out[j++] = channels === 4 ? recon[s + 3] : 255;
  }
  return { width, height, data: out };
}

// ───────────────────────── span measurement (matches the Python proof) ─────────────────────────

/** A fal layerize-text span we measure: clean text color + bbox in bg-image pixel space. */
export interface SpanInput {
  text: string;
  color: string; // hex, e.g. "#1B2511"
  x: number;
  y: number;
  width: number;
  height: number;
  fontSizePx: number; // fal font_size (bg-image px)
  bold: boolean;
}

export interface SpanResult {
  text: string;
  textColor: string;
  bbox: [number, number, number, number]; // [x0,y0,x1,y1] in bg-image px
  worstRatio: number;
  medianRatio: number;
  largeText: boolean;
  threshold: number;
  passes: boolean;
}

/** Pull the spans out of fal's text_containers[] → flat SpanInput[]. */
export function spansFromContainers(containers: any[]): SpanInput[] {
  const spans: SpanInput[] = [];
  for (const cont of containers ?? []) {
    for (const it of cont.items ?? []) {
      const ff = String(it.font_file ?? '');
      const bold = /Bold|Black|Heavy|Semibold|SemiBold/.test(ff);
      const x = it.x;
      const y = it.y;
      const w = it.width;
      const h = it.height;
      if (x == null || w == null) continue;
      const items = (it.spans ?? []).filter((sp: any) => sp.color);
      // When an item holds MULTIPLE differently-colored spans, sampling the FULL item
      // bbox for each one dilutes a small failing span with unrelated pixels (the 2nd-percentile
      // denoise can then hide it). Slice the item's x-range proportionally by character count so each
      // span is sampled over (approximately) its own glyphs. Single-span items keep the full box.
      const totalChars = items.reduce((n: number, sp: any) => n + Math.max(1, String(sp.text ?? '').trim().length), 0) || 1;
      let cursor = x;
      for (const sp of items) {
        const text = String(sp.text ?? '').replace(/\n/g, ' ').trim();
        const frac = items.length > 1 ? Math.max(1, text.length) / totalChars : 1;
        const spanW = items.length > 1 ? w * frac : w;
        const spanX = items.length > 1 ? cursor : x;
        cursor += spanW;
        spans.push({ text, color: sp.color, x: spanX, y, width: spanW, height: h, fontSizePx: it.font_size ?? 0, bold });
      }
    }
  }
  return spans;
}

/**
 * Is this span "large text" per WCAG (≥18pt, or ≥14pt bold)? We only have fal's font_size in
 * BG-IMAGE PIXELS, so we convert via the page's point-width if known (pagePointWidth / imgWidth =
 * pt-per-px), exactly like the Python proof (which used 611/BW). When pagePointWidth is unknown we
 * CANNOT prove large-text, so we conservatively treat the span as NORMAL (requires 4.5:1). That can
 * only over-require contrast → at worst it escalates a large-text span that would pass at 3:1; it
 * never lets a real failure through. Documented approximation (conservative-on-unknown).
 */
function isLargeText(fontSizePx: number, bold: boolean, ptPerPx: number | null): boolean {
  if (ptPerPx == null) return false; // unknown scale → assume normal (the safe direction)
  const pt = fontSizePx * ptPerPx;
  return pt >= 18 || (pt >= 14 && bold);
}

export interface MeasureResult {
  spans: SpanResult[];
  worst: SpanResult | null; // the worst-case span (lowest margin to its own threshold)
  minWorstRatio: number | null;
  allPass: boolean;
  anyFail: boolean;
  method: string;
  approximated: boolean; // true → bg sampled as a single representative color (PNG decode failed)
}

/**
 * The deterministic measurement. For each span: text color vs the ACTUAL background pixels it falls
 * on (worst-case, denoised at the 2nd percentile — matches the Python proof). Returns per-span
 * ratios + the single worst-case span that decides pass/fail.
 *
 * @param bg            decoded bg image (text removed) — sample bg pixels under each span
 * @param spans         fal spans (clean text color + bbox)
 * @param pagePointWidth optional page width in PostScript points; enables large-text classification
 */
export function measureContrast(
  bg: DecodedImage,
  spans: SpanInput[],
  pagePointWidth?: number,
): MeasureResult {
  const ptPerPx = pagePointWidth && bg.width > 0 ? pagePointWidth / bg.width : null;
  const results: SpanResult[] = [];
  // If ANY sampled bg pixel is non-opaque (alpha < 255), the rendered-page color under
  // that glyph is unknown — measuring vs the raw RGB would fabricate a plausible-but-wrong ratio.
  // We refuse to attest in that case: flag the whole measurement approximated → the verdict escalates.
  let sawTransparency = false;

  for (const sp of spans) {
    const tcol = hexToRgb(sp.color);
    const x0 = Math.max(0, Math.floor(sp.x));
    const y0 = Math.max(0, Math.floor(sp.y));
    const x1 = Math.min(bg.width, Math.ceil(sp.x + sp.width));
    const y1 = Math.min(bg.height, Math.ceil(sp.y + sp.height));
    if (x1 <= x0 || y1 <= y0) continue;

    // Collect contrast ratios for every OPAQUE bg pixel under the span, then take the denoised
    // worst-case (2nd percentile) and the median — identical statistic to the reference implementation.
    const ratios: number[] = [];
    for (let y = y0; y < y1; y += 1) {
      const rowOff = (y * bg.width + x0) * 4;
      for (let x = x0; x < x1; x += 1) {
        const o = rowOff + (x - x0) * 4;
        if (bg.data[o + 3] < 255) { sawTransparency = true; continue; } // skip non-opaque
        ratios.push(contrastRatio(tcol, [bg.data[o], bg.data[o + 1], bg.data[o + 2]]));
      }
    }
    if (ratios.length === 0) continue;
    ratios.sort((a, b) => a - b);
    const worst = round2(ratios[Math.max(0, Math.floor(ratios.length / 50))]);
    const median = round2(ratios[Math.floor(ratios.length / 2)]);
    const large = isLargeText(sp.fontSizePx, sp.bold, ptPerPx);
    const threshold = large ? 3.0 : 4.5;
    results.push({
      text: sp.text.slice(0, 80),
      textColor: sp.color,
      bbox: [x0, y0, x1, y1],
      worstRatio: worst,
      medianRatio: median,
      largeText: large,
      threshold,
      passes: worst >= threshold,
    });
  }

  // Transparency in the bg → cannot cleanly attest a pass; mark approximated so the verdict escalates.
  const method = sawTransparency
    ? 'layerize text/bg separation; bg had transparency under text (composite unknown) → unreliable'
    : 'layerize text/bg separation; text color vs actual bg pixels (worst-case)';
  return summarize(results, sawTransparency, method);
}

/**
 * Approximation fallback when the bg PNG can't be decoded: measure each span's text color against a
 * SINGLE representative background color (passed in). This is NOT the rigorous per-pixel method — it
 * is flagged (approximated:true) so the coordinator/LLM escalates rather than trusting it.
 */
export function measureContrastApprox(
  bgColor: RGB,
  spans: SpanInput[],
  pagePointWidth?: number,
  bgImgWidth?: number,
): MeasureResult {
  const ptPerPx = pagePointWidth && bgImgWidth ? pagePointWidth / bgImgWidth : null;
  const results: SpanResult[] = spans.map((sp) => {
    const ratio = round2(contrastRatio(hexToRgb(sp.color), bgColor));
    const large = isLargeText(sp.fontSizePx, sp.bold, ptPerPx);
    const threshold = large ? 3.0 : 4.5;
    return {
      text: sp.text.slice(0, 80),
      textColor: sp.color,
      bbox: [Math.floor(sp.x), Math.floor(sp.y), Math.ceil(sp.x + sp.width), Math.ceil(sp.y + sp.height)] as [number, number, number, number],
      worstRatio: ratio,
      medianRatio: ratio,
      largeText: large,
      threshold,
      passes: ratio >= threshold,
    };
  });
  return summarize(results, true, 'representative-bg approximation (bg PNG decode unavailable)');
}

function summarize(results: SpanResult[], approximated: boolean, method: string): MeasureResult {
  // Worst-case span = the one with the smallest margin (worstRatio - threshold). Failures sort first.
  let worst: SpanResult | null = null;
  for (const r of results) {
    if (!worst || r.worstRatio - r.threshold < worst.worstRatio - worst.threshold) worst = r;
  }
  return {
    spans: results,
    worst,
    minWorstRatio: results.length ? Math.min(...results.map((r) => r.worstRatio)) : null,
    allPass: results.length > 0 && results.every((r) => r.passes),
    anyFail: results.some((r) => !r.passes),
    method,
    approximated,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ───────────────────────── verdict → A2A Assessment ─────────────────────────

export const CONTRAST_AGENT = 'contrast-service';
export const CONTRAST_STANDARD = 'WCAG 1.4.3';

/**
 * Turn a deterministic measurement into the A2A Assessment. This is the DETERMINISTIC branch
 * (step 2): a clean all-pass → passed; any clear fail → failed+needs_human. The borderline /
 * approximated case stays cannot_tell and is routed by the LLM-decide step (step 3). The LLM
 * NEVER changes the ratio — it only picks the completion action for the cannot_tell case.
 */
export function contrastVerdict(m: MeasureResult): Assessment {
  const evidence: Evidence[] = [];
  if (m.worst) {
    evidence.push({
      kind: 'bbox',
      page: 1,
      bbox: m.worst.bbox,
      detail: `worst-case span "${m.worst.text}" ${m.worst.textColor} → ${m.worst.worstRatio}:1 (needs ${m.worst.threshold}:1${m.worst.largeText ? ', large text' : ''})`,
      citation: 'p1-contrast-worst',
    });
  }
  evidence.push({
    kind: 'measurement',
    page: 1,
    detail: `${m.spans.length} spans; min worst-case ${m.minWorstRatio ?? 'n/a'}:1; method=${m.method}`,
    citation: 'p1-contrast-summary',
  });

  // No measurable text → nothing to assert (e.g. flat raster page with no recovered spans).
  if (m.spans.length === 0) {
    return row('not_present', 0.4, true, evidence, 'No text spans recovered from layerize — contrast not measurable; human confirm whether the page has real text.');
  }

  // Approximation never yields a clean attestation: best it can do is a pre-assessment flagged for review.
  if (m.approximated) {
    return row('cannot_tell', 0.4, true, evidence,
      `Background could not be decoded per-pixel; measured against a representative bg color (approximation). ${m.anyFail ? 'At least one span fails even approximated → likely fail.' : 'Approximate pass — needs human confirm.'}`);
  }

  // Clear fail → failed, gate for a human (the moat: a machine fail is still a pre-assessment).
  if (m.anyFail) {
    const failing = m.spans.filter((s) => !s.passes).length;
    return row('failed', 0.9, true, evidence,
      `${failing}/${m.spans.length} text span(s) below the WCAG 1.4.3 minimum; worst ${m.worst?.worstRatio}:1 needs ${m.worst?.threshold}:1.`);
  }

  // Clear pass — all spans clear their threshold with margin. High confidence; no gate.
  // (A thin margin near the threshold could still be escalated by the LLM-decide step.)
  return row('passed', 0.9, false, evidence,
    `All ${m.spans.length} text span(s) meet WCAG 1.4.3; min worst-case ${m.minWorstRatio}:1.`);
}

function row(verdict: Assessment['verdict'], confidence: number, needsHuman: boolean, evidence: Evidence[], rationale: string): Assessment {
  return {
    agent: CONTRAST_AGENT,
    standard_refs: [CONTRAST_STANDARD],
    state: needsHuman ? 'input_required' : 'completed',
    verdict,
    confidence,
    needs_human: needsHuman,
    evidence,
    rationale,
  };
}

/**
 * Is the measurement "borderline" — i.e. should we ask the LLM-decide step what to do?
 *
 * A deterministic FAIL is NEVER borderline. Any span below its threshold settles the rule
 * as failed+needs_human in contrastVerdict(); routing it to the LLM (which can return `accept`) could
 * drop the human gate. So the router only ever sees PASS-side ambiguity (a thin band ABOVE the worst
 * span's threshold) or the no-spans / approximated escalation cases. The LLM can only confirm-escalate
 * or accept a genuine borderline PASS — it can never clear a fail. (Belt-and-suspenders with the
 * llmDecideCompletion guard that refuses to clear needs_human unless verdict==='passed'.)
 */
export function isBorderline(m: MeasureResult): boolean {
  if (m.spans.length === 0) return true; // nothing measurable → escalate-route
  if (m.approximated) return true; // bg not decoded / transparency → escalate-route
  if (m.anyFail) return false; // a clear fail is settled deterministically — never route to the LLM
  if (!m.worst) return true;
  // PASS-side only: the worst span clears its threshold but by a thin margin (busy-raster ambiguity).
  const margin = m.worst.worstRatio - m.worst.threshold;
  return margin >= 0 && margin < 0.5;
}
