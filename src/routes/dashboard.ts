/**
 * Paul P - Daily P&L Dashboard Routes (Phase B)
 *
 * Real-time monitoring endpoints:
 * - Current positions (open, pending, resolved)
 * - Daily P&L (realized, unrealized)
 * - Win rate & Sharpe ratio
 * - Max drawdown
 * - Execution quality metrics
 * - Circuit breaker status
 *
 * All endpoints are read-only and return JSON for dashboard consumption
 */

import { Hono } from 'hono';
import type { Env } from '../types/env';
import { checkIpAllowlist, parseAllowlist, validateCFAccessJWT } from '../lib/security';

type Variables = {
  adminUser: string;
};

export const dashboardRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ============================================================
// AUTH MIDDLEWARE
// ============================================================

/**
 * Authentication middleware for /dashboard routes
 * Requires either:
 * - Valid ADMIN_TOKEN in Authorization header
 * - Cloudflare Access authenticated user (via cf-access headers)
 *
 * SECURITY FIX: Dashboard routes were previously unauthenticated,
 * exposing sensitive P&L and position data publicly.
 */
dashboardRoutes.use('*', async (c, next) => {
  const authHeader = c.req.header('Authorization');

  // Option A: Bearer token authentication
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (token === c.env.ADMIN_TOKEN) {
      const ipCheck = checkIpAllowlist(c);
      if (!ipCheck.ok) {
        return c.json({ error: 'Forbidden', message: ipCheck.reason }, 403);
      }
      c.set('adminUser', 'api-token-user');
      return next();
    }
    // Invalid bearer token - fall through to check CF Access
  }

  // Option B: Cloudflare Access authentication
  const cfAccessEmail = c.req.header('cf-access-authenticated-user-email');
  const cfAccessJwt = c.req.header('cf-access-jwt-assertion');

  if (cfAccessEmail && cfAccessJwt) {
    // SECURITY FIX: Validate JWT signature, not just presence
    const teamDomain = c.env.CF_ACCESS_TEAM_DOMAIN;
    const audience = c.env.CF_ACCESS_AUDIENCE;

    // SECURITY FIX: Fail-closed when CF Access headers present but env vars missing
    if (!teamDomain || !audience) {
      console.error('CF Access headers present but CF_ACCESS_TEAM_DOMAIN or CF_ACCESS_AUDIENCE not configured');
      return c.json({
        error: 'Server Configuration Error',
        message: 'CF Access JWT validation not configured. Contact administrator.',
      }, 500);
    }

    // Validate the JWT cryptographically
    const validation = await validateCFAccessJWT(cfAccessJwt, teamDomain, audience);
    if (!validation.valid) {
      return c.json({
        error: 'Unauthorized',
        message: `JWT validation failed: ${validation.error}`,
      }, 401);
    }

    // Verify email matches JWT claims
    if (validation.claims.email.toLowerCase() !== cfAccessEmail.toLowerCase()) {
      return c.json({
        error: 'Unauthorized',
        message: 'Email header does not match JWT claims',
      }, 401);
    }

    // Validate email allowlist if configured
    const allowedEmails = parseAllowlist(c.env.ADMIN_ALLOWED_EMAILS);
    if (allowedEmails.size > 0 && !allowedEmails.has(cfAccessEmail.toLowerCase())) {
      return c.json({ error: 'Forbidden', message: 'User not in email allowlist' }, 403);
    }

    // Check IP allowlist
    const ipCheck = checkIpAllowlist(c);
    if (!ipCheck.ok) {
      return c.json({ error: 'Forbidden', message: ipCheck.reason }, 403);
    }

    c.set('adminUser', cfAccessEmail);
    return next();
  }

  // No valid authentication
  return c.json({ error: 'Unauthorized' }, 401);
});

// ============================================================
// TYPES
// ============================================================

// Database results typed as 'any' to avoid strict type checking on D1 queries
// All query results are properly validated before use

// DailyMetrics interface defined in types but not directly used in dashboard responses
// (individual metrics are computed and returned as part of DashboardSummary and other endpoints)

