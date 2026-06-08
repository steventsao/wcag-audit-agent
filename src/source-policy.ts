// Minimal content-rights gate for URL ingest. The /live session is private + ephemeral + noindex
// (never a public mirror), so the binding constraint is: NEVER defeat an access control and NEVER
// fetch an L3 (license/permission-gated) source. Everything else a user explicitly pastes is treated
// as a private, user-asserted parse (P) — they're viewing it, not publishing it. This is the minimal
// subset of the host taxonomy the standalone worker needs.

export interface UrlGate {
  ok: boolean;
  level: 'L0' | 'L1' | 'P' | 'L3';
  reason: string;
}

// L3 — license/permission-gated or access-controlled. Hard block: do not fetch or parse.
const L3_HOST_PATTERNS: RegExp[] = [/(^|\.)hkexnews\.hk$/i];

// SSRF guard. A public PDF URL must NEVER be used to reach an internal / loopback / link-local address —
// that "defeats a network access control" (the DMCA §1201 / CFAA line) and would let an
// unauthenticated view_html caller exfiltrate cloud metadata (169.254.169.254) or internal services. We
// block IP-literal hosts in private/reserved ranges (incl. integer/hex IPv4 and all IPv6 literals) plus
// internal hostnames. NOTE: this does NOT stop DNS rebinding — a *public* hostname that resolves to a
// private IP at fetch time — which needs resolve-then-pin that Workers `fetch` can't express. Residual risk.
const BLOCKED_HOST_EXACT = new Set(['localhost', 'metadata.google.internal', 'metadata.goog', '0.0.0.0']);
export function isBlockedNetworkHost(rawHost: string): boolean {
  let host = rawHost.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // unwrap IPv6 brackets
  if (host === '' || BLOCKED_HOST_EXACT.has(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return true;
  if (host.includes(':')) return true; // any IPv6 literal — public IPv6-literal PDF hosts are vanishingly rare
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some((n) => n > 255)) return true; // malformed dotted-quad → block
    const [a, b] = o;
    if (a === 0 || a === 10 || a === 127) return true; // 0/8, 10/8, loopback 127/8
    if (a === 169 && b === 254) return true; // link-local 169.254/16 (incl. AWS/GCP metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a === 192 && b === 0 && o[2] === 0) return true; // 192.0.0/24 (IETF protocol assignments)
    if (a >= 224) return true; // multicast 224/4 + reserved 240/4
    return false; // any other dotted-quad = public IPv4, allow
  }
  if (/^(0x[0-9a-f]+|\d+)$/.test(host)) return true; // integer/hex IPv4 encoding (e.g. 2130706433 = 127.0.0.1)
  return false;
}

// L0 — open / public-record / public-domain (full transform is fine).
const L0_HOST_PATTERNS: RegExp[] = [
  /(^|\.)sec\.gov$/i,
  /(^|\.)govinfo\.gov$/i,
  /(^|\.)federalregister\.gov$/i,
  /(^|\.)gutenberg\.org$/i,
];

// L1 — copyrighted but lawfully reachable (e.g. arXiv default license). Fetchable for a private view.
const L1_HOST_PATTERNS: RegExp[] = [/(^|\.)arxiv\.org$/i];

/**
 * Gate a public PDF URL before any fetch. Allows L0/L1 and unknown hosts as a private (P) user-asserted
 * parse; blocks L3 and any non-http(s) / access-control-defeating scheme. The session never publishes a
 * public mirror, so a private render to the requester is the favored, policy-safe path.
 */
export function assertUrlIngestAllowed(rawUrl: string): UrlGate {
  let host: string;
  let scheme: string;
  try {
    const u = new URL(rawUrl);
    host = u.hostname;
    scheme = u.protocol;
  } catch {
    return { ok: false, level: 'L3', reason: 'Invalid URL.' };
  }
  if (scheme !== 'http:' && scheme !== 'https:') {
    return { ok: false, level: 'L3', reason: 'Only http(s) URLs are allowed.' };
  }
  if (isBlockedNetworkHost(host)) {
    return { ok: false, level: 'L3', reason: `${host} is an internal/reserved address — refusing to fetch (that would defeat a network access control).` };
  }
  if (L3_HOST_PATTERNS.some((re) => re.test(host))) {
    return { ok: false, level: 'L3', reason: `${host} is license/permission-gated (L3) — cannot fetch. Upload the file you lawfully obtained instead.` };
  }
  if (L0_HOST_PATTERNS.some((re) => re.test(host))) {
    return { ok: true, level: 'L0', reason: `${host} is an open/public-record source (L0).` };
  }
  if (L1_HOST_PATTERNS.some((re) => re.test(host))) {
    return { ok: true, level: 'L1', reason: `${host} is lawfully reachable (L1) — rendered privately for you, not published.` };
  }
  return { ok: true, level: 'P', reason: `${host} unclassified — treated as a private, user-asserted view (P); never published.` };
}
