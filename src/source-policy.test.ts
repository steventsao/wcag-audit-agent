import { describe, it, expect } from 'vitest';
import { assertUrlIngestAllowed, isBlockedNetworkHost } from './source-policy';

describe('isBlockedNetworkHost (SSRF guard)', () => {
  it('blocks loopback, link-local, private and reserved IPv4', () => {
    for (const h of [
      '127.0.0.1',
      '127.5.5.5',
      '0.0.0.0',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // AWS/GCP metadata
      '100.64.0.1', // CGNAT
      '192.0.0.1',
      '224.0.0.1', // multicast
      '255.255.255.255',
    ]) {
      expect(isBlockedNetworkHost(h), h).toBe(true);
    }
  });

  it('blocks internal hostnames and IPv6 literals', () => {
    for (const h of ['localhost', 'foo.localhost', 'svc.internal', 'box.local', 'metadata.google.internal', '::1', 'fe80::1', '[::1]', '']) {
      expect(isBlockedNetworkHost(h), h).toBe(true);
    }
  });

  it('blocks integer / hex IPv4 encodings and malformed quads', () => {
    for (const h of ['2130706433', '0x7f000001', '999.1.1.1']) {
      expect(isBlockedNetworkHost(h), h).toBe(true);
    }
  });

  it('allows ordinary public hosts and public IPv4', () => {
    for (const h of ['arxiv.org', 'www.sec.gov', 'files.catbox.moe', '8.8.8.8', '1.2.3.4']) {
      expect(isBlockedNetworkHost(h), h).toBe(false);
    }
  });

  it('assertUrlIngestAllowed refuses SSRF targets before classifying', () => {
    const meta = assertUrlIngestAllowed('http://169.254.169.254/latest/meta-data/');
    expect(meta.ok).toBe(false);
    expect(meta.level).toBe('L3');

    const local = assertUrlIngestAllowed('http://localhost:8787/x.pdf');
    expect(local.ok).toBe(false);

    // a normal L1 source still passes
    const arxiv = assertUrlIngestAllowed('https://arxiv.org/pdf/2401.00001.pdf');
    expect(arxiv.ok).toBe(true);
    expect(arxiv.level).toBe('L1');
  });
});
