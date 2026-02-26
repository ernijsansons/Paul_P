/**
 * Paul P - Risk Governor Agent (P-12)
 *
 * Enforces 17 fail-closed risk invariants.
 * Manages circuit breaker state machine.
 * All trading must pass through this agent.
 *
 * Circuit Breaker States:
 * - NORMAL: All trading allowed
 * - CAUTION: Reduced limits, extra logging
 * - HALT: No new positions, can only close
 * - RECOVERY: Gradual return to normal
 */

import { PaulPAgent } from './base';
import {
  runAllInvariantChecks,
  getCriticalFailures,
  getWarnings,
  shouldBlockOrder,
  type RiskCheckRequest,
  type RiskLimits,
  type CorrelatedMarketInfo,
  DEFAULT_LIMITS,
} from '../lib/risk/invariants';
import { getCorrelatedMarkets } from '../lib/risk/event-graph';

type CircuitBreakerState = 'NORMAL' | 'CAUTION' | 'HALT' | 'RECOVERY';

// Row type for SQL queries (snake_case to match DB columns)
type CircuitBreakerHistoryRow = {
  from_state: string;
  to_state: string;
  reason: string;
  timestamp: string;
};

interface PortfolioState {
  totalValue: number;
  dailyPnL: number;
  weeklyPnL: number;
  maxDrawdown: number;
  peakValue: number;
  positions: Array<{
    marketId: string;
    category: string;
    size: number;
    unrealizedPnL: number;
    entryPrice: number;
    currentPrice: number;
  }>;
  lastUpdated: string;
}

interface AlertConfig {
  dailyLossAlertPct: number;
  drawdownAlertPct: number;
  vpinAlertThreshold: number;
  consecutiveFailuresForHalt: number;
}

const DEFAULT_ALERT_CONFIG: AlertConfig = {
  dailyLossAlertPct: 2,
  drawdownAlertPct: 7,
  vpinAlertThreshold: 0.5,
  consecutiveFailuresForHalt: 3,
};

export class RiskGovernorAgent extends PaulPAgent {
  readonly agentName = 'risk-governor';

  private circuitBreakerState: CircuitBreakerState = 'NORMAL';
  private riskLimits: RiskLimits = { ...DEFAULT_LIMITS };
  private alertConfig: AlertConfig = { ...DEFAULT_ALERT_CONFIG };
  private consecutiveFailures = 0;
  private lastStateChange: string = new Date().toISOString();

