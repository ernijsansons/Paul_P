/**
 * Paul P - Strategy XV Signal Agent (P-04)
 *
 * Cross-venue signal following strategy
 *
 * Strategy Overview:
 * - Scan approved market pairs from D1 for price divergence
 * - Generate signals when divergence exceeds threshold
 * - FAIL-CLOSED: No signals if pair status != 'approved'
 * - Use Kelly criterion for sizing
 * - Check VPIN for toxic flow before signaling
 */

import { PaulPAgent } from './base';
import { computeKellySize, type MonteCarloConfig } from '../lib/strategy/kelly-sizing';
import { computeVPIN, type Trade, type VPINResult } from '../lib/market-data/vpin';
import { deterministicId } from '../lib/utils/deterministic-id';
import type { SqlStorageValue } from '@cloudflare/workers-types';

// Signal types for queue
export interface XVTradingSignal {
  signalId: string;
  strategy: 'xv_signal';
  pairId: string;
  canonicalEventId: string;
  polymarketMarketId: string;
  kalshiMarketId: string;
  signalSide: 'BUY_KALSHI' | 'SELL_KALSHI'; // Which side to take
  direction: 'YES' | 'NO';
  targetSize: number;
  kellyFraction: number;
  expectedEdge: number;
  polymarketPrice: number;
  kalshiPrice: number;
  priceDivergence: number;
  confidence: number;
  vpinPolymarket: number;
  vpinKalshi: number;
  createdAt: string;
  expiresAt: string;
  metadata: {
    equivalenceGrade: string;
    pairStatus: string;
    pairExpiresAt: string;
  };
}

// Market pair from D1
interface MarketPair {
  id: string;
  canonicalEventId: string;
  marketAId: string;
  marketBId: string;
  equivalenceGrade: 'identical' | 'near_equivalent' | 'similar_but_divergent' | 'not_equivalent';
  status: 'pending_review' | 'approved' | 'rejected' | 'expired';
  expiresAt: string | null;
  settlementRuleSimilarity: number;
  ruleTextHashA: string | null;
  ruleTextHashB: string | null;
}

// Canonical market details
interface CanonicalMarket {
  id: string;
  canonicalEventId: string;
  venue: 'polymarket' | 'kalshi';
  venueMarketId: string;
  venueMarketTitle: string;
  resolutionCriteriaText: string;
}

// Local position tracking (index signature required for SqlStorage)
interface XVPositionRow extends Record<string, SqlStorageValue> {
  position_id: string;
  pair_id: string;
  polymarket_market_id: string;
  kalshi_market_id: string;
  direction: string;
  poly_entry_price: number;
  kalshi_entry_price: number;
  size: number;
  unrealized_pnl: number;
  realized_pnl: number;
  status: string;
  created_at: string;
  closed_at: string | null;
}

// Scan result for divergent pair
interface DivergentPair {
  pairId: string;
  canonicalEventId: string;
  polymarketMarketId: string;
  kalshiMarketId: string;
  polymarketPrice: number;
  kalshiPrice: number;
  priceDivergence: number; // Absolute difference in cents
  equivalenceGrade: string;
  expiresAt: string | null;
}

// Configuration type for updateConfig endpoint
interface XVConfig {
  minDivergenceCents: number;
  maxVPIN: number;
  maxSpread: number;
  maxPositionPct: number;
  signalExpiryHours: number;
}

export class StrategyXVSignalAgent extends PaulPAgent {
  readonly agentName = 'strategy-xvsignal';

  // Configuration
  private config: XVConfig = {
    minDivergenceCents: 3, // Minimum 3 cent divergence to consider
    maxVPIN: 0.6, // Don't trade if VPIN > 0.6 (toxic flow)
    maxSpread: 0.05, // Max 5% spread on execution venue
    maxPositionPct: 5, // Max 5% of bankroll per position
    signalExpiryHours: 4, // Signals expire after 4 hours
  };

  private monteCarloConfig: MonteCarloConfig = {
    simulations: 10000,
    assumedCV: 0.35, // Slightly higher uncertainty for cross-venue
  };

