/**
 * Paul P - Strategy Deployment Workflow
 *
 * GO/NO-GO criteria validation for live deployment:
 * - Paper trading performance validation
 * - System health checks
 * - LLM drift sweep verification
 * - Human approval workflow
 * - Capital allocation
 */

import type { Env } from '../types/env';

// ============================================================
// Types
// ============================================================

export type StrategyType = 'bonding' | 'weather' | 'xv_signal' | 'smart_money' | 'resolution';

export interface StrategyGOCriteria {
  minPaperPositions: number;
  minWinRate: number;
  maxDrawdown: number;
  minCLVPositiveRate?: number;
  minOOSAccuracy?: number;
}

export interface SystemGOCriteria {
  allInvariantsTested: boolean;
  auditChainIntact: boolean;
  anchorVerified: boolean;
  driftSweepPassed: boolean;
  humanApproval: 'pending' | 'approved' | 'rejected';
}

export interface GOCriteriaResult {
  strategy: StrategyType;
  passed: boolean;
  criteria: Record<string, CriterionResult>;
  missingCriteria: string[];
  timestamp: string;
}

export interface CriterionResult {
  name: string;
  required: number | boolean;
  actual: number | boolean;
  passed: boolean;
  message?: string;
}

export interface DeploymentState {
  strategies: Record<StrategyType, StrategyDeploymentState>;
  systemChecks: SystemGOCriteria;
  deploymentPhase: 'validation' | 'awaiting_approval' | 'deploying' | 'live' | 'failed';
  lastUpdated: string;
}

export interface StrategyDeploymentState {
  status: 'not_ready' | 'validating' | 'ready' | 'live' | 'disabled';
  goResult?: GOCriteriaResult;
  paperStats?: PaperTradingStats;
  liveCapital?: number;
  deployedAt?: string;
}

export interface PaperTradingStats {
  totalPositions: number;
  winRate: number;
  maxDrawdown: number;
  clvPositiveRate?: number;
  oosAccuracy?: number;
  avgCLV: number;
  sharpeRatio: number;
  lastUpdated: string;
}

export interface LiveCapitalAllocation {
  strategy: StrategyType;
  capital: number;
  maxPositionPct: number;
}

export interface BacktestFidelityReport {
  strategy: StrategyType;
  paperPeriod: { start: string; end: string };
  metrics: {
    totalTrades: number;
    winRate: number;
    avgCLV: number;
    sharpe: number;
    maxDrawdown: number;
    profitFactor: number;
  };
  comparison?: {
    historicalAvgCLV: number;
    deviation: number;
    withinExpected: boolean;
  };
  generatedAt: string;
}

// ============================================================
// GO Criteria Definitions
// ============================================================

const STRATEGY_GO_CRITERIA: Record<StrategyType, StrategyGOCriteria> = {
  bonding: {
    minPaperPositions: 15,
    minWinRate: 0.90,
    maxDrawdown: 0.05,
  },
  weather: {
    minPaperPositions: 20,
    minWinRate: 0.50, // Weather is harder
    maxDrawdown: 0.10,
    minOOSAccuracy: 0.55,
    minCLVPositiveRate: 0.60,
  },
  xv_signal: {
    minPaperPositions: 10,
    minWinRate: 0.65,
    maxDrawdown: 0.08,
  },
  smart_money: {
    minPaperPositions: 10,
    minWinRate: 0.60,
    maxDrawdown: 0.08,
  },
  resolution: {
    minPaperPositions: 10,
    minWinRate: 0.55,
    maxDrawdown: 0.10,
  },
};

const LIVE_ALLOCATION: Record<StrategyType, LiveCapitalAllocation> = {
  bonding: { strategy: 'bonding', capital: 500, maxPositionPct: 5 },
  weather: { strategy: 'weather', capital: 300, maxPositionPct: 5 },
  xv_signal: { strategy: 'xv_signal', capital: 0, maxPositionPct: 5 }, // Enabled after 2 weeks
  smart_money: { strategy: 'smart_money', capital: 0, maxPositionPct: 5 }, // Enabled after 2 weeks
  resolution: { strategy: 'resolution', capital: 0, maxPositionPct: 5 }, // Enabled after 2 weeks
};