  protected async initLocalTables(): Promise<void> {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS circuit_breaker_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        reason TEXT NOT NULL,
        timestamp TEXT NOT NULL
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS risk_check_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        market_id TEXT NOT NULL,
        strategy TEXT NOT NULL,
        size REAL NOT NULL,
        approved INTEGER NOT NULL,
        invariants_passed INTEGER NOT NULL,
        invariants_failed INTEGER NOT NULL,
        critical_failures TEXT,
        warnings TEXT,
        timestamp TEXT NOT NULL
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        total_value REAL NOT NULL,
        daily_pnl REAL NOT NULL,
        weekly_pnl REAL NOT NULL,
        max_drawdown REAL NOT NULL,
        position_count INTEGER NOT NULL,
        timestamp TEXT NOT NULL
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS alert_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        acknowledged INTEGER DEFAULT 0,
        timestamp TEXT NOT NULL
      )
    `);
  }

  protected async handleRequest(request: Request, path: string): Promise<Response> {
    await this.initLocalTables();

    switch (path) {
      case '/check-signal':
        return this.checkSignal(request);
      case '/check-invariants':
        return this.checkInvariants(request);
      case '/circuit-breaker/status':
        return this.getCircuitBreakerStatus();
      case '/circuit-breaker/transition':
        return this.transitionCircuitBreaker(request);
      case '/circuit-breaker/reset':
        return this.resetCircuitBreaker(request);
      case '/alert/critical':
        return this.handleCriticalAlert(request);
      case '/alert/acknowledge':
        return this.acknowledgeAlert(request);
      case '/portfolio/update':
        return this.updatePortfolioState(request);
      case '/portfolio/snapshot':
        return this.getPortfolioSnapshot();
      case '/limits':
        return this.getLimits();
      case '/limits/update':
        return this.updateLimits(request);
      case '/history':
        return this.getCheckHistory(request);
      case '/status':
        return this.getStatus();
      case '/detect-position-drift':
        return this.detectPositionDrift(request);
      case '/assess-llm-drift':
        return this.assessLLMDrift(request);
      default:
        return Response.json({ error: 'Not found' }, { status: 404 });
    }
  }

  private async checkSignal(request: Request): Promise<Response> {
    const rawBody = await request.json() as Record<string, unknown>;

    // Handle both new nested format and legacy flat format
    let body: Partial<RiskCheckRequest>;

    if (rawBody.signal && typeof rawBody.signal === 'object') {
      // New format: { signal: {...}, strategyType, capital }
      const signal = rawBody.signal as Record<string, unknown>;
      body = {
        marketId: signal.marketId as string,
        venue: (signal.venue ?? 'kalshi') as 'kalshi' | 'polymarket',
        side: signal.side as 'YES' | 'NO',
        size: (signal.requestedSize ?? signal.suggestedSize ?? 0) as number,
        price: signal.marketPrice as number,
        strategy: (rawBody.strategyType ?? signal.strategyType ?? 'unknown') as string,
        marketPrice: signal.marketPrice as number,
        spread: (signal.spread ?? 0) as number,
        volume24h: (signal.volume24h ?? 0) as number,
        vpinScore: signal.vpinScore as number | undefined,
        ambiguityScore: signal.ambiguityScore as number | undefined,
        equivalenceGrade: signal.equivalenceGrade as string | undefined,
        category: (signal.category ?? 'unknown') as string,
      };

      // Add capital to portfolio value if provided
      if (typeof rawBody.capital === 'number') {
        body.portfolioValue = rawBody.capital;
      }
    } else {
      // Legacy flat format
      body = rawBody as Partial<RiskCheckRequest>;
    }

    // Fetch correlated markets from Event Graph for I3 check (P-06)
    let correlatedMarkets: CorrelatedMarketInfo[] = [];
    try {
      correlatedMarkets = await getCorrelatedMarkets(this.env, body.marketId ?? 'unknown');
    } catch (error) {
      // Event Graph query failed - continue without correlation data (fail-open for this check)
      console.warn('Event Graph correlation lookup failed:', error);
    }
    body.correlatedMarkets = correlatedMarkets;

    const checkRequest = this.buildRiskCheckRequest(body);
    const adjustedLimits = this.getAdjustedLimits();
    const results = runAllInvariantChecks(checkRequest, adjustedLimits);

    const criticalFailures = getCriticalFailures(results);
    const warnings = getWarnings(results);
    const blocked = shouldBlockOrder(results);

    this.sql.exec(
      `INSERT INTO risk_check_history
       (market_id, strategy, size, approved, invariants_passed, invariants_failed, critical_failures, warnings, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      checkRequest.marketId,
      checkRequest.strategy,
      checkRequest.size,
      blocked ? 0 : 1,
      results.filter(r => r.passed).length,
      results.filter(r => !r.passed).length,
      JSON.stringify(criticalFailures.map(f => f.id)),
      JSON.stringify(warnings.map(w => w.id)),
      new Date().toISOString()
    );

