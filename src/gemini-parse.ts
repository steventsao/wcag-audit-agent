// VLM producer. Gemini ingests the PDF natively and STREAMS semantic HTML; we split complete
// top-level blocks out of the stream and hand each to onBlock as it finishes. Self-contained in the
// Worker (one HTTPS call), no rasterizer, no node-graph. gemini-3-flash-preview @ thinkingLevel=low
// gives ~1.4s time-to-first-token (measured on a dense 10-K page).
import { GEMINI_MODEL, VLM_PROMPT, extractBlocks, stripFence } from './live-doc-core';

export interface StreamGeminiOpts {
  /** base64 PDF bytes. */
  bytesB64: string;
  apiKey: string;
  model?: string;
  /** called with each COMPLETE top-level HTML block as it streams out. */
  onBlock: (html: string) => Promise<void> | void;
}

/** Stream a PDF→HTML conversion from Gemini, emitting complete blocks progressively. */
export async function streamGeminiHtml(o: StreamGeminiOpts): Promise<void> {
  const model = o.model || GEMINI_MODEL;
  const body = {
    contents: [
      { parts: [{ inline_data: { mime_type: 'application/pdf', data: o.bytesB64 } }, { text: VLM_PROMPT }] },
    ],
    generationConfig: { temperature: 0, thinkingConfig: { thinkingLevel: 'low' } },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${o.apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`gemini ${res.status}: ${detail.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let sseBuf = '';
  let html = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuf += dec.decode(value, { stream: true });
    let nl: number;
    // SSE frames are `data: {json}` lines; JSON is single-line per event.
    while ((nl = sseBuf.indexOf('\n')) >= 0) {
      const line = sseBuf.slice(0, nl).trim();
      sseBuf = sseBuf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const js = line.slice(5).trim();
      if (!js || js === '[DONE]') continue;
      let obj: unknown;
      try {
        obj = JSON.parse(js);
      } catch {
        continue;
      }
      const text = geminiText(obj);
      if (!text) continue;
      html += text;
      const { blocks, rest } = extractBlocks(html);
      html = rest;
      for (const b of blocks) if (b) await o.onBlock(b);
    }
  }

  // flush any complete-but-unterminated tail
  const tail = stripFence(html).trim();
  if (tail) await o.onBlock(tail);
}

function geminiText(obj: unknown): string {
  const o = obj as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const parts = o?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => p.text || '').join('');
}

/**
 * One-shot (non-streaming) Gemini text completion. Backs the A11yAgent's conversational `chat()` surface —
 * answers a user question grounded in the live audit state. Mirrors streamGeminiHtml's auth/endpoint, but
 * a single generateContent call (no SSE) since the reply is short.
 */
export async function geminiComplete(apiKey: string, prompt: string, model?: string): Promise<string> {
  const m = model || GEMINI_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, thinkingConfig: { thinkingLevel: 'low' } },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`gemini ${res.status}: ${detail.slice(0, 200)}`);
  }
  const obj = await res.json().catch(() => null);
  return geminiText(obj).trim() || '(no reply)';
}
