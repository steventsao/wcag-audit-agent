import { DurableObject } from 'cloudflare:workers';

/**
 * PdfRasterizer — Durable Object that owns a Cloudflare Container running MuPDF (`mutool draw`).
 * This worker owns its OWN rasterizer copy so the `crop` param can be added without affecting any
 * shared production page-render container.
 *
 * Endpoints (forwarded to the container over port 8080):
 *   POST /render?page=N&dpi=150[&crop=ymin,xmin,ymax,xmax]  — body: PDF bytes → image/png (optionally cropped)
 *   POST /pages                                              — body: PDF bytes → {"pages": N}
 *   GET  /_health                                            → "ok"
 */
export class PdfRasterizer extends DurableObject {
  container: globalThis.Container;
  monitor?: Promise<unknown>;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    if (ctx.container === undefined) {
      throw new Error('PdfRasterizer: no container bound (check wrangler.toml [[containers]])');
    }
    this.container = ctx.container;
    ctx.blockConcurrencyWhile(async () => {
      await this.ensureRunning();
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureRunning();
    return this.container.getTcpPort(8080).fetch(request);
  }

  private async ensureRunning(): Promise<void> {
    if (!this.container.running) {
      // CF Containers runtime needs entrypoint explicitly from start(); Dockerfile CMD alone is not honored.
      this.container.start({ entrypoint: ['/server'], enableInternet: false });
      this.monitor = this.container
        .monitor()
        .then(() => console.log('[pdf-rasterizer] container exited'))
        .catch((err) => console.error('[pdf-rasterizer] monitor error:', err));
      await this.waitUntilReady();
    }
  }

  private async waitUntilReady(): Promise<void> {
    const deadlineMs = Date.now() + 15_000;
    while (Date.now() < deadlineMs) {
      try {
        const res = await this.container.getTcpPort(8080).fetch(new Request('http://pdf-rasterizer/_health'));
        if (res.ok) return;
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('[pdf-rasterizer] container did not become ready in 15s');
  }
}