    if (blocked) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.alertConfig.consecutiveFailuresForHalt) {
        await this.transitionToState('HALT', 'Consecutive risk check failures');
      }
    } else {
      this.consecutiveFailures = 0;
    }

    await this.logAudit('RISK_CHECK', {
      marketId: checkRequest.marketId,
      strategy: checkRequest.strategy,
      size: checkRequest.size,
      approved: !blocked,
      criticalFailures: criticalFailures.length,
      warnings: warnings.length,
      circuitBreakerState: this.circuitBreakerState,
    });

    if (blocked) {
      return Response.json({
        approved: false,
        reason: criticalFailures.map(f => f.message).join('; '),
        violations: criticalFailures.map(f => ({
          id: f.id,
          name: f.name,
          message: f.message,
          actual: f.actualValue,
          threshold: f.threshold,
        })),
        warnings: warnings.map(w => ({ id: w.id, name: w.name, message: w.message })),
        circuitBreakerState: this.circuitBreakerState,
      });
    }

    return Response.json({
      approved: true,
      warnings: warnings.map(w => ({ id: w.id, name: w.name, message: w.message })),
      circuitBreakerState: this.circuitBreakerState,
      checksRun: results.length,
      checksPassed: results.filter(r => r.passed).length,
    });
  }

  private async checkInvariants(request: Request): Promise<Response> {
    const body = await request.json() as Partial<RiskCheckRequest>;
    const checkRequest = this.buildRiskCheckRequest(body);
    const results = runAllInvariantChecks(checkRequest, this.riskLimits);

    return Response.json({
      results: results.map(r => ({
        id: r.id,
        name: r.name,
        passed: r.passed,
        actual: r.actualValue,
        threshold: r.threshold,
        message: r.message,
        severity: r.severity,
      })),
      summary: {
        total: results.length,
        passed: results.filter(r => r.passed).length,
        failed: results.filter(r => !r.passed).length,
        criticalFailures: getCriticalFailures(results).length,
        warnings: getWarnings(results).length,
      },
    });
  }

  private async getCircuitBreakerStatus(): Promise<Response> {
    const recentHistory = this.sql.exec<CircuitBreakerHistoryRow>(
      `SELECT from_state, to_state, reason, timestamp
       FROM circuit_breaker_history ORDER BY timestamp DESC LIMIT 10`
    ).toArray();

    return Response.json({
      state: this.circuitBreakerState,
      lastStateChange: this.lastStateChange,
      consecutiveFailures: this.consecutiveFailures,
      adjustedLimits: this.getAdjustedLimits(),
      recentHistory,
    });
  }

  private async transitionCircuitBreaker(request: Request): Promise<Response> {
    const body = await request.json() as { targetState: CircuitBreakerState; reason: string };

    if (!this.isValidTransition(this.circuitBreakerState, body.targetState)) {
      return Response.json({
        error: `Invalid transition from ${this.circuitBreakerState} to ${body.targetState}`,
      }, { status: 400 });
    }

    const previousState = this.circuitBreakerState;
    await this.transitionToState(body.targetState, body.reason);

    return Response.json({ previousState, newState: body.targetState, reason: body.reason });
  }

  private async resetCircuitBreaker(request: Request): Promise<Response> {
    const body = await request.json() as { reason: string; force?: boolean };

    if (!body.force && this.circuitBreakerState === 'HALT') {
      return Response.json({ error: 'Cannot reset from HALT without force flag' }, { status: 400 });
    }

    const previousState = this.circuitBreakerState;
    await this.transitionToState('NORMAL', body.reason);
    this.consecutiveFailures = 0;

    return Response.json({ previousState, newState: 'NORMAL', reason: body.reason });
  }

  private async handleCriticalAlert(request: Request): Promise<Response> {
    const alert = await request.json() as { type: string; severity: 'warning' | 'critical'; message: string };

    this.sql.exec(
      `INSERT INTO alert_history (alert_type, severity, message, timestamp) VALUES (?, ?, ?, ?)`,
      alert.type, alert.severity, alert.message, new Date().toISOString()
    );

    if (alert.severity === 'critical') {
      if (this.circuitBreakerState === 'NORMAL') {
        await this.transitionToState('CAUTION', alert.message);
      } else if (this.circuitBreakerState === 'CAUTION') {
        await this.transitionToState('HALT', alert.message);
      }
    }

    await this.logAudit('CRITICAL_ALERT', { alert, newState: this.circuitBreakerState });
    return Response.json({ newState: this.circuitBreakerState, alertRecorded: true });
  }

  private async acknowledgeAlert(request: Request): Promise<Response> {
    const body = await request.json() as { alertId: number };
    this.sql.exec(`UPDATE alert_history SET acknowledged = 1 WHERE id = ?`, body.alertId);
    return Response.json({ success: true, alertId: body.alertId });
  }

  private async updatePortfolioState(request: Request): Promise<Response> {
    const state = await request.json() as PortfolioState;

    this.sql.exec(
      `INSERT INTO portfolio_snapshots (total_value, daily_pnl, weekly_pnl, max_drawdown, position_count, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      state.totalValue, state.dailyPnL, state.weeklyPnL, state.maxDrawdown, state.positions.length, new Date().toISOString()
    );

    const dailyLossPct = Math.abs(Math.min(0, state.dailyPnL)) / state.totalValue * 100;
    const drawdownPct = state.maxDrawdown * 100;

    if (dailyLossPct >= this.alertConfig.dailyLossAlertPct) {
      await this.recordAlert('DAILY_LOSS_ALERT',
        dailyLossPct >= this.riskLimits.maxDailyLossPct ? 'critical' : 'warning',
        `Daily loss ${dailyLossPct.toFixed(2)}% approaching/exceeding limit`);
    }

    if (drawdownPct >= this.alertConfig.drawdownAlertPct) {
      await this.recordAlert('DRAWDOWN_ALERT',
        drawdownPct >= this.riskLimits.maxDrawdownPct ? 'critical' : 'warning',
        `Drawdown ${drawdownPct.toFixed(2)}% approaching/exceeding limit`);
    }

    return Response.json({ updated: true });
  }

  private async recordAlert(type: string, severity: 'warning' | 'critical', message: string): Promise<void> {
    this.sql.exec(
      `INSERT INTO alert_history (alert_type, severity, message, timestamp) VALUES (?, ?, ?, ?)`,
      type, severity, message, new Date().toISOString()
    );

    if (severity === 'critical') {
      if (this.circuitBreakerState === 'NORMAL') {
        await this.transitionToState('CAUTION', message);
      } else if (this.circuitBreakerState === 'CAUTION') {
        await this.transitionToState('HALT', message);
      }
    }
  }

  private async getPortfolioSnapshot(): Promise<Response> {
    const snapshot = this.sql.exec<{
      total_value: number; daily_pnl: number; weekly_pnl: number;
      max_drawdown: number; position_count: number; timestamp: string;
    }>(`SELECT * FROM portfolio_snapshots ORDER BY timestamp DESC LIMIT 1`).one();

    return Response.json(snapshot ?? { message: 'No snapshot available' });
  }

  private async getLimits(): Promise<Response> {
    return Response.json({
      base: this.riskLimits,
      adjusted: this.getAdjustedLimits(),
      circuitBreakerState: this.circuitBreakerState,
    });
  }

  private async updateLimits(request: Request): Promise<Response> {
    const body = await request.json() as Partial<RiskLimits>;
    this.riskLimits = { ...this.riskLimits, ...body };
    await this.logAudit('RISK_LIMITS_UPDATED', { newLimits: this.riskLimits });
    return Response.json({ limits: this.riskLimits, adjusted: this.getAdjustedLimits() });
  }

  private async getCheckHistory(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);

    const history = this.sql.exec<{
      market_id: string; strategy: string; size: number; approved: number;
      invariants_passed: number; invariants_failed: number;
      critical_failures: string; warnings: string; timestamp: string;
    }>(`SELECT * FROM risk_check_history ORDER BY timestamp DESC LIMIT ?`, limit).toArray();

    return Response.json({
      history: history.map(h => ({
        ...h, approved: h.approved === 1,
        critical_failures: JSON.parse(h.critical_failures || '[]'),
        warnings: JSON.parse(h.warnings || '[]'),
      })),
    });
  }

  private async getStatus(): Promise<Response> {
    const recentChecks = this.sql.exec<{ count: number; approved: number }>(
      `SELECT COUNT(*) as count, SUM(approved) as approved FROM risk_check_history WHERE timestamp > datetime('now', '-1 hour')`
    ).one();

    const unacknowledgedAlerts = this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM alert_history WHERE acknowledged = 0`
    ).one();

    return Response.json({
      agent: this.agentName,
      circuitBreakerState: this.circuitBreakerState,
      lastStateChange: this.lastStateChange,
      consecutiveFailures: this.consecutiveFailures,
      checksLastHour: recentChecks?.count ?? 0,
      approvalRateLastHour: recentChecks?.count
        ? ((recentChecks.approved ?? 0) / recentChecks.count * 100).toFixed(1) + '%' : 'N/A',
      unacknowledgedAlerts: unacknowledgedAlerts?.count ?? 0,
      limits: this.riskLimits,
    });
  }

