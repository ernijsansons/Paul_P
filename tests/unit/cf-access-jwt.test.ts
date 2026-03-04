import { describe, expect, it, beforeEach, vi } from 'vitest';
import { validateCFAccessJWT, clearKeyCache } from '../../src/lib/security/cf-access-jwt';

describe('CF Access JWT Validation', () => {
  beforeEach(() => {
    clearKeyCache();
    vi.restoreAllMocks();
  });

  describe('validateCFAccessJWT', () => {
    it('rejects invalid JWT format (not a JWT)', async () => {
      // Mock fetch to return valid cert response (so we test JWT parsing, not fetch)
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          public_certs: [{
            kid: 'test-kid',
            cert: '-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAKHBfpegNEa/MA0GCSqGSIb3DQEBCwUAMBExDzANBgNVBAMMBnVudXNlZDAeFw0yNDAxMDEwMDAwMDBaFw0yNTAxMDEwMDAwMDBaMBExDzANBgNVBAMMBnVudXNlZDBcMA0GCSqGSIb3DQEBAQUAA0sAMEgCQQC7o96FCFzN5Ph5P5uAXHUP8GcQtNTqRVbGxXkx1/oRuAI5e9XDZ1eJ8v1VZj+8qFLy5dAsMnkz+M3k5+zyqBn9AgMBAAGjUDBOMB0GA1UdDgQWBBT5ePXmfdJ7K6qBWrVCnvJlVKkYKjAfBgNVHSMEGDAWgBT5ePXmfdJ7K6qBWrVCnvJlVKkYKjAMBgNVHRMEBTADAQH/MA0GCSqGSIb3DQEBCwUAA0EAY2CfgZrT2FcNwRXA8LY8LGlA9V5M5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A==\n-----END CERTIFICATE-----'
          }]
        })
      }));

      const result = await validateCFAccessJWT(
        'not-a-jwt',
        'team.cloudflareaccess.com',
        'aud123'
      );

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBeDefined();
      }
    });

    it('rejects JWT with invalid signature', async () => {
      // Mock fetch to return valid cert response
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          public_certs: [{
            kid: 'test-kid',
            cert: '-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAKHBfpegNEa/MA0GCSqGSIb3DQEBCwUAMBExDzANBgNVBAMMBnVudXNlZDAeFw0yNDAxMDEwMDAwMDBaFw0yNTAxMDEwMDAwMDBaMBExDzANBgNVBAMMBnVudXNlZDBcMA0GCSqGSIb3DQEBAQUAA0sAMEgCQQC7o96FCFzN5Ph5P5uAXHUP8GcQtNTqRVbGxXkx1/oRuAI5e9XDZ1eJ8v1VZj+8qFLy5dAsMnkz+M3k5+zyqBn9AgMBAAGjUDBOMB0GA1UdDgQWBBT5ePXmfdJ7K6qBWrVCnvJlVKkYKjAfBgNVHSMEGDAWgBT5ePXmfdJ7K6qBWrVCnvJlVKkYKjAMBgNVHRMEBTADAQH/MA0GCSqGSIb3DQEBCwUAA0EAY2CfgZrT2FcNwRXA8LY8LGlA9V5M5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A==\n-----END CERTIFICATE-----'
          }]
        })
      }));

      // A JWT with valid format but invalid/spoofed signature
      const fakeJwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20iLCJhdWQiOlsiYXVkMTIzIl0sImlzcyI6Imh0dHBzOi8vdGVhbS5jbG91ZGZsYXJlYWNjZXNzLmNvbSIsInN1YiI6InVzZXIxMjMiLCJpYXQiOjE3MDQwNjcyMDAsImV4cCI6MTczNTY4OTYwMH0.fake-signature';

      const result = await validateCFAccessJWT(
        fakeJwt,
        'team.cloudflareaccess.com',
        'aud123'
      );

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('failed');
      }
    });

    it('handles fetch error when retrieving certs', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      }));

      const result = await validateCFAccessJWT(
        'any-jwt',
        'team.cloudflareaccess.com',
        'aud123'
      );

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('Failed to fetch CF Access certs');
      }
    });

    it('returns error when no public keys available', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          public_certs: [],
        })
      }));

      const result = await validateCFAccessJWT(
        'any-jwt',
        'team.cloudflareaccess.com',
        'aud123'
      );

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('No CF Access public keys');
      }
    });

    it('imports keys from JWK format (keys array)', async () => {
      // Mock fetch to return JWK keys format (no public_certs)
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          keys: [{
            kid: 'jwk-key-1',
            kty: 'RSA',
            alg: 'RS256',
            use: 'sig',
            // These are valid RSA key parameters (from a test key)
            e: 'AQAB',
            n: 'u5o9pcFFLMFBPVmNZsrOvKBnNYmJPQYrC9TXuJdGHNfQ6u1oZTSG_dZMK9Jdw0FNfOFO8BvH2QXAM-4nGdh8wKoaXPaT3_NKQzrmA-C3dWJTJJRYJEKQEqQnrRdWlvDIWIXJv9bKFE4m9pP4qFxU5lXM0eC_nLzSLzBLQQw'
          }],
          public_certs: []  // Empty certs, only JWK keys
        })
      }));

      // A JWT with valid format but won't verify (we just test key import works)
      const testJwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20ifQ.fake';

      const result = await validateCFAccessJWT(
        testJwt,
        'team.cloudflareaccess.com',
        'aud123'
      );

      // Should fail signature verification (fake signature) but NOT fail with "no keys"
      expect(result.valid).toBe(false);
      if (!result.valid) {
        // Error should be about signature, not missing keys
        expect(result.error).not.toContain('No CF Access public keys');
        expect(result.error).toContain('failed');
      }
    });

    it('uses JWK keys when public_certs is missing entirely', async () => {
      // Some tenants might only return keys array without public_certs field
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          keys: [{
            kid: 'jwk-only-key',
            kty: 'RSA',
            alg: 'RS256',
            use: 'sig',
            e: 'AQAB',
            n: 'u5o9pcFFLMFBPVmNZsrOvKBnNYmJPQYrC9TXuJdGHNfQ6u1oZTSG_dZMK9Jdw0FNfOFO8BvH2QXAM-4nGdh8wKoaXPaT3_NKQzrmA-C3dWJTJJRYJEKQEqQnrRdWlvDIWIXJv9bKFE4m9pP4qFxU5lXM0eC_nLzSLzBLQQw'
          }]
          // No public_certs or public_cert fields
        })
      }));

      const testJwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20ifQ.fake';

      const result = await validateCFAccessJWT(
        testJwt,
        'team.cloudflareaccess.com',
        'aud123'
      );

      // Should attempt verification with JWK key, not fail with "no keys"
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).not.toContain('No CF Access public keys');
      }
    });
  });

  describe('cache behavior', () => {
    it('caches keys by team domain', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          public_certs: [{
            kid: 'test-kid',
            cert: '-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAKHBfpegNEa/MA0GCSqGSIb3DQEBCwUAMBExDzANBgNVBAMMBnVudXNlZDAeFw0yNDAxMDEwMDAwMDBaFw0yNTAxMDEwMDAwMDBaMBExDzANBgNVBAMMBnVudXNlZDBcMA0GCSqGSIb3DQEBAQUAA0sAMEgCQQC7o96FCFzN5Ph5P5uAXHUP8GcQtNTqRVbGxXkx1/oRuAI5e9XDZ1eJ8v1VZj+8qFLy5dAsMnkz+M3k5+zyqBn9AgMBAAGjUDBOMB0GA1UdDgQWBBT5ePXmfdJ7K6qBWrVCnvJlVKkYKjAfBgNVHSMEGDAWgBT5ePXmfdJ7K6qBWrVCnvJlVKkYKjAMBgNVHRMEBTADAQH/MA0GCSqGSIb3DQEBCwUAA0EAY2CfgZrT2FcNwRXA8LY8LGlA9V5M5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A==\n-----END CERTIFICATE-----'
          }]
        })
      });
      vi.stubGlobal('fetch', fetchMock);

      // First call to team1 - JWT won't verify, so:
      // 1) fetch from cache (miss) = 1 fetch
      // 2) retry with fresh keys = 1 fetch
      await validateCFAccessJWT('jwt1', 'team1.cloudflareaccess.com', 'aud1');
      expect(fetchMock).toHaveBeenCalledTimes(2); // cache miss + retry

      // Second call to same team - cache hit for initial, but JWT still won't verify
      // So still does retry = 1 more fetch
      await validateCFAccessJWT('jwt2', 'team1.cloudflareaccess.com', 'aud1');
      expect(fetchMock).toHaveBeenCalledTimes(3); // +1 retry

      // Call to different team - new domain = 1 fetch, then retry = 1 fetch
      await validateCFAccessJWT('jwt3', 'team2.cloudflareaccess.com', 'aud2');
      expect(fetchMock).toHaveBeenCalledTimes(5); // +2 (cache miss + retry)
    });

    it('clearKeyCache clears all cached domains', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          public_certs: [{
            kid: 'test-kid',
            cert: '-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAKHBfpegNEa/MA0GCSqGSIb3DQEBCwUAMBExDzANBgNVBAMMBnVudXNlZDAeFw0yNDAxMDEwMDAwMDBaFw0yNTAxMDEwMDAwMDBaMBExDzANBgNVBAMMBnVudXNlZDBcMA0GCSqGSIb3DQEBAQUAA0sAMEgCQQC7o96FCFzN5Ph5P5uAXHUP8GcQtNTqRVbGxXkx1/oRuAI5e9XDZ1eJ8v1VZj+8qFLy5dAsMnkz+M3k5+zyqBn9AgMBAAGjUDBOMB0GA1UdDgQWBBT5ePXmfdJ7K6qBWrVCnvJlVKkYKjAfBgNVHSMEGDAWgBT5ePXmfdJ7K6qBWrVCnvJlVKkYKjAMBgNVHRMEBTADAQH/MA0GCSqGSIb3DQEBCwUAA0EAY2CfgZrT2FcNwRXA8LY8LGlA9V5M5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A==\n-----END CERTIFICATE-----'
          }]
        })
      });
      vi.stubGlobal('fetch', fetchMock);

      // Populate cache - 2 fetches (initial + retry due to verify failure)
      await validateCFAccessJWT('jwt1', 'team1.cloudflareaccess.com', 'aud1');
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Clear cache
      clearKeyCache();

      // Should fetch again - 2 more fetches (cache miss + retry)
      await validateCFAccessJWT('jwt2', 'team1.cloudflareaccess.com', 'aud1');
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('retries with fresh keys when verification fails (key rotation handling)', async () => {
      // Simulate key rotation: first fetch returns old key, retry returns new key
      let fetchCount = 0;
      const fetchMock = vi.fn().mockImplementation(() => {
        fetchCount++;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            public_certs: [{
              // Both return the same "old" cert that won't verify the JWT
              // The point is to verify that a retry (second fetch) happens
              kid: `test-kid-${fetchCount}`,
              cert: '-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAKHBfpegNEa/MA0GCSqGSIb3DQEBCwUAMBExDzANBgNVBAMMBnVudXNlZDAeFw0yNDAxMDEwMDAwMDBaFw0yNTAxMDEwMDAwMDBaMBExDzANBgNVBAMMBnVudXNlZDBcMA0GCSqGSIb3DQEBAQUAA0sAMEgCQQC7o96FCFzN5Ph5P5uAXHUP8GcQtNTqRVbGxXkx1/oRuAI5e9XDZ1eJ8v1VZj+8qFLy5dAsMnkz+M3k5+zyqBn9AgMBAAGjUDBOMB0GA1UdDgQWBBT5ePXmfdJ7K6qBWrVCnvJlVKkYKjAfBgNVHSMEGDAWgBT5ePXmfdJ7K6qBWrVCnvJlVKkYKjAMBgNVHRMEBTADAQH/MA0GCSqGSIb3DQEBCwUAA0EAY2CfgZrT2FcNwRXA8LY8LGlA9V5M5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A5e5A==\n-----END CERTIFICATE-----'
            }]
          })
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      // A JWT that won't verify with the test cert
      const fakeJwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20ifQ.fake';

      const result = await validateCFAccessJWT(
        fakeJwt,
        'team.cloudflareaccess.com',
        'aud123'
      );

      // Verification should fail (expected, since the cert doesn't match)
      expect(result.valid).toBe(false);

      // KEY TEST: fetch should be called TWICE - once for cache, once for retry
      // This proves the retry-on-failure logic is working
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