// ============================================================
// Workflow Implementation
// ============================================================

export class StrategyDeploymentWorkflow {
  private state: DeploymentState;

  constructor(private env: Env) {
    this.state = {
      strategies: {
        bonding: { status: 'not_ready' },
        weather: { status: 'not_ready' },
        xv_signal: { status: 'not_ready' },
        smart_money: { status: 'not_ready' },
        resolution: { status: 'not_ready' },
      },
      systemChecks: {
        allInvariantsTested: false,
        auditChainIntact: false,
        anchorVerified: false,
        driftSweepPassed: false,
        humanApproval: 'pending',
      },
      deploymentPhase: 'validation',
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Validate GO criteria for a specific strategy
   */
  async validateStrategyGO(strategy: StrategyType): Promise<GOCriteriaResult> {
    const criteria = STRATEGY_GO_CRITERIA[strategy];
    const stats = await this.fetchPaperTradingStats(strategy);

    const results: Record<string, CriterionResult> = {};
    const missingCriteria: string[] = [];
    let allPassed = true;

    // Check paper positions
    results.minPaperPositions = {
      name: 'Minimum Paper Positions',
      required: criteria.minPaperPositions,
      actual: stats?.totalPositions ?? 0,
      passed: (stats?.totalPositions ?? 0) >= criteria.minPaperPositions,
    };
    if (!results.minPaperPositions.passed) {
      allPassed = false;
      missingCriteria.push(`Need ${criteria.minPaperPositions} paper positions, have ${stats?.totalPositions ?? 0}`);
    }

    // Check win rate
    results.minWinRate = {
      name: 'Minimum Win Rate',
      required: criteria.minWinRate,
      actual: stats?.winRate ?? 0,
      passed: (stats?.winRate ?? 0) >= criteria.minWinRate,
    };
    if (!results.minWinRate.passed) {
      allPassed = false;
      missingCriteria.push(`Win rate ${((stats?.winRate ?? 0) * 100).toFixed(1)}% below required ${(criteria.minWinRate * 100).toFixed(1)}%`);
    }

    // Check max drawdown
    results.maxDrawdown = {
      name: 'Maximum Drawdown',
      required: criteria.maxDrawdown,
      actual: stats?.maxDrawdown ?? 1,
      passed: (stats?.maxDrawdown ?? 1) <= criteria.maxDrawdown,
    };
    if (!results.maxDrawdown.passed) {
      allPassed = false;
      missingCriteria.push(`Drawdown ${((stats?.maxDrawdown ?? 1) * 100).toFixed(1)}% exceeds max ${(criteria.maxDrawdown * 100).toFixed(1)}%`);
    }

    // Check CLV positive rate (if required)
    if (criteria.minCLVPositiveRate !== undefined) {
      results.minCLVPositiveRate = {
        name: 'CLV Positive Rate',
        required: criteria.minCLVPositiveRate,
        actual: stats?.clvPositiveRate ?? 0,
        passed: (stats?.clvPositiveRate ?? 0) >= criteria.minCLVPositiveRate,
      };
      if (!results.minCLVPositiveRate.passed) {
        allPassed = false;
        missingCriteria.push(`CLV positive rate ${((stats?.clvPositiveRate ?? 0) * 100).toFixed(1)}% below required ${(criteria.minCLVPositiveRate * 100).toFixed(1)}%`);
      }
    }

    // Check OOS accuracy (if required)
    if (criteria.minOOSAccuracy !== undefined) {
      results.minOOSAccuracy = {
        name: 'Out-of-Sample Accuracy',
        required: criteria.minOOSAccuracy,
        actual: stats?.oosAccuracy ?? 0,
        passed: (stats?.oosAccuracy ?? 0) >= criteria.minOOSAccuracy,
      };
      if (!results.minOOSAccuracy.passed) {
        allPassed = false;
        missingCriteria.push(`OOS accuracy ${((stats?.oosAccuracy ?? 0) * 100).toFixed(1)}% below required ${(criteria.minOOSAccuracy * 100).toFixed(1)}%`);
      }
    }

    const result: GOCriteriaResult = {
      strategy,
      passed: allPassed,
      criteria: results,
      missingCriteria,
      timestamp: new Date().toISOString(),
    };

    // Update state
    this.state.strategies[strategy].goResult = result;
    this.state.strategies[strategy].paperStats = stats ?? undefined;
    this.state.strategies[strategy].status = allPassed ? 'ready' : 'not_ready';
    this.state.lastUpdated = new Date().toISOString();

    return result;
  }

  /**
   * Validate all system-level GO criteria
   */
  async validateSystemGO(): Promise<SystemGOCriteria> {
    // Check invariants
    const invariantsResult = await this.checkInvariantsTested();
    this.state.systemChecks.allInvariantsTested = invariantsResult;

    // Check audit chain
    const chainResult = await this.checkAuditChainIntegrity();
    this.state.systemChecks.auditChainIntact = chainResult.intact;
    this.state.systemChecks.anchorVerified = chainResult.anchorValid;

    // Check drift sweep
    const driftResult = await this.checkLLMDriftSweep();
    this.state.systemChecks.driftSweepPassed = driftResult;

    this.state.lastUpdated = new Date().toISOString();
    return this.state.systemChecks;
  }

  /**
   * Grant human approval for deployment
   */
  async grantHumanApproval(approverId: string): Promise<boolean> {
    // Log the approval event
    await this.logDeploymentEvent('HUMAN_APPROVAL_GRANTED', {
      approverId,
      timestamp: new Date().toISOString(),
    });

    this.state.systemChecks.humanApproval = 'approved';
    this.state.lastUpdated = new Date().toISOString();

    // Check if we can proceed to deployment
    if (this.canProceedToDeployment()) {
      this.state.deploymentPhase = 'deploying';
    }

    return true;
  }

  /**
   * Reject deployment
   */
  async rejectDeployment(reviewerId: string, reason: string): Promise<void> {
    await this.logDeploymentEvent('DEPLOYMENT_REJECTED', {
      reviewerId,
      reason,
      timestamp: new Date().toISOString(),
    });

    this.state.systemChecks.humanApproval = 'rejected';
    this.state.deploymentPhase = 'failed';
    this.state.lastUpdated = new Date().toISOString();
  }

  /**
   * Check if all criteria met for deployment
   */
  canProceedToDeployment(): boolean {
    // At least one strategy must be ready
    const readyStrategies = Object.values(this.state.strategies).filter(
      s => s.status === 'ready'
    );
    if (readyStrategies.length === 0) return false;

    // All system checks must pass
    if (!this.state.systemChecks.allInvariantsTested) return false;
    if (!this.state.systemChecks.auditChainIntact) return false;
    if (!this.state.systemChecks.anchorVerified) return false;
    if (!this.state.systemChecks.driftSweepPassed) return false;
    if (this.state.systemChecks.humanApproval !== 'approved') return false;

    return true;
  }

  /**
   * Execute deployment for approved strategies
   */
  async executeDeployment(): Promise<{
    deployed: StrategyType[];
    skipped: StrategyType[];
    errors: Array<{ strategy: StrategyType; error: string }>;
  }> {
    if (!this.canProceedToDeployment()) {
      throw new Error('Cannot proceed: GO criteria not met');
    }

    const deployed: StrategyType[] = [];
    const skipped: StrategyType[] = [];
    const errors: Array<{ strategy: StrategyType; error: string }> = [];

    for (const [strategy, state] of Object.entries(this.state.strategies) as Array<[StrategyType, StrategyDeploymentState]>) {
      if (state.status !== 'ready') {
        skipped.push(strategy);
        continue;
      }

      try {
        // Get capital allocation
        const allocation = LIVE_ALLOCATION[strategy];
        if (allocation.capital === 0) {
          skipped.push(strategy);
          continue;
        }

        // Set execution policy to LIVE
        await this.setExecutionMode(strategy, 'LIVE');

        // Allocate capital
        await this.allocateCapital(strategy, allocation.capital, allocation.maxPositionPct);

        // Update state
        this.state.strategies[strategy].status = 'live';
        this.state.strategies[strategy].liveCapital = allocation.capital;
        this.state.strategies[strategy].deployedAt = new Date().toISOString();

        deployed.push(strategy);

        await this.logDeploymentEvent('STRATEGY_DEPLOYED', {
          strategy,
          capital: allocation.capital,
          maxPositionPct: allocation.maxPositionPct,
        });
      } catch (error) {
        errors.push({
          strategy,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (deployed.length > 0) {
      this.state.deploymentPhase = 'live';
    }

    this.state.lastUpdated = new Date().toISOString();

    return { deployed, skipped, errors };
  }

  /**
   * Generate backtest fidelity report
   */
  async generateBacktestFidelityReport(strategy: StrategyType): Promise<BacktestFidelityReport> {
    const stats = await this.fetchPaperTradingStats(strategy);

    // Fetch historical data for comparison
    const historical = await this.fetchHistoricalMetrics(strategy);

    const report: BacktestFidelityReport = {
      strategy,
      paperPeriod: {
        start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        end: new Date().toISOString(),
      },
      metrics: {
        totalTrades: stats?.totalPositions ?? 0,
        winRate: stats?.winRate ?? 0,
        avgCLV: stats?.avgCLV ?? 0,
        sharpe: stats?.sharpeRatio ?? 0,
        maxDrawdown: stats?.maxDrawdown ?? 0,
        profitFactor: stats ? (stats.winRate / (1 - stats.winRate)) : 0,
      },
      generatedAt: new Date().toISOString(),
    };

    if (historical) {
      const deviation = Math.abs((stats?.avgCLV ?? 0) - historical.avgCLV) / (historical.avgCLV || 1);
      report.comparison = {
        historicalAvgCLV: historical.avgCLV,
        deviation,
        withinExpected: deviation < 0.5, // Within 50% of historical
      };
    }

    return report;
  }

  /**
   * Get current deployment state
   */
  getState(): DeploymentState {
    return { ...this.state };
  }

  /**
   * Get full deployment checklist
   */
  async getDeploymentChecklist(): Promise<{
    preDeployment: Array<{ item: string; status: 'pass' | 'fail' | 'pending' }>;
    goLive: Array<{ item: string; status: 'pass' | 'fail' | 'pending' }>;
    postDeployment: Array<{ item: string; status: 'pass' | 'fail' | 'pending' }>;
  }> {
    await this.validateSystemGO();

    return {
      preDeployment: [
        {
          item: 'All 17 invariants have passing tests',
          status: this.state.systemChecks.allInvariantsTested ? 'pass' : 'fail',
        },
        {
          item: 'Audit chain integrity verified from genesis',
          status: this.state.systemChecks.auditChainIntact ? 'pass' : 'fail',
        },
        {
          item: 'D1_ANCHOR has valid anchors',
          status: this.state.systemChecks.anchorVerified ? 'pass' : 'fail',
        },
        {
          item: 'Drift sweep shows no blocked_deployment flags',
          status: this.state.systemChecks.driftSweepPassed ? 'pass' : 'fail',
        },
        {
          item: 'Regression test suite passes 100%',
          status: 'pending', // Would check in production
        },
        {
          item: 'Paper trading shows positive CLV for strategies',
          status: Object.values(this.state.strategies).some(s => s.status === 'ready') ? 'pass' : 'fail',
        },
        {
          item: 'Circuit breaker tested through all state transitions',
          status: 'pending', // Would verify in production
        },
      ],
      goLive: [
        {
          item: 'Human approval received via workflow event',
          status: this.state.systemChecks.humanApproval === 'approved' ? 'pass' :
                  this.state.systemChecks.humanApproval === 'rejected' ? 'fail' : 'pending',
        },
        {
          item: 'Execution policy set to LIVE for approved strategies',
          status: Object.values(this.state.strategies).some(s => s.status === 'live') ? 'pass' : 'pending',
        },
        {
          item: 'Initial capital allocated',
          status: Object.values(this.state.strategies).some(s => (s.liveCapital ?? 0) > 0) ? 'pass' : 'pending',
        },
        {
          item: 'Monitoring alerts configured',
          status: 'pending',
        },
        {
          item: 'Daily report workflow active',
          status: 'pending',
        },
        {
          item: 'Postmortem template ready',
          status: 'pending',
        },
      ],
      postDeployment: [
        {
          item: 'First live orders executed successfully',
          status: 'pending',
        },
        {
          item: 'Reconciliation agent confirms position sync',
          status: 'pending',
        },
        {
          item: 'No invariant violations',
          status: 'pending',
        },
        {
          item: 'Audit chain updated with live events',
          status: 'pending',
        },
        {
          item: 'Slack alerts functioning',
          status: 'pending',
        },
      ],
    };
  }

  // ============================================================
  // Private Helpers
  // ============================================================

  private async fetchPaperTradingStats(strategy: StrategyType): Promise<PaperTradingStats | null> {
    try {
      // Query D1 for paper trading statistics from paper_positions table
      const result = await this.env.DB.prepare(`
        SELECT
          COUNT(*) as total_positions,
          AVG(CASE WHEN realized_pnl > 0 THEN 1.0 ELSE 0.0 END) as win_rate,
          MAX(drawdown) as max_drawdown,
          AVG(clv) as avg_clv,
          AVG(CASE WHEN clv > 0 THEN 1.0 ELSE 0.0 END) as clv_positive_rate
        FROM paper_positions
        WHERE strategy = ? AND status IN ('closed', 'resolved')
      `).bind(strategy).first<{
        total_positions: number;
        win_rate: number | null;
        max_drawdown: number | null;
        avg_clv: number | null;
        clv_positive_rate: number | null;
      }>();

      if (!result || result.total_positions === 0) return null;

      // Calculate Sharpe ratio from historical returns if available
      const returnsResult = await this.env.DB.prepare(`
        SELECT realized_pnl, size
        FROM paper_positions
        WHERE strategy = ? AND status IN ('closed', 'resolved') AND size > 0
      `).bind(strategy).all<{ realized_pnl: number; size: number }>();

      const returns = (returnsResult.results ?? [])
        .filter(r => r.size > 0)
        .map(r => r.realized_pnl / r.size);

      const mean = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
      const variance = returns.length > 1
        ? returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1)
        : 0;
      const sharpe = variance > 0 ? mean / Math.sqrt(variance) : 0;

      return {
        totalPositions: result.total_positions,
        winRate: result.win_rate ?? 0,
        maxDrawdown: result.max_drawdown ?? 0,
        avgCLV: result.avg_clv ?? 0,
        clvPositiveRate: result.clv_positive_rate ?? 0,
        sharpeRatio: sharpe,
        lastUpdated: new Date().toISOString(),
      };
    } catch (error) {
      console.error(`Error fetching paper stats for ${strategy}:`, error);
      return null;
    }
  }

  private async checkInvariantsTested(): Promise<boolean> {
    try {
      // Check that all 17 invariants have passing tests in the last 24 hours
      const result = await this.env.DB.prepare(`
        SELECT COUNT(DISTINCT invariant_id) as distinct_invariants
        FROM invariant_test_results
        WHERE passed = 1 AND tested_at > datetime('now', '-1 day')
      `).first<{ distinct_invariants: number }>();

      // Require all 17 invariants to have passing tests
      return (result?.distinct_invariants ?? 0) >= 17;
    } catch (error) {
      console.error('Error checking invariant tests:', error);
      return false;
    }
  }

  private async checkAuditChainIntegrity(): Promise<{ intact: boolean; anchorValid: boolean }> {
    try {
      // Check chain integrity - look for gaps in event_sequence
      const chainResult = await this.env.DB.prepare(`
        SELECT COUNT(*) as gap_count FROM (
          SELECT event_sequence,
                 LAG(event_sequence) OVER (ORDER BY event_sequence) as prev_seq
          FROM audit_chain_events
        ) WHERE event_sequence != prev_seq + 1 AND prev_seq IS NOT NULL
      `).first<{ gap_count: number }>();

      // Check anchor validity in anchor database
      // Schema has 'verified' column (INTEGER 0/1)
      const anchorResult = await this.env.DB_ANCHOR.prepare(`
        SELECT COUNT(*) as verified_count FROM audit_chain_anchors
        WHERE verified = 1
      `).first<{ verified_count: number }>();

      // Also check that we have at least one recent anchor
      const recentAnchor = await this.env.DB_ANCHOR.prepare(`
        SELECT COUNT(*) as recent_count FROM audit_chain_anchors
        WHERE anchor_timestamp > datetime('now', '-2 hours')
      `).first<{ recent_count: number }>();

      return {
        intact: (chainResult?.gap_count ?? 1) === 0,
        anchorValid: (anchorResult?.verified_count ?? 0) > 0 && (recentAnchor?.recent_count ?? 0) > 0,
      };
    } catch (error) {
      console.error('Error checking audit chain integrity:', error);
      return { intact: false, anchorValid: false };
    }
  }

  private async checkLLMDriftSweep(): Promise<boolean> {
    try {
      // Check for blocked deployment flags in recent drift sweeps
      // Using run_at column from 0005_llm_governance.sql schema
      const result = await this.env.DB.prepare(`
        SELECT COUNT(*) as blocked FROM llm_drift_sweeps
        WHERE blocked_deployment = 1
        AND run_at > datetime('now', '-7 days')
      `).first<{ blocked: number }>();

      // If there are any blocked sweeps in the last 7 days, fail
      return (result?.blocked ?? 0) === 0;
    } catch (error) {
      console.error('Error checking LLM drift sweep:', error);
      // Default to false (blocked) on error for safety
      return false;
    }
  }

  private async fetchHistoricalMetrics(strategy: StrategyType): Promise<{ avgCLV: number } | null> {
    try {
      const result = await this.env.DB.prepare(`
        SELECT AVG(clv) as avg_clv FROM historical_metrics
        WHERE strategy = ?
      `).bind(strategy).first<{ avg_clv: number }>();

      return result ? { avgCLV: result.avg_clv } : null;
    } catch {
      return null;
    }
  }

  private async setExecutionMode(strategy: StrategyType, mode: 'PAPER' | 'LIVE'): Promise<void> {
    await this.env.DB.prepare(`
      INSERT INTO strategy_execution_mode (strategy, mode, changed_at, reason)
      VALUES (?, ?, datetime('now'), 'Deployment workflow')
      ON CONFLICT(strategy) DO UPDATE SET mode = excluded.mode, changed_at = excluded.changed_at, reason = excluded.reason
    `).bind(strategy, mode).run();
  }

  private async allocateCapital(strategy: StrategyType, capital: number, maxPositionPct: number): Promise<void> {
    await this.env.DB.prepare(`
      INSERT INTO capital_allocation (strategy, capital, max_position_pct, available, enabled, enabled_at, allocated_at)
      VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))
      ON CONFLICT(strategy) DO UPDATE SET
        capital = excluded.capital,
        max_position_pct = excluded.max_position_pct,
        available = excluded.available,
        enabled = 1,
        enabled_at = datetime('now'),
        updated_at = datetime('now')
    `).bind(strategy, capital, maxPositionPct, capital).run();
  }

  private async logDeploymentEvent(eventType: string, payload: Record<string, unknown>): Promise<void> {
    await this.env.DB.prepare(`
      INSERT INTO deployment_events (event_type, payload, created_at)
      VALUES (?, ?, datetime('now'))
    `).bind(eventType, JSON.stringify(payload)).run();
  }
}

// ============================================================
// Export helpers
// ============================================================

export function getStrategyGOCriteria(strategy: StrategyType): StrategyGOCriteria {
  return STRATEGY_GO_CRITERIA[strategy];
}

export function getLiveAllocation(strategy: StrategyType): LiveCapitalAllocation {
  return LIVE_ALLOCATION[strategy];
}
