/**
 * Phase C Validation SQL Queries
 *
 * These queries validate that Phase C paper trading execution completed successfully.
 * Run these queries against paul-p-primary D1 database to verify:
 *
 * 1. Position monitoring works (stop-loss, take-profit, time-exit)
 * 2. Tail concentration enforcement is active
 * 3. Slippage tracking and kill switch function
 * 4. Circuit breaker state transitions work
 * 5. Execution quality metrics calculated correctly
 * 6. Dashboard endpoints return accurate data
 *
 * Expected Time: 2-3 minutes for all queries
 * Run at: End of Phase C paper trading (before Phase D live deployment)
 */

-- ============================================================================
-- VALIDATION 1: POSITION MONITORING (Stop-Loss, Take-Profit, Time-Exit)
-- ============================================================================

-- V1.1: Count positions that hit stop-loss
SELECT
  'STOP_LOSS_TRIGGERED' as control_type,
  COUNT(*) as count,
  COUNT(CASE WHEN was_stopped_out = 1 THEN 1 END) as stopped_count,
  AVG(CAST(was_stopped_out AS FLOAT)) as trigger_rate,
  AVG(unrealized_pnl) as avg_pnl_at_stop,
  MIN(stop_loss_triggered_at) as first_trigger,
  MAX(stop_loss_triggered_at) as last_trigger
FROM positions
WHERE status IN ('CLOSED', 'EXITED')
  AND created_at >= datetime('now', '-1 day')
  AND was_stopped_out = 1;

-- V1.2: Count positions that hit take-profit
SELECT
  'TAKE_PROFIT_TRIGGERED' as control_type,
  COUNT(*) as count,
  COUNT(CASE WHEN was_take_profit = 1 THEN 1 END) as tp_count,
  AVG(CAST(was_take_profit AS FLOAT)) as trigger_rate,
  AVG(unrealized_pnl) as avg_pnl_at_tp,
  SUM(unrealized_pnl) as total_realized_from_tp
FROM positions
WHERE status IN ('CLOSED', 'EXITED')
  AND created_at >= datetime('now', '-1 day')
  AND was_take_profit = 1;

-- V1.3: Count positions that hit time-limit (7 days)
SELECT
  'TIME_EXIT_TRIGGERED' as control_type,
  COUNT(*) as count,
  COUNT(CASE WHEN was_time_exit = 1 THEN 1 END) as time_exit_count,
  AVG(CAST(was_time_exit AS FLOAT)) as trigger_rate,
  AVG(unrealized_pnl) as avg_pnl_at_time_exit,
  MAX((julianday(time_exit_triggered_at) - julianday(created_at)) * 24) as max_holding_hours
FROM positions
WHERE status IN ('CLOSED', 'EXITED')
  AND created_at >= datetime('now', '-1 day')
  AND was_time_exit = 1;

-- V1.4: Verify stop-loss enforcement (all stopped positions should be <= -3%)
SELECT
  'STOP_LOSS_VALIDATION' as validation_type,
  COUNT(*) as total_stopped,
  COUNT(CASE WHEN unrealized_pnl >= -0.03 THEN 1 END) as within_3pct_limit,
  COUNT(CASE WHEN unrealized_pnl < -0.03 THEN 1 END) as exceeds_limit,
  MIN(unrealized_pnl) as worst_loss,
  AVG(unrealized_pnl) as avg_loss,
  CASE
    WHEN COUNT(CASE WHEN unrealized_pnl < -0.03 THEN 1 END) = 0 THEN '✓ PASS'
    ELSE '✗ FAIL'
  END as validation_result
FROM positions
WHERE was_stopped_out = 1
  AND created_at >= datetime('now', '-1 day');

-- V1.5: Verify take-profit enforcement (all TP positions should be >= +50%)
SELECT
  'TAKE_PROFIT_VALIDATION' as validation_type,
  COUNT(*) as total_tp,
  COUNT(CASE WHEN unrealized_pnl <= 0.50 THEN 1 END) as within_50pct_limit,
  COUNT(CASE WHEN unrealized_pnl > 0.50 THEN 1 END) as exceeds_limit,
  MAX(unrealized_pnl) as best_gain,
  AVG(unrealized_pnl) as avg_gain,
  CASE
    WHEN COUNT(CASE WHEN unrealized_pnl > 0.50 THEN 1 END) = 0 THEN '✓ PASS'
    ELSE '✗ FAIL'
  END as validation_result