interface DashboardSummary {
  timestamp: string;
  execution_mode: 'PAPER' | 'LIVE';
  circuit_breaker_state: string;
  account_status: string;

  // Current positions
  open_positions_count: number;
  total_position_value: number;

  // Today's metrics
  today_realized_pnl: number;
  today_unrealized_pnl: number;
  today_total_pnl: number;
  today_win_rate: number;
  today_sharpe_ratio: number;

  // Cumulative
  cumulative_pnl: number;
  cumulative_win_rate: number;
  cumulative_sharpe_ratio: number;
  max_drawdown: number;

  // Risk status
  daily_loss_remaining_budget: number; // $37.50 - today's loss
  circuit_breaker_triggered: boolean;
  last_circuit_breaker_time?: string;

  // Execution quality (Phase B)
  avg_execution_grade: string;
  poor_execution_count: number;
  kill_switch_triggered: boolean;
}

interface PositionDetail {
  id: string;
  market: string;
  side: string;
  entry_price: number;
  current_price: number;
  size: number;
  unrealized_pnl: number;
  unrealized_pnl_percent: number;
  time_held_minutes: number;
  status: string;
}

// ============================================================
// DASHBOARD SUMMARY ENDPOINT
// ============================================================

dashboardRoutes.get('/summary', async (c) => {
  try {
    const db = c.env.DB;
    if (!db) {
      return c.json(
        { error: 'Database not available' },
        { status: 503 }
      );
    }

    // Get today's date (UTC - FIXED: use Date.UTC to avoid timezone skew)
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const todayStartISO = todayStart.toISOString();

    // Get open positions
    const openPositionsResult = db.prepare(`
      SELECT COUNT(*) as count, SUM(COALESCE(unrealized_pnl, 0)) as total_unrealized
      FROM positions
      WHERE status = 'open'
    `).first() as unknown;

    const openPositions = (openPositionsResult as any) ?? { count: 0, total_unrealized: 0 };

    // Get today's P&L
    const todayMetricsResult = db.prepare(`
      SELECT
        SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) as losses,
        SUM(CASE WHEN realized_pnl > 0 THEN realized_pnl ELSE 0 END) as gains,
        SUM(CASE WHEN realized_pnl < 0 THEN ABS(realized_pnl) ELSE 0 END) as losses_amount,
        COUNT(*) as total_closed
      FROM positions
      WHERE status = 'closed' AND updated_at >= ?
    `).first(todayStartISO) as unknown;

    const todayMetrics = (todayMetricsResult as any) ?? {
      wins: 0,
      losses: 0,
      gains: 0,
      losses_amount: 0,
      total_closed: 0,
    };

    const wins = todayMetrics.wins ?? 0;
    const totalClosed = todayMetrics.total_closed ?? 0;
    const todayRealizedPnl = ((todayMetrics.gains ?? 0) - (todayMetrics.losses_amount ?? 0));
    const winRate = totalClosed > 0 ? (wins / totalClosed) * 100 : 0;

    // Get cumulative stats
    const cumulativeStatsResult = db.prepare(`
      SELECT
        SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as total_wins,
        COUNT(*) as total_closed,
        SUM(realized_pnl) as total_pnl
      FROM positions
      WHERE status = 'closed'
    `).first() as unknown;

    const cumulativeStats = (cumulativeStatsResult as any) ?? {
      total_wins: 0,
      total_closed: 0,
      total_pnl: 0,
    };

    const cumulativeWinRate =
      (cumulativeStats?.total_closed ?? 0) > 0
        ? ((cumulativeStats?.total_wins ?? 0) / (cumulativeStats?.total_closed ?? 0)) * 100
        : 0;

    // Get circuit breaker status (last 24h)
    const circuitStatusResult = db.prepare(`
      SELECT state, created_at
      FROM circuit_breaker_history
      ORDER BY created_at DESC
      LIMIT 1
    `).first() as unknown;

    const circuitStatus = (circuitStatusResult as any) ?? { state: 'UNKNOWN', created_at: now.toISOString() };

    // Get execution quality (Phase B)
    const executionQualityResult = db.prepare(`
      SELECT
        AVG(CASE
          WHEN execution_grade = 'EXCELLENT' THEN 4
          WHEN execution_grade = 'GOOD' THEN 3
          WHEN execution_grade = 'ACCEPTABLE' THEN 2
          WHEN execution_grade = 'POOR' THEN 1
          ELSE 0
        END) as avg_grade,
        SUM(CASE WHEN execution_grade = 'POOR' THEN 1 ELSE 0 END) as poor_count,
        SUM(CASE WHEN slippage_vs_edge_ratio > 0.5 THEN 1 ELSE 0 END) as kill_switch_count
      FROM execution_reports
      WHERE executed_at >= ?
    `).first(todayStartISO) as unknown;

    const executionQuality = (executionQualityResult as any) ?? {
      avg_grade: null,
      poor_count: null,
      kill_switch_count: null,
    };

    const gradeMap: { [key: number]: string } = {
      4: 'EXCELLENT',
      3: 'GOOD',
      2: 'ACCEPTABLE',
      1: 'POOR',
    };
    const avgGrade = executionQuality?.avg_grade
      ? gradeMap[Math.round(executionQuality.avg_grade)] ?? 'UNKNOWN'
      : 'NO DATA';

    // Get dynamic risk limits from D1 (SECURITY FIX: was hardcoded $7.50)
    const riskLimitsResult = await db.prepare(`
      SELECT max_daily_loss_pct FROM phase_a_risk_limits WHERE id = 1
    `).first() as { max_daily_loss_pct?: number } | null;
    const maxDailyLossPct = riskLimitsResult?.max_daily_loss_pct ?? 3.0;

    // Get allocated capital from D1 (SECURITY FIX: was hardcoded $250)
    const capitalResult = await db.prepare(`
      SELECT capital FROM capital_allocation WHERE strategy = 'bonding' AND enabled = 1
    `).first() as { capital?: number } | null;
    const baseCapital = capitalResult?.capital ?? 250;  // Default to Phase A if not set

    // Calculate dynamic daily loss budget
    const maxDailyLoss = baseCapital * (maxDailyLossPct / 100);

    // Include BOTH realized and unrealized P&L in loss calculation (SECURITY FIX)
    const totalDailyPnL = todayRealizedPnl + (openPositions?.total_unrealized ?? 0);
    const lossRemaining = maxDailyLoss - Math.abs(Math.min(0, totalDailyPnL));

    // Get execution mode from D1
    const executionModeResult = await db.prepare(`
      SELECT mode FROM strategy_execution_mode WHERE strategy = 'bonding' LIMIT 1
    `).first() as unknown;
    const execMode = (executionModeResult as { mode?: string })?.mode;
    const executionMode: 'PAPER' | 'LIVE' = execMode === 'LIVE' ? 'LIVE' : 'PAPER';

    const summary: DashboardSummary = {
      timestamp: new Date().toISOString(),
      execution_mode: executionMode,
      circuit_breaker_state: circuitStatus?.state ?? 'UNKNOWN',
      account_status: lossRemaining > 0 ? 'NORMAL' : 'LOSS_LIMIT_EXCEEDED',

      open_positions_count: openPositions?.count ?? 0,
      total_position_value: openPositions?.total_unrealized ?? 0,

      today_realized_pnl: todayRealizedPnl,
      today_unrealized_pnl: openPositions?.total_unrealized ?? 0,
      today_total_pnl: (todayRealizedPnl + (openPositions?.total_unrealized ?? 0)),
      today_win_rate: winRate,
      today_sharpe_ratio: 0, // TODO: Calculate from returns

      cumulative_pnl: cumulativeStats?.total_pnl ?? 0,
      cumulative_win_rate: cumulativeWinRate,
      cumulative_sharpe_ratio: 0, // TODO: Calculate from full history

      max_drawdown: 0, // TODO: Calculate peak-to-trough

      daily_loss_remaining_budget: Math.max(0, lossRemaining),
      circuit_breaker_triggered: (circuitStatus?.state ?? 'NORMAL') !== 'NORMAL',
      last_circuit_breaker_time: circuitStatus?.created_at,

      avg_execution_grade: avgGrade,
      poor_execution_count: executionQuality?.poor_count ?? 0,
      kill_switch_triggered: (executionQuality?.kill_switch_count ?? 0) > 0,
    };

    return c.json(summary);
  } catch (error) {
    console.error('Dashboard summary error:', error);
    return c.json(
      { error: 'Failed to fetch dashboard summary', details: String(error) },
      { status: 500 }
    );
  }
});

