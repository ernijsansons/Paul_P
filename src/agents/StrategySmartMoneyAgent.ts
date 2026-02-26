/**
 * Paul P - Strategy Smart Money Agent
 *
 * Smart money convergence strategy
 *
 * Strategy Overview:
 * - Track high-skill accounts (skill_score >= 70)
 * - Detect when 3+ high-skill accounts converge on same market
 * - Generate conviction-weighted signals
 * - Require Kalshi equivalent market for execution
 */

import { PaulPAgent } from './base';
import { computeKellySize, type MonteCarloConfig } from '../lib/strategy/kelly-sizing';
import type { SqlStorageValue } from '@cloudflare/workers-types';

// Signal types for queue
export interface SmartMoneySignal {
  signalId: string;
  strategy: 'smart_money';
  marketId: string;
  kalshiMarketId: string | null;
  direction: 'YES' | 'NO';
  targetSize: number;
  kellyFraction: number;
  expectedEdge: number;
  marketPrice: number;
  conviction: number;
  convergingAccounts: number;
  highSkillAccounts: string[];
  avgSkillScore: number;
  sumPositionSize: number;
  createdAt: string;
  expiresAt: string;
  metadata: {
    convergenceWindowHours: number;
    minAccountsRequired: number;
    skillThreshold: number;
  };
}

// Account being tracked (index signature required for SqlStorage)
interface TrackedAccount extends Record<string, SqlStorageValue> {
  proxyWallet: string;
  skillScore: number;
  skillTier: string;
  totalPnL: number;
  lastSyncedAt: string;
}

// Account position from D1
interface AccountPositionRow {
  proxy_wallet: string;
  condition_id: string;
  side: string;
  avg_entry_price: number;
  total_size: number;
  first_trade_at: string;
  market_question: string;
}

// Convergence event
interface ConvergenceEvent {
  id: string;
  marketId: string;
  marketQuestion: string;
  direction: 'YES' | 'NO';
  accounts: Array<{
    proxyWallet: string;
    skillScore: number;
    positionSize: number;
    entryPrice: number;
    enteredAt: string;
  }>;
  totalConviction: number;
  detectedAt: string;
}

// Local position tracking (index signature required for SqlStorage)
interface SmartMoneyPositionRow extends Record<string, SqlStorageValue> {
  position_id: string;
  market_id: string;
  kalshi_market_id: string | null;
  direction: string;
  entry_price: number;
  size: number;
  unrealized_pnl: number;
  realized_pnl: number;
  status: string;
  convergence_accounts: number;
  conviction: number;
  created_at: string;
  closed_at: string | null;
}

// Configuration type for updateConfig endpoint
interface SmartMoneyConfig {
  minSkillScore: number;
  minConvergingAccounts: number;
  convergenceWindowHours: number;
  maxPositionPct: number;
  signalExpiryHours: number;
  convictionMultiplier: number;
}

export class StrategySmartMoneyAgent extends PaulPAgent {
  readonly agentName = 'strategy-smartmoney';

  // Configuration
  private config: SmartMoneyConfig = {
    minSkillScore: 70, // Minimum skill score to track
    minConvergingAccounts: 3, // Minimum accounts for convergence
    convergenceWindowHours: 24, // Time window for convergence detection
    maxPositionPct: 5, // Max 5% of bankroll per position
    signalExpiryHours: 8, // Signals expire after 8 hours
    convictionMultiplier: 1.0, // Multiplier for conviction-weighted sizing
  };

  private monteCarloConfig: MonteCarloConfig = {
    simulations: 10000,
    assumedCV: 0.4, // Higher uncertainty for following others
  };

  protected async initLocalTables(): Promise<void> {
    // Tracked accounts
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS tracked_accounts (
        proxy_wallet TEXT PRIMARY KEY,
        skill_score REAL NOT NULL,
        skill_tier TEXT NOT NULL,
        total_pnl REAL DEFAULT 0,
        last_synced_at TEXT NOT NULL
      )
    `);

    // Account positions (recent)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS account_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proxy_wallet TEXT NOT NULL,
        condition_id TEXT NOT NULL,
        side TEXT NOT NULL,
        position_size REAL NOT NULL,
        entry_price REAL NOT NULL,
        entered_at TEXT NOT NULL,
        UNIQUE(proxy_wallet, condition_id, side)
      )
    `);

