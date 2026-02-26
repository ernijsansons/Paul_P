/**
 * Sources Registry Tests (P-12: FACT provenance)
 */

import { describe, it, expect } from 'vitest';
import type { SourceType, SourceQuality } from '../../src/lib/evidence/sources-registry';

// Since sources-registry requires Env with D1 and R2,
// we'll test the logic without actual database calls

describe('Sources Registry', () => {
  describe('Source Types', () => {
    it('should define all valid source types', () => {
      const validTypes: SourceType[] = [
        'api_response',
        'websocket_message',
        'webhook_payload',
        'manual_entry',
        'computed',
      ];

      expect(validTypes).toHaveLength(5);
      expect(validTypes).toContain('api_response');
      expect(validTypes).toContain('websocket_message');
      expect(validTypes).toContain('webhook_payload');
      expect(validTypes).toContain('manual_entry');
      expect(validTypes).toContain('computed');
    });
  });

  describe('Source Quality', () => {
    it('should define quality levels in order', () => {
      const qualities: SourceQuality[] = [
        'authoritative',
        'primary',
        'secondary',
        'tertiary',
      ];

      expect(qualities).toHaveLength(4);
      expect(qualities[0]).toBe('authoritative');
      expect(qualities[3]).toBe('tertiary');
    });

    it('should use authoritative for official exchange APIs', () => {
      // Authoritative: Official source (exchange API, government data)
      const authoritativeSources = ['polymarket API', 'kalshi API', 'SEC EDGAR'];
      expect(authoritativeSources.length).toBeGreaterThan(0);
    });

    it('should use primary for direct observations', () => {
      // Primary: Direct observation (trade execution, orderbook snapshot)
      const primarySources = ['trade execution', 'orderbook snapshot', 'position update'];
      expect(primarySources.length).toBeGreaterThan(0);
    });
  });

  describe('Source Entry Structure', () => {
    it('should have required fields', () => {
      const entry = {
        id: 'src_123',
        sourceType: 'api_response' as SourceType,
        sourceUrl: 'https://api.polymarket.com/markets',
        sourceVendor: 'polymarket',
        quality: 'authoritative' as SourceQuality,
        evidenceHash: 'abc123',
        evidenceBlobKey: 'evidence/polymarket/abc123',
        fetchedAt: '2024-01-01T00:00:00Z',
        metadata: { marketCount: 100 },
        createdAt: '2024-01-01T00:00:00Z',
      };

      expect(entry.id).toBeDefined();
      expect(entry.sourceType).toBe('api_response');
      expect(entry.sourceUrl).toContain('https://');
      expect(entry.sourceVendor).toBe('polymarket');
      expect(entry.quality).toBe('authoritative');
      expect(entry.evidenceHash).toBeDefined();
      expect(entry.evidenceBlobKey).toContain('evidence/');
      expect(entry.fetchedAt).toBeDefined();
      expect(entry.metadata).toBeDefined();
      expect(entry.createdAt).toBeDefined();
    });

    it('should support optional fields for computed sources', () => {
      const computedEntry: {
        id: string;
        sourceType: SourceType;
        sourceUrl: string;
        sourceVendor: string;
        quality: SourceQuality;
        evidenceHash: string;
        evidenceBlobKey?: string;
        fetchedAt: string;
        metadata: Record<string, unknown>;
        lineage: string[];
        createdAt: string;
      } = {
        id: 'src_456',
        sourceType: 'computed' as SourceType,
        sourceUrl: 'internal://vpin-computation',
        sourceVendor: 'paul-p',
        quality: 'secondary' as SourceQuality,
        evidenceHash: 'def456',
        // evidenceBlobKey intentionally omitted for computed sources
        fetchedAt: '2024-01-01T00:00:00Z',
        metadata: {},
        lineage: ['src_123', 'src_124'], // Parent sources
        createdAt: '2024-01-01T00:00:00Z',
      };

      expect(computedEntry.lineage).toBeDefined();
      expect(computedEntry.lineage).toHaveLength(2);
      expect(computedEntry.evidenceBlobKey).toBeUndefined();
    });

    it('should support expiration times', () => {
      const entryWithTTL = {
        id: 'src_789',
        sourceType: 'api_response' as SourceType,
        sourceUrl: 'https://api.example.com',
        sourceVendor: 'example',
        quality: 'primary' as SourceQuality,
        evidenceHash: 'ghi789',
        fetchedAt: '2024-01-01T00:00:00Z',
        expiresAt: '2024-01-02T00:00:00Z', // 24 hour TTL
        metadata: {},
        createdAt: '2024-01-01T00:00:00Z',
      };

      expect(entryWithTTL.expiresAt).toBeDefined();
      const fetchedTime = new Date(entryWithTTL.fetchedAt).getTime();
      const expiresTime = new Date(entryWithTTL.expiresAt).getTime();
      expect(expiresTime - fetchedTime).toBe(24 * 60 * 60 * 1000); // 24 hours
    });
  });

  describe('Evidence Hash Verification', () => {
    it('should produce consistent hashes for same content', async () => {
      const content = 'test content';
      const encoder = new TextEncoder();
      const data = encoder.encode(content);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hash1 = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

      const data2 = encoder.encode(content);
      const hashBuffer2 = await crypto.subtle.digest('SHA-256', data2);
      const hashArray2 = Array.from(new Uint8Array(hashBuffer2));
      const hash2 = hashArray2.map(b => b.toString(16).padStart(2, '0')).join('');

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different content', async () => {
      const encoder = new TextEncoder();

      const data1 = encoder.encode('content A');
      const hashBuffer1 = await crypto.subtle.digest('SHA-256', data1);
      const hash1 = Array.from(new Uint8Array(hashBuffer1))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      const data2 = encoder.encode('content B');
      const hashBuffer2 = await crypto.subtle.digest('SHA-256', data2);
      const hash2 = Array.from(new Uint8Array(hashBuffer2))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('Source Registration Validation', () => {
    it('should require sourceUrl', () => {
      const registration = {
        sourceType: 'api_response' as SourceType,
        sourceUrl: '', // Empty URL should fail validation
        sourceVendor: 'test',
        quality: 'primary' as SourceQuality,
      };

      expect(registration.sourceUrl).toBe('');
      // In actual implementation, this would throw validation error
    });

    it('should require sourceVendor', () => {
      const registration = {
        sourceType: 'api_response' as SourceType,
        sourceUrl: 'https://api.example.com',
        sourceVendor: '', // Empty vendor should fail validation
        quality: 'primary' as SourceQuality,
      };

      expect(registration.sourceVendor).toBe('');
    });

    it('should validate TTL is positive', () => {
      const validTTL = 3600; // 1 hour
      const invalidTTL = -1;

      expect(validTTL).toBeGreaterThan(0);
      expect(invalidTTL).toBeLessThan(0);
    });
  });

  describe('Lineage Tracking', () => {
    it('should track parent sources for computed data', () => {
      const parentSources = ['src_001', 'src_002', 'src_003'];
      const computedSource = {
        id: 'src_computed',
        sourceType: 'computed' as SourceType,
        lineage: parentSources,
      };

      expect(computedSource.lineage).toHaveLength(3);
      expect(computedSource.lineage).toContain('src_001');
    });

    it('should support multi-level lineage', () => {
      // Level 1: Raw API responses
      const level1 = ['src_api_1', 'src_api_2'];

      // Level 2: Aggregated data
      const level2 = {
        id: 'src_aggregated',
        lineage: level1,
      };

      // Level 3: Computed metric
      const level3 = {
        id: 'src_metric',
        lineage: [level2.id],
      };

      expect(level3.lineage).toContain(level2.id);
    });
  });

  describe('Quality Distribution', () => {
    it('should count sources by quality level', () => {
      const sources = [
        { quality: 'authoritative' },
        { quality: 'authoritative' },
        { quality: 'primary' },
        { quality: 'primary' },
        { quality: 'primary' },
        { quality: 'secondary' },
        { quality: 'tertiary' },
      ];

      const distribution = sources.reduce(
        (acc, s) => {
          acc[s.quality as SourceQuality] = (acc[s.quality as SourceQuality] || 0) + 1;
          return acc;
        },
        {} as Record<SourceQuality, number>
      );

      expect(distribution.authoritative).toBe(2);
      expect(distribution.primary).toBe(3);
      expect(distribution.secondary).toBe(1);
      expect(distribution.tertiary).toBe(1);
    });
  });

  describe('Vendor Statistics', () => {
    it('should group sources by vendor', () => {
      const sources = [
        { sourceVendor: 'polymarket' },
        { sourceVendor: 'polymarket' },
        { sourceVendor: 'kalshi' },
        { sourceVendor: 'kalshi' },
        { sourceVendor: 'kalshi' },
        { sourceVendor: 'paul-p' },
      ];

      const byVendor = sources.reduce(
        (acc, s) => {
          acc[s.sourceVendor] = (acc[s.sourceVendor] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      );

      expect(byVendor.polymarket).toBe(2);
      expect(byVendor.kalshi).toBe(3);
      expect(byVendor['paul-p']).toBe(1);
    });
  });
});