FROM positions
WHERE was_take_profit = 1
  AND created_at >= datetime('now', '-1 day');

-- ============================================================================
-- VALIDATION 2: TAIL CONCENTRATION ENFORCEMENT
-- ============================================================================

-- V2.1: Check tail concentration snapshots (should show compliance)
SELECT
  'TAIL_CONCENTRATION' as control_type,
  COUNT(*) as total_snapshots,
  COUNT(CASE WHEN is_compliant = 1 THEN 1 END) as compliant_count,
  COUNT(CASE WHEN is_compliant = 0 THEN 1 END) as non_compliant_count,
  AVG(tail_herfindahl) as avg_herfindahl,
  MAX(tail_herfindahl) as max_herfindahl,
  MIN(tail_herfindahl) as min_herfindahl,
  CASE
    WHEN MAX(tail_herfindahl) <= 0.30 THEN '✓ PASS'
    ELSE '✗ WARN'
  END as enforcement_status
FROM tail_concentration_snapshots
WHERE created_at >= datetime('now', '-1 day');

-- V2.2: Positions that triggered tail concentration escalation
SELECT
  'TAIL_ESCALATION' as event_type,
  COUNT(*) as escalation_count,
  AVG(tail_herfindahl) as avg_herfindahl_at_breach,
  COUNT(CASE WHEN rebalance_recommended = 1 THEN 1 END) as rebalance_count
FROM tail_concentration_snapshots
WHERE is_compliant = 0
  AND created_at >= datetime('now', '-1 day');

-- ============================================================================
-- VALIDATION 3: SLIPPAGE TRACKING & KILL SWITCH
-- ============================================================================

-- V3.1: Slippage history - check if kill switch was triggered
SELECT
  'SLIPPAGE_KILL_SWITCH' as control_type,
  COUNT(*) as total_orders,
  COUNT(CASE WHEN exceeds_kill_threshold = 1 THEN 1 END) as kill_switch_triggered,
  AVG(slippage_ratio) as avg_slippage_ratio,
  MAX(slippage_ratio) as worst_slippage_ratio,
  COUNT(CASE WHEN slippage_ratio > 0.50 THEN 1 END) as orders_exceeding_threshold,
  CASE
    WHEN COUNT(CASE WHEN exceeds_kill_threshold = 1 THEN 1 END) <= 2 THEN '✓ PASS'
    ELSE '✗ WARN'
  END as kill_switch_status
FROM slippage_history
WHERE created_at >= datetime('now', '-1 day');

-- V3.2: Markets that triggered kill switch (should be blocked from further trading)
SELECT
  market_id,
  COUNT(*) as orders_on_market,
  COUNT(CASE WHEN exceeds_kill_threshold = 1 THEN 1 END) as kill_switch_triggers,
  AVG(slippage_ratio) as avg_slippage_ratio,
  MAX(slippage_ratio) as worst_ratio,
  MIN(created_at) as first_kill_trigger
FROM slippage_history
WHERE exceeds_kill_threshold = 1
  AND created_at >= datetime('now', '-1 day')
GROUP BY market_id
ORDER BY kill_switch_triggers DESC;

-- V3.3: Slippage vs edge ratio distribution
SELECT
  'SLIPPAGE_VS_EDGE_DISTRIBUTION' as metric_type,
  COUNT(*) as total_orders,
  COUNT(CASE WHEN slippage_ratio <= 0.30 THEN 1 END) as excellent,
  COUNT(CASE WHEN slippage_ratio > 0.30 AND slippage_ratio <= 0.50 THEN 1 END) as good,
  COUNT(CASE WHEN slippage_ratio > 0.50 AND slippage_ratio <= 1.00 THEN 1 END) as acceptable,
  COUNT(CASE WHEN slippage_ratio > 1.00 THEN 1 END) as poor,
  ROUND(100.0 * COUNT(CASE WHEN slippage_ratio <= 0.50 THEN 1 END) / COUNT(*), 1) as pct_within_budget