  protected async initLocalTables(): Promise<void> {
    // Pair signals tracking
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pair_signals (
        signal_id TEXT PRIMARY KEY,
        pair_id TEXT NOT NULL,
        polymarket_market_id TEXT NOT NULL,
        kalshi_market_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        poly_price REAL NOT NULL,
        kalshi_price REAL NOT NULL,
        divergence REAL NOT NULL,
        target_size REAL NOT NULL,
        kelly_fraction REAL NOT NULL,
        expected_edge REAL NOT NULL,
        created_at TEXT NOT NULL,
        executed INTEGER DEFAULT 0,
        execution_price REAL,
        execution_time TEXT
      )
    `);

    // Cross-venue position tracking
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS xv_positions (
        position_id TEXT PRIMARY KEY,
        pair_id TEXT NOT NULL,
        polymarket_market_id TEXT NOT NULL,
        kalshi_market_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        poly_entry_price REAL NOT NULL,
        kalshi_entry_price REAL NOT NULL,
        size REAL NOT NULL,
        unrealized_pnl REAL DEFAULT 0,
        realized_pnl REAL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        closed_at TEXT
      )
    `);

    // Scan results cache
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS xv_scan_cache (
        scan_id TEXT PRIMARY KEY,
        divergent_pairs_count INTEGER NOT NULL,
        data TEXT NOT NULL,
        scanned_at TEXT NOT NULL
      )
    `);

    // Historical returns for CV calculation
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS xv_historical_returns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_value REAL NOT NULL,
        pair_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      )
    `);
  }

  protected async handleRequest(request: Request, path: string): Promise<Response> {
    // Ensure tables exist
    await this.initLocalTables();

    switch (path) {
      case '/scan-pairs':
        return this.scanPairs();
      case '/generate-signals':
        return this.generateSignals(request);
      case '/positions':
        return this.getPositions();
      case '/positions/update':
        return this.updatePosition(request);
      case '/config':
        return this.getConfig();
      case '/config/update':
        return this.updateConfig(request);
      case '/status':
        return this.getStatus();
      case '/metrics':
        return this.getMetrics();
      default:
        return Response.json({ error: 'Not found' }, { status: 404 });
    }
  }

  /**
   * Scan approved market pairs for price divergence
   * POST /scan-pairs
   */
  private async scanPairs(): Promise<Response> {
    // FAIL-CLOSED: Only query pairs that are approved AND have valid equivalence grade
    const pairs = await this.env.DB.prepare(`
      SELECT
        mp.id,
        mp.canonical_event_id,
        mp.market_a_id,
        mp.market_b_id,
        mp.equivalence_grade,
        mp.status,
        mp.expires_at,
        mp.settlement_rule_similarity,
        mp.rule_text_hash_a,
        mp.rule_text_hash_b
      FROM market_pairs mp
      WHERE mp.status = 'approved'
        AND mp.equivalence_grade IN ('identical', 'near_equivalent')
        AND (mp.expires_at IS NULL OR mp.expires_at > datetime('now'))
    `).all<MarketPair>();

    if (!pairs.results || pairs.results.length === 0) {
      await this.logAudit('XV_SCAN_NO_PAIRS', {
        reason: 'No approved pairs found',
      });

      return Response.json({
        divergentPairs: [],
        scannedPairs: 0,
        message: 'No approved market pairs found',
      });
    }

    const divergentPairs: DivergentPair[] = [];

    for (const pair of pairs.results) {
      // Get canonical market details for both sides
      const [marketA, marketB] = await Promise.all([
        this.env.DB.prepare(`SELECT * FROM canonical_markets WHERE id = ?`)
          .bind(pair.marketAId)
          .first<CanonicalMarket>(),
        this.env.DB.prepare(`SELECT * FROM canonical_markets WHERE id = ?`)
          .bind(pair.marketBId)
          .first<CanonicalMarket>(),
      ]);

      if (!marketA || !marketB) {
        console.warn(`Missing canonical market for pair ${pair.id}`);
        continue;
      }

      // Determine which is Polymarket and which is Kalshi
      const polyMarket = marketA.venue === 'polymarket' ? marketA : marketB;
      const kalshiMarket = marketA.venue === 'kalshi' ? marketA : marketB;

      if (polyMarket.venue !== 'polymarket' || kalshiMarket.venue !== 'kalshi') {
        // Not a Polymarket-Kalshi pair, skip
        continue;
      }

      // Get current prices from markets table
      const [polyPrice, kalshiPrice] = await Promise.all([
        this.getMarketPrice(polyMarket.venueMarketId, 'polymarket'),
        this.getMarketPrice(kalshiMarket.venueMarketId, 'kalshi'),
      ]);

      if (polyPrice === null || kalshiPrice === null) {
        continue;
      }

      // Calculate divergence in cents
      const divergence = Math.abs(polyPrice - kalshiPrice) * 100;

      if (divergence >= this.config.minDivergenceCents) {
        divergentPairs.push({
          pairId: pair.id,
          canonicalEventId: pair.canonicalEventId,
          polymarketMarketId: polyMarket.venueMarketId,
          kalshiMarketId: kalshiMarket.venueMarketId,
          polymarketPrice: polyPrice,
          kalshiPrice: kalshiPrice,
          priceDivergence: divergence,
          equivalenceGrade: pair.equivalenceGrade,
          expiresAt: pair.expiresAt,
        });
      }
    }

    // Cache scan results
    const scanId = deterministicId(
      'xv-scan',
      divergentPairs.length,
      pairs.results.length,
      new Date().toISOString()
    );
    this.sql.exec(
      `INSERT OR REPLACE INTO xv_scan_cache (scan_id, divergent_pairs_count, data, scanned_at)
       VALUES (?, ?, ?, ?)`,
      scanId,
      divergentPairs.length,
      JSON.stringify(divergentPairs),
      new Date().toISOString()
    );

    await this.logAudit('XV_SCAN_COMPLETE', {
      scannedPairs: pairs.results.length,
      divergentPairs: divergentPairs.length,
      scanId,
    });

    return Response.json({
      scanId,
      divergentPairs,
      scannedPairs: pairs.results.length,
      minDivergence: this.config.minDivergenceCents,
      scannedAt: new Date().toISOString(),
    });
  }

  /**
   * Generate cross-venue signals from divergent pairs
   * POST /generate-signals { capital: number }
   */
  private async generateSignals(request: Request): Promise<Response> {
    const body = await request.json() as { capital: number };

    if (!body.capital || body.capital <= 0) {
      return Response.json({ error: 'Capital required' }, { status: 400 });
    }

    // First scan for divergent pairs
    const scanResult = await this.scanPairs();
    const scanData = await scanResult.json() as { divergentPairs: DivergentPair[] };

    if (scanData.divergentPairs.length === 0) {
      return Response.json({
        signals: [],
        message: 'No divergent pairs found',
      });
    }

    // Get historical returns for CV
    const historicalReturns = this.getHistoricalReturns();
    if (historicalReturns.length >= 5) {
      this.monteCarloConfig.historicalReturns = historicalReturns;
    }

    const signals: XVTradingSignal[] = [];
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.signalExpiryHours * 60 * 60 * 1000);

    for (const pair of scanData.divergentPairs) {
      // FAIL-CLOSED: Re-verify pair is still approved
      const pairStatus = await this.env.DB.prepare(`
        SELECT status, expires_at FROM market_pairs WHERE id = ?
      `).bind(pair.pairId).first<{ status: string; expires_at: string | null }>();

      if (!pairStatus || pairStatus.status !== 'approved') {
        await this.logAudit('XV_SIGNAL_REJECTED', {
          pairId: pair.pairId,
          reason: 'Pair not approved',
          status: pairStatus?.status ?? 'not_found',
        });
        continue;
      }

      // Check if pair has expired
      if (pairStatus.expires_at && new Date(pairStatus.expires_at) < now) {
        await this.logAudit('XV_SIGNAL_REJECTED', {
          pairId: pair.pairId,
          reason: 'Pair expired',
          expiresAt: pairStatus.expires_at,
        });
        continue;
      }

      // Check VPIN on both venues (get recent trades)
      const [polyTrades, kalshiTrades] = await Promise.all([
        this.getRecentTrades(pair.polymarketMarketId, 'polymarket'),
        this.getRecentTrades(pair.kalshiMarketId, 'kalshi'),
      ]);

      const polyVPIN = this.computeVPINFromTrades(polyTrades);
      const kalshiVPIN = this.computeVPINFromTrades(kalshiTrades);

      if (polyVPIN.currentVPIN > this.config.maxVPIN || kalshiVPIN.currentVPIN > this.config.maxVPIN) {
        await this.logAudit('XV_SIGNAL_REJECTED', {
          pairId: pair.pairId,
          reason: 'VPIN too high (toxic flow)',
          polyVPIN: polyVPIN.currentVPIN,
          kalshiVPIN: kalshiVPIN.currentVPIN,
          threshold: this.config.maxVPIN,
        });
        continue;
      }

      // Determine signal direction:
      // If Polymarket price > Kalshi price, Polymarket is expensive
      // We should BUY on Kalshi (cheaper) and could SHORT on Polymarket
      // Since we only execute on Kalshi, we signal based on that
      const polyExpensive = pair.polymarketPrice > pair.kalshiPrice;
      const signalSide = polyExpensive ? 'BUY_KALSHI' : 'SELL_KALSHI';
      const direction = polyExpensive ? 'YES' : 'NO';

      // Use Polymarket price as "fair" price since it's more liquid
      const fairProbability = pair.polymarketPrice;
      const marketPrice = pair.kalshiPrice;

      // Compute Kelly sizing
      const kellyResult = computeKellySize(
        {
          fairProbability,
          marketPrice,
          side: direction,
          bankroll: body.capital,
          maxPositionPct: this.config.maxPositionPct,
        },
        this.monteCarloConfig
      );

      if (!kellyResult.hasEdge) {
        await this.logAudit('XV_SIGNAL_REJECTED', {
          pairId: pair.pairId,
          reason: 'No Kelly edge',
          kellyFraction: kellyResult.kellyFraction,
        });
        continue;
      }

      const signal: XVTradingSignal = {
        signalId: `xv_${pair.pairId}_${now.getTime()}`,
        strategy: 'xv_signal',
        pairId: pair.pairId,
        canonicalEventId: pair.canonicalEventId,
        polymarketMarketId: pair.polymarketMarketId,
        kalshiMarketId: pair.kalshiMarketId,
        signalSide,
        direction,
        targetSize: kellyResult.positionSize,
        kellyFraction: kellyResult.adjustedFraction,
        expectedEdge: kellyResult.expectedEdge,
        polymarketPrice: pair.polymarketPrice,
        kalshiPrice: pair.kalshiPrice,
        priceDivergence: pair.priceDivergence,
        confidence: kellyResult.confidenceAdjustment,
        vpinPolymarket: polyVPIN.currentVPIN,
        vpinKalshi: kalshiVPIN.currentVPIN,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        metadata: {
          equivalenceGrade: pair.equivalenceGrade,
          pairStatus: pairStatus.status,
          pairExpiresAt: pairStatus.expires_at ?? '',
        },
      };

      signals.push(signal);

      // Store in local history
      this.sql.exec(
        `INSERT INTO pair_signals (
          signal_id, pair_id, polymarket_market_id, kalshi_market_id,
          direction, poly_price, kalshi_price, divergence,
          target_size, kelly_fraction, expected_edge, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        signal.signalId,
        signal.pairId,
        signal.polymarketMarketId,
        signal.kalshiMarketId,
        signal.direction,
        signal.polymarketPrice,
        signal.kalshiPrice,
        signal.priceDivergence,
        signal.targetSize,
        signal.kellyFraction,
        signal.expectedEdge,
        signal.createdAt
      );
    }

    // Send signals to queue
    if (signals.length > 0) {
      await this.env.QUEUE_SIGNALS.send({
        type: 'XV_SIGNALS',
        signals,
        timestamp: now.toISOString(),
      });
    }

    await this.logAudit('XV_SIGNALS_GENERATED', {
      signalCount: signals.length,
      scannedPairs: scanData.divergentPairs.length,
      capital: body.capital,
    });

    return Response.json({
      signals,
      scannedPairs: scanData.divergentPairs.length,
      rejectedCount: scanData.divergentPairs.length - signals.length,
    });
  }

  /**
   * Get current positions
   */
  private async getPositions(): Promise<Response> {
    const positions = this.sql.exec<XVPositionRow>(
      `SELECT * FROM xv_positions WHERE status != 'closed' ORDER BY created_at DESC`
    ).toArray();

    const summary = {
      total: positions.length,
      totalSize: positions.reduce((sum, p) => sum + p.size, 0),
      unrealizedPnl: positions.reduce((sum, p) => sum + p.unrealized_pnl, 0),
    };

    return Response.json({ positions, summary });
  }

  /**
   * Update position (called by execution agents)
   */
  private async updatePosition(request: Request): Promise<Response> {
    const body = await request.json() as Partial<XVPositionRow> & { positionId: string };

    if (!body.positionId) {
      return Response.json({ error: 'positionId required' }, { status: 400 });
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.unrealized_pnl !== undefined) {
      updates.push('unrealized_pnl = ?');
      values.push(body.unrealized_pnl);
    }
    if (body.realized_pnl !== undefined) {
      updates.push('realized_pnl = ?');
      values.push(body.realized_pnl);

      // Record return for CV calculation
      const position = this.sql.exec<XVPositionRow>(
        `SELECT * FROM xv_positions WHERE position_id = ?`,
        body.positionId
      ).one();

      if (position && position.size > 0) {
        this.sql.exec(
          `INSERT INTO xv_historical_returns (return_value, pair_id, recorded_at)
           VALUES (?, ?, ?)`,
          body.realized_pnl / position.size,
          position.pair_id,
          new Date().toISOString()
        );
      }
    }
    if (body.status !== undefined) {
      updates.push('status = ?');
      values.push(body.status);
      if (body.status === 'closed') {
        updates.push('closed_at = ?');
        values.push(new Date().toISOString());
      }
    }

    if (updates.length === 0) {
      return Response.json({ error: 'No updates provided' }, { status: 400 });
    }

    values.push(body.positionId);

    this.sql.exec(
      `UPDATE xv_positions SET ${updates.join(', ')} WHERE position_id = ?`,
      ...values
    );

    return Response.json({ success: true, positionId: body.positionId });
  }

  /**
   * Get current configuration
   */
  private async getConfig(): Promise<Response> {
    return Response.json({
      xvConfig: this.config,
      monteCarlo: this.monteCarloConfig,
    });
  }

  /**
   * Update configuration
   */
  private async updateConfig(request: Request): Promise<Response> {
    const body = await request.json() as {
      xvConfig?: Partial<XVConfig>;
      monteCarlo?: Partial<MonteCarloConfig>;
    };

    if (body.xvConfig) {
      this.config = { ...this.config, ...body.xvConfig };
    }
    if (body.monteCarlo) {
      this.monteCarloConfig = { ...this.monteCarloConfig, ...body.monteCarlo };
    }

    await this.logAudit('XV_CONFIG_UPDATED', {
      xvConfig: this.config,
      monteCarlo: this.monteCarloConfig,
    });

    return Response.json({
      xvConfig: this.config,
      monteCarlo: this.monteCarloConfig,
    });
  }

  /**
   * Get agent status
   */
  private async getStatus(): Promise<Response> {
    const openPositions = this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM xv_positions WHERE status = 'open'`
    ).one();

    const recentSignals = this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM pair_signals WHERE created_at > datetime('now', '-1 day')`
    ).one();

    // Count approved pairs
    const approvedPairs = await this.env.DB.prepare(`
      SELECT COUNT(*) as count FROM market_pairs
      WHERE status = 'approved'
        AND equivalence_grade IN ('identical', 'near_equivalent')
    `).first<{ count: number }>();

    return Response.json({
      agent: this.agentName,
      strategyType: 'xv_signal',
      status: 'paper',
      config: this.config,
      openPositions: openPositions?.count ?? 0,
      recentSignals: recentSignals?.count ?? 0,
      approvedPairs: approvedPairs?.count ?? 0,
      lastActivity: new Date().toISOString(),
    });
  }

  /**
   * Get strategy metrics
   */
  private async getMetrics(): Promise<Response> {
    const positions = this.sql.exec<XVPositionRow>(
      `SELECT * FROM xv_positions`
    ).toArray();

    const returns = this.getHistoricalReturns();
    const totalPnl = positions.reduce((sum, p) => sum + p.realized_pnl + p.unrealized_pnl, 0);

    // Calculate Sharpe-like ratio
    const mean = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const variance = returns.length > 0
      ? returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length
      : 0;
    const sharpe = variance > 0 ? mean / Math.sqrt(variance) : 0;

    return Response.json({
      totalPositions: positions.length,
      openPositions: positions.filter(p => p.status === 'open').length,
      closedPositions: positions.filter(p => p.status === 'closed').length,
      totalPnl,
      sharpeRatio: sharpe,
      returnCount: returns.length,
    });
  }

  // ============================================================
  // Helper Methods
  // ============================================================

  /**
   * Get market price from D1
   */
  private async getMarketPrice(venueMarketId: string, venue: string): Promise<number | null> {
    if (venue === 'polymarket') {
      const result = await this.env.DB.prepare(`
        SELECT last_yes_price FROM markets WHERE condition_id = ?
      `).bind(venueMarketId).first<{ last_yes_price: number }>();
      return result?.last_yes_price ?? null;
    } else {
      const result = await this.env.DB.prepare(`
        SELECT last_yes_price FROM markets WHERE condition_id = ?
      `).bind(venueMarketId).first<{ last_yes_price: number }>();
      return result?.last_yes_price ?? null;
    }
  }

  /**
   * Get recent trades for VPIN calculation
   */
  private async getRecentTrades(venueMarketId: string, _venue: string): Promise<Trade[]> {
    const trades = await this.env.DB.prepare(`
      SELECT price, size as volume, timestamp
      FROM trades
      WHERE condition_id = ?
        AND timestamp > datetime('now', '-1 hour')
      ORDER BY timestamp ASC
      LIMIT 1000
    `).bind(venueMarketId).all<{ price: number; volume: number; timestamp: string }>();

    return (trades.results ?? []).map(t => ({
      price: t.price,
      volume: t.volume,
      timestamp: new Date(t.timestamp).getTime(),
    }));
  }

  /**
   * Compute VPIN from trades
   */
  private computeVPINFromTrades(trades: Trade[]): VPINResult {
    if (trades.length < 10) {
      // Not enough data, return normal flow
      return {
        currentVPIN: 0,
        buckets: [],
        flowClassification: 'normal',
        edgeMultiplier: 1.0,
        shouldPause: false,
        lastUpdated: new Date().toISOString(),
      };
    }

    // Compute midpoints from trades
    const midpoints = trades.map((t, i) => {
      const windowTrades = trades.slice(Math.max(0, i - 10), i + 1);
      const avgPrice = windowTrades.reduce((sum, wt) => sum + wt.price, 0) / windowTrades.length;
      return { timestamp: t.timestamp, price: avgPrice };
    });

    return computeVPIN(trades, midpoints, {
      bucketSize: 500, // Smaller buckets for prediction markets
      rollingBuckets: 30,
    });
  }

  /**
   * Get historical returns for CV calculation
   */
  private getHistoricalReturns(): number[] {
    const rows = this.sql.exec<{ return_value: number }>(
      `SELECT return_value FROM xv_historical_returns ORDER BY recorded_at DESC LIMIT 100`
    ).toArray();

    return rows.map(r => r.return_value);
  }
}
