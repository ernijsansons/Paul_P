import { describe, expect, it } from 'vitest';
import {
  constants as cryptoConstants,
  generateKeyPairSync,
  verify as nodeVerify,
} from 'node:crypto';
import type { Env } from '../../src/types/env';
import { generateKalshiAuthHeaders, requiresAuth, validateApiKey } from '../../src/lib/kalshi/auth';

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'test',
    SYSTEM_NAME: 'Paul P',
    KALSHI_API_KEY: 'f5dab4a7-1cc5-437f-bc39-5cbf2351d613',
    KALSHI_PRIVATE_KEY: '',
    ...overrides,
  } as Env;
}

describe('kalshi auth helpers', () => {
  it('generates ACCESS headers with millisecond timestamp and verifiable signature', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });

    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const env = createEnv({ KALSHI_PRIVATE_KEY: privatePem });

    const path = '/trade-api/v2/portfolio/balance';
    const result = await generateKalshiAuthHeaders(env, 'GET', path);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value['KALSHI-ACCESS-KEY']).toBe(env.KALSHI_API_KEY);
    expect(result.value['KALSHI-ACCESS-SIGNATURE']).toBeTruthy();
    expect(result.value['KALSHI-ACCESS-TIMESTAMP']).toMatch(/^\d{13}$/);

    const message = `${result.value['KALSHI-ACCESS-TIMESTAMP']}GET${path}`;
    const signature = result.value['KALSHI-ACCESS-SIGNATURE'];
    expect(signature).toBeTruthy();

    const verified = nodeVerify(
      'sha256',
      Buffer.from(message, 'utf8'),
      {
        key: publicPem,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      },
      Buffer.from(signature ?? '', 'base64')
    );

    expect(verified).toBe(true);
  });

  it('supports PKCS#1 RSA private keys', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });

    const pkcs1Pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const env = createEnv({ KALSHI_PRIVATE_KEY: pkcs1Pem });

    const result = await generateKalshiAuthHeaders(env, 'GET', '/trade-api/v2/portfolio/balance');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const signature = result.value['KALSHI-ACCESS-SIGNATURE'];
    expect(signature).toBeTruthy();
    expect((signature ?? '').length).toBeGreaterThan(0);
  });

  it('fails closed when required credentials are missing', async () => {
    const missingApiKey = await generateKalshiAuthHeaders(
      createEnv({ KALSHI_API_KEY: '' }),
      'GET',
      '/trade-api/v2/portfolio/balance'
    );
    expect(missingApiKey.ok).toBe(false);
    if (!missingApiKey.ok) {
      expect(missingApiKey.error.message).toContain('KALSHI_API_KEY');
    }

    const missingPrivate = await generateKalshiAuthHeaders(
      createEnv({ KALSHI_PRIVATE_KEY: '' }),
      'GET',
      '/trade-api/v2/portfolio/balance'
    );
    expect(missingPrivate.ok).toBe(false);
    if (!missingPrivate.ok) {
      expect(missingPrivate.error.message).toContain('KALSHI_PRIVATE_KEY');
    }
  });

  it('auth requirement classifier is fail-closed and query-safe', () => {
    expect(requiresAuth('/trade-api/v2/markets')).toBe(false);
    expect(requiresAuth('/trade-api/v2/markets/INX-26FEB28-B5000/trades')).toBe(false);
    expect(requiresAuth('/trade-api/v2/markets/INX-26FEB28-B5000/orderbook?depth=1')).toBe(false);
    expect(requiresAuth('/trade-api/v2/portfolio/balance')).toBe(true);
    expect(requiresAuth('/unknown/path')).toBe(true);
  });

  it('validates Kalshi API key as UUID', () => {
    expect(validateApiKey('f5dab4a7-1cc5-437f-bc39-5cbf2351d613')).toBe(true);
    expect(validateApiKey('not-a-uuid')).toBe(false);
  });
});