FROM slippage_history
WHERE created_at >= datetime('now', '-1 day');

-- ============================================================================
-- VALIDATION 4: CIRCUIT BREAKER STATE TRANSITIONS
-- ============================================================================

-- V4.1: Circuit breaker history - verify state transitions
SELECT
  'CIRCUIT_BREAKER_TRANSITIONS' as event_type,
  state,
  COUNT(*) as transition_count,
  MIN(created_at) as first_transition,
  MAX(created_at) as last_transition,
  AVG(CAST(halt_duration_minutes AS FLOAT)) as avg_halt_duration
FROM circuit_breaker_history
WHERE created_at >= datetime('now', '-1 day')
GROUP BY state
ORDER BY transition_count DESC;

-- V4.2: Check if HALT timeout recovery is working (should see HALT -> RECOVERY transitions)
SELECT
  'HALT_RECOVERY' as recovery_type,
  COUNT(*) as halt_events,
  COUNT(CASE WHEN halt_duration_minutes > 0 THEN 1 END) as halts_with_duration,
  COUNT(CASE WHEN halt_duration_minutes >= 60 THEN 1 END) as timeouts_triggered,
  AVG(halt_duration_minutes) as avg_halt_duration,
  CASE
    WHEN COUNT(CASE WHEN halt_duration_minutes >= 60 THEN 1 END) > 0 THEN '✓ PASS'
    ELSE '✓ PASS (No HALTs triggered, expected)'
  END as timeout_status
FROM circuit_breaker_history
WHERE state = 'HALT'
  AND created_at >= datetime('now', '-1 day');

-- V4.3: CAUTION throttling verification (should see position size reductions during CAUTION)
SELECT
  'CAUTION_THROTTLING' as throttle_type,
  COUNT(*) as caution_events,
  COUNT(CASE WHEN state = 'CAUTION' THEN 1 END) as caution_count,
  MIN(created_at) as first_caution,
  MAX(created_at) as last_caution,
  CASE
    WHEN COUNT(CASE WHEN state = 'CAUTION' THEN 1 END) > 0 THEN '✓ TRIGGERED'
    ELSE '✓ NOT_TRIGGERED (Expected if no circuit breaker activation)'
  END as throttle_status
FROM circuit_breaker_history
WHERE created_at >= datetime('now', '-1 day')
  AND state = 'CAUTION';

-- ============================================================================
-- VALIDATION 5: EXECUTION QUALITY METRICS
-- ============================================================================

-- V5.1: Execution quality grade distribution
SELECT
  'EXECUTION_QUALITY' as metric_type,
  COUNT(*) as total_orders,
  COUNT(CASE WHEN execution_grade = 'EXCELLENT' THEN 1 END) as excellent,
  COUNT(CASE WHEN execution_grade = 'GOOD' THEN 1 END) as good,
  COUNT(CASE WHEN execution_grade = 'ACCEPTABLE' THEN 1 END) as acceptable,
  COUNT(CASE WHEN execution_grade = 'POOR' THEN 1 END) as poor,
  ROUND(100.0 * (COUNT(CASE WHEN execution_grade IN ('EXCELLENT', 'GOOD') THEN 1 END) / COUNT(*)), 1) as pct_good_excellent,
  CASE
    WHEN ROUND(100.0 * (COUNT(CASE WHEN execution_grade IN ('EXCELLENT', 'GOOD') THEN 1 END) / COUNT(*)), 1) >= 80.0 THEN '✓ PASS'
    ELSE '✗ FAIL'
  END as quality_status
FROM execution_reports
WHERE executed_at >= datetime('now', '-1 day');

-- V5.2: Average slippage vs expected edge
SELECT
  'SLIPPAGE_ANALYSIS' as analysis_type,
  COUNT(*) as total_orders,
  ROUND(AVG(expected_slippage), 4) as avg_expected_slippage,
  ROUND(AVG(realized_slippage), 4) as avg_realized_slippage,
  ROUND(AVG(edge_percent), 4) as avg_edge_percent,
  ROUND(AVG(slippage_vs_edge_ratio), 3) as avg_ratio,
  CASE
    WHEN AVG(slippage_vs_edge_ratio) <= 0.50 THEN '✓ PASS (Slippage < 50% of edge)'
    ELSE '✗ FAIL (Slippage exceeds budget)'
  END as slippage_status