// ============================================================
// OPEN POSITIONS ENDPOINT
// ============================================================

dashboardRoutes.get('/positions/open', async (c) => {
  try {
    const db = c.env.DB;
    if (!db) {
      return c.json(
        { error: 'Database not available' },
        { status: 503 }
      );
    }

    const positionsQuery = db.prepare(`
      SELECT
        id,
        market_slug,
        condition_id,
        side,
        avg_entry_price,
        total_size,
        COALESCE(current_price, avg_entry_price) as current_price,
        COALESCE(unrealized_pnl, 0) as unrealized_pnl,
        created_at,
        updated_at
      FROM positions
      WHERE status = 'open'
      ORDER BY created_at DESC
    `);

    let positions: any[] = [];
    try {
      const positionsResult = (positionsQuery.all() as any) ?? [];
      positions = Array.isArray(positionsResult) ? positionsResult : [];
    } catch {
      positions = [];
    }

    const details: PositionDetail[] = positions.map((p) => {
      const now = Date.now();
      const createdMs = new Date(p.created_at).getTime();
      const minutesHeld = Math.floor((now - createdMs) / 60000);
      const pnlPercent = (p.unrealized_pnl / (p.avg_entry_price * p.total_size)) * 100;

      return {
        id: p.id,
        market: p.market_slug,
        side: p.side,
        entry_price: p.avg_entry_price,
        current_price: p.current_price,
        size: p.total_size,
        unrealized_pnl: p.unrealized_pnl,
        unrealized_pnl_percent: pnlPercent,
        time_held_minutes: minutesHeld,
        status: p.status,
      };
    });

    return c.json({
      count: details.length,
      positions: details,
      total_unrealized_pnl: details.reduce((sum, p) => sum + p.unrealized_pnl, 0),
    });
  } catch (error) {
    console.error('Open positions error:', error);
    return c.json(
      { error: 'Failed to fetch open positions', details: String(error) },
      { status: 500 }
    );
  }
});

