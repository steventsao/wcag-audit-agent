import { describe, expect, it } from 'vitest';
import { bearerMatches, boundedRequest, hashAuditOwnerToken, newAuditOwnerToken, ownerHashMatches } from './audit-security';

describe('private audit guards', () => {
  it('fails closed for missing configuration and rejects a wrong bearer', async () => {
    const good = new Request('https://example.org/audit', { headers: { authorization: 'Bearer secret' } });
    const bad = new Request('https://example.org/audit', { headers: { authorization: 'Bearer other' } });
    expect(await bearerMatches(good, undefined)).toBe(false);
    expect(await bearerMatches(good, 'secret')).toBe(true);
    expect(await bearerMatches(bad, 'secret')).toBe(false);
  });

  it('mints unique owner capabilities and hashes them before storage', async () => {
    const first = newAuditOwnerToken();
    const second = newAuditOwnerToken();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
    expect(await hashAuditOwnerToken(first)).not.toBe(first);
    expect(await hashAuditOwnerToken(first)).not.toBe(await hashAuditOwnerToken(second));
    expect(ownerHashMatches(await hashAuditOwnerToken(first), await hashAuditOwnerToken(first))).toBe(true);
    expect(ownerHashMatches(await hashAuditOwnerToken(first), await hashAuditOwnerToken(second))).toBe(false);
    expect(ownerHashMatches(undefined, await hashAuditOwnerToken(first))).toBe(false);
  });

  it('enforces the actual streamed request size without Content-Length', async () => {
    const request = new Request('https://example.org/audit', { method: 'POST', body: '123456' });
    await expect(boundedRequest(request, 5)).rejects.toThrow('request_too_large');
  });

  it('preserves a request within the byte limit', async () => {
    const request = new Request('https://example.org/audit', { method: 'POST', body: '1234' });
    const bounded = await boundedRequest(request, 5);
    expect(await bounded.text()).toBe('1234');
  });
});
