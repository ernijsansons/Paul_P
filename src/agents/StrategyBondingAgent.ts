/**
 * Paul P - Strategy Bonding Agent (P-09, P-10, P-18)
 *
 * Implements bonding + barbell strategy (Rank #1)
 *
 * Strategy Overview:
 * - Scan Kalshi for markets with p_yes > 0.93 (bond candidates)
 * - Allocate 90% to bonds, 10% to tails
 * - Use Kelly criterion with Monte Carlo CV adjustment for sizing
 * - Minimum 30% of tail allocation to event hedges
 */

import { PaulPAgent } from './base';
import {
  allocateBarbell,
  filterBondCandidates,
  categorizeTail,
  validateBarbellAllocation,
  calculateExpectedReturn,
  type BarbellConfig,
  type TailType,
} from '../lib/strategy/barbell';
import {
  computeKellySize,
  type MonteCarloConfig,
} from '../lib/strategy/kelly-sizing';
import { deterministicId } from '../lib/utils/deterministic-id';

// Signal types for queue
export interface TradingSignal {
  signalId: string;
  strategy: 'bonding_barbell';
  marketId: string;
  venue: 'kalshi' | 'polymarket';
  side: 'YES' | 'NO';
  signalType: 'bond' | 'tail';
  tailType?: TailType;
  targetSize: number;
  kellyFraction: number;
  expectedEdge: number;
  marketPrice: number;
  fairProbability: number;
  confidence: number;
  createdAt: string;
  expiresAt: string;
  metadata: {
    herfindahlIndex: number;
    eventHedgePct: number;
    barbellValid: boolean;
  };
}

// Local position tracking (uses snake_case to match SQLite columns)
type BondingPositionRow = {
  position_id: string;
  market_id: string;
  venue: string;
  position_type: string;
  tail_type: string | null;
  entry_price: number;
  size: number;
  unrealized_pnl: number;
  realized_pnl: number;
  status: string;
  created_at: string;
  closed_at: string | null;
};

// Market candidate from scan
interface MarketCandidate {
  marketId: string;
  venue: 'kalshi' | 'polymarket';
  title: string;
  probability: number;
  volume24h: number;
  spread: number;
  category?: string;
  tags?: string[];
  description?: string;
  endDate?: string;
}

export class StrategyBondingAgent extends PaulPAgent {
  readonly agentName = 'strategy-bonding';

  // Configuration
  private config: BarbellConfig = {
    bondPct: 90,
    tailPct: 10,
    minBondProbability: 0.93,
    minEventHedgePct: 30,
    maxHerfindahl: 0.25,
    maxSingleBondPct: 20,
    maxSingleTailPct: 40,
  };

  private monteCarloConfig: MonteCarloConfig = {
    simulations: 10000,
    assumedCV: 0.3,
  };

  protected async initLocalTables(): Promise<void> {
    // Local positions table
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS bonding_positions (
        position_id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL,
        venue TEXT NOT NULL,
        position_type TEXT NOT NULL CHECK (position_type IN ('bond', 'tail')),
        tail_type TEXT,
        entry_price REAL NOT NULL,
        size REAL NOT NULL,
        unrealized_pnl REAL DEFAULT 0,
        realized_pnl REAL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        closed_at TEXT
      )
    `);

    // Signal history
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS signal_history (
        signal_id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL,
        signal_type TEXT NOT NULL,
        target_size REAL NOT NULL,
        kelly_fraction REAL NOT NULL,
        expected_edge REAL NOT NULL,
        created_at TEXT NOT NULL,
        executed INTEGER DEFAULT 0,
        execution_price REAL,
        execution_time TEXT
      )
    `);

