/**
 * Paul P - Kalshi Execution Agent (P-14)
 *
 * Handles Kalshi order execution with:
 * - RSA-PSS authentication for live trading
 * - Paper trading mode for backtesting/simulation
 * - Execution policy enforcement
 * - RiskGovernorAgent integration
 * - Order lifecycle tracking
 */

import { PaulPAgent } from './base';
import type { Env } from '../types/env';
import * as kalshiClient from '../lib/kalshi/client';
import { deterministicId } from '../lib/utils/deterministic-id';
import {
  type ExecutionMode,
  type ExecutionPolicy,
  type ExecutionRequest,
  type ExecutionResult,
  type PaperFill,
  type RateLimitState,
  type QueuedExecution,
  getExecutionPolicy,
  customizePolicy,
  validateExecutionRequest,
  transformToKalshiOrder,
  simulatePaperFill,
  createRateLimitState,
  updateRateLimitState,
  calculateExecutionPriority,
  sortExecutionQueue,
} from '../lib/execution/policy';
import type { KalshiMarket } from '../lib/kalshi/types';

// ============================================================
// TYPES
// ============================================================

type OrderRow = {
  order_id: string;
  client_order_id: string;
  ticker: string;
  side: string;
  action: string;
  order_type: string;
  requested_size: number;
  limit_price: number | null;
  status: string;
  fill_count: number;
  fill_price: number | null;
  source_strategy: string;
  signal_id: string;
  execution_mode: string;
  created_at: string;
  updated_at: string;
  evidence_hash: string | null;
};

type PaperPositionRow = {
  ticker: string;
  side: string;
  contracts: number;
  avg_entry_price: number;
  realized_pnl: number;
  unrealized_pnl: number;
  updated_at: string;
};

interface RiskCheckResponse {
  approved: boolean;
  adjustedSize?: number;
  rejectionReason?: string;
  violations?: string[];
}

// ============================================================
// AGENT
// ============================================================

export class KalshiExecAgent extends PaulPAgent {
  readonly agentName = 'kalshi-exec';

