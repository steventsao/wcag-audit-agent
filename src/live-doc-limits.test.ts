import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  checkLiveGuestPageLimit,
  LIVE_GUEST_PAGE_LIMIT,
  liveGuestPageLimitMessage,
  readLivePdfPageCount,
} from './live-doc-limits';

async function pdfBytesWithPages(pageCount: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) pdf.addPage();
  return pdf.save();
}

describe('live document guest page limit', () => {
  it('counts generated PDFs', async () => {
    const bytes = await pdfBytesWithPages(3);
    await expect(readLivePdfPageCount(bytes)).resolves.toBe(3);
  });

  it('allows PDFs at the landing page limit', async () => {
    const bytes = await pdfBytesWithPages(LIVE_GUEST_PAGE_LIMIT);
    await expect(checkLiveGuestPageLimit(bytes)).resolves.toEqual({
      ok: true,
      pageCount: LIVE_GUEST_PAGE_LIMIT,
    });
  });

  it('rejects PDFs over the landing page limit', async () => {
    const pageCount = LIVE_GUEST_PAGE_LIMIT + 1;
    const bytes = await pdfBytesWithPages(pageCount);
    await expect(checkLiveGuestPageLimit(bytes)).resolves.toEqual({
      ok: false,
      pageCount,
      maxPages: LIVE_GUEST_PAGE_LIMIT,
      message: liveGuestPageLimitMessage(pageCount),
    });
  });
});