    // Scan results cache
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS scan_cache (
        scan_id TEXT PRIMARY KEY,
        scan_type TEXT NOT NULL,
        market_count INTEGER NOT NULL,
        data TEXT NOT NULL,
        scanned_at TEXT NOT NULL
      )
    `);

    // Historical returns for CV calculation
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS historical_returns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_value REAL NOT NULL,
        position_type TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      )
    `);
  }

  protected async handleRequest(request: Request, path: string): Promise<Response> {
    // Ensure tables exist
    await this.initLocalTables();

    switch (path) {
      case '/scan':
        return this.scanForOpportunities();
      case '/scan/bonds':
        return this.scanBondCandidates();
      case '/scan/tails':
        return this.scanTailCandidates();
      case '/generate-signals':
        return this.generateSignals(request);
      case '/allocate':
        return this.computeAllocation(request);
      case '/positions':
        return this.getPositions();
      case '/positions/update':
        return this.updatePosition(request);
      case '/kelly':
        return this.computeKelly(request);
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
   * Scan for all opportunities (bonds + tails)
   */
  private async scanForOpportunities(): Promise<Response> {
    const [bondResult, tailResult] = await Promise.all([
      this.fetchBondCandidates(),
      this.fetchTailCandidates(),
    ]);

    const scanId = deterministicId(
      'scan',
      bondResult.length,
      tailResult.length,
      new Date().toISOString()
    );

    // Cache scan results
    this.sql.exec(
      `INSERT OR REPLACE INTO scan_cache (scan_id, scan_type, market_count, data, scanned_at)
       VALUES (?, 'full', ?, ?, ?)`,
      scanId,
      bondResult.length + tailResult.length,
      JSON.stringify({ bonds: bondResult, tails: tailResult }),
      new Date().toISOString()
    );

    await this.logAudit('BONDING_SCAN_COMPLETE', {
      bondCount: bondResult.length,
      tailCount: tailResult.length,
      scanId,
    });

    return Response.json({
      scanId,
      bonds: bondResult,
      tails: tailResult,
      scannedAt: new Date().toISOString(),
    });
  }

  /**
   * Scan specifically for bond candidates (p_yes > 93%)
   */
  private async scanBondCandidates(): Promise<Response> {
    const candidates = await this.fetchBondCandidates();

    return Response.json({
      count: candidates.length,
      candidates,
      threshold: this.config.minBondProbability,
    });
  }

  /**
   * Scan for tail candidates (event hedges, regime tails, diversifiers)
   */
  private async scanTailCandidates(): Promise<Response> {
    const candidates = await this.fetchTailCandidates();

    // Categorize tails
    const categorized = candidates.map(c => ({
      ...c,
      tailType: categorizeTail({
        marketId: c.marketId,
        category: c.category,
        tags: c.tags,
        description: c.description,
      }),
    }));

    const summary = {
      event_hedge: categorized.filter(c => c.tailType === 'event_hedge').length,
      regime_tail: categorized.filter(c => c.tailType === 'regime_tail').length,
      diversifier: categorized.filter(c => c.tailType === 'diversifier').length,
    };

    return Response.json({
      count: categorized.length,
      candidates: categorized,
      summary,
    });
  }

  /**
   * Fetch bond candidates from MarketDataAgent
   */
  private async fetchBondCandidates(): Promise<MarketCandidate[]> {
    // Query D1 for high-probability markets
    const markets = await this.env.DB.prepare(`
      SELECT
        condition_id as marketId,
        'kalshi' as venue,
        question as title,
        last_yes_price as probability,
        peak_volume_24h as volume24h,
        avg_spread as spread,
        category,
        tags
      FROM markets
      WHERE last_yes_price >= ?
        AND avg_spread < 0.05
        AND peak_volume_24h > 1000
        AND status = 'active'
      ORDER BY peak_volume_24h DESC
      LIMIT 50
    `).bind(this.config.minBondProbability).all<{
      marketId: string;
      venue: string;
      title: string;
      probability: number;
      volume24h: number;
      spread: number;
      category: string | null;
      tags: string | null;
    }>();

    return (markets.results ?? []).map(m => ({
      marketId: m.marketId,
      venue: 'kalshi' as const,
      title: m.title,
      probability: m.probability,
      volume24h: m.volume24h ?? 0,
      spread: m.spread ?? 0,
      category: m.category ?? undefined,
      tags: m.tags ? JSON.parse(m.tags) : undefined,
    }));
  }

  /**
   * Fetch tail candidates from MarketDataAgent
   */
  private async fetchTailCandidates(): Promise<MarketCandidate[]> {
    // Query D1 for tail markets (lower probability, specific categories)
    const markets = await this.env.DB.prepare(`
      SELECT
        condition_id as marketId,
        'kalshi' as venue,
        question as title,
        last_yes_price as probability,
        peak_volume_24h as volume24h,
        avg_spread as spread,
        category,
        tags,
        description
      FROM markets
      WHERE last_yes_price < 0.20
        AND peak_volume_24h > 500
        AND status = 'active'
        AND (
          category IN ('politics', 'economics', 'weather', 'geopolitics')
          OR description LIKE '%crisis%'
          OR description LIKE '%emergency%'
          OR description LIKE '%war%'
          OR description LIKE '%collapse%'
        )
      ORDER BY peak_volume_24h DESC
      LIMIT 30
    `).all<{
      marketId: string;
      venue: string;
      title: string;
      probability: number;
      volume24h: number;
      spread: number;
      category: string | null;
      tags: string | null;
      description: string | null;
    }>();

    return (markets.results ?? []).map(m => ({
      marketId: m.marketId,
      venue: 'kalshi' as const,
      title: m.title,
      probability: m.probability,
      volume24h: m.volume24h ?? 0,
      spread: m.spread ?? 0,
      category: m.category ?? undefined,
      tags: m.tags ? JSON.parse(m.tags) : undefined,
      description: m.description ?? undefined,
    }));
  }

  /**
   * Generate trading signals based on current scan
   */
  private async generateSignals(request: Request): Promise<Response> {
    const body = await request.json() as {
      capital: number;
      fairProbabilities?: Record<string, number>;
    };

    if (!body.capital || body.capital <= 0) {
      return Response.json({ error: 'Capital required' }, { status: 400 });
    }

    // Fetch candidates
    const [bondCandidates, tailCandidates] = await Promise.all([
      this.fetchBondCandidates(),
      this.fetchTailCandidates(),
    ]);

    // Get historical returns for CV calculation
    const historicalReturns = this.getHistoricalReturns();
    if (historicalReturns.length >= 5) {
      this.monteCarloConfig.historicalReturns = historicalReturns;
    }

    // Filter and prepare bond candidates
    const filteredBonds = filterBondCandidates(
      bondCandidates.map(b => ({
        marketId: b.marketId,
        venue: b.venue,
        probability: b.probability,
        volume24h: b.volume24h,
        spread: b.spread,
      })),
      this.config
    );

    // Prepare tail candidates with payoff multiples
    const preparedTails = tailCandidates.map(t => ({
      marketId: t.marketId,
      venue: t.venue,
      probability: t.probability,
      tailType: categorizeTail({
        marketId: t.marketId,
        category: t.category,
        tags: t.tags,
        description: t.description,
      }),
      payoffMultiple: this.estimatePayoffMultiple(t.probability),
    }));

    // Compute barbell allocation
    const allocation = allocateBarbell(
      body.capital,
      filteredBonds,
      preparedTails,
      this.config
    );

    // Validate allocation
    const validation = validateBarbellAllocation(allocation, this.config);
    if (!validation.valid) {
      await this.logAudit('BONDING_ALLOCATION_INVALID', {
        errors: validation.errors,
        capital: body.capital,
      });
    }

    // Generate signals
    const signals: TradingSignal[] = [];
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24h expiry

    // Bond signals
    for (const bond of allocation.bondPositions) {
      const fairProb = body.fairProbabilities?.[bond.marketId] ?? bond.probability;

      const kellyResult = computeKellySize(
        {
          fairProbability: fairProb,
          marketPrice: bond.probability,
          side: 'YES',
          bankroll: body.capital,
          maxPositionPct: this.config.maxSingleBondPct,
        },
        this.monteCarloConfig
      );

      if (kellyResult.hasEdge) {
        signals.push({
          signalId: `sig_bond_${bond.marketId}_${now.getTime()}`,
          strategy: 'bonding_barbell',
          marketId: bond.marketId,
          venue: bond.venue as 'kalshi' | 'polymarket',
          side: 'YES',
          signalType: 'bond',
          targetSize: bond.allocation,
          kellyFraction: kellyResult.adjustedFraction,
          expectedEdge: kellyResult.expectedEdge,
          marketPrice: bond.probability,
          fairProbability: fairProb,
          confidence: kellyResult.confidenceAdjustment,
          createdAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
          metadata: {
            herfindahlIndex: allocation.herfindahlIndex,
            eventHedgePct: allocation.eventHedgePct,
            barbellValid: allocation.isValid,
          },
        });
      }
    }

    // Tail signals
    for (const tail of allocation.tailPositions) {
      const fairProb = body.fairProbabilities?.[tail.marketId] ?? tail.probability * 1.5; // Assume some edge

      const kellyResult = computeKellySize(
        {
          fairProbability: fairProb,
          marketPrice: tail.probability,
          side: 'YES',
          bankroll: body.capital,
          maxPositionPct: this.config.maxSingleTailPct,
        },
        this.monteCarloConfig
      );

      signals.push({
        signalId: `sig_tail_${tail.marketId}_${now.getTime()}`,
        strategy: 'bonding_barbell',
        marketId: tail.marketId,
        venue: tail.venue as 'kalshi' | 'polymarket',
        side: 'YES',
        signalType: 'tail',
        tailType: tail.tailType,
        targetSize: tail.allocation,
        kellyFraction: kellyResult.adjustedFraction,
        expectedEdge: kellyResult.expectedEdge,
        marketPrice: tail.probability,
        fairProbability: fairProb,
        confidence: kellyResult.confidenceAdjustment,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        metadata: {
          herfindahlIndex: allocation.herfindahlIndex,
          eventHedgePct: allocation.eventHedgePct,
          barbellValid: allocation.isValid,
        },
      });
    }

    // Store signals in local history
    for (const signal of signals) {
      this.sql.exec(
        `INSERT INTO signal_history (signal_id, market_id, signal_type, target_size, kelly_fraction, expected_edge, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        signal.signalId,
        signal.marketId,
        signal.signalType,
        signal.targetSize,
        signal.kellyFraction,
        signal.expectedEdge,
        signal.createdAt
      );
    }

    // Send signals to queue
    await this.env.QUEUE_SIGNALS.send({
      type: 'BONDING_SIGNALS',
      signals,
      allocation: {
        totalCapital: allocation.totalCapital,
        bondAllocation: allocation.bondAllocation,
        tailAllocation: allocation.tailAllocation,
        herfindahlIndex: allocation.herfindahlIndex,
        eventHedgePct: allocation.eventHedgePct,
        isValid: allocation.isValid,
      },
      timestamp: now.toISOString(),
    });

    await this.logAudit('BONDING_SIGNALS_GENERATED', {
      signalCount: signals.length,
      bondSignals: signals.filter(s => s.signalType === 'bond').length,
      tailSignals: signals.filter(s => s.signalType === 'tail').length,
      capital: body.capital,
      allocationValid: allocation.isValid,
    });

    return Response.json({
      signals,
      allocation,
      validation,
      expectedReturn: calculateExpectedReturn(allocation),
    });
  }

  /**
   * Compute allocation without generating signals
   */
  private async computeAllocation(request: Request): Promise<Response> {
    const body = await request.json() as { capital: number };

    if (!body.capital || body.capital <= 0) {
      return Response.json({ error: 'Capital required' }, { status: 400 });
    }

    const [bondCandidates, tailCandidates] = await Promise.all([
      this.fetchBondCandidates(),
      this.fetchTailCandidates(),
    ]);

    const filteredBonds = filterBondCandidates(
      bondCandidates.map(b => ({
        marketId: b.marketId,
        venue: b.venue,
        probability: b.probability,
        volume24h: b.volume24h,
        spread: b.spread,
      })),
      this.config
    );

    const preparedTails = tailCandidates.map(t => ({
      marketId: t.marketId,
      venue: t.venue,
      probability: t.probability,
      tailType: categorizeTail({
        marketId: t.marketId,
        category: t.category,
        tags: t.tags,
        description: t.description,
      }),
      payoffMultiple: this.estimatePayoffMultiple(t.probability),
    }));

    const allocation = allocateBarbell(body.capital, filteredBonds, preparedTails, this.config);
    const validation = validateBarbellAllocation(allocation, this.config);
    const expectedReturn = calculateExpectedReturn(allocation);

    return Response.json({
      allocation,
      validation,
      expectedReturn,
    });
  }

  /**
   * Compute Kelly sizing for a single opportunity
   */
  private async computeKelly(request: Request): Promise<Response> {
    const body = await request.json() as {
      fairProbability: number;
      marketPrice: number;
      side: 'YES' | 'NO';
      bankroll: number;
      maxPositionPct?: number;
    };

    if (!body.fairProbability || !body.marketPrice || !body.side || !body.bankroll) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const historicalReturns = this.getHistoricalReturns();
    const config: MonteCarloConfig = {
      ...this.monteCarloConfig,
      historicalReturns: historicalReturns.length >= 5 ? historicalReturns : undefined,
    };

    const result = computeKellySize(
      {
        fairProbability: body.fairProbability,
        marketPrice: body.marketPrice,
        side: body.side,
        bankroll: body.bankroll,
        maxPositionPct: body.maxPositionPct ?? 5,
      },
      config
    );

    return Response.json(result);
  }

  /**
   * Get current positions
   */
  private async getPositions(): Promise<Response> {
    const positions = this.sql.exec<BondingPositionRow>(
      `SELECT * FROM bonding_positions WHERE status != 'closed' ORDER BY created_at DESC`
    ).toArray();

    const summary = {
      total: positions.length,
      bonds: positions.filter(p => p.position_type === 'bond').length,
      tails: positions.filter(p => p.position_type === 'tail').length,
      totalSize: positions.reduce((sum, p) => sum + p.size, 0),
      unrealizedPnl: positions.reduce((sum, p) => sum + p.unrealized_pnl, 0),
    };

    return Response.json({ positions, summary });
  }

  /**
   * Update position (called by execution agents)
   */
  private async updatePosition(request: Request): Promise<Response> {
    const body = await request.json() as Partial<BondingPositionRow> & { positionId: string };

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
      this.sql.exec(
        `INSERT INTO historical_returns (return_value, position_type, recorded_at)
         VALUES (?, ?, ?)`,
        body.realized_pnl / (body.size ?? 1),
        body.position_type ?? 'unknown',
        new Date().toISOString()
      );
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
      `UPDATE bonding_positions SET ${updates.join(', ')} WHERE position_id = ?`,
      ...values
    );

    return Response.json({ success: true, positionId: body.positionId });
  }

  /**
   * Get current configuration
   */
  private async getConfig(): Promise<Response> {
    return Response.json({
      barbell: this.config,
      monteCarlo: this.monteCarloConfig,
    });
  }

  /**
   * Update configuration
   */
  private async updateConfig(request: Request): Promise<Response> {
    const body = await request.json() as {
      barbell?: Partial<BarbellConfig>;
      monteCarlo?: Partial<MonteCarloConfig>;
    };

    if (body.barbell) {
      this.config = { ...this.config, ...body.barbell };
    }
    if (body.monteCarlo) {
      this.monteCarloConfig = { ...this.monteCarloConfig, ...body.monteCarlo };
    }

    await this.logAudit('BONDING_CONFIG_UPDATED', {
      barbell: this.config,
      monteCarlo: this.monteCarloConfig,
    });

    return Response.json({
      barbell: this.config,
      monteCarlo: this.monteCarloConfig,
    });
  }

  /**
   * Get agent status
   */
  private async getStatus(): Promise<Response> {
    const openPositions = this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM bonding_positions WHERE status = 'open'`
    ).one();

    const recentSignals = this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM signal_history WHERE created_at > datetime('now', '-1 day')`
    ).one();

    return Response.json({
      agent: this.agentName,
      strategyType: 'bonding_barbell',
      status: 'paper',
      config: this.config,
      openPositions: openPositions?.count ?? 0,
      recentSignals: recentSignals?.count ?? 0,
      lastActivity: new Date().toISOString(),
    });
  }

  /**
   * Get strategy metrics
   */
  private async getMetrics(): Promise<Response> {
    const positions = this.sql.exec<BondingPositionRow>(
      `SELECT * FROM bonding_positions`
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
      bondPositions: positions.filter(p => p.position_type === 'bond').length,
      tailPositions: positions.filter(p => p.position_type === 'tail').length,
    });
  }

  /**
   * Get historical returns for CV calculation
   */
  private getHistoricalReturns(): number[] {
    const rows = this.sql.exec<{ return_value: number }>(
      `SELECT return_value FROM historical_returns ORDER BY recorded_at DESC LIMIT 100`
    ).toArray();

    return rows.map(r => r.return_value);
  }

  /**
   * Estimate payoff multiple for tail positions
   * Lower probability = higher payoff potential
   */
  private estimatePayoffMultiple(probability: number): number {
    if (probability <= 0 || probability >= 1) return 1;
    // Payoff multiple is roughly 1/probability for binary markets
    // Cap at reasonable levels
    return Math.min(1 / probability, 50);
  }
}
