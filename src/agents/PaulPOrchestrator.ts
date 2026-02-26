/**
 * Paul P - Main Orchestrator Agent (P-15)
 *
 * Top-level coordinator for all system operations:
 * - Scheduled cron jobs for data ingestion and maintenance
 * - Signal scanning workflow
 * - Order execution lifecycle
 * - System health monitoring
 */

import { PaulPAgent } from './base';
import type { Env } from '../types/env';
import {
  type OrderLifecycle,
  createOrderLifecycle,
  transitionOrder,
  stepValidate,
  stepApplyRiskResult,
  stepApplyExecutionResult,
  isTerminalState,
  calculateWorkflowMetrics,
} from '../lib/execution/workflow';
import type { ExecutionRequest, ExecutionResult } from '../lib/execution/policy';
import type { TradingSignal } from '../types/signals';
import { getAllocation } from '../lib/execution/capital-allocation';
import { deterministicId } from '../lib/utils/deterministic-id';

// ============================================================
// TYPES
// ============================================================

interface SignalScanResult {
  strategy: string;
  capital: number;
  signals: TradingSignal[];
}

type OrderLifecycleRow = {
  order_id: string;
  signal_id: string;
  strategy: string;
  ticker: string;
  side: string;
  requested_size: number;
  max_price: number;
  current_state: string;
  state_history: string;
  filled_size: number;
  avg_fill_price: number | null;
  entry_price: number | null;
  closing_line_price: number | null;
  clv: number | null;
  signal_model_probability: number | null;
  signal_edge: number | null;
  signal_confidence: number | null;
  created_at: string;
  updated_at: string;
  evidence_hashes: string;
};

// ============================================================
// AGENT
// ============================================================