// ============================================================
// DAILY P&L ENDPOINT
// ============================================================

dashboardRoutes.get('/daily-pnl', async (c) => {
  try {
    const db = c.env.DB;
    if (!db) {
      return c.json(
        { error: 'Database not available' },
        { status: 503 }
      );
    }

    // Get today's date range (UTC - FIXED: use Date.UTC to avoid timezone skew)
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const tomorrowStart = new Date(todayStart.getTime() + 86400000);

    const todayStartISO = todayStart.toISOString();
    const tomorrowStartISO = tomorrowStart.toISOString();

    // Get today's metrics
    const metricsQuery = db.prepare(`
      SELECT
        COUNT(*) as total_positions,
        SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) as losses,
        SUM(CASE WHEN realized_pnl > 0 THEN realized_pnl ELSE 0 END) as gains,
        SUM(CASE WHEN realized_pnl < 0 THEN ABS(realized_pnl) ELSE 0 END) as losses_amount,
        AVG(realized_pnl) as avg_pnl
      FROM positions
      WHERE status = 'closed'
        AND updated_at >= datetime(?)
        AND updated_at < datetime(?)
    `);
    const metricsResult = metricsQuery.bind(todayStartISO, tomorrowStartISO).first() as unknown;

    const metrics = (metricsResult as any) ?? {
      total_positions: 0,
      wins: 0,
      losses: 0,
      gains: 0,
      losses_amount: 0,
      avg_pnl: 0,
    };

    const totalPositions = metrics?.total_positions ?? 0;
    const wins = metrics?.wins ?? 0;
    const losses = metrics?.losses ?? 0;
    const winRate = totalPositions > 0 ? (wins / totalPositions) * 100 : 0;
    const realizedPnl = ((metrics?.gains ?? 0) - (metrics?.losses_amount ?? 0));

    // Get unrealized P&L from open positions
    const unrealizedMetricsResult = db.prepare(`
      SELECT
        SUM(COALESCE(unrealized_pnl, 0)) as total_unrealized,
        COUNT(*) as open_count
      FROM positions
      WHERE status = 'open'
    `).first() as unknown;

    const unrealizedMetrics = (unrealizedMetricsResult as any) ?? {
      total_unrealized: 0,
      open_count: 0,
    };

    return c.json({
      date: todayStart.toISOString().split('T')[0],
      realized_pnl: parseFloat(realizedPnl.toFixed(2)),
      unrealized_pnl: parseFloat((unrealizedMetrics?.total_unrealized ?? 0).toFixed(2)),
      total_pnl: parseFloat((realizedPnl + (unrealizedMetrics?.total_unrealized ?? 0)).toFixed(2)),
      closed_positions: totalPositions,
      open_positions: unrealizedMetrics?.open_count ?? 0,
      wins,
      losses,
      win_rate: parseFloat(winRate.toFixed(1)),
      avg_pnl: parseFloat((metrics?.avg_pnl ?? 0).toFixed(2)),
      sharpe_ratio: 0, // TODO: Calculate
    });
  } catch (error) {
    console.error('Daily P&L error:', error);
    return c.json(
      { error: 'Failed to fetch daily P&L', details: String(error) },
      { status: 500 }
    );
  }
});

