import { PDFDocument } from 'pdf-lib';

export const LIVE_GUEST_PAGE_LIMIT = 50;

export type LiveGuestPageLimitResult =
  | { ok: true; pageCount: number | null }
  | { ok: false; pageCount: number; maxPages: number; message: string };

export function liveGuestPageLimitMessage(pageCount: number, maxPages = LIVE_GUEST_PAGE_LIMIT): string {
  return `PDF has ${pageCount} pages; landing page submits are limited to ${maxPages} pages. Sign up to process the full document.`;
}

export async function readLivePdfPageCount(pdfBytes: Uint8Array | ArrayBuffer): Promise<number | null> {
  try {
    const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    return pdf.getPageCount();
  } catch {
    return null;
  }
}

export async function checkLiveGuestPageLimit(
  pdfBytes: Uint8Array | ArrayBuffer,
  maxPages = LIVE_GUEST_PAGE_LIMIT,
): Promise<LiveGuestPageLimitResult> {
  const pageCount = await readLivePdfPageCount(pdfBytes);
  if (pageCount !== null && pageCount > maxPages) {
    return {
      ok: false,
      pageCount,
      maxPages,
      message: liveGuestPageLimitMessage(pageCount, maxPages),
    };
  }
  return { ok: true, pageCount };
}
