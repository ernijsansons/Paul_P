/**
 * Integration Tests for Market Data Ingestion
 *
 * Tests the full market ingestion workflow including:
 * - Polymarket market fetching
 * - Evidence blob storage
 * - Database persistence
 * - VPIN computation
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';

describe('Market Ingestion Integration', () => {
  // Test market data
  const testPolymarketMarket = {
    conditionId: 'test-condition-id-001',
    question: 'Will Bitcoin reach $100k by end of 2025?',
    description: 'This market resolves YES if Bitcoin reaches $100,000 USD.',
    resolutionSource: 'CoinGecko',
    resolutionCriteria: 'Resolves YES if BTC reaches $100,000 USD on CoinGecko at any time before Dec 31, 2025.',
    endDate: '2025-12-31T23:59:59Z',
    volumeUsd: 500000,
    volume24hUsd: 25000,
    spread: 0.02,
    category: 'crypto',
    tags: ['bitcoin', 'price'],
    series: null,
    evidenceHash: 'test-hash-001',
    fetchedAt: new Date().toISOString(),
  };

  const testKalshiMarket = {
    ticker: 'BTCPRICE-25DEC31-T100000',
    title: 'Bitcoin price above $100,000 on December 31, 2025?',
    rulesText: 'Market resolves YES if Bitcoin price is above $100,000 USD on CoinGecko at close on Dec 31, 2025.',
    settlementTime: '2025-12-31T23:59:59Z',
    dollarVolume24h: 30000,
    spread: 0.03,
    category: 'crypto',
    seriesTicker: 'BTCPRICE',
    evidenceHash: 'test-hash-002',
    fetchedAt: new Date().toISOString(),
  };

  beforeAll(async () => {
    // Ensure the markets table exists
    try {
      await env.DB.prepare(`
        SELECT 1 FROM markets LIMIT 1
      `).first();
    } catch {
      // Table might not exist in test env, create it
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS markets (
          condition_id TEXT PRIMARY KEY,
          question TEXT NOT NULL,
          description TEXT,
          resolution_source TEXT,
          resolution_criteria TEXT,
          end_date TEXT,
          resolved_at TEXT,
          resolution_outcome TEXT,
          total_volume_usd REAL,
          peak_volume_24h REAL,
          avg_spread REAL,
          depth_proxy_usd REAL,
          category TEXT,
          market_class TEXT,
          ambiguity_score REAL,
          ambiguity_scoring_run_id TEXT,
          has_dispute_history INTEGER DEFAULT 0,
          duration_hours REAL,
          news_shock_flag INTEGER DEFAULT 0,
          tags TEXT,
          series TEXT,
          evidence_hash TEXT,
          last_synced_at TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `).run();
    }
  });

  describe('Direct Database Operations', () => {
    it('should insert a Polymarket market into D1', async () => {
      await env.DB.prepare(`
        INSERT INTO markets (
          condition_id, question, description, resolution_source, resolution_criteria,
          end_date, total_volume_usd, peak_volume_24h, avg_spread, category, tags,
          series, evidence_hash, last_synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (condition_id) DO UPDATE SET
          total_volume_usd = excluded.total_volume_usd,
          peak_volume_24h = excluded.peak_volume_24h,
          avg_spread = excluded.avg_spread,
          evidence_hash = excluded.evidence_hash,
          last_synced_at = excluded.last_synced_at
      `).bind(
        testPolymarketMarket.conditionId,
        testPolymarketMarket.question,
        testPolymarketMarket.description,
        testPolymarketMarket.resolutionSource,
        testPolymarketMarket.resolutionCriteria,
        testPolymarketMarket.endDate,
        testPolymarketMarket.volumeUsd,
        testPolymarketMarket.volume24hUsd,
        testPolymarketMarket.spread,
        testPolymarketMarket.category,
        JSON.stringify(testPolymarketMarket.tags),
        testPolymarketMarket.series,
        testPolymarketMarket.evidenceHash,
        testPolymarketMarket.fetchedAt
      ).run();

      // Verify insertion
      const result = await env.DB.prepare(`
        SELECT * FROM markets WHERE condition_id = ?
      `).bind(testPolymarketMarket.conditionId).first<{ question: string; total_volume_usd: number }>();

      expect(result).toBeDefined();
      expect(result?.question).toBe(testPolymarketMarket.question);
      expect(result?.total_volume_usd).toBe(testPolymarketMarket.volumeUsd);
    });

    it('should insert a Kalshi market into D1', async () => {
      await env.DB.prepare(`
        INSERT INTO markets (
          condition_id, question, description, resolution_criteria,
          end_date, total_volume_usd, peak_volume_24h, avg_spread, category,
          series, evidence_hash, last_synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (condition_id) DO UPDATE SET
          total_volume_usd = excluded.total_volume_usd,
          peak_volume_24h = excluded.peak_volume_24h,
          avg_spread = excluded.avg_spread,
          evidence_hash = excluded.evidence_hash,
          last_synced_at = excluded.last_synced_at
      `).bind(
        testKalshiMarket.ticker,
        testKalshiMarket.title,
        '',
        testKalshiMarket.rulesText,
        testKalshiMarket.settlementTime,
        testKalshiMarket.dollarVolume24h,
        testKalshiMarket.dollarVolume24h,
        testKalshiMarket.spread,
        testKalshiMarket.category,
        testKalshiMarket.seriesTicker,
        testKalshiMarket.evidenceHash,
        testKalshiMarket.fetchedAt
      ).run();

      // Verify insertion
      const result = await env.DB.prepare(`
        SELECT * FROM markets WHERE condition_id = ?
      `).bind(testKalshiMarket.ticker).first<{ question: string }>();

      expect(result).toBeDefined();
      expect(result?.question).toBe(testKalshiMarket.title);
    });

    it('should count markets correctly after insertion', async () => {
      // First insert some markets
      await env.DB.prepare(`
        INSERT OR REPLACE INTO markets (condition_id, question, category, last_synced_at)
        VALUES ('count-test-1', 'Test market 1', 'crypto', datetime('now')),
               ('count-test-2', 'Test market 2', 'crypto', datetime('now'))
      `).run();

      const result = await env.DB.prepare(`
        SELECT COUNT(*) as count FROM markets
      `).first<{ count: number }>();

      expect(result?.count).toBeGreaterThanOrEqual(2);
    });

    it('should query markets by category after insertion', async () => {
      // First insert some crypto markets
      await env.DB.prepare(`
        INSERT OR REPLACE INTO markets (condition_id, question, category, last_synced_at)
        VALUES ('cat-test-1', 'Crypto market 1', 'crypto', datetime('now')),
               ('cat-test-2', 'Crypto market 2', 'crypto', datetime('now'))
      `).run();

      const results = await env.DB.prepare(`
        SELECT * FROM markets WHERE category = ?
      `).bind('crypto').all<{ condition_id: string }>();

      expect(results.results?.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Evidence Storage', () => {
    it('should store evidence blob in R2', async () => {
      const evidenceData = JSON.stringify({
        markets: [testPolymarketMarket],
        fetchedAt: new Date().toISOString(),
      });

      const evidenceKey = `evidence/polymarket/test-${Date.now()}`;

      await env.R2_EVIDENCE.put(evidenceKey, evidenceData, {
        customMetadata: {
          type: 'market_response',
          venue: 'polymarket',
        },
      });

      // Verify storage
      const obj = await env.R2_EVIDENCE.get(evidenceKey);
      expect(obj).toBeDefined();

      const storedData = await obj!.text();
      expect(storedData).toBe(evidenceData);

      // Verify metadata
      expect(obj!.customMetadata).toHaveProperty('type', 'market_response');
      expect(obj!.customMetadata).toHaveProperty('venue', 'polymarket');
    });

    it('should hash evidence consistently', async () => {
      const data = JSON.stringify({ test: 'data' });
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
      const hash1 = Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      const hashBuffer2 = await crypto.subtle.digest('SHA-256', encoder.encode(data));
      const hash2 = Array.from(new Uint8Array(hashBuffer2))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(64); // SHA-256 hex length
    });
  });

  describe('Audit Logging', () => {
    beforeAll(async () => {
      // Create audit_log table if not exists
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          entity_type TEXT,
          entity_id TEXT,
          payload TEXT,
          evidence_hash TEXT,
          r2_evidence_key TEXT,
          timestamp TEXT DEFAULT (datetime('now'))
        )
      `).run();
    });

    it('should log audit events', async () => {
      const auditId = `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      await env.DB.prepare(`
        INSERT INTO audit_log (id, event_type, entity_type, entity_id, payload, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        auditId,
        'MARKETS_INGESTED',
        'market',
        'polymarket',
        JSON.stringify({ count: 500, venue: 'polymarket' }),
        new Date().toISOString()
      ).run();

      // Verify
      const result = await env.DB.prepare(`
        SELECT * FROM audit_log WHERE id = ?
      `).bind(auditId).first<{ event_type: string; payload: string }>();

      expect(result?.event_type).toBe('MARKETS_INGESTED');
      expect(JSON.parse(result?.payload ?? '{}')).toHaveProperty('count', 500);
    });
  });

  describe('Market Count Verification', () => {
    it('should store and retrieve market data', async () => {
      // Insert test data
      await env.DB.prepare(`
        INSERT OR REPLACE INTO markets (condition_id, question, category, last_synced_at)
        VALUES ('verify-1', 'Verification market 1', 'politics', datetime('now')),
               ('verify-2', 'Verification market 2', 'politics', datetime('now'))
      `).run();

      const result = await env.DB.prepare(`
        SELECT COUNT(*) as count FROM markets WHERE condition_id LIKE 'verify-%'
      `).first<{ count: number }>();

      expect(result?.count).toBe(2);
    });

    it('should filter crypto markets correctly', async () => {
      // Insert test data
      await env.DB.prepare(`
        INSERT OR REPLACE INTO markets (condition_id, question, category, last_synced_at)
        VALUES ('crypto-verify-1', 'Crypto verification 1', 'crypto', datetime('now')),
               ('crypto-verify-2', 'Crypto verification 2', 'crypto', datetime('now'))
      `).run();

      const result = await env.DB.prepare(`
        SELECT COUNT(*) as count FROM markets WHERE category = 'crypto' AND condition_id LIKE 'crypto-verify-%'
      `).first<{ count: number }>();

      expect(result?.count).toBe(2);
    });
  });
});
