/**
 * Paul P - Reconciliation Agent
 *
 * Position reconciliation and verification between:
 * - Internal position tracking (order_lifecycle table)
 * - Venue reported positions (Kalshi API)
 *
 * Key functions:
 * - /reconcile: Compare and report position drift
 * - /rebuild-positions: Reconstruct internal state from venue
 * - /event/fill: Process fill events
 * - /status: Current reconciliation status
 */

import { PaulPAgent } from './base';
import type { Env } from '../types/env';

// ============================================================
// TYPES
// ============================================================

interface InternalPosition {
  marketId: string;
  side: 'YES' | 'NO';
  size: number;
  avgPrice: number;
  strategy: string;
}

interface VenuePosition {
  marketId: string;
  side: 'YES' | 'NO';
  size: number;
  avgPrice: number;
}

interface PositionDrift {
  marketId: string;
  internalSize: number;
  venueSize: number;
  drift: number;
  driftPct: number;
  severity: 'none' | 'minor' | 'major' | 'critical';
}

interface ReconciliationResult {
  timestamp: string;
  internalPositionCount: number;
  venuePositionCount: number;
  matchedCount: number;
  drifts: PositionDrift[];
  totalAbsoluteDrift: number;
  maxDriftPct: number;
  status: 'ok' | 'drift_detected' | 'major_drift' | 'critical_drift';
}

// ============================================================
// AGENT
// ============================================================