/**
   * Detect position drift between expected (local) and broker positions
   * P-24: Triggers CAUTION at 2% drift, HALT at 5% drift
   */
  private async detectPositionDrift(request: Request): Promise<Response> {
    const body = await request.json() as {
      expectedPositions: Array<{
        marketId: string;
        side: 'YES' | 'NO';
        size: number;
        avgPrice: number;
      }>;
      brokerPositions: Array<{
        marketId: string;
        side: 'YES' | 'NO';
        size: number;
        avgPrice: number;
      }>;
    };

    const driftReport: Array<{
      marketId: string;
      side: 'YES' | 'NO';
      expectedSize: number;
      brokerSize: number;
      driftPct: number;
      driftSeverity: 'none' | 'warning' | 'critical';
    }> = [];

    let maxDriftPct = 0;
    let criticalDriftCount = 0;
    let warningDriftCount = 0;

    // Build map of broker positions for quick lookup
    const brokerMap = new Map<string, typeof body.brokerPositions[0]>();
    for (const pos of body.brokerPositions) {
      brokerMap.set(`${pos.marketId}:${pos.side}`, pos);
    }

    // Compare each expected position against broker
    for (const expected of body.expectedPositions) {
      const key = `${expected.marketId}:${expected.side}`;
      const broker = brokerMap.get(key);
      const brokerSize = broker?.size ?? 0;

      // Calculate drift percentage (relative to expected)
      const driftPct = expected.size > 0
        ? Math.abs(expected.size - brokerSize) / expected.size * 100
        : brokerSize > 0 ? 100 : 0;

      let driftSeverity: 'none' | 'warning' | 'critical' = 'none';
      if (driftPct >= 5) {
        driftSeverity = 'critical';
        criticalDriftCount++;
      } else if (driftPct >= 2) {
        driftSeverity = 'warning';
        warningDriftCount++;
      }

      maxDriftPct = Math.max(maxDriftPct, driftPct);

      driftReport.push({
        marketId: expected.marketId,
        side: expected.side,
        expectedSize: expected.size,
        brokerSize,
        driftPct,
        driftSeverity,
      });

      // Remove from broker map to track orphaned positions
      brokerMap.delete(key);
    }

    // Check for orphaned broker positions (positions we don't expect)
    for (const [_key, brokerPos] of brokerMap.entries()) {
      if (brokerPos.size > 0) {
        driftReport.push({
          marketId: brokerPos.marketId,
          side: brokerPos.side,
          expectedSize: 0,
          brokerSize: brokerPos.size,
          driftPct: 100,
          driftSeverity: 'critical',
        });
        criticalDriftCount++;
      }
    }

    // Determine recommended action
    let recommendation: 'NORMAL' | 'CAUTION' | 'HALT' = 'NORMAL';
    let circuitBreakerTriggered = false;

    if (criticalDriftCount > 0 || maxDriftPct >= 5) {
      recommendation = 'HALT';
      if (this.circuitBreakerState !== 'HALT') {
        await this.transitionToState('HALT', `Critical position drift detected: ${maxDriftPct.toFixed(2)}%`);
        circuitBreakerTriggered = true;
      }
    } else if (warningDriftCount > 0 || maxDriftPct >= 2) {
      recommendation = 'CAUTION';
      if (this.circuitBreakerState === 'NORMAL') {
        await this.transitionToState('CAUTION', `Position drift warning: ${maxDriftPct.toFixed(2)}%`);
        circuitBreakerTriggered = true;
      }
    }

    // Record alert if drift detected
    if (maxDriftPct > 0) {
      await this.recordAlert(
        'POSITION_DRIFT',
        criticalDriftCount > 0 ? 'critical' : 'warning',
        `Position drift detected: max ${maxDriftPct.toFixed(2)}%, ${criticalDriftCount} critical, ${warningDriftCount} warnings`
      );
    }

    await this.logAudit('POSITION_DRIFT_CHECK', {
      expectedCount: body.expectedPositions.length,
      brokerCount: body.brokerPositions.length,
      maxDriftPct,
      criticalDriftCount,
      warningDriftCount,
      recommendation,
    });

    return Response.json({
      verified: criticalDriftCount === 0 && warningDriftCount === 0,
      maxDriftPct,
      criticalDriftCount,
      warningDriftCount,
      recommendation,
      circuitBreakerState: this.circuitBreakerState,
      circuitBreakerTriggered,
      driftReport,
    });
  }

  /**
   * Assess LLM prompt drift against gold corpus
   * P-21: Block deployment if regression > 15% or correlation < 0.85
   */
  private async assessLLMDrift(request: Request): Promise<Response> {
    const body = await request.json() as {
      promptVersion: string;
      promptType: 'ambiguity' | 'equivalence' | 'resolution';
      testResults: Array<{
        testCaseId: string;
        expectedScore: number;
        actualScore: number;
        category: 'standard' | 'edge_case' | 'historically_disputed' | 'ambiguous_phrasing' | 'prompt_injection';
      }>;
      adversarialResults?: Array<{
        testCaseId: string;
        passed: boolean;
        injectionAttempted: string;
      }>;
    };

    // Calculate regression metrics
    const scores = body.testResults.map(r => ({
      expected: r.expectedScore,
      actual: r.actualScore,
      delta: Math.abs(r.actualScore - r.expectedScore),
    }));

    const maxDelta = Math.max(...scores.map(s => s.delta));
    const avgDelta = scores.reduce((sum, s) => sum + s.delta, 0) / scores.length;

    // Calculate Pearson correlation
    const n = scores.length;
    const sumX = scores.reduce((sum, s) => sum + s.expected, 0);
    const sumY = scores.reduce((sum, s) => sum + s.actual, 0);
    const sumXY = scores.reduce((sum, s) => sum + s.expected * s.actual, 0);
    const sumX2 = scores.reduce((sum, s) => sum + s.expected * s.expected, 0);
    const sumY2 = scores.reduce((sum, s) => sum + s.actual * s.actual, 0);

    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    const correlation = denominator !== 0 ? numerator / denominator : 0;

    // Check rank order stability (top 3 should be same)
    const sortedExpected = [...body.testResults].sort((a, b) => b.expectedScore - a.expectedScore);
    const sortedActual = [...body.testResults].sort((a, b) => b.actualScore - a.actualScore);
    const top3Expected = sortedExpected.slice(0, 3).map(r => r.testCaseId);
    const top3Actual = sortedActual.slice(0, 3).map(r => r.testCaseId);
    const rankOrderStable = top3Expected.every((id, idx) => top3Actual[idx] === id);

    // Check adversarial tests (must be 100% pass rate)
    const adversarialPassRate = body.adversarialResults
      ? body.adversarialResults.filter(r => r.passed).length / body.adversarialResults.length
      : 1.0;

    // Calculate pass rate
    const passThreshold = 0.15; // 15% max delta
    const passingTests = body.testResults.filter(r => Math.abs(r.actualScore - r.expectedScore) <= passThreshold);
    const passRate = passingTests.length / body.testResults.length;

    // Determine deployment decision
    const failures: string[] = [];

    if (maxDelta > passThreshold) {
      failures.push(`Max delta ${(maxDelta * 100).toFixed(1)}% exceeds ${(passThreshold * 100).toFixed(0)}% threshold`);
    }

    if (correlation < 0.85) {
      failures.push(`Correlation ${correlation.toFixed(3)} below 0.85 threshold`);
    }

    if (!rankOrderStable) {
      failures.push('Top-3 rank order changed');
    }

    if (adversarialPassRate < 1.0) {
      failures.push(`Adversarial tests: ${(adversarialPassRate * 100).toFixed(0)}% pass rate (100% required)`);
    }

    if (passRate < 0.90) {
      failures.push(`Overall pass rate ${(passRate * 100).toFixed(1)}% below 90% threshold`);
    }

    const deployAllowed = failures.length === 0;

    // Record drift sweep result to D1 (via API call would be needed in real implementation)
    // For now, we audit log it
    await this.logAudit('LLM_DRIFT_ASSESSMENT', {
      promptVersion: body.promptVersion,
      promptType: body.promptType,
      testCount: body.testResults.length,
      maxDelta,
      avgDelta,
      correlation,
      rankOrderStable,
      adversarialPassRate,
      passRate,
      deployAllowed,
      failures,
    });

    // Record alert if deployment blocked
    if (!deployAllowed) {
      await this.recordAlert(
        'LLM_DRIFT_BLOCKED',
        'critical',
        `Prompt ${body.promptVersion} deployment blocked: ${failures.join('; ')}`
      );
    }

    return Response.json({
      promptVersion: body.promptVersion,
      promptType: body.promptType,
      deployAllowed,
      decision: deployAllowed ? 'DEPLOY_ALLOWED' : 'BLOCK_DEPLOYMENT',
      metrics: {
        testCount: body.testResults.length,
        passRate,
        maxDelta,
        avgDelta,
        correlation,
        rankOrderStable,
        adversarialPassRate,
      },
      thresholds: {
        maxDeltaThreshold: passThreshold,
        minCorrelation: 0.85,
        minPassRate: 0.90,
        adversarialRequired: 1.0,
      },
      failures,
      categoryBreakdown: {
        standard: body.testResults.filter(r => r.category === 'standard').length,
        edgeCase: body.testResults.filter(r => r.category === 'edge_case').length,
        historicallyDisputed: body.testResults.filter(r => r.category === 'historically_disputed').length,
        ambiguousPhrasing: body.testResults.filter(r => r.category === 'ambiguous_phrasing').length,
        promptInjection: body.testResults.filter(r => r.category === 'prompt_injection').length,
      },
    });
  }

  private buildRiskCheckRequest(partial: Partial<RiskCheckRequest>): RiskCheckRequest {
    return {
      marketId: partial.marketId ?? 'unknown',
      venue: partial.venue ?? 'kalshi',
      side: partial.side ?? 'YES',
      size: partial.size ?? 0,
      price: partial.price ?? 0,
      strategy: partial.strategy ?? 'unknown',
      marketPrice: partial.marketPrice ?? partial.price ?? 0,
      spread: partial.spread ?? 0,
      volume24h: partial.volume24h ?? 0,
      vpinScore: partial.vpinScore,
      ambiguityScore: partial.ambiguityScore,
      equivalenceGrade: partial.equivalenceGrade,
      settlementDate: partial.settlementDate ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      category: partial.category ?? 'unknown',
      lastPriceUpdate: partial.lastPriceUpdate ?? new Date().toISOString(),
      portfolioValue: partial.portfolioValue ?? 10000,
      dailyPnL: partial.dailyPnL ?? 0,
      weeklyPnL: partial.weeklyPnL ?? 0,
      maxDrawdown: partial.maxDrawdown ?? 0,
      existingPositions: partial.existingPositions ?? [],
      correlatedMarkets: partial.correlatedMarkets ?? [], // P-06 Event Graph integration
      circuitBreakerState: this.circuitBreakerState,
      systemHealthy: partial.systemHealthy ?? true,
    };
  }

  private getAdjustedLimits(): RiskLimits {
    const base = { ...this.riskLimits };

    switch (this.circuitBreakerState) {
      case 'CAUTION':
        return {
          ...base,
          maxPositionPct: base.maxPositionPct * 0.5,
          maxConcentrationPct: base.maxConcentrationPct * 0.5,
          maxOrderSize: base.maxOrderSize * 0.5,
          maxDailyLossPct: base.maxDailyLossPct * 0.5,
        };
      case 'HALT':
        return { ...base, maxPositionPct: 0, maxConcentrationPct: 0, maxOrderSize: 0 };
      case 'RECOVERY':
        return {
          ...base,
          maxPositionPct: base.maxPositionPct * 0.75,
          maxConcentrationPct: base.maxConcentrationPct * 0.75,
          maxOrderSize: base.maxOrderSize * 0.75,
        };
      default:
        return base;
    }
  }

  private isValidTransition(from: CircuitBreakerState, to: CircuitBreakerState): boolean {
    const validTransitions: Record<CircuitBreakerState, CircuitBreakerState[]> = {
      NORMAL: ['CAUTION', 'HALT'],
      CAUTION: ['NORMAL', 'HALT', 'RECOVERY'],
      HALT: ['RECOVERY'],
      RECOVERY: ['NORMAL', 'CAUTION', 'HALT'],
    };
    return validTransitions[from]?.includes(to) ?? false;
  }

  private async transitionToState(to: CircuitBreakerState, reason: string): Promise<void> {
    const from = this.circuitBreakerState;
    this.sql.exec(
      `INSERT INTO circuit_breaker_history (from_state, to_state, reason, timestamp) VALUES (?, ?, ?, ?)`,
      from, to, reason, new Date().toISOString()
    );
    this.circuitBreakerState = to;
    this.lastStateChange = new Date().toISOString();
    await this.logAudit('CIRCUIT_BREAKER_TRANSITION', { from, to, reason });
  }
}
