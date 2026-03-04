/**
 * Position Monitor Agent - Phase A Risk Hardening
 *
 * Runs every 5 minutes to check all open positions for:
 * 1. Stop-loss trigger (-3% from entry) - HARD GUARDRAIL
 * 2. Take-profit trigger (+50% max gain) - LOCK IN WINS
 * 3. Time-based exit (>7 days holding) - PREVENT STALE POSITIONS
 *
 * This is a fail-closed guardrail to prevent catastrophic losses.
 */

import { PaulPAgent } from './base';

interface PositionRecord {
  id: string;
  market_slug: string;
  condition_id: string;
  side: 'YES' | 'NO';
  avg_entry_price: number;
  total_size: number;
  status: 'open' | 'closed' | 'resolved';
  first_trade_at: string;
  created_at: string;
  current_price?: number;
}

export class PositionMonitorAgent extends PaulPAgent {
  readonly agentName = 'position-monitor';

  /**
   * Check all open positions for exit triggers
   */
  private async checkAllPositions(): Promise<void> {
    const now = Date.now();

    try {
      const positions = this.sql.exec(
        `SELECT id, condition_id, side, avg_entry_price, total_size,
                status, created_at, current_price FROM positions WHERE status = 'open'`
      ).toArray() as unknown as PositionRecord[];

      for (const position of positions) {
        const currentPrice = position.current_price ?? position.avg_entry_price;
        if (currentPrice > 0) {
          await this.evaluatePosition(position, currentPrice, now);
        }
      }
    } catch (error) {
      console.error('Position check error:', error);
      await this.logAudit('POSITION_MONITOR_ERROR', { error: String(error) });
    }
  }

  /**
   * Evaluate a position for exit conditions
   */
  private async evaluatePosition(
    position: PositionRecord,
    currentPrice: number,
    now: number
  ): Promise<void> {
    const entryPrice = position.avg_entry_price;
    const stopLossPrice = entryPrice * 0.97; // -3%
    const takeProfitPrice = entryPrice * 1.5; // +50%

    const createdMs = new Date(position.created_at).getTime();
    const holdingMs = now - createdMs;
    const holdingHours = holdingMs / (1000 * 60 * 60);

    // Determine exit action needed
    let exitReason: string | null = null;

    // STOP-LOSS: Hard guardrail (always triggered first)
    if (currentPrice <= stopLossPrice) {
      exitReason = 'STOP_LOSS_HIT';
    }
    // TAKE-PROFIT: Lock in large gains
    else if (currentPrice >= takeProfitPrice) {
      exitReason = 'TAKE_PROFIT_HIT';
    }
    // TIME-BASED: Prevent stale positions
    else if (holdingHours > 168) {
      // 7 days
      exitReason = 'TIME_LIMIT_EXCEEDED';
    }

    // Execute exit if triggered
    if (exitReason) {
      await this.exitPosition(position, currentPrice, exitReason);
    } else {
      // Update current price for monitoring
      this.sql.exec(
        `UPDATE positions SET current_price = ?, current_price_at = ? WHERE id = ?`,
        [currentPrice, new Date().toISOString(), position.id]
      );
    }
  }

  /**
   * Exit a position and record the event
   */
  private async exitPosition(
    position: PositionRecord,
    exitPrice: number,
    reason: string
  ): Promise<void> {
    const now = new Date().toISOString();

    // Calculate realized PnL
    const pnl =
      (exitPrice - position.avg_entry_price) * position.total_size *
      (position.side === 'YES' ? 1 : -1);

    // Map exit reason to tracking columns
    let updateFields = '';
    if (reason === 'STOP_LOSS_HIT') {
      updateFields = 'was_stopped_out = 1, stop_loss_triggered_at = ?';
    } else if (reason === 'TAKE_PROFIT_HIT') {
      updateFields = 'was_take_profit = 1, take_profit_triggered_at = ?';
    } else {
      updateFields = 'was_time_exit = 1, time_exit_triggered_at = ?';
    }

    // Update position
    this.sql.exec(
      `UPDATE positions
       SET status = 'closed', exit_price = ?, realized_pnl = ?, ${updateFields},
           updated_at = ?
       WHERE id = ?`,
      [exitPrice, pnl, now, now, position.id]
    );

    // Log event
    this.sql.exec(
      `INSERT INTO position_monitor_events
       (position_id, event_type, market_price, stop_loss_price, triggered, trigger_reason)
       VALUES (?, ?, ?, ?, 1, ?)`,
      [position.id, 'POSITION_EXIT', exitPrice, position.avg_entry_price * 0.97, reason]
    );

    // Audit trail
    await this.logAudit('POSITION_EXIT', {
      position_id: position.id,
      reason,
      exit_price: exitPrice,
      entry_price: position.avg_entry_price,
      realized_pnl: pnl,
    });
  }

  /**
   * Implement abstract method from DurableObject
   */
  async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/check') {
      await this.checkAllPositions();
      return Response.json({ status: 'checked' });
    }

    if (request.method === 'GET' && url.pathname === '/status') {
      const openPositions = this.sql.exec<{ count: number }>(
        `SELECT COUNT(*) as count FROM positions WHERE status = 'open'`
      ).one();
      return Response.json({ open_positions: openPositions?.count ?? 0 });
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  /**
   * Implement alarm handler for periodic position checking (called by Cloudflare scheduler)
   */
  async alarm(): Promise<void> {
    try {
      await this.checkAllPositions();
    } catch (error) {
      console.error('Monitor alarm error:', error);
      await this.logAudit('POSITION_MONITOR_ALARM_ERROR', { error: String(error) });
    }
    // Note: Alarms are scheduled via wrangler.toml cron configuration
    // No need to manually reschedule here
  }
}