export class PaulPOrchestrator extends PaulPAgent {
  readonly agentName = 'paul-p-orchestrator';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initTables();
  }

  private initTables(): void {
    this.runQuery(`
      CREATE TABLE IF NOT EXISTS order_lifecycle (
        order_id TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL,
        strategy TEXT NOT NULL,
        ticker TEXT NOT NULL,
        side TEXT NOT NULL,
        requested_size INTEGER NOT NULL,
        max_price INTEGER NOT NULL,
        current_state TEXT NOT NULL,
        state_history TEXT NOT NULL,
        filled_size INTEGER DEFAULT 0,
        avg_fill_price REAL,
        entry_price REAL,
        closing_line_price REAL,
        clv REAL,
        signal_model_probability REAL,
        signal_edge REAL,
        signal_confidence REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        evidence_hashes TEXT NOT NULL
      )
    `);

    // Forward-compatible local schema migration for existing DO instances.
    const addColumnIfMissing = (columnDef: string): void => {
      try {
        this.runQuery(`ALTER TABLE order_lifecycle ADD COLUMN ${columnDef}`);
      } catch {
        // Column already exists.
      }
    };
    addColumnIfMissing('signal_model_probability REAL');
    addColumnIfMissing('signal_edge REAL');
    addColumnIfMissing('signal_confidence REAL');

    this.runQuery(`CREATE INDEX IF NOT EXISTS idx_lifecycle_state ON order_lifecycle(current_state)`);
    this.runQuery(`CREATE INDEX IF NOT EXISTS idx_lifecycle_strategy ON order_lifecycle(strategy)`);
    this.runQuery(`CREATE INDEX IF NOT EXISTS idx_lifecycle_created ON order_lifecycle(created_at)`);
  }

  // SQL wrapper methods
  private runQuery(query: string, ...params: unknown[]): void {
    this.sql.exec(query, ...params);
  }

  private queryRows<T extends Record<string, SqlStorageValue>>(query: string, ...params: unknown[]): T[] {
    return this.sql.exec<T>(query, ...params).toArray();
  }

  protected async handleRequest(_request: Request, path: string): Promise<Response> {
    switch (path) {
      // Cron handlers
      case '/cron/ingest':
        return this.handleIngestCron();
      case '/cron/scan-signals':
        return this.handleSignalScanCron();
      case '/cron/execute-signals':
        return this.handleExecuteSignalsCron();
      case '/cron/reconcile':
        return this.handleReconcileCron();
      case '/cron/anchor':
        return this.handleAnchorCron();
      case '/cron/daily-report':
        return this.handleDailyReportCron();
      case '/cron/llm-drift':
        return this.handleLLMDriftCron();

      // Manual triggers
      case '/trigger/ingest':
        return this.handleIngestCron();
      case '/trigger/scan':
        return this.handleSignalScanCron();
      case '/trigger/execute':
        return this.handleExecuteSignalsCron();
      case '/trigger/reconcile':
        return this.handleReconcileCron();

      // Workflow management
      case '/workflow/orders':
        return this.getWorkflowOrders(_request);
      case '/workflow/order':
        return this.getWorkflowOrder(_request);
      case '/workflow/metrics':
        return this.getWorkflowMetrics();
      case '/workflow/cancel':
        return this.cancelWorkflowOrder(_request);

      // Status
      case '/status':
        return this.getStatus();
      case '/health':
        return this.getHealthCheck();

      default:
        return Response.json({ error: 'Not found' }, { status: 404 });
    }
  }

  private buildSignalId(signal: TradingSignal, strategy: string): string {
    if (signal.signalId && signal.signalId.length > 0) {
      return signal.signalId;
    }

    return deterministicId(
      'signal',
      strategy,
      signal.marketId,
      signal.side,
      signal.action,
      signal.generatedAt,
      signal.expiresAt
    );
  }

  // ============================================================
  // CRON HANDLERS
  // ============================================================

  private async handleIngestCron(): Promise<Response> {
    console.log('Triggering data ingestion...');

    // Queue ingestion jobs for both venues
    await this.env.QUEUE_INGESTION.send({
      type: 'fetch_markets',
      venue: 'polymarket',
      payload: { active: true, limit: 100 },
    });

    await this.env.QUEUE_INGESTION.send({
      type: 'fetch_markets',
      venue: 'kalshi',
      payload: { status: 'active', limit: 100 },
    });

    await this.logAudit('INGESTION_TRIGGERED', { source: 'cron' });

    return Response.json({ triggered: true, timestamp: new Date().toISOString() });
  }

  /**
   * Scan for trading signals from all strategy agents
   */
  private async handleSignalScanCron(): Promise<Response> {
    console.log('Scanning for trading signals...');
    const startTime = Date.now();
    const results: SignalScanResult[] = [];

    // Get capital allocations for all strategies
    const bondingAlloc = getAllocation('bonding');
    const weatherAlloc = getAllocation('weather');
    const xvAlloc = getAllocation('xv_signal');
    const smartMoneyAlloc = getAllocation('smart_money');
    const resolutionAlloc = getAllocation('resolution');

    // Scan Bonding Strategy
    if (bondingAlloc.enabled) {
      try {
        const bondingId = this.env.STRATEGY_BONDING.idFromName('singleton');
        const bonding = this.env.STRATEGY_BONDING.get(bondingId);
        const bondingResponse = await bonding.fetch('http://localhost/generate-signals', {
          method: 'POST',
          body: JSON.stringify({ capital: bondingAlloc.capital, minEdge: 0.05 }),
        });
        const bondingResult = await bondingResponse.json<{ signals: TradingSignal[] }>();
        results.push({
          strategy: 'bonding',
          capital: bondingAlloc.capital,
          signals: bondingResult.signals ?? [],
        });
      } catch (error) {
        console.error('Bonding strategy scan failed:', error);
      }
    }

    // Scan Weather Strategy
    if (weatherAlloc.enabled) {
      try {
        const weatherId = this.env.STRATEGY_WEATHER.idFromName('singleton');
        const weather = this.env.STRATEGY_WEATHER.get(weatherId);
        const weatherResponse = await weather.fetch('http://localhost/generate-signals', {
          method: 'POST',
          body: JSON.stringify({ capital: weatherAlloc.capital, minEdge: 0.05 }),
        });
        const weatherResult = await weatherResponse.json<{ signals: TradingSignal[] }>();
        results.push({
          strategy: 'weather',
          capital: weatherAlloc.capital,
          signals: weatherResult.signals ?? [],
        });
      } catch (error) {
        console.error('Weather strategy scan failed:', error);
      }
    }

    // Scan XV Signal Strategy
    if (xvAlloc.enabled) {
      try {
        const xvId = this.env.STRATEGY_XVSIGNAL.idFromName('singleton');
        const xv = this.env.STRATEGY_XVSIGNAL.get(xvId);
        const xvResponse = await xv.fetch('http://localhost/generate-signals', {
          method: 'POST',
          body: JSON.stringify({ capital: xvAlloc.capital, minEdge: 0.03 }),
        });
        const xvResult = await xvResponse.json<{ signals: TradingSignal[] }>();
        results.push({
          strategy: 'xv_signal',
          capital: xvAlloc.capital,
          signals: xvResult.signals ?? [],
        });
      } catch (error) {
        console.error('XV Signal strategy scan failed:', error);
      }
    }

    // Scan Smart Money Strategy
    if (smartMoneyAlloc.enabled) {
      try {
        const smId = this.env.STRATEGY_SMARTMONEY.idFromName('singleton');
        const sm = this.env.STRATEGY_SMARTMONEY.get(smId);
        const smResponse = await sm.fetch('http://localhost/generate-signals', {
          method: 'POST',
          body: JSON.stringify({ capital: smartMoneyAlloc.capital, minEdge: 0.05 }),
        });
        const smResult = await smResponse.json<{ signals: TradingSignal[] }>();
        results.push({
          strategy: 'smart_money',
          capital: smartMoneyAlloc.capital,
          signals: smResult.signals ?? [],
        });
      } catch (error) {
        console.error('Smart Money strategy scan failed:', error);
      }
    }

    // Scan Resolution Strategy
    if (resolutionAlloc.enabled) {
      try {
        const resId = this.env.STRATEGY_RESOLUTION.idFromName('singleton');
        const res = this.env.STRATEGY_RESOLUTION.get(resId);
        const resResponse = await res.fetch('http://localhost/generate-signals', {
          method: 'POST',
          body: JSON.stringify({ capital: resolutionAlloc.capital, minEdge: 0.10 }),
        });
        const resResult = await resResponse.json<{ signals: TradingSignal[] }>();
        results.push({
          strategy: 'resolution',
          capital: resolutionAlloc.capital,
          signals: resResult.signals ?? [],
        });
      } catch (error) {
        console.error('Resolution strategy scan failed:', error);
      }
    }

    // Create order lifecycles for each signal
    const orders: OrderLifecycle[] = [];
    for (const result of results) {
      for (const signal of result.signals) {
        const order = createOrderLifecycle(
          this.buildSignalId(signal, result.strategy),
          result.strategy,
          signal.marketId,
          signal.side,
          signal.suggestedSize,
          Math.round(signal.marketPrice * 100), // Convert to cents
          signal.modelProbability,
          signal.edge,
          signal.confidence
        );
        orders.push(order);
        this.saveOrderLifecycle(order);
      }
    }

    const totalSignals = results.reduce((sum, r) => sum + r.signals.length, 0);

    await this.logAudit('SIGNAL_SCAN_COMPLETED', {
      strategies: results.length,
      totalSignals,
      ordersCreated: orders.length,
      durationMs: Date.now() - startTime,
    });

    return Response.json({
      scanned: true,
      strategies: results.map(r => ({
        strategy: r.strategy,
        capital: r.capital,
        signalCount: r.signals.length,
      })),
      totalSignals,
      ordersCreated: orders.length,
    });
  }

  /**
   * Execute pending signals through the workflow
   */
  private async handleExecuteSignalsCron(): Promise<Response> {
    console.log('Executing pending signals...');
    const startTime = Date.now();

    // Get pending orders
    const pendingOrders = this.queryRows<OrderLifecycleRow>(
      `SELECT * FROM order_lifecycle WHERE current_state IN ('PENDING', 'VALIDATED', 'RISK_APPROVED')
       ORDER BY created_at ASC LIMIT 10`
    );

    const executed: string[] = [];
    const rejected: string[] = [];
    const errors: Array<{ orderId: string; error: string }> = [];

    for (const row of pendingOrders) {
      let order = this.deserializeOrder(row);

      try {
        // Step 1: Validate if pending
        if (order.currentState === 'PENDING') {
          const ctx = stepValidate({ order });
          order = ctx.order;
          this.saveOrderLifecycle(order);

          if (order.currentState === 'REJECTED') {
            rejected.push(order.orderId);
            continue;
          }
        }

        // Step 2: Risk check if validated
        if (order.currentState === 'VALIDATED') {
          const riskResult = await this.checkWithRiskGovernor(order);
          const ctx = stepApplyRiskResult(
            { order },
            riskResult.approved,
            riskResult.adjustedSize,
            riskResult.violations
          );
          order = ctx.order;
          this.saveOrderLifecycle(order);

          if (order.currentState === 'RISK_REJECTED') {
            rejected.push(order.orderId);
            continue;
          }
        }

        // Step 3: Execute if risk approved
        if (order.currentState === 'RISK_APPROVED') {
          const execResult = await this.executeOrder(order);
          const ctx = stepApplyExecutionResult({ order }, execResult);
          order = ctx.order;
          this.saveOrderLifecycle(order);

          if (isTerminalState(order.currentState)) {
            if (order.currentState === 'FILLED') {
              executed.push(order.orderId);
            } else {
              rejected.push(order.orderId);
            }
          }
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push({ orderId: order.orderId, error: errorMsg });
        order = transitionOrder(order, 'ERROR', errorMsg);
        order.lastError = errorMsg;
        this.saveOrderLifecycle(order);
      }
    }

    await this.logAudit('SIGNAL_EXECUTION_COMPLETED', {
      processed: pendingOrders.length,
      executed: executed.length,
      rejected: rejected.length,
      errors: errors.length,
      durationMs: Date.now() - startTime,
    });

    return Response.json({
      processed: pendingOrders.length,
      executed,
      rejected,
      errors,
      durationMs: Date.now() - startTime,
    });
  }

  private async handleReconcileCron(): Promise<Response> {
    console.log('Triggering reconciliation...');

    const reconId = this.env.RECONCILIATION.idFromName('singleton');
    const recon = this.env.RECONCILIATION.get(reconId);

    await recon.fetch('http://internal/reconcile', { method: 'POST' });

    await this.logAudit('RECONCILIATION_TRIGGERED', { source: 'cron' });

    return Response.json({ triggered: true });
  }

  private async handleAnchorCron(): Promise<Response> {
    console.log('Triggering audit chain anchor...');

    const auditId = this.env.AUDIT_REPORTER.idFromName('singleton');
    const audit = this.env.AUDIT_REPORTER.get(auditId);

    await audit.fetch('http://internal/anchor', { method: 'POST' });

    return Response.json({ triggered: true });
  }

  private async handleDailyReportCron(): Promise<Response> {
    console.log('Generating daily report...');

    // Calculate daily metrics
    const metrics = await this.getDailyMetrics();

    await this.logAudit('DAILY_REPORT_GENERATED', metrics);

    return Response.json({ triggered: true, metrics });
  }

  private async handleLLMDriftCron(): Promise<Response> {
    console.log('Running LLM drift sweep...');

    const researchId = this.env.RESEARCH_AGENT.idFromName('singleton');
    const research = this.env.RESEARCH_AGENT.get(researchId);

    await research.fetch('http://internal/drift-sweep', { method: 'POST' });

    return Response.json({ triggered: true });
  }

  // ============================================================
  // WORKFLOW HANDLERS
  // ============================================================

  private async getWorkflowOrders(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const state = url.searchParams.get('state');
    const strategy = url.searchParams.get('strategy');
    const limit = parseInt(url.searchParams.get('limit') ?? '50');

    let query = 'SELECT * FROM order_lifecycle WHERE 1=1';
    const params: (string | number)[] = [];

    if (state) {
      query += ' AND current_state = ?';
      params.push(state);
    }

    if (strategy) {
      query += ' AND strategy = ?';
      params.push(strategy);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = this.queryRows<OrderLifecycleRow>(query, ...params);
    const orders = rows.map(r => this.deserializeOrder(r));

    return Response.json({ orders, count: orders.length });
  }

  private async getWorkflowOrder(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const orderId = url.searchParams.get('orderId');

    if (!orderId) {
      return Response.json({ error: 'orderId required' }, { status: 400 });
    }

    const rows = this.queryRows<OrderLifecycleRow>(
      'SELECT * FROM order_lifecycle WHERE order_id = ?',
      orderId
    );

    if (rows.length === 0) {
      return Response.json({ error: 'Order not found' }, { status: 404 });
    }

    const order = this.deserializeOrder(rows[0]!);
    return Response.json({ order });
  }

  private async getWorkflowMetrics(): Promise<Response> {
    const rows = this.queryRows<OrderLifecycleRow>(
      'SELECT * FROM order_lifecycle'
    );

    const orders = rows.map(r => this.deserializeOrder(r));
    const metrics = calculateWorkflowMetrics(orders);

    return Response.json({ metrics });
  }

  private async cancelWorkflowOrder(request: Request): Promise<Response> {
    const { orderId } = await request.json<{ orderId: string }>();

    if (!orderId) {
      return Response.json({ error: 'orderId required' }, { status: 400 });
    }

    const rows = this.queryRows<OrderLifecycleRow>(
      'SELECT * FROM order_lifecycle WHERE order_id = ?',
      orderId
    );

    if (rows.length === 0) {
      return Response.json({ error: 'Order not found' }, { status: 404 });
    }

    let order = this.deserializeOrder(rows[0]!);

    if (isTerminalState(order.currentState)) {
      return Response.json({
        error: `Order is in terminal state: ${order.currentState}`,
      }, { status: 400 });
    }

    order = transitionOrder(order, 'CANCELLED', 'Cancelled by user');
    this.saveOrderLifecycle(order);

    await this.logAudit('ORDER_CANCELLED', { orderId });

    return Response.json({ success: true, order });
  }

  // ============================================================
  // STATUS
  // ============================================================

  private async getStatus(): Promise<Response> {
    const orderStats = this.queryRows<{ state: string; count: number }>(
      `SELECT current_state as state, COUNT(*) as count
       FROM order_lifecycle
       GROUP BY current_state`
    );

    return Response.json({
      agent: this.agentName,
      status: 'operational',
      timestamp: new Date().toISOString(),
      ordersByState: Object.fromEntries(orderStats.map(s => [s.state, s.count])),
    });
  }

  private async getHealthCheck(): Promise<Response> {
    const checks: Record<string, boolean> = {};

    // Check strategy agents
    try {
      const bondingId = this.env.STRATEGY_BONDING.idFromName('singleton');
      const bonding = this.env.STRATEGY_BONDING.get(bondingId);
      const response = await bonding.fetch('http://localhost/status');
      checks['strategy_bonding'] = response.ok;
    } catch {
      checks['strategy_bonding'] = false;
    }

    try {
      const weatherId = this.env.STRATEGY_WEATHER.idFromName('singleton');
      const weather = this.env.STRATEGY_WEATHER.get(weatherId);
      const response = await weather.fetch('http://localhost/status');
      checks['strategy_weather'] = response.ok;
    } catch {
      checks['strategy_weather'] = false;
    }

    // Check risk governor
    try {
      const riskId = this.env.RISK_GOVERNOR.idFromName('singleton');
      const risk = this.env.RISK_GOVERNOR.get(riskId);
      const response = await risk.fetch('http://localhost/status');
      checks['risk_governor'] = response.ok;
    } catch {
      checks['risk_governor'] = false;
    }

    // Check execution agent
    try {
      const execId = this.env.KALSHI_EXEC.idFromName('singleton');
      const kalshiExec = this.env.KALSHI_EXEC.get(execId);
      const response = await kalshiExec.fetch('http://localhost/status');
      checks['kalshi_exec'] = response.ok;
    } catch {
      checks['kalshi_exec'] = false;
    }

    const allHealthy = Object.values(checks).every(v => v);

    return Response.json({
      healthy: allHealthy,
      checks,
      timestamp: new Date().toISOString(),
    });
  }

  // ============================================================
  // HELPERS
  // ============================================================

  private async checkWithRiskGovernor(order: OrderLifecycle): Promise<{
    approved: boolean;
    adjustedSize?: number;
    violations?: string[];
  }> {
    const riskId = this.env.RISK_GOVERNOR.idFromName('singleton');
    const riskGovernor = this.env.RISK_GOVERNOR.get(riskId);

    // Get capital allocation for the strategy
    const allocation = getAllocation(order.strategy as 'bonding' | 'weather' | 'xv_signal' | 'smart_money' | 'resolution');

    const response = await riskGovernor.fetch('http://localhost/check-signal', {
      method: 'POST',
      body: JSON.stringify({
        signal: {
          marketId: order.ticker,
          side: order.side,
          modelProbability: order.signalModelProbability ?? order.maxPrice / 100,
          marketPrice: order.maxPrice / 100,
          edge: order.signalEdge ?? 0,
          confidence: order.signalConfidence ?? 0.5,
          requestedSize: order.requestedSize,
        },
        strategyType: order.strategy,
        capital: allocation.capital,
      }),
    });

    const result = await response.json<{
      approved: boolean;
      adjustedSize?: number;
      violations?: Array<{ code: string; message: string }>;
    }>();

    return {
      approved: result.approved,
      adjustedSize: result.adjustedSize,
      violations: result.violations?.map(v => v.message),
    };
  }

  private async executeOrder(order: OrderLifecycle): Promise<ExecutionResult> {
    const execId = this.env.KALSHI_EXEC.idFromName('singleton');
    const kalshiExec = this.env.KALSHI_EXEC.get(execId);

    const execRequest: ExecutionRequest = {
      orderId: order.orderId,
      signal: {
        marketId: order.ticker,
        side: order.side,
        modelProbability: order.signalModelProbability ?? order.maxPrice / 100,
        marketPrice: order.maxPrice / 100,
        edge: order.signalEdge ?? 0,
        confidence: order.signalConfidence ?? 0.5,
      },
      requestedSize: order.requestedSize,
      maxPrice: order.maxPrice,
      orderType: 'limit',
      source: order.strategy,
      timestamp: new Date().toISOString(),
    };

    const response = await kalshiExec.fetch('http://localhost/execute', {
      method: 'POST',
      body: JSON.stringify(execRequest),
    });

    return response.json();
  }

  private saveOrderLifecycle(order: OrderLifecycle): void {
    this.runQuery(
      `INSERT OR REPLACE INTO order_lifecycle (
        order_id, signal_id, strategy, ticker, side, requested_size, max_price,
        current_state, state_history, filled_size, avg_fill_price, entry_price,
        closing_line_price, clv, signal_model_probability, signal_edge, signal_confidence,
        created_at, updated_at, evidence_hashes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      order.orderId,
      order.signalId,
      order.strategy,
      order.ticker,
      order.side,
      order.requestedSize,
      order.maxPrice,
      order.currentState,
      JSON.stringify(order.stateHistory),
      order.filledSize,
      order.avgFillPrice ?? null,
      order.entryPrice ?? null,
      order.closingLinePrice ?? null,
      order.clv ?? null,
      order.signalModelProbability ?? null,
      order.signalEdge ?? null,
      order.signalConfidence ?? null,
      order.createdAt,
      new Date().toISOString(),
      JSON.stringify(order.evidenceHashes)
    );
  }

  private deserializeOrder(row: OrderLifecycleRow): OrderLifecycle {
    return {
      orderId: row.order_id,
      signalId: row.signal_id,
      strategy: row.strategy,
      ticker: row.ticker,
      side: row.side as 'YES' | 'NO',
      requestedSize: row.requested_size,
      maxPrice: row.max_price,
      currentState: row.current_state as OrderLifecycle['currentState'],
      stateHistory: JSON.parse(row.state_history),
      filledSize: row.filled_size,
      avgFillPrice: row.avg_fill_price ?? undefined,
      entryPrice: row.entry_price ?? undefined,
      closingLinePrice: row.closing_line_price ?? undefined,
      clv: row.clv ?? undefined,
      signalModelProbability: row.signal_model_probability ?? undefined,
      signalEdge: row.signal_edge ?? undefined,
      signalConfidence: row.signal_confidence ?? undefined,
      createdAt: row.created_at,
      evidenceHashes: JSON.parse(row.evidence_hashes),
      retryCount: 0,
    };
  }

  private async getDailyMetrics(): Promise<Record<string, unknown>> {
    const today = new Date().toISOString().split('T')[0];

    const ordersTodayResult = this.queryRows<{ count: number }>(
      `SELECT COUNT(*) as count FROM order_lifecycle WHERE created_at >= ?`,
      today
    );

    const filledTodayResult = this.queryRows<{ count: number }>(
      `SELECT COUNT(*) as count FROM order_lifecycle
       WHERE current_state = 'FILLED' AND updated_at >= ?`,
      today
    );

    const avgClvResult = this.queryRows<{ avg_clv: number }>(
      `SELECT AVG(clv) as avg_clv FROM order_lifecycle
       WHERE clv IS NOT NULL AND updated_at >= ?`,
      today
    );

    return {
      date: today,
      ordersCreated: ordersTodayResult[0]?.count ?? 0,
      ordersFilled: filledTodayResult[0]?.count ?? 0,
      avgCLV: avgClvResult[0]?.avg_clv ?? 0,
    };
  }
}