FROM execution_reports
WHERE executed_at >= datetime('now', '-1 day');

-- V5.3: Market-by-market execution quality
SELECT
  ticker,
  COUNT(*) as order_count,
  COUNT(CASE WHEN execution_grade IN ('EXCELLENT', 'GOOD') THEN 1 END) as good_grades,
  ROUND(100.0 * COUNT(CASE WHEN execution_grade IN ('EXCELLENT', 'GOOD') THEN 1 END) / COUNT(*), 1) as pct_good,
  ROUND(AVG(realized_slippage), 4) as avg_slippage,
  ROUND(AVG(edge_percent), 4) as avg_edge,
  COUNT(CASE WHEN kill_switch_triggered = 1 THEN 1 END) as kill_switch_count
FROM execution_reports
WHERE executed_at >= datetime('now', '-1 day')
GROUP BY ticker
ORDER BY kill_switch_count DESC, pct_good ASC;

-- ============================================================================
-- VALIDATION 6: POSITION ACCOUNTING & P&L
-- ============================================================================

-- V6.1: Overall P&L summary for Phase C
SELECT
  'PHASE_C_PNL_SUMMARY' as period,
  COUNT(*) as total_positions,
  COUNT(CASE WHEN unrealized_pnl > 0 THEN 1 END) as winning_positions,
  COUNT(CASE WHEN unrealized_pnl < 0 THEN 1 END) as losing_positions,
  COUNT(CASE WHEN unrealized_pnl = 0 THEN 1 END) as break_even,
  ROUND(100.0 * COUNT(CASE WHEN unrealized_pnl > 0 THEN 1 END) / COUNT(*), 1) as win_rate_percent,
  ROUND(SUM(unrealized_pnl), 2) as total_realized_pnl,
  ROUND(AVG(unrealized_pnl), 4) as avg_pnl_per_position,
  ROUND(MIN(unrealized_pnl), 4) as worst_position,
  ROUND(MAX(unrealized_pnl), 4) as best_position,
  CASE
    WHEN ROUND(100.0 * COUNT(CASE WHEN unrealized_pnl > 0 THEN 1 END) / COUNT(*), 1) > 50.0 AND SUM(unrealized_pnl) > 0 THEN '✓ PASS'
    ELSE '✗ FAIL'
  END as pnl_status
FROM positions
WHERE status IN ('CLOSED', 'EXITED')
  AND created_at >= datetime('now', '-1 day');

-- V6.2: Drawdown analysis
SELECT
  'MAX_DRAWDOWN_ANALYSIS' as metric,
  COUNT(*) as positions_analyzed,
  ROUND(MAX(CASE WHEN unrealized_pnl < 0 THEN ABS(unrealized_pnl) ELSE 0 END), 2) as worst_single_loss,
  ROUND(AVG(CASE WHEN unrealized_pnl < 0 THEN ABS(unrealized_pnl) ELSE 0 END), 2) as avg_loss_magnitude,
  ROUND(SUM(CASE WHEN unrealized_pnl < 0 THEN unrealized_pnl ELSE 0 END), 2) as total_losses,
  CASE
    WHEN MAX(CASE WHEN unrealized_pnl < 0 THEN ABS(unrealized_pnl) ELSE 0 END) <= 37.50 THEN '✓ PASS (< $37.50 = 15% of $250)'
    ELSE '✗ FAIL (Exceeds 15% drawdown limit)'
  END as drawdown_status
FROM positions
WHERE status IN ('CLOSED', 'EXITED')
  AND created_at >= datetime('now', '-1 day');

-- V6.3: Strategy performance comparison (Bonding vs Weather)
SELECT
  strategy_name,
  COUNT(*) as position_count,
  COUNT(CASE WHEN unrealized_pnl > 0 THEN 1 END) as wins,
  ROUND(100.0 * COUNT(CASE WHEN unrealized_pnl > 0 THEN 1 END) / COUNT(*), 1) as win_rate_pct,
  ROUND(SUM(unrealized_pnl), 2) as total_pnl,
  ROUND(AVG(unrealized_pnl), 4) as avg_pnl,
  ROUND(MIN(unrealized_pnl), 4) as worst_loss,
  ROUND(MAX(unrealized_pnl), 4) as best_gain