  private executionMode: ExecutionMode = 'PAPER';
  private policy: ExecutionPolicy;
  private rateLimitState: RateLimitState;
  private executionQueue: QueuedExecution[] = [];
  private marketCache: Map<string, KalshiMarket> = new Map();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.policy = getExecutionPolicy('PAPER');
    this.rateLimitState = createRateLimitState();
    this.initTables();
  }

  private initTables(): void {
    // Orders table
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        order_id TEXT PRIMARY KEY,
        client_order_id TEXT NOT NULL,
        ticker TEXT NOT NULL,
        side TEXT NOT NULL,
        action TEXT NOT NULL,
        order_type TEXT NOT NULL,
        requested_size INTEGER NOT NULL,
        limit_price INTEGER,
        status TEXT NOT NULL,
        fill_count INTEGER DEFAULT 0,
        fill_price INTEGER,
        source_strategy TEXT NOT NULL,
        signal_id TEXT NOT NULL,
        execution_mode TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        evidence_hash TEXT
      )
    `);

    // Paper positions table
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS paper_positions (
        ticker TEXT NOT NULL,
        side TEXT NOT NULL,
        contracts INTEGER NOT NULL DEFAULT 0,
        avg_entry_price REAL NOT NULL DEFAULT 0,
        realized_pnl REAL NOT NULL DEFAULT 0,
        unrealized_pnl REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (ticker, side)
      )
    `);

    // Indexes
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_orders_ticker ON orders(ticker)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_orders_strategy ON orders(source_strategy)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at)`);
  }

  protected async handleRequest(request: Request, path: string): Promise<Response> {
    switch (path) {
      // Execution endpoints
      case '/execute':
        return this.executeOrder(request);
      case '/execute-batch':
        return this.executeBatch(request);
      case '/cancel':
        return this.cancelOrder(request);

      // Queue management
      case '/queue':
        return this.getQueue();
      case '/queue/process':
        return this.processQueue();
      case '/queue/clear':
        return this.clearQueue();

      // Position tracking
      case '/positions':
        return this.getPositions();
      case '/positions/paper':
        return this.getPaperPositions();
      case '/positions/sync':
        return this.syncPositions();

      // Order history
      case '/orders':
        return this.getOrders(request);
      case '/orders/history':
        return this.getOrderHistory(request);

      // Balance
      case '/balance':
        return this.getBalance();

      // Policy management
      case '/policy':
        return this.getPolicy();
      case '/policy/update':
        return this.updatePolicy(request);
      case '/mode':
        return this.getExecutionMode();
      case '/mode/set':
        return this.setExecutionMode(request);

      // Status
      case '/status':
        return this.getStatus();
      case '/metrics':
        return this.getMetrics();

      // Events
      case '/event/order-update':
        return this.handleOrderUpdate(request);
      case '/event/fill':
        return this.handleFillEvent(request);

      default:
        return Response.json({ error: 'Not found' }, { status: 404 });
    }
  }

  // ============================================================
  // EXECUTION
  // ============================================================

  private async executeOrder(request: Request): Promise<Response> {
    const startTime = Date.now();
    const execRequest = await request.json<ExecutionRequest>();

    // Generate order ID if not provided
    const orderId = execRequest.orderId || deterministicId(
      'kalshi_order',
      execRequest.signal.marketId,
      execRequest.signal.side,
      execRequest.requestedSize,
      execRequest.maxPrice,
      execRequest.timestamp
    );
    execRequest.orderId = orderId;

    // Get market data for validation
    const market = await this.getMarketData(execRequest.signal.marketId);
    if (!market) {
      return Response.json({
        success: false,
        orderId,
        mode: this.executionMode,
        status: 'rejected',
        rejectionReason: `Market ${execRequest.signal.marketId} not found`,
        executionTimeMs: Date.now() - startTime,
      } as ExecutionResult);
    }

    // Validate against policy
    const validation = validateExecutionRequest(
      execRequest,
      market,
      this.policy,
      this.rateLimitState
    );

    if (!validation.valid) {
      await this.logAudit('ORDER_VALIDATION_FAILED', {
        orderId,
        errors: validation.errors,
        warnings: validation.warnings,
      });

      return Response.json({
        success: false,
        orderId,
        mode: this.executionMode,
        status: 'rejected',
        rejectionReason: validation.errors.join('; '),
        executionTimeMs: Date.now() - startTime,
      } as ExecutionResult);
    }

    // Check with RiskGovernorAgent if required
    if (this.policy.requireRiskApproval) {
      const riskCheck = await this.checkWithRiskGovernor(execRequest, market);
      if (!riskCheck.approved) {
        await this.logAudit('ORDER_RISK_REJECTED', {
          orderId,
          reason: riskCheck.rejectionReason,
          violations: riskCheck.violations,
        });

        return Response.json({
          success: false,
          orderId,
          mode: this.executionMode,
          status: 'rejected',
          rejectionReason: riskCheck.rejectionReason,
          executionTimeMs: Date.now() - startTime,
        } as ExecutionResult);
      }

      // Apply adjusted size from risk governor
      if (riskCheck.adjustedSize && riskCheck.adjustedSize < execRequest.requestedSize) {
        execRequest.requestedSize = riskCheck.adjustedSize;
      }
    }

    // Execute based on mode
    let result: ExecutionResult;
    if (this.executionMode === 'PAPER') {
      result = await this.executePaperOrder(execRequest, market);
    } else if (this.executionMode === 'LIVE') {
      result = await this.executeLiveOrder(execRequest);
    } else {
      result = {
        success: false,
        orderId,
        mode: 'DISABLED',
        status: 'rejected',
        rejectionReason: 'Execution is disabled',
        executionTimeMs: Date.now() - startTime,
      };
    }

    // Update rate limits
    const orderNotional = execRequest.requestedSize * execRequest.maxPrice;
    this.rateLimitState = updateRateLimitState(this.rateLimitState, orderNotional);

    // Log warnings if any
    if (validation.warnings.length > 0) {
      await this.logAudit('ORDER_WARNINGS', {
        orderId,
        warnings: validation.warnings,
      });
    }

    result.executionTimeMs = Date.now() - startTime;
    return Response.json(result);
  }

  private async executePaperOrder(
    request: ExecutionRequest,
    market: KalshiMarket
  ): Promise<ExecutionResult> {
    const paperFill = simulatePaperFill(request, market, this.policy);

    // Store order record
    this.storeOrderRecord({
      order_id: request.orderId,
      client_order_id: request.orderId,
      ticker: request.signal.marketId,
      side: request.signal.side.toLowerCase(),
      action: 'buy',
      order_type: request.orderType,
      requested_size: request.requestedSize,
      limit_price: request.maxPrice,
      status: 'filled',
      fill_count: paperFill.count,
      fill_price: paperFill.fillPrice,
      source_strategy: request.source,
      signal_id: request.orderId,
      execution_mode: 'PAPER',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      evidence_hash: null,
    });

    // Update paper position
    this.updatePaperPosition(paperFill);

    await this.logAudit('PAPER_ORDER_FILLED', {
      orderId: request.orderId,
      ticker: paperFill.ticker,
      side: paperFill.side,
      count: paperFill.count,
      fillPrice: paperFill.fillPrice,
      slippage: paperFill.slippage,
    });

    return {
      success: true,
      orderId: request.orderId,
      mode: 'PAPER',
      status: 'paper_filled',
      paperFill,
      executionTimeMs: 0,
    };
  }

  private async executeLiveOrder(request: ExecutionRequest): Promise<ExecutionResult> {
    const kalshiOrder = transformToKalshiOrder(request, this.policy);

    const result = await kalshiClient.submitOrder(this.env, kalshiOrder);

    if (!result.ok) {
      await this.logAudit('LIVE_ORDER_FAILED', {
        orderId: request.orderId,
        error: result.error.message,
      });

      return {
        success: false,
        orderId: request.orderId,
        mode: 'LIVE',
        status: 'rejected',
        rejectionReason: result.error.message,
        executionTimeMs: 0,
      };
    }

    const order = result.value.order;

    // Store order record
    this.storeOrderRecord({
      order_id: order.order_id,
      client_order_id: order.client_order_id,
      ticker: order.ticker,
      side: order.side,
      action: order.action,
      order_type: order.type,
      requested_size: order.order_count,
      limit_price: order.yes_price || order.no_price,
      status: order.status,
      fill_count: order.filled_count,
      fill_price: order.filled_price,
      source_strategy: request.source,
      signal_id: request.orderId,
      execution_mode: 'LIVE',
      created_at: order.created_time,
      updated_at: new Date().toISOString(),
      evidence_hash: result.value.evidenceHash,
    });

    await this.logAudit('LIVE_ORDER_SUBMITTED', {
      orderId: order.order_id,
      clientOrderId: order.client_order_id,
      ticker: order.ticker,
      status: order.status,
      evidenceHash: result.value.evidenceHash,
    }, result.value.evidenceHash);

    return {
      success: true,
      orderId: order.order_id,
      mode: 'LIVE',
      status: 'submitted',
      order,
      executionTimeMs: 0,
    };
  }

  private async executeBatch(request: Request): Promise<Response> {
    const { requests } = await request.json<{ requests: ExecutionRequest[] }>();
    const results: ExecutionResult[] = [];

    for (const req of requests) {
      // Queue each request
      const priority = calculateExecutionPriority(req);
      this.executionQueue.push({
        request: req,
        priority,
        queuedAt: Date.now(),
        retryCount: 0,
        maxRetries: 3,
      });
    }

    // Sort queue by priority
    this.executionQueue = sortExecutionQueue(this.executionQueue);

    // Process queue
    while (this.executionQueue.length > 0) {
      const item = this.executionQueue.shift();
      if (!item) break;

      const fakeRequest = new Request('http://localhost/execute', {
        method: 'POST',
        body: JSON.stringify(item.request),
      });

      const response = await this.executeOrder(fakeRequest);
      const execResult = await response.json<ExecutionResult>();
      results.push(execResult);

      // Respect rate limits - add delay if needed
      if (this.executionQueue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, this.policy.minOrderSpacingMs));
      }
    }

    return Response.json({
      processed: results.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    });
  }

  private async cancelOrder(request: Request): Promise<Response> {
    const { orderId } = await request.json<{ orderId: string }>();

    if (this.executionMode === 'PAPER') {
      // Paper mode: just update the record
      this.runSql(
        `UPDATE orders SET status = ?, updated_at = ? WHERE order_id = ?`,
        'cancelled',
        new Date().toISOString(),
        orderId
      );

      await this.logAudit('PAPER_ORDER_CANCELLED', { orderId });
      return Response.json({ success: true, mode: 'PAPER' });
    }

    // Live mode: cancel via API
    const result = await kalshiClient.cancelOrder(this.env, orderId);

    if (!result.ok) {
      return Response.json({
        success: false,
        error: result.error.message,
      });
    }

    // Update local record
    this.runSql(
      `UPDATE orders SET status = ?, updated_at = ? WHERE order_id = ?`,
      'cancelled',
      new Date().toISOString(),
      orderId
    );

    await this.logAudit('LIVE_ORDER_CANCELLED', {
      orderId,
      evidenceHash: result.value.evidenceHash,
    }, result.value.evidenceHash);

    return Response.json({ success: true, mode: 'LIVE' });
  }

  // Helper to run SQL (wrapper around sql.exec)
  private runSql(query: string, ...params: unknown[]): void {
    this.sql.exec(query, ...params);
  }

  private querySql<T extends Record<string, SqlStorageValue>>(query: string, ...params: unknown[]): T[] {
    return this.sql.exec<T>(query, ...params).toArray();
  }

  // ============================================================
  // RISK INTEGRATION
  // ============================================================

  private async checkWithRiskGovernor(
    request: ExecutionRequest,
    market: KalshiMarket
  ): Promise<RiskCheckResponse> {
    try {
      const riskGovernorId = this.env.RISK_GOVERNOR.idFromName('singleton');
      const riskGovernor = this.env.RISK_GOVERNOR.get(riskGovernorId);

      const response = await riskGovernor.fetch('http://localhost/check-signal', {
        method: 'POST',
        body: JSON.stringify({
          signal: {
            marketId: request.signal.marketId,
            side: request.signal.side,
            modelProbability: request.signal.modelProbability,
            marketPrice: request.signal.marketPrice,
            edge: request.signal.edge,
            confidence: request.signal.confidence,
            requestedSize: request.requestedSize,
          },
          market: {
            ticker: market.ticker,
            yesBid: market.yes_bid,
            yesAsk: market.yes_ask,
            volume24h: market.volume_24h,
            openInterest: market.open_interest,
          },
        }),
      });

      const checkResult = await response.json<{
        approved: boolean;
        adjustedSize?: number;
        violations?: Array<{ code: string; message: string }>;
      }>();

      return {
        approved: checkResult.approved,
        adjustedSize: checkResult.adjustedSize,
        rejectionReason: checkResult.violations?.map(v => v.message).join('; '),
        violations: checkResult.violations?.map(v => v.code),
      };
    } catch (error) {
      // Fail closed - reject if risk check fails
      return {
        approved: false,
        rejectionReason: `Risk check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  // ============================================================
  // POSITION TRACKING
  // ============================================================

  private async getPositions(): Promise<Response> {
    if (this.executionMode === 'PAPER') {
      return this.getPaperPositions();
    }

    const result = await kalshiClient.getPositions(this.env);

    if (!result.ok) {
      return Response.json({ error: result.error.message }, { status: 500 });
    }

    return Response.json({
      mode: 'LIVE',
      positions: result.value.positions,
      evidenceHash: result.value.evidenceHash,
    });
  }

  private async getPaperPositions(): Promise<Response> {
    const positions = this.querySql<PaperPositionRow>(
      `SELECT * FROM paper_positions WHERE contracts > 0`
    );

    return Response.json({
      mode: 'PAPER',
      positions,
    });
  }

  private updatePaperPosition(fill: PaperFill): void {
    const existing = this.querySql<PaperPositionRow>(
      `SELECT * FROM paper_positions WHERE ticker = ? AND side = ?`,
      fill.ticker,
      fill.side
    );

    if (existing.length > 0) {
      const pos = existing[0]!;
      // Update existing position
      const newContracts = pos.contracts + fill.count;
      const totalCost = pos.contracts * pos.avg_entry_price + fill.count * fill.fillPrice;
      const newAvgPrice = newContracts > 0 ? totalCost / newContracts : 0;

      this.runSql(
        `UPDATE paper_positions SET contracts = ?, avg_entry_price = ?, updated_at = ?
         WHERE ticker = ? AND side = ?`,
        newContracts,
        newAvgPrice,
        new Date().toISOString(),
        fill.ticker,
        fill.side
      );
    } else {
      // Insert new position
      this.runSql(
        `INSERT INTO paper_positions (ticker, side, contracts, avg_entry_price, realized_pnl, unrealized_pnl, updated_at)
         VALUES (?, ?, ?, ?, 0, 0, ?)`,
        fill.ticker,
        fill.side,
        fill.count,
        fill.fillPrice,
        new Date().toISOString()
      );
    }
  }

  private async syncPositions(): Promise<Response> {
    if (this.executionMode !== 'LIVE') {
      return Response.json({ error: 'Position sync only available in LIVE mode' }, { status: 400 });
    }

    const result = await kalshiClient.getPositions(this.env);
    if (!result.ok) {
      return Response.json({ error: result.error.message }, { status: 500 });
    }

    await this.logAudit('POSITIONS_SYNCED', {
      positionCount: result.value.positions.length,
      evidenceHash: result.value.evidenceHash,
    });

    return Response.json({
      synced: true,
      positions: result.value.positions,
    });
  }

  // ============================================================
  // ORDERS
  // ============================================================

  private async getOrders(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const limit = parseInt(url.searchParams.get('limit') ?? '50');

    if (this.executionMode === 'PAPER') {
      let orders: OrderRow[];
      if (status) {
        orders = this.querySql<OrderRow>(
          `SELECT * FROM orders WHERE execution_mode = ? AND status = ?
           ORDER BY created_at DESC LIMIT ?`,
          'PAPER',
          status,
          limit
        );
      } else {
        orders = this.querySql<OrderRow>(
          `SELECT * FROM orders WHERE execution_mode = ?
           ORDER BY created_at DESC LIMIT ?`,
          'PAPER',
          limit
        );
      }

      return Response.json({
        mode: 'PAPER',
        orders,
      });
    }

    // Live mode
    const result = await kalshiClient.getOrders(this.env, {
      status: status ?? undefined,
      limit,
    });

    if (!result.ok) {
      return Response.json({ error: result.error.message }, { status: 500 });
    }

    return Response.json({
      mode: 'LIVE',
      orders: result.value.orders,
      evidenceHash: result.value.evidenceHash,
    });
  }

  private async getOrderHistory(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') ?? '100');
    const ticker = url.searchParams.get('ticker');
    const strategy = url.searchParams.get('strategy');

    let orders: OrderRow[];
    if (ticker && strategy) {
      orders = this.querySql<OrderRow>(
        `SELECT * FROM orders WHERE ticker = ? AND source_strategy = ?
         ORDER BY created_at DESC LIMIT ?`,
        ticker,
        strategy,
        limit
      );
    } else if (ticker) {
      orders = this.querySql<OrderRow>(
        `SELECT * FROM orders WHERE ticker = ?
         ORDER BY created_at DESC LIMIT ?`,
        ticker,
        limit
      );
    } else if (strategy) {
      orders = this.querySql<OrderRow>(
        `SELECT * FROM orders WHERE source_strategy = ?
         ORDER BY created_at DESC LIMIT ?`,
        strategy,
        limit
      );
    } else {
      orders = this.querySql<OrderRow>(
        `SELECT * FROM orders ORDER BY created_at DESC LIMIT ?`,
        limit
      );
    }

    return Response.json({ orders });
  }

  private storeOrderRecord(order: OrderRow): void {
    this.runSql(
      `INSERT OR REPLACE INTO orders (
        order_id, client_order_id, ticker, side, action, order_type,
        requested_size, limit_price, status, fill_count, fill_price,
        source_strategy, signal_id, execution_mode, created_at, updated_at, evidence_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      order.order_id,
      order.client_order_id,
      order.ticker,
      order.side,
      order.action,
      order.order_type,
      order.requested_size,
      order.limit_price,
      order.status,
      order.fill_count,
      order.fill_price,
      order.source_strategy,
      order.signal_id,
      order.execution_mode,
      order.created_at,
      order.updated_at,
      order.evidence_hash
    );
  }

  // ============================================================
  // BALANCE
  // ============================================================

  private async getBalance(): Promise<Response> {
    if (this.executionMode === 'PAPER') {
      // Calculate paper balance from positions
      const positions = this.querySql<PaperPositionRow>(
        `SELECT * FROM paper_positions`
      );

      const totalValue = positions.reduce(
        (sum: number, p: PaperPositionRow) => sum + p.contracts * p.avg_entry_price,
        0
      );

      return Response.json({
        mode: 'PAPER',
        balance: {
          balance: 10000 - totalValue, // Assume $100 starting balance
          portfolio_value: totalValue,
          total_deposited: 10000,
          total_withdrawn: 0,
        },
      });
    }

    const result = await kalshiClient.getBalance(this.env);
    if (!result.ok) {
      return Response.json({ error: result.error.message }, { status: 500 });
    }

    return Response.json({
      mode: 'LIVE',
      balance: result.value.balance,
      evidenceHash: result.value.evidenceHash,
    });
  }

  // ============================================================
  // QUEUE MANAGEMENT
  // ============================================================

  private async getQueue(): Promise<Response> {
    return Response.json({
      queueLength: this.executionQueue.length,
      queue: this.executionQueue.map(q => ({
        orderId: q.request.orderId,
        marketId: q.request.signal.marketId,
        priority: q.priority,
        queuedAt: q.queuedAt,
        retryCount: q.retryCount,
      })),
    });
  }

  private async processQueue(): Promise<Response> {
    const processed: ExecutionResult[] = [];

    while (this.executionQueue.length > 0) {
      const item = this.executionQueue.shift();
      if (!item) break;

      const fakeRequest = new Request('http://localhost/execute', {
        method: 'POST',
        body: JSON.stringify(item.request),
      });

      const response = await this.executeOrder(fakeRequest);
      const execResult = await response.json<ExecutionResult>();
      processed.push(execResult);

      // Add delay between orders
      if (this.executionQueue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, this.policy.minOrderSpacingMs));
      }
    }

    return Response.json({
      processed: processed.length,
      results: processed,
    });
  }

  private async clearQueue(): Promise<Response> {
    const cleared = this.executionQueue.length;
    this.executionQueue = [];

    await this.logAudit('QUEUE_CLEARED', { clearedCount: cleared });

    return Response.json({ cleared });
  }

  // ============================================================
  // POLICY MANAGEMENT
  // ============================================================

  private async getPolicy(): Promise<Response> {
    return Response.json({
      mode: this.executionMode,
      policy: this.policy,
      rateLimitState: this.rateLimitState,
    });
  }

  private async updatePolicy(request: Request): Promise<Response> {
    const updates = await request.json<Partial<ExecutionPolicy>>();

    this.policy = customizePolicy(this.policy, updates);

    await this.logAudit('POLICY_UPDATED', { updates });

    return Response.json({
      success: true,
      policy: this.policy,
    });
  }

  private async getExecutionMode(): Promise<Response> {
    return Response.json({ mode: this.executionMode });
  }

  private async setExecutionMode(request: Request): Promise<Response> {
    const { mode } = await request.json<{ mode: ExecutionMode }>();

    if (!['PAPER', 'LIVE', 'DISABLED'].includes(mode)) {
      return Response.json({ error: 'Invalid mode' }, { status: 400 });
    }

    const previousMode = this.executionMode;
    this.executionMode = mode;
    this.policy = getExecutionPolicy(mode);

    await this.logAudit('EXECUTION_MODE_CHANGED', {
      previousMode,
      newMode: mode,
    });

    return Response.json({
      success: true,
      previousMode,
      newMode: mode,
      policy: this.policy,
    });
  }

  // ============================================================
  // EVENTS
  // ============================================================

  private async handleOrderUpdate(request: Request): Promise<Response> {
    const update = await request.json<{
      orderId: string;
      status: string;
      filledCount?: number;
      filledPrice?: number;
    }>();

    // Update local record
    if (update.filledCount !== undefined) {
      this.runSql(
        `UPDATE orders SET status = ?, fill_count = ?, fill_price = ?, updated_at = ?
         WHERE order_id = ?`,
        update.status,
        update.filledCount,
        update.filledPrice ?? null,
        new Date().toISOString(),
        update.orderId
      );
    } else {
      this.runSql(
        `UPDATE orders SET status = ?, updated_at = ? WHERE order_id = ?`,
        update.status,
        new Date().toISOString(),
        update.orderId
      );
    }

    await this.logAudit('ORDER_UPDATE_RECEIVED', update);

    return Response.json({ received: true });
  }

  private async handleFillEvent(request: Request): Promise<Response> {
    const fill = await request.json<{
      orderId: string;
      ticker: string;
      side: 'yes' | 'no';
      count: number;
      price: number;
    }>();

    // Update order fill count
    this.runSql(
      `UPDATE orders SET fill_count = fill_count + ?, fill_price = ?, status = 'filled', updated_at = ?
       WHERE order_id = ?`,
      fill.count,
      fill.price,
      new Date().toISOString(),
      fill.orderId
    );

    await this.logAudit('FILL_RECEIVED', fill);

    return Response.json({ received: true });
  }

  // ============================================================
  // STATUS
  // ============================================================

  private async getStatus(): Promise<Response> {
    const orderCountResult = this.querySql<{ count: number }>(
      `SELECT COUNT(*) as count FROM orders`
    );

    const recentOrdersResult = this.querySql<{ count: number }>(
      `SELECT COUNT(*) as count FROM orders WHERE created_at > datetime('now', '-1 hour')`
    );

    return Response.json({
      agentName: this.agentName,
      executionMode: this.executionMode,
      policy: this.policy,
      rateLimitState: this.rateLimitState,
      queueLength: this.executionQueue.length,
      stats: {
        totalOrders: orderCountResult[0]?.count ?? 0,
        ordersLastHour: recentOrdersResult[0]?.count ?? 0,
      },
    });
  }

  private async getMetrics(): Promise<Response> {
    const metrics = this.querySql<{
      execution_mode: string;
      status: string;
      count: number;
      total_fills: number;
      avg_fill_price: number;
    }>(
      `SELECT execution_mode, status, COUNT(*) as count,
              SUM(fill_count) as total_fills, AVG(fill_price) as avg_fill_price
       FROM orders GROUP BY execution_mode, status`
    );

    const byStrategy = this.querySql<{
      source_strategy: string;
      count: number;
      filled: number;
      rejected: number;
    }>(
      `SELECT source_strategy, COUNT(*) as count,
              SUM(CASE WHEN status = 'filled' THEN 1 ELSE 0 END) as filled,
              SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected
       FROM orders GROUP BY source_strategy`
    );

    return Response.json({
      byModeAndStatus: metrics,
      byStrategy,
      rateLimits: {
        ordersThisMinute: this.rateLimitState.ordersThisMinute,
        ordersThisHour: this.rateLimitState.ordersThisHour,
        volumeToday: this.rateLimitState.volumeToday,
        maxOrdersPerMinute: this.policy.maxOrdersPerMinute,
        maxOrdersPerHour: this.policy.maxOrdersPerHour,
        maxDailyVolume: this.policy.maxDailyVolume,
      },
    });
  }

  // ============================================================
  // HELPERS
  // ============================================================

  private async getMarketData(ticker: string): Promise<KalshiMarket | null> {
    // Check cache first
    if (this.marketCache.has(ticker)) {
      return this.marketCache.get(ticker)!;
    }

    // Fetch from API
    const result = await kalshiClient.fetchMarket(this.env, ticker);
    if (!result.ok) {
      return null;
    }

    // Cache for 60 seconds
    this.marketCache.set(ticker, result.value.market);
    setTimeout(() => this.marketCache.delete(ticker), 60000);

    return result.value.market;
  }
}
