// Render a cropped figure region via this worker's own PdfRasterizer container.
import type { FigureRef } from './live-doc-core';

export interface RasterEnv {
  PDF_RASTERIZER: DurableObjectNamespace;
}

/**
 * Render one PDF page to a PNG cropped to a figure's bbox, via the PdfRasterizer container.
 * `bbox` is [ymin, xmin, ymax, xmax] normalized 0–1000 (Gemini-native order) — passed straight through
 * to the Go `crop` param, which converts to a pixel rect against the rendered page and pads/clamps.
 */
export async function renderCroppedPagePng(
  env: RasterEnv,
  pdfBytes: Uint8Array,
  fig: Pick<FigureRef, 'page' | 'bbox'>,
  opts: { dpi?: number; instanceName?: string } = {},
): Promise<Uint8Array> {
  const ns = env.PDF_RASTERIZER;
  if (!ns) throw new Error('PDF_RASTERIZER binding missing — add [[containers]] + DO binding to wrangler.toml');
  const stub = ns.get(ns.idFromName(opts.instanceName ?? 'default-v2'));
  const dpi = opts.dpi ?? 150;
  const crop = fig.bbox.join(','); // ymin,xmin,ymax,xmax
  const res = await stub.fetch(
    new Request(`http://pdf-rasterizer/render?page=${fig.page}&dpi=${dpi}&crop=${crop}`, {
      method: 'POST',
      body: pdfBytes,
    }),
  );
  if (!res.ok) {
    throw new Error(`pdf-rasterizer /render ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}
