/** Guards for the private audit and attestation API. Keep the live /s and MCP surfaces separate. */
export const MAX_AUDIT_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_AUDIT_REQUEST_BYTES = 28 * 1024 * 1024; // 20 MiB PDF after base64 + JSON
export const MAX_CONTROL_REQUEST_BYTES = 128 * 1024;

export async function bearerMatches(request: Request, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;
  const supplied = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') || '')?.[1];
  if (!supplied) return false;
  const hash = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([hash(supplied), hash(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a[i] ^ b[i];
  return difference === 0;
}

export function newAuditOwnerToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashAuditOwnerToken(token: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function ownerHashMatches(expected: string | undefined, supplied: string | undefined): boolean {
  if (!expected || !supplied || expected.length !== 64 || supplied.length !== 64) return false;
  let difference = 0;
  for (let i = 0; i < 64; i += 1) difference |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  return difference === 0;
}

/** Read a request with an actual streamed byte cap; Content-Length is only an early hint. */
export async function boundedRequest(request: Request, maxBytes: number): Promise<Request> {
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new Error('request_too_large');
  const reader = request.body?.getReader();
  if (!reader) return request;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('request_too_large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const headers = new Headers(request.headers);
  headers.set('content-length', String(size));
  return new Request(request.url, { method: request.method, headers, body: bytes.buffer as ArrayBuffer });
}