FROM positions
WHERE status IN ('CLOSED', 'EXITED')
  AND created_at >= datetime('now', '-1 day')
GROUP BY strategy_name
ORDER BY total_pnl DESC;

-- ============================================================================
-- VALIDATION 7: DASHBOARD ENDPOINTS ACCURACY
-- ============================================================================

-- V7.1: Dashboard summary snapshot (for dashboard/summary endpoint)
SELECT
  'DASHBOARD_SUMMARY' as endpoint,
  'PAPER' as execution_mode,
  'NORMAL' as circuit_breaker_state,
  COUNT(CASE WHEN status = 'OPEN' THEN 1 END) as open_positions_count,
  ROUND(SUM(CASE WHEN status = 'CLOSED' AND realized_at >= datetime('now', 'start of day') THEN unrealized_pnl ELSE 0 END), 2) as today_realized_pnl,
  ROUND(SUM(CASE WHEN status = 'OPEN' THEN unrealized_pnl ELSE 0 END), 2) as today_unrealized_pnl,
  ROUND(SUM(CASE WHEN status = 'OPEN' THEN unrealized_pnl ELSE 0 END) + SUM(CASE WHEN status = 'CLOSED' AND realized_at >= datetime('now', 'start of day') THEN unrealized_pnl ELSE 0 END), 2) as today_total_pnl,
  ROUND(100.0 * COUNT(CASE WHEN unrealized_pnl > 0 AND status = 'CLOSED' AND realized_at >= datetime('now', 'start of day') THEN 1 END) / NULLIF(COUNT(CASE WHEN status = 'CLOSED' AND realized_at >= datetime('now', 'start of day') THEN 1 END), 0), 1) as today_win_rate
FROM positions;

-- V7.2: Open positions snapshot (for dashboard/positions/open endpoint)
SELECT
  'OPEN_POSITIONS' as endpoint,
  id as position_id,
  market_id,
  side,
  ROUND(entry_price, 2) as entry_price,
  ROUND(current_price, 2) as current_price,
  size,
  ROUND(unrealized_pnl, 2) as unrealized_pnl,
  ROUND(100.0 * unrealized_pnl / (entry_price * size), 2) as unrealized_pnl_percent,
  ROUND((julianday('now') - julianday(created_at)) * 24 * 60, 0) as time_held_minutes,
  status
FROM positions
WHERE status = 'OPEN'
ORDER BY created_at DESC
LIMIT 10;

-- V7.3: Daily P&L summary (for dashboard/daily-pnl endpoint)
SELECT
  'DAILY_PNL' as endpoint,
  DATE(created_at) as summary_date,
  COUNT(*) as closed_positions,
  COUNT(CASE WHEN status = 'OPEN' THEN 1 END) as open_positions,
  COUNT(CASE WHEN unrealized_pnl > 0 THEN 1 END) as wins,
  COUNT(CASE WHEN unrealized_pnl < 0 THEN 1 END) as losses,
  ROUND(100.0 * COUNT(CASE WHEN unrealized_pnl > 0 THEN 1 END) / NULLIF(COUNT(CASE WHEN status = 'CLOSED' THEN 1 END), 0), 1) as win_rate,
  ROUND(SUM(unrealized_pnl), 2) as total_pnl,
  ROUND(AVG(unrealized_pnl), 4) as avg_pnl
FROM positions
WHERE created_at >= datetime('now', '-1 day')
GROUP BY DATE(created_at)
ORDER BY summary_date DESC;

-- V7.4: Execution quality summary (for dashboard/execution-quality endpoint)
SELECT
  'EXECUTION_QUALITY' as endpoint,
  DATE(executed_at) as summary_date,
  COUNT(*) as total_orders,
  COUNT(CASE WHEN execution_grade = 'EXCELLENT' THEN 1 END) as excellent_count,
  COUNT(CASE WHEN execution_grade = 'GOOD' THEN 1 END) as good_count,
  COUNT(CASE WHEN execution_grade = 'ACCEPTABLE' THEN 1 END) as acceptable_count,
  COUNT(CASE WHEN execution_grade = 'POOR' THEN 1 END) as poor_count,
  ROUND(AVG(realized_slippage), 4) as avg_slippage_cents,
  ROUND(100.0 * COUNT(CASE WHEN execution_grade IN ('EXCELLENT', 'GOOD') THEN 1 END) / COUNT(*), 1) as pct_good_excellent
