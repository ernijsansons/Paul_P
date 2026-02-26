/**
 * Paul P - Evidence Store Tests
 *
 * Tests for evidence-first architecture:
 * - SHA-256 hashing
 * - Compression/decompression
 * - Idempotency key generation
 * - Deterministic ID generation
 */

import { describe, it, expect } from 'vitest';
import {
  sha256,
  sha256String,
  sha256Json,
  computeIdempotencyKey,
  computePositionId,
  computeCanonicalMarketId,
  verifyHash,
} from '../../src/lib/evidence/hasher';

describe('SHA-256 Hashing', () => {
  it('should compute consistent hash for ArrayBuffer', async () => {
    const data = new TextEncoder().encode('hello world');
    const hash1 = await sha256(data);
    const hash2 = await sha256(data);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // 256 bits = 64 hex chars
  });

  it('should compute different hash for different data', async () => {
    const data1 = new TextEncoder().encode('hello');
    const data2 = new TextEncoder().encode('world');

    const hash1 = await sha256(data1);
    const hash2 = await sha256(data2);

    expect(hash1).not.toBe(hash2);
  });

  it('should hash empty data', async () => {
    const empty = new Uint8Array(0);
    const hash = await sha256(empty);

    expect(hash).toHaveLength(64);
    // Known SHA-256 of empty string
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('SHA-256 String Hashing', () => {
  it('should hash strings correctly', async () => {
    const hash = await sha256String('hello world');

    expect(hash).toHaveLength(64);
    // Known SHA-256 of "hello world"
    expect(hash).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('should handle unicode strings', async () => {
    const hash = await sha256String('Hello 世界');

    expect(hash).toHaveLength(64);
  });
});

describe('SHA-256 JSON Hashing', () => {
  it('should hash JSON objects consistently', async () => {
    const obj = { foo: 'bar', num: 42 };
    const hash1 = await sha256Json(obj);
    const hash2 = await sha256Json(obj);

    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different objects', async () => {
    const obj1 = { foo: 'bar' };
    const obj2 = { foo: 'baz' };

    const hash1 = await sha256Json(obj1);
    const hash2 = await sha256Json(obj2);

    expect(hash1).not.toBe(hash2);
  });

  it('should handle nested objects', async () => {
    const obj = {
      outer: {
        inner: {
          value: 'deep',
        },
      },
      array: [1, 2, 3],
    };

    const hash = await sha256Json(obj);
    expect(hash).toHaveLength(64);
  });
});

describe('Idempotency Key Generation', () => {
  it('should generate consistent keys for same inputs', async () => {
    const key1 = await computeIdempotencyKey('submit_order', 'TICKER-123', 'YES', 'BUY');
    const key2 = await computeIdempotencyKey('submit_order', 'TICKER-123', 'YES', 'BUY');

    expect(key1).toBe(key2);
  });

  it('should generate different keys for different operations', async () => {
    const key1 = await computeIdempotencyKey('submit_order', 'TICKER-123');
    const key2 = await computeIdempotencyKey('cancel_order', 'TICKER-123');

    expect(key1).not.toBe(key2);
  });

  it('should handle numeric arguments', async () => {
    const key = await computeIdempotencyKey('order', 'ticker', 100, true);

    expect(key).toHaveLength(64);
  });
});

describe('Position ID Generation', () => {
  it('should generate deterministic position IDs', async () => {
    const id1 = await computePositionId('0x1234abcd', 'cond-123', 'YES');
    const id2 = await computePositionId('0x1234abcd', 'cond-123', 'YES');

    expect(id1).toBe(id2);
    expect(id1).toMatch(/^pos_[a-f0-9]{32}$/);
  });

  it('should generate different IDs for different wallets', async () => {
    const id1 = await computePositionId('0x1111', 'cond-123', 'YES');
    const id2 = await computePositionId('0x2222', 'cond-123', 'YES');

    expect(id1).not.toBe(id2);
  });

  it('should generate different IDs for different sides', async () => {
    const id1 = await computePositionId('0x1234', 'cond-123', 'YES');
    const id2 = await computePositionId('0x1234', 'cond-123', 'NO');

    expect(id1).not.toBe(id2);
  });
});

describe('Canonical Market ID Generation', () => {
  it('should generate deterministic canonical market IDs', async () => {
    const id1 = await computeCanonicalMarketId('us-election-2028', 'polymarket', '0xcond123');
    const id2 = await computeCanonicalMarketId('us-election-2028', 'polymarket', '0xcond123');

    expect(id1).toBe(id2);
    expect(id1).toMatch(/^cm_[a-f0-9]{32}$/);
  });

  it('should generate different IDs for different venues', async () => {
    const id1 = await computeCanonicalMarketId('event-1', 'polymarket', 'market-id');
    const id2 = await computeCanonicalMarketId('event-1', 'kalshi', 'market-id');

    expect(id1).not.toBe(id2);
  });

  it('should generate different IDs for different events', async () => {
    const id1 = await computeCanonicalMarketId('event-1', 'polymarket', 'market-id');
    const id2 = await computeCanonicalMarketId('event-2', 'polymarket', 'market-id');

    expect(id1).not.toBe(id2);
  });
});

describe('Hash Verification', () => {
  it('should verify correct hash', async () => {
    const data = new TextEncoder().encode('test data');
    const hash = await sha256(data);

    const isValid = await verifyHash(data, hash);
    expect(isValid).toBe(true);
  });

  it('should reject incorrect hash', async () => {
    const data = new TextEncoder().encode('test data');
    const wrongHash = 'a'.repeat(64);

    const isValid = await verifyHash(data, wrongHash);
    expect(isValid).toBe(false);
  });

  it('should reject hash of different data', async () => {
    const data1 = new TextEncoder().encode('data 1');
    const data2 = new TextEncoder().encode('data 2');
    const hash1 = await sha256(data1);

    const isValid = await verifyHash(data2, hash1);
    expect(isValid).toBe(false);
  });
});