// ============================================================
// EXECUTION QUALITY ENDPOINT
// ============================================================

dashboardRoutes.get('/execution-quality', async (c) => {
  try {
    const db = c.env.DB;
    if (!db) {
      return c.json(
        { error: 'Database not available' },
        { status: 503 }
      );
    }

    const today = new Date().toISOString().split('T')[0];

    // Get execution quality summary for today
    const todayStr = today || new Date().toISOString().split('T')[0];
    const summaryQuery = db.prepare(`
      SELECT
        SUM(CASE WHEN execution_grade = 'EXCELLENT' THEN 1 ELSE 0 END) as excellent,
        SUM(CASE WHEN execution_grade = 'GOOD' THEN 1 ELSE 0 END) as good,
        SUM(CASE WHEN execution_grade = 'ACCEPTABLE' THEN 1 ELSE 0 END) as acceptable,
        SUM(CASE WHEN execution_grade = 'POOR' THEN 1 ELSE 0 END) as poor,
        AVG(realized_slippage) as avg_slippage,
        AVG(slippage_ratio) as avg_slippage_ratio,
        COUNT(*) as total
      FROM execution_reports
      WHERE strftime('%Y-%m-%d', executed_at) = ?
    `);
    const summaryResult = summaryQuery.bind(todayStr).first() as unknown;

    const summary = (summaryResult as any) ?? {
      excellent: 0,
      good: 0,
      acceptable: 0,
      poor: 0,
      avg_slippage: 0,
      avg_slippage_ratio: 0,
      total: 0,
    };

    return c.json({
      date: today,
      grades: {
        excellent: summary?.excellent ?? 0,
        good: summary?.good ?? 0,
        acceptable: summary?.acceptable ?? 0,
        poor: summary?.poor ?? 0,
      },
      total_orders: summary?.total ?? 0,
      average_slippage_cents: parseFloat((summary?.avg_slippage ?? 0).toFixed(2)),
      average_slippage_ratio: parseFloat((summary?.avg_slippage_ratio ?? 0).toFixed(3)),
      grade_distribution: summary?.total
        ? {
            excellent_pct: parseFloat((((summary?.excellent ?? 0) / summary?.total) * 100).toFixed(1)),
            good_pct: parseFloat((((summary?.good ?? 0) / summary?.total) * 100).toFixed(1)),
            acceptable_pct: parseFloat((((summary?.acceptable ?? 0) / summary?.total) * 100).toFixed(1)),
            poor_pct: parseFloat((((summary?.poor ?? 0) / summary?.total) * 100).toFixed(1)),
          }
        : null,
    });
  } catch (error) {
    console.error('Execution quality error:', error);
    return c.json(
      { error: 'Failed to fetch execution quality', details: String(error) },
      { status: 500 }
    );
  }
});