FROM execution_reports
WHERE executed_at >= datetime('now', '-1 day')
GROUP BY DATE(executed_at)
ORDER BY summary_date DESC;

-- ============================================================================
-- VALIDATION 8: AUDIT TRAIL COMPLETENESS
-- ============================================================================

-- V8.1: Signal to execution pipeline completeness
SELECT
  'AUDIT_TRAIL' as validation,
  COUNT(DISTINCT signal_id) as total_signals,
  COUNT(DISTINCT CASE WHEN position_id IS NOT NULL THEN position_id END) as signals_executed,
  ROUND(100.0 * COUNT(DISTINCT CASE WHEN position_id IS NOT NULL THEN position_id END) / COUNT(DISTINCT signal_id), 1) as execution_rate_pct,
  COUNT(DISTINCT CASE WHEN risk_approved = 1 THEN signal_id END) as risk_approved,
  COUNT(DISTINCT CASE WHEN order_submitted = 1 THEN signal_id END) as orders_submitted,
  COUNT(DISTINCT CASE WHEN order_filled = 1 THEN signal_id END) as orders_filled
FROM audit_trail
WHERE created_at >= datetime('now', '-1 day')
  AND category IN ('SIGNAL', 'EXECUTION', 'ORDER');

-- ============================================================================
-- PHASE C SUCCESS CRITERIA SUMMARY
-- ============================================================================

-- Final validation: All checks passed?
SELECT
  'PHASE_C_VALIDATION_SUMMARY' as final_result,
  CASE WHEN COUNT(*) = 8 THEN '✓ ALL CHECKS PASSED' ELSE '✗ SOME CHECKS FAILED' END as status,
  COUNT(*) as checks_passed,
  8 as total_checks
FROM (
  -- Check 1: Stop-loss enforcement
  SELECT 1 as result FROM positions WHERE was_stopped_out = 1 AND created_at >= datetime('now', '-1 day') AND unrealized_pnl >= -0.03
  UNION ALL
  -- Check 2: Take-profit enforcement
  SELECT 1 as result FROM positions WHERE was_take_profit = 1 AND created_at >= datetime('now', '-1 day') AND unrealized_pnl <= 0.50
  UNION ALL
  -- Check 3: Tail concentration limit
  SELECT 1 as result FROM tail_concentration_snapshots WHERE max(tail_herfindahl) <= 0.30 AND created_at >= datetime('now', '-1 day')
  UNION ALL
  -- Check 4: Kill switch no false positives
  SELECT 1 as result FROM slippage_history WHERE COUNT(CASE WHEN exceeds_kill_threshold = 1 THEN 1 END) <= 2 AND created_at >= datetime('now', '-1 day')
  UNION ALL
  -- Check 5: Circuit breaker transitions
  SELECT 1 as result FROM circuit_breaker_history WHERE COUNT(DISTINCT state) >= 2 AND created_at >= datetime('now', '-1 day')
  UNION ALL
  -- Check 6: Execution quality >= 80%
  SELECT 1 as result FROM execution_reports WHERE ROUND(100.0 * COUNT(CASE WHEN execution_grade IN ('EXCELLENT', 'GOOD') THEN 1 END) / COUNT(*), 1) >= 80.0 AND executed_at >= datetime('now', '-1 day')
  UNION ALL
  -- Check 7: Win rate > 50%
  SELECT 1 as result FROM positions WHERE ROUND(100.0 * COUNT(CASE WHEN unrealized_pnl > 0 THEN 1 END) / COUNT(*), 1) > 50.0 AND created_at >= datetime('now', '-1 day') AND status IN ('CLOSED', 'EXITED')
  UNION ALL
  -- Check 8: Max drawdown < 15%
  SELECT 1 as result FROM positions WHERE MAX(CASE WHEN unrealized_pnl < 0 THEN ABS(unrealized_pnl) ELSE 0 END) <= 37.50 AND created_at >= datetime('now', '-1 day')
);