    // Convergence events
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS convergence_events (
        id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL,
        market_question TEXT,
        direction TEXT NOT NULL,
        accounts_json TEXT NOT NULL,
        total_conviction REAL NOT NULL,
        detected_at TEXT NOT NULL,
        signaled INTEGER DEFAULT 0
      )
    `);

    // Smart money positions
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS smartmoney_positions (
        position_id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL,
        kalshi_market_id TEXT,
        direction TEXT NOT NULL,
        entry_price REAL NOT NULL,
        size REAL NOT NULL,
        unrealized_pnl REAL DEFAULT 0,
        realized_pnl REAL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open',
        convergence_accounts INTEGER NOT NULL,
        conviction REAL NOT NULL,
        created_at TEXT NOT NULL,
        closed_at TEXT
      )
    `);

    // Signal history
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS smartmoney_signals (
        signal_id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        convergence_accounts INTEGER NOT NULL,
        conviction REAL NOT NULL,
        target_size REAL NOT NULL,
        created_at TEXT NOT NULL,
        executed INTEGER DEFAULT 0
      )
    `);

    // Historical returns
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS smartmoney_returns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_value REAL NOT NULL,
        market_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      )
    `);
  }

  protected async handleRequest(request: Request, path: string): Promise<Response> {
    await this.initLocalTables();

    switch (path) {
      case '/track-accounts':
        return this.trackAccounts();
      case '/sync-positions':
        return this.syncPositions();
      case '/detect-convergence':
        return this.detectConvergence();
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
   * Track high-skill accounts from D1
   * POST /track-accounts
   */
  private async trackAccounts(): Promise<Response> {
    // Query accounts with skill_score >= threshold
    const accounts = await this.env.DB.prepare(`
      SELECT
        proxy_wallet,
        skill_score,
        total_pnl_usd as total_pnl,
        last_synced_at
      FROM accounts
      WHERE skill_score >= ?
      ORDER BY skill_score DESC
      LIMIT 500
    `).bind(this.config.minSkillScore).all<{
      proxy_wallet: string;
      skill_score: number;
      total_pnl: number;
      last_synced_at: string;
    }>();

    if (!accounts.results || accounts.results.length === 0) {
      return Response.json({
        tracked: 0,
        message: 'No high-skill accounts found',
        threshold: this.config.minSkillScore,
      });
    }

    const now = new Date().toISOString();
    let updatedCount = 0;

    for (const account of accounts.results) {
      // Determine tier from skill score
      let tier: string;
      if (account.skill_score >= 80) tier = 'elite';
      else if (account.skill_score >= 60) tier = 'skilled';
      else tier = 'competent';

      // Upsert into local tracking
      this.sql.exec(
        `INSERT OR REPLACE INTO tracked_accounts (proxy_wallet, skill_score, skill_tier, total_pnl, last_synced_at)
         VALUES (?, ?, ?, ?, ?)`,
        account.proxy_wallet,
        account.skill_score,
        tier,
        account.total_pnl ?? 0,
        now
      );
      updatedCount++;
    }

    await this.logAudit('SMARTMONEY_ACCOUNTS_TRACKED', {
      count: updatedCount,
      threshold: this.config.minSkillScore,
      topScore: accounts.results[0]?.skill_score ?? 0,
    });

    return Response.json({
      tracked: updatedCount,
      threshold: this.config.minSkillScore,
      topAccounts: accounts.results.slice(0, 5).map(a => ({
        wallet: a.proxy_wallet.slice(0, 10) + '...',
        score: a.skill_score,
      })),
    });
  }

  /**
   * Sync positions for tracked accounts
   * POST /sync-positions
   */
  private async syncPositions(): Promise<Response> {
    // Get all tracked accounts
    const trackedAccounts = this.sql.exec<TrackedAccount>(
      `SELECT * FROM tracked_accounts ORDER BY skill_score DESC`
    ).toArray();

    if (trackedAccounts.length === 0) {
      return Response.json({
        synced: 0,
        message: 'No tracked accounts. Call /track-accounts first.',
      });
    }

    // Get recent positions from D1 for tracked accounts
    const wallets = trackedAccounts.map(a => a.proxyWallet);
    const placeholders = wallets.map(() => '?').join(',');
    const windowHours = this.config.convergenceWindowHours;

    const positions = await this.env.DB.prepare(`
      SELECT
        proxy_wallet,
        condition_id,
        side,
        avg_entry_price,
        total_size,
        first_trade_at,
        market_question
      FROM positions
      WHERE proxy_wallet IN (${placeholders})
        AND status = 'open'
        AND first_trade_at > datetime('now', '-${windowHours} hours')
      ORDER BY first_trade_at DESC
    `).bind(...wallets).all<AccountPositionRow>();

    // Clear old positions and insert new ones
    this.sql.exec(`DELETE FROM account_positions`);

    let syncedCount = 0;
    for (const pos of positions.results ?? []) {
      this.sql.exec(
        `INSERT OR REPLACE INTO account_positions (proxy_wallet, condition_id, side, position_size, entry_price, entered_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        pos.proxy_wallet,
        pos.condition_id,
        pos.side,
        pos.total_size,
        pos.avg_entry_price,
        pos.first_trade_at
      );
      syncedCount++;
    }

    await this.logAudit('SMARTMONEY_POSITIONS_SYNCED', {
      trackedAccounts: trackedAccounts.length,
      syncedPositions: syncedCount,
    });

    return Response.json({
      synced: syncedCount,
      trackedAccounts: trackedAccounts.length,
    });
  }

  /**
   * Detect convergence events (3+ accounts on same market)
   * POST /detect-convergence
   */
  private async detectConvergence(): Promise<Response> {
    // First sync positions
    await this.syncPositions();

    // Get tracked accounts map for skill scores
    const trackedAccounts = this.sql.exec<TrackedAccount>(
      `SELECT * FROM tracked_accounts`
    ).toArray();
    const skillMap = new Map(trackedAccounts.map(a => [a.proxyWallet, a.skillScore]));

    // Group positions by market and direction
    const positions = this.sql.exec<{
      proxy_wallet: string;
      condition_id: string;
      side: string;
      position_size: number;
      entry_price: number;
      entered_at: string;
    }>(`SELECT * FROM account_positions ORDER BY condition_id, side`).toArray();

    // Build market -> direction -> accounts mapping
    const convergenceMap = new Map<string, Map<string, Array<{
      proxyWallet: string;
      skillScore: number;
      positionSize: number;
      entryPrice: number;
      enteredAt: string;
    }>>>();

    for (const pos of positions) {
      const marketKey = pos.condition_id;
      const skillScore = skillMap.get(pos.proxy_wallet) ?? 0;

      if (!convergenceMap.has(marketKey)) {
        convergenceMap.set(marketKey, new Map());
      }

      const marketMap = convergenceMap.get(marketKey)!;
      if (!marketMap.has(pos.side)) {
        marketMap.set(pos.side, []);
      }

      marketMap.get(pos.side)!.push({
        proxyWallet: pos.proxy_wallet,
        skillScore,
        positionSize: pos.position_size,
        entryPrice: pos.entry_price,
        enteredAt: pos.entered_at,
      });
    }

    // Find convergences (3+ accounts)
    const convergenceEvents: ConvergenceEvent[] = [];
    const now = new Date();

    for (const [marketId, directionMap] of convergenceMap) {
      for (const [direction, accounts] of directionMap) {
        if (accounts.length >= this.config.minConvergingAccounts) {
          // Calculate total conviction = sum(position_size * skill_score)
          const totalConviction = accounts.reduce(
            (sum, a) => sum + a.positionSize * a.skillScore,
            0
          );

          // Get market question from D1
          const market = await this.env.DB.prepare(
            `SELECT question FROM markets WHERE condition_id = ?`
          ).bind(marketId).first<{ question: string }>();

          const event: ConvergenceEvent = {
            id: `conv_${marketId}_${direction}_${now.getTime()}`,
            marketId,
            marketQuestion: market?.question ?? 'Unknown',
            direction: direction as 'YES' | 'NO',
            accounts,
            totalConviction,
            detectedAt: now.toISOString(),
          };

          convergenceEvents.push(event);

          // Store convergence event
          this.sql.exec(
            `INSERT INTO convergence_events (id, market_id, market_question, direction, accounts_json, total_conviction, detected_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            event.id,
            event.marketId,
            event.marketQuestion,
            event.direction,
            JSON.stringify(event.accounts),
            event.totalConviction,
            event.detectedAt
          );
        }
      }
    }

    await this.logAudit('SMARTMONEY_CONVERGENCE_DETECTED', {
      eventsFound: convergenceEvents.length,
      totalMarkets: convergenceMap.size,
    });

    return Response.json({
      convergenceEvents,
      total: convergenceEvents.length,
      minAccountsRequired: this.config.minConvergingAccounts,
    });
  }

  /**
   * Generate signals from convergence events
   * POST /generate-signals { capital: number }
   */
  private async generateSignals(request: Request): Promise<Response> {
    const body = await request.json() as { capital: number };

    if (!body.capital || body.capital <= 0) {
      return Response.json({ error: 'Capital required' }, { status: 400 });
    }

    // First detect convergence
    const detectResult = await this.detectConvergence();
    const detectData = await detectResult.json() as { convergenceEvents: ConvergenceEvent[] };

    if (detectData.convergenceEvents.length === 0) {
      return Response.json({
        signals: [],
        message: 'No convergence events found',
      });
    }

    // Get historical returns for CV
    const historicalReturns = this.getHistoricalReturns();
    if (historicalReturns.length >= 5) {
      this.monteCarloConfig.historicalReturns = historicalReturns;
    }

    const signals: SmartMoneySignal[] = [];
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.signalExpiryHours * 60 * 60 * 1000);

    for (const event of detectData.convergenceEvents) {
      // Check if Kalshi equivalent exists
      const kalshiMarket = await this.findKalshiEquivalent(event.marketId);

      if (!kalshiMarket) {
        await this.logAudit('SMARTMONEY_SIGNAL_REJECTED', {
          marketId: event.marketId,
          reason: 'No Kalshi equivalent market',
        });
        continue;
      }

      // Get current market price
      const marketPrice = await this.getMarketPrice(kalshiMarket.id);
      if (marketPrice === null) {
        continue;
      }

      // Calculate conviction-weighted fair probability
      // Average entry price weighted by conviction
      const avgEntryPrice = event.accounts.reduce(
        (sum, a) => sum + a.entryPrice * a.positionSize * a.skillScore,
        0
      ) / event.totalConviction;

      // Fair probability = weighted average entry + edge adjustment
      // Smart money assumed to have 2-5c edge on average
      const assumedEdge = 0.03;
      const fairProbability = event.direction === 'YES'
        ? Math.min(avgEntryPrice + assumedEdge, 0.95)
        : Math.max(avgEntryPrice - assumedEdge, 0.05);

      // Compute Kelly sizing
      const kellyResult = computeKellySize(
        {
          fairProbability,
          marketPrice,
          side: event.direction,
          bankroll: body.capital,
          maxPositionPct: this.config.maxPositionPct,
        },
        this.monteCarloConfig
      );

      if (!kellyResult.hasEdge) {
        await this.logAudit('SMARTMONEY_SIGNAL_REJECTED', {
          marketId: event.marketId,
          reason: 'No Kelly edge',
          kellyFraction: kellyResult.kellyFraction,
        });
        continue;
      }

      // Adjust size by conviction
      const normalizedConviction = Math.min(event.totalConviction / 10000, 2); // Cap at 2x
      const convictionAdjustedSize = kellyResult.positionSize * normalizedConviction * this.config.convictionMultiplier;

      const avgSkillScore = event.accounts.reduce((sum, a) => sum + a.skillScore, 0) / event.accounts.length;
      const sumPositionSize = event.accounts.reduce((sum, a) => sum + a.positionSize, 0);

      const signal: SmartMoneySignal = {
        signalId: `sm_${event.marketId}_${now.getTime()}`,
        strategy: 'smart_money',
        marketId: event.marketId,
        kalshiMarketId: kalshiMarket.id,
        direction: event.direction,
        targetSize: Math.min(convictionAdjustedSize, body.capital * this.config.maxPositionPct / 100),
        kellyFraction: kellyResult.adjustedFraction,
        expectedEdge: kellyResult.expectedEdge,
        marketPrice,
        conviction: event.totalConviction,
        convergingAccounts: event.accounts.length,
        highSkillAccounts: event.accounts.map(a => a.proxyWallet.slice(0, 10) + '...'),
        avgSkillScore,
        sumPositionSize,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        metadata: {
          convergenceWindowHours: this.config.convergenceWindowHours,
          minAccountsRequired: this.config.minConvergingAccounts,
          skillThreshold: this.config.minSkillScore,
        },
      };

      signals.push(signal);

      // Store signal
      this.sql.exec(
        `INSERT INTO smartmoney_signals (signal_id, market_id, direction, convergence_accounts, conviction, target_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        signal.signalId,
        signal.marketId,
        signal.direction,
        signal.convergingAccounts,
        signal.conviction,
        signal.targetSize,
        signal.createdAt
      );

      // Mark convergence event as signaled
      this.sql.exec(
        `UPDATE convergence_events SET signaled = 1 WHERE id = ?`,
        event.id
      );
    }

    // Send signals to queue
    if (signals.length > 0) {
      await this.env.QUEUE_SIGNALS.send({
        type: 'SMARTMONEY_SIGNALS',
        signals,
        timestamp: now.toISOString(),
      });
    }

    await this.logAudit('SMARTMONEY_SIGNALS_GENERATED', {
      signalCount: signals.length,
      convergenceEvents: detectData.convergenceEvents.length,
      capital: body.capital,
    });

    return Response.json({
      signals,
      convergenceEvents: detectData.convergenceEvents.length,
      rejectedCount: detectData.convergenceEvents.length - signals.length,
    });
  }

  /**
   * Get current positions
   */
  private async getPositions(): Promise<Response> {
    const positions = this.sql.exec<SmartMoneyPositionRow>(
      `SELECT * FROM smartmoney_positions WHERE status != 'closed' ORDER BY created_at DESC`
    ).toArray();

    const summary = {
      total: positions.length,
      totalSize: positions.reduce((sum, p) => sum + p.size, 0),
      unrealizedPnl: positions.reduce((sum, p) => sum + p.unrealized_pnl, 0),
      avgConviction: positions.length > 0
        ? positions.reduce((sum, p) => sum + p.conviction, 0) / positions.length
        : 0,
    };

    return Response.json({ positions, summary });
  }

  /**
   * Update position
   */
  private async updatePosition(request: Request): Promise<Response> {
    const body = await request.json() as Partial<SmartMoneyPositionRow> & { positionId: string };

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

      // Record return
      const position = this.sql.exec<SmartMoneyPositionRow>(
        `SELECT * FROM smartmoney_positions WHERE position_id = ?`,
        body.positionId
      ).one();

      if (position && position.size > 0) {
        this.sql.exec(
          `INSERT INTO smartmoney_returns (return_value, market_id, recorded_at)
           VALUES (?, ?, ?)`,
          body.realized_pnl / position.size,
          position.market_id,
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
      `UPDATE smartmoney_positions SET ${updates.join(', ')} WHERE position_id = ?`,
      ...values
    );

    return Response.json({ success: true, positionId: body.positionId });
  }

  /**
   * Get configuration
   */
  private async getConfig(): Promise<Response> {
    return Response.json({
      smartMoneyConfig: this.config,
      monteCarlo: this.monteCarloConfig,
    });
  }

  /**
   * Update configuration
   */
  private async updateConfig(request: Request): Promise<Response> {
    const body = await request.json() as {
      smartMoneyConfig?: Partial<SmartMoneyConfig>;
      monteCarlo?: Partial<MonteCarloConfig>;
    };

    if (body.smartMoneyConfig) {
      this.config = { ...this.config, ...body.smartMoneyConfig };
    }
    if (body.monteCarlo) {
      this.monteCarloConfig = { ...this.monteCarloConfig, ...body.monteCarlo };
    }

    await this.logAudit('SMARTMONEY_CONFIG_UPDATED', {
      config: this.config,
      monteCarlo: this.monteCarloConfig,
    });

    return Response.json({
      smartMoneyConfig: this.config,
      monteCarlo: this.monteCarloConfig,
    });
  }

  /**
   * Get status
   */
  private async getStatus(): Promise<Response> {
    const trackedCount = this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM tracked_accounts`
    ).one();

    const openPositions = this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM smartmoney_positions WHERE status = 'open'`
    ).one();

    const recentSignals = this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM smartmoney_signals WHERE created_at > datetime('now', '-1 day')`
    ).one();

    const recentConvergence = this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM convergence_events WHERE detected_at > datetime('now', '-1 day')`
    ).one();

    return Response.json({
      agent: this.agentName,
      strategyType: 'smart_money',
      status: 'paper',
      config: this.config,
      trackedAccounts: trackedCount?.count ?? 0,
      openPositions: openPositions?.count ?? 0,
      recentSignals: recentSignals?.count ?? 0,
      recentConvergence: recentConvergence?.count ?? 0,
      lastActivity: new Date().toISOString(),
    });
  }

  /**
   * Get metrics
   */
  private async getMetrics(): Promise<Response> {
    const positions = this.sql.exec<SmartMoneyPositionRow>(
      `SELECT * FROM smartmoney_positions`
    ).toArray();

    const returns = this.getHistoricalReturns();
    const totalPnl = positions.reduce((sum, p) => sum + p.realized_pnl + p.unrealized_pnl, 0);

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
      avgConvergenceAccounts: positions.length > 0
        ? positions.reduce((sum, p) => sum + p.convergence_accounts, 0) / positions.length
        : 0,
    });
  }

  // ============================================================
  // Helper Methods
  // ============================================================

  /**
   * Find Kalshi equivalent market via market pairs
   */
  private async findKalshiEquivalent(polymarketMarketId: string): Promise<{ id: string } | null> {
    const result = await this.env.DB.prepare(`
      SELECT cm_kalshi.venue_market_id as id
      FROM market_pairs mp
      JOIN canonical_markets cm_poly ON mp.market_a_id = cm_poly.id OR mp.market_b_id = cm_poly.id
      JOIN canonical_markets cm_kalshi ON (mp.market_a_id = cm_kalshi.id OR mp.market_b_id = cm_kalshi.id)
        AND cm_kalshi.venue = 'kalshi'
      WHERE cm_poly.venue_market_id = ?
        AND cm_poly.venue = 'polymarket'
        AND mp.status = 'approved'
        AND mp.equivalence_grade IN ('identical', 'near_equivalent')
      LIMIT 1
    `).bind(polymarketMarketId).first<{ id: string }>();

    return result ?? null;
  }

  /**
   * Get market price from D1
   */
  private async getMarketPrice(marketId: string): Promise<number | null> {
    const result = await this.env.DB.prepare(`
      SELECT last_yes_price FROM markets WHERE condition_id = ?
    `).bind(marketId).first<{ last_yes_price: number }>();
    return result?.last_yes_price ?? null;
  }

  /**
   * Get historical returns for CV
   */
  private getHistoricalReturns(): number[] {
    const rows = this.sql.exec<{ return_value: number }>(
      `SELECT return_value FROM smartmoney_returns ORDER BY recorded_at DESC LIMIT 100`
    ).toArray();

    return rows.map(r => r.return_value);
  }
}
