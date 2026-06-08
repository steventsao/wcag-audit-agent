// figure-image-workflow.ts — figure-image lane for the live accessible-document surface.
//
// Runs SEPARATELY from the text stream (LiveDocAgent kicks it after the page reads in) so figures never
// block first paint. Each figure resolves to a REAL cropped <img> of its bbox region and is posted back to
// the LiveDocAgent as a generic `replace` HTML event — the frontend stays a dumb SSE HTML facade.
//
// The crop is produced by THIS worker's own PdfRasterizer container (no shared prod rasterizer touched):
// read the session PDF (stashed in R2 at upload) → render the page cropped to the figure bbox → inline as a
// base64 data-URI. One durable step per figure (render+emit together, so the big base64 html is never
// persisted as a step result). CONTRACT: post /figure-ready for EVERY figure (success or fail) so
// LiveDocAgent's pendingFigures counter always drains to zero and the stream can finally signal `done`.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { type FigureRef, escapeHtml, renderFigureImg } from '../live-doc-core';
import { renderCroppedPagePng } from '../render-crop';

export interface FigureImageParams {
  /** LiveDocAgent session id (idFromName) to post resolved crops back to. */
  sessionId: string;
  /** R2 key of the stashed session PDF. */
  r2Key: string;
  figures: FigureRef[];
}

interface FigureEnv {
  LIVE_DOC_AGENT: DurableObjectNamespace;
  PDF_RASTERIZER: DurableObjectNamespace;
  LIVE_PDF_BUCKET: R2Bucket;
}

/** Caption-only fallback figure (no bbox/img → no "Rendering…" placeholder, no broken image). */
function captionOnlyFigure(fig: FigureRef): string {
  const cap = escapeHtml(fig.caption);
  return `<figure id="${fig.id}">${cap ? `<figcaption>${cap}</figcaption>` : ''}</figure>`;
}

export class FigureImageWorkflow extends WorkflowEntrypoint<FigureEnv, FigureImageParams> {
  async run(event: WorkflowEvent<FigureImageParams>, step: WorkflowStep): Promise<void> {
    const { sessionId, r2Key, figures } = event.payload;
    const ns = this.env.LIVE_DOC_AGENT;
    const session = ns.get(ns.idFromName(sessionId));

    // Read the stashed PDF once (outside step.do so the bytes are never persisted as a step result; this
    // re-reads cheaply if the whole workflow restarts). Missing → every figure falls back to caption-only.
    const obj = await this.env.LIVE_PDF_BUCKET.get(r2Key);
    const bytes = obj ? new Uint8Array(await obj.arrayBuffer()) : null;

    for (const fig of figures) {
      await step.do(`figure:${fig.id}`, async () => {
        let html: string;
        if (!bytes) {
          html = captionOnlyFigure(fig);
        } else {
          try {
            const png = await renderCroppedPagePng(this.env, bytes, fig);
            // Store the crop in R2 and reference it by a small URL — the durable DO snapshot must NOT
            // carry inline data-URIs (multi-figure docs would blow the storage/replay budget).
            const cropKey = `s/${sessionId}/fig/${fig.id}.png`;
            await this.env.LIVE_PDF_BUCKET.put(cropKey, png, { httpMetadata: { contentType: 'image/png' } });
            html = renderFigureImg(fig, `/s/${sessionId}/fig/${fig.id}.png`);
          } catch {
            html = captionOnlyFigure(fig); // never leave a figure stuck on the "Rendering…" placeholder
          }
        }
        await session.fetch('https://do/figure-ready', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ figureId: fig.id, html }),
        });
      });
    }

    // Best-effort cleanup of the stashed PDF (the live view keeps the inlined crops; the bytes aren't needed).
    await step.do('cleanup', async () => {
      await this.env.LIVE_PDF_BUCKET.delete(r2Key);
    });
  }
}