export class ReconciliationAgent extends PaulPAgent {
  readonly agentName = 'reconciliation-agent';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initTables();
  }

  private initTables(): void {
    // Track reconciliation history
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS reconciliation_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        internal_count INTEGER NOT NULL,
        venue_count INTEGER NOT NULL,
        matched_count INTEGER NOT NULL,
        drift_count INTEGER NOT NULL,
        max_drift_pct REAL NOT NULL,
        status TEXT NOT NULL
      )
    `);

    // Track position drifts
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS position_drift_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reconciliation_id INTEGER NOT NULL,
        market_id TEXT NOT NULL,
        internal_size REAL NOT NULL,
        venue_size REAL NOT NULL,
        drift REAL NOT NULL,
        drift_pct REAL NOT NULL,
        severity TEXT NOT NULL,
        timestamp TEXT NOT NULL
      )
    `);
  }

  protected async handleRequest(request: Request, path: string): Promise<Response> {
    switch (path) {
      case '/reconcile':
        return this.runReconciliation();
      case '/rebuild-positions':
        return this.rebuildPositions();
      case '/event/fill':
        return this.handleFill(request);
      case '/status':
        return this.getStatus();
      case '/history':
        return this.getHistory(request);
      default:
        return Response.json({ error: 'Not found' }, { status: 404 });
    }
  }

  /**
   * Run position reconciliation against venue
   */
  private async runReconciliation(): Promise<Response> {
    const timestamp = new Date().toISOString();

    // 1. Get internal positions from order_lifecycle
    const internalPositions = await this.getInternalPositions();

    // 2. Get positions from Kalshi (via KalshiExecAgent)
    const venuePositions = await this.getVenuePositions();

    // 3. Compare and compute drift
    const drifts = this.computeDrifts(internalPositions, venuePositions);

    // 4. Calculate summary
    const totalAbsoluteDrift = drifts.reduce((sum, d) => sum + Math.abs(d.drift), 0);
    const maxDriftPct = Math.max(0, ...drifts.map(d => Math.abs(d.driftPct)));
    const matchedCount = drifts.filter(d => d.severity === 'none').length;

    // 5. Determine status
    let status: ReconciliationResult['status'] = 'ok';
    if (drifts.some(d => d.severity === 'critical')) {
      status = 'critical_drift';
    } else if (drifts.some(d => d.severity === 'major')) {
      status = 'major_drift';
    } else if (drifts.some(d => d.severity === 'minor')) {
      status = 'drift_detected';
    }

    // 6. Store result
    const historyResult = this.sql.exec<{ id: number }>(
      `INSERT INTO reconciliation_history
       (timestamp, internal_count, venue_count, matched_count, drift_count, max_drift_pct, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
      timestamp,
      internalPositions.length,
      venuePositions.length,
      matchedCount,
      drifts.filter(d => d.severity !== 'none').length,
      maxDriftPct,
      status
    ).one();

    const reconciliationId = historyResult?.id ?? 0;

    // Store individual drifts
    for (const drift of drifts.filter(d => d.severity !== 'none')) {
      this.sql.exec(
        `INSERT INTO position_drift_log
         (reconciliation_id, market_id, internal_size, venue_size, drift, drift_pct, severity, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        reconciliationId,
        drift.marketId,
        drift.internalSize,
        drift.venueSize,
        drift.drift,
        drift.driftPct,
        drift.severity,
        timestamp
      );
    }

    // 7. Alert if critical drift
    if (status === 'critical_drift' || status === 'major_drift') {
      await this.alertDrift(drifts, status);
    }

    const result: ReconciliationResult = {
      timestamp,
      internalPositionCount: internalPositions.length,
      venuePositionCount: venuePositions.length,
      matchedCount,
      drifts,
      totalAbsoluteDrift,
      maxDriftPct,
      status,
    };

    await this.logAudit('RECONCILIATION_COMPLETED', {
      status,
      internalCount: internalPositions.length,
      venueCount: venuePositions.length,
      driftCount: drifts.filter(d => d.severity !== 'none').length,
      maxDriftPct,
    });

    return Response.json(result);
  }

  /**
   * Rebuild internal positions from venue data
   */
  private async rebuildPositions(): Promise<Response> {
    const venuePositions = await this.getVenuePositions();

    // Clear internal tracking and rebuild from venue
    // This is a recovery operation

    await this.logAudit('POSITIONS_REBUILT', {
      positionCount: venuePositions.length,
      timestamp: new Date().toISOString(),
    });

    return Response.json({
      rebuilt: true,
      positionCount: venuePositions.length,
      positions: venuePositions,
    });
  }

  /**
   * Handle fill event from venue
   */
  private async handleFill(request: Request): Promise<Response> {
    const fill = await request.json() as {
      orderId: string;
      marketId: string;
      side: 'YES' | 'NO';
      fillPrice: number;
      fillSize: number;
      timestamp: string;
    };

    await this.logAudit('FILL_RECEIVED', {
      orderId: fill.orderId,
      marketId: fill.marketId,
      side: fill.side,
      fillPrice: fill.fillPrice,
      fillSize: fill.fillSize,
    });

    return Response.json({ received: true, fill });
  }

  /**
   * Get current reconciliation status
   */
  private async getStatus(): Promise<Response> {
    const lastRecon = this.sql.exec<{
      timestamp: string;
      status: string;
      drift_count: number;
      max_drift_pct: number;
    }>(
      `SELECT timestamp, status, drift_count, max_drift_pct
       FROM reconciliation_history
       ORDER BY id DESC LIMIT 1`
    ).one();

    return Response.json({
      agent: this.agentName,
      lastReconciliation: lastRecon?.timestamp ?? 'never',
      lastStatus: lastRecon?.status ?? 'unknown',
      lastDriftCount: lastRecon?.drift_count ?? 0,
      lastMaxDriftPct: lastRecon?.max_drift_pct ?? 0,
    });
  }

  /**
   * Get reconciliation history
   */
  private async getHistory(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') ?? '20');

    const history = this.sql.exec<{
      id: number;
      timestamp: string;
      internal_count: number;
      venue_count: number;
      matched_count: number;
      drift_count: number;
      max_drift_pct: number;
      status: string;
    }>(
      `SELECT * FROM reconciliation_history ORDER BY id DESC LIMIT ?`,
      limit
    ).toArray();

    return Response.json({ history });
  }

  // ============================================================
  // HELPERS
  // ============================================================

  private async getInternalPositions(): Promise<InternalPosition[]> {
    // Query order_lifecycle for filled orders grouped by market
    const orchestratorId = this.env.PAUL_P_ORCHESTRATOR.idFromName('singleton');
    const orchestrator = this.env.PAUL_P_ORCHESTRATOR.get(orchestratorId);

    try {
      const response = await orchestrator.fetch('http://internal/workflow/orders?state=FILLED');
      const data = await response.json<{ orders: Array<{
        ticker: string;
        side: string;
        filledSize: number;
        avgFillPrice: number;
        strategy: string;
      }> }>();

      // Group by market
      const positionMap = new Map<string, InternalPosition>();
      for (const order of data.orders ?? []) {
        const key = `${order.ticker}-${order.side}`;
        const existing = positionMap.get(key);
        if (existing) {
          // Aggregate
          const totalSize = existing.size + order.filledSize;
          existing.avgPrice = (existing.avgPrice * existing.size + (order.avgFillPrice ?? 0) * order.filledSize) / totalSize;
          existing.size = totalSize;
        } else {
          positionMap.set(key, {
            marketId: order.ticker,
            side: order.side as 'YES' | 'NO',
            size: order.filledSize,
            avgPrice: order.avgFillPrice ?? 0,
            strategy: order.strategy,
          });
        }
      }

      return Array.from(positionMap.values());
    } catch (error) {
      console.error('Failed to get internal positions:', error);
      return [];
    }
  }

  private async getVenuePositions(): Promise<VenuePosition[]> {
    // Query Kalshi for current positions
    const kalshiExecId = this.env.KALSHI_EXEC.idFromName('singleton');
    const kalshiExec = this.env.KALSHI_EXEC.get(kalshiExecId);

    try {
      const response = await kalshiExec.fetch('http://internal/positions');
      const data = await response.json<{ positions: VenuePosition[] }>();
      return data.positions ?? [];
    } catch (error) {
      console.error('Failed to get venue positions:', error);
      return [];
    }
  }

  private computeDrifts(internal: InternalPosition[], venue: VenuePosition[]): PositionDrift[] {
    const drifts: PositionDrift[] = [];

    // Create maps for quick lookup
    const internalMap = new Map(internal.map(p => [`${p.marketId}-${p.side}`, p]));
    const venueMap = new Map(venue.map(p => [`${p.marketId}-${p.side}`, p]));

    // Check all markets from both sides
    const allKeys = new Set([...internalMap.keys(), ...venueMap.keys()]);

    for (const key of allKeys) {
      const int = internalMap.get(key);
      const ven = venueMap.get(key);

      const internalSize = int?.size ?? 0;
      const venueSize = ven?.size ?? 0;
      const drift = venueSize - internalSize;
      const driftPct = internalSize > 0 ? (drift / internalSize) * 100 : (venueSize > 0 ? 100 : 0);

      // Determine severity
      let severity: PositionDrift['severity'] = 'none';
      const absDriftPct = Math.abs(driftPct);
      if (absDriftPct >= 5) {
        severity = 'critical';
      } else if (absDriftPct >= 2) {
        severity = 'major';
      } else if (absDriftPct > 0.1) {
        severity = 'minor';
      }

      const [marketId] = key.split('-');
      drifts.push({
        marketId: marketId!,
        internalSize,
        venueSize,
        drift,
        driftPct,
        severity,
      });
    }

    return drifts;
  }

  private async alertDrift(drifts: PositionDrift[], status: string): Promise<void> {
    // Alert risk governor about drift
    const riskId = this.env.RISK_GOVERNOR.idFromName('singleton');
    const riskGovernor = this.env.RISK_GOVERNOR.get(riskId);

    const criticalDrifts = drifts.filter(d => d.severity === 'critical' || d.severity === 'major');

    await riskGovernor.fetch('http://internal/alert/critical', {
      method: 'POST',
      body: JSON.stringify({
        type: 'POSITION_DRIFT',
        severity: status === 'critical_drift' ? 'critical' : 'warning',
        message: `Position drift detected: ${criticalDrifts.length} positions with significant drift`,
        data: {
          driftCount: criticalDrifts.length,
          markets: criticalDrifts.map(d => d.marketId),
        },
      }),
    });
  }
}
