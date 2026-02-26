/**
 * Paul P - IBKR Execution Agent
 *
 * Handles Interactive Brokers hedge execution via Client Portal API.
 * Used for delta hedging prediction market positions with traditional
 * financial instruments.
 *
 * Note: IBKR Client Portal API requires a running gateway process.
 * This agent assumes the gateway is accessible via IBKR_GATEWAY_URL.
 */

import { PaulPAgent } from './base';
import type { Env } from '../types/env';
import { storeEvidence, type StoreEvidenceInput } from '../lib/evidence/store';
import { sha256String } from '../lib/evidence/hasher';
import { deterministicId } from '../lib/utils/deterministic-id';

// ============================================================
// TYPES
// ============================================================

type ExecutionMode = 'PAPER' | 'LIVE' | 'DISABLED';

interface IBKROrder {
  conid: number;
  orderType: 'LMT' | 'MKT' | 'STP' | 'STOP_LIMIT';
  side: 'BUY' | 'SELL';
  quantity: number;
  price?: number;
  tif: 'DAY' | 'GTC' | 'IOC';
  outsideRth?: boolean;
  referrer?: string;
}

interface IBKRPosition {
  conid: number;
  ticker: string;
  name: string;
  position: number;
  mktPrice: number;
  mktValue: number;
  avgCost: number;
  unrealizedPnL: number;
  realizedPnL: number;
  currency: string;
}

type OrderRow = {
  order_id: string;
  conid: number;
  ticker: string;
  side: string;
  order_type: string;
  quantity: number;
  limit_price: number | null;
  status: string;
  filled_qty: number;
  avg_fill_price: number | null;
  hedge_strategy: string;
  related_market_id: string;
  execution_mode: string;
  created_at: string;
  updated_at: string;
  evidence_hash: string | null;
};

type PositionRow = {
  conid: number;
  ticker: string;
  position: number;
  avg_cost: number;
  unrealized_pnl: number;
  realized_pnl: number;
  updated_at: string;
};

// ============================================================
// AGENT
// ============================================================

export class IBKRExecAgent extends PaulPAgent {
  readonly agentName = 'ibkr-exec';

  private executionMode: ExecutionMode = 'PAPER';
  private gatewayUrl: string = '';
  private accountId: string = '';
  private isConnected = false;
  private lastHeartbeat: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.gatewayUrl = env.IBKR_GATEWAY_URL ?? 'https://localhost:5000/v1/api';
    this.accountId = env.IBKR_ACCOUNT_ID ?? '';
    this.initTables();
  }

  private initTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ibkr_orders (
        order_id TEXT PRIMARY KEY,
        conid INTEGER NOT NULL,
        ticker TEXT NOT NULL,
        side TEXT NOT NULL,
        order_type TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        limit_price REAL,
        status TEXT NOT NULL,
        filled_qty INTEGER DEFAULT 0,
        avg_fill_price REAL,
        hedge_strategy TEXT NOT NULL,
        related_market_id TEXT,
        execution_mode TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        evidence_hash TEXT
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ibkr_positions (
        conid INTEGER PRIMARY KEY,
        ticker TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        avg_cost REAL NOT NULL DEFAULT 0,
        unrealized_pnl REAL NOT NULL DEFAULT 0,
        realized_pnl REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ibkr_contracts (
        conid INTEGER PRIMARY KEY,
        ticker TEXT NOT NULL,
        name TEXT NOT NULL,
        sec_type TEXT NOT NULL,
        exchange TEXT NOT NULL,
        currency TEXT NOT NULL,
        cached_at TEXT NOT NULL
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ibkr_connection (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        connected INTEGER NOT NULL DEFAULT 0,
        account_id TEXT,
        last_heartbeat TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      )
    `);

    this.sql.exec(`
      INSERT OR IGNORE INTO ibkr_connection (id, connected, updated_at)
      VALUES (1, 0, ?)
    `, new Date().toISOString());

    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_ibkr_orders_status ON ibkr_orders(status)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_ibkr_orders_created ON ibkr_orders(created_at)`);
  }

  protected async handleRequest(request: Request, path: string): Promise<Response> {
    switch (path) {
      case '/connect':
        return this.connect();
      case '/disconnect':
        return this.disconnect();
      case '/heartbeat':
        return this.heartbeat();
      case '/connection/status':
        return this.getConnectionStatus();
      case '/execute':
        return this.executeOrder(request);
      case '/cancel':
        return this.cancelOrder(request);
      case '/positions':
        return this.getPositions();
      case '/positions/sync':
        return this.syncPositions();
      case '/account':
        return this.getAccount();
      case '/balance':
        return this.getBalance();
      case '/orders':
        return this.getOrders(request);
      case '/orders/history':
        return this.getOrderHistory(request);
      case '/contract/search':
        return this.searchContract(request);
      case '/contract/details':
        return this.getContractDetails(request);
      case '/mode':
        return this.getExecutionMode();
      case '/mode/set':
        return this.setExecutionMode(request);
      case '/status':
        return this.getStatus();
      default:
        return Response.json({ error: 'Not found' }, { status: 404 });
    }
  }

  private async connect(): Promise<Response> {
    if (this.executionMode === 'PAPER') {
      this.isConnected = true;
      this.lastHeartbeat = new Date().toISOString();
      this.updateConnectionState(true, null);

      return Response.json({
        connected: true,
        mode: 'PAPER',
        message: 'Paper trading mode - simulated connection',
      });
    }

    try {
      const response = await this.ibkrFetch('/iserver/auth/status');

      if (!response.ok) {
        throw new Error(`Gateway auth check failed: ${response.status}`);
      }

      const data = await response.json() as {
        authenticated: boolean;
        connected: boolean;
        competing: boolean;
      };

      if (!data.authenticated) {
        return Response.json({
          connected: false,
          error: 'Not authenticated - login required at IBKR gateway',
        }, { status: 401 });
      }

      this.isConnected = data.connected;
      this.lastHeartbeat = new Date().toISOString();
      this.updateConnectionState(data.connected, null);

      await this.logAudit('IBKR_CONNECTED', {
        authenticated: data.authenticated,
        connected: data.connected,
      });

      return Response.json({
        connected: data.connected,
        authenticated: data.authenticated,
        mode: 'LIVE',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.updateConnectionState(false, errorMessage);

      return Response.json({
        connected: false,
        error: errorMessage,
      }, { status: 500 });
    }
  }

  private async disconnect(): Promise<Response> {
    this.isConnected = false;
    this.updateConnectionState(false, null);
    await this.logAudit('IBKR_DISCONNECTED', {});
    return Response.json({ disconnected: true });
  }

  private async heartbeat(): Promise<Response> {
    if (this.executionMode === 'PAPER') {
      this.lastHeartbeat = new Date().toISOString();
      return Response.json({ alive: true, mode: 'PAPER' });
    }

    try {
      const response = await this.ibkrFetch('/tickle');
      const data = await response.json() as { session: string };

      this.lastHeartbeat = new Date().toISOString();
      this.isConnected = true;

      return Response.json({
        alive: true,
        session: data.session,
        lastHeartbeat: this.lastHeartbeat,
      });
    } catch (error) {
      this.isConnected = false;
      return Response.json({
        alive: false,
        error: error instanceof Error ? error.message : String(error),
      }, { status: 500 });
    }
  }

  private async getConnectionStatus(): Promise<Response> {
    const state = this.sql.exec<{
      connected: number;
      account_id: string | null;
      last_heartbeat: string | null;
      last_error: string | null;
    }>(`SELECT * FROM ibkr_connection WHERE id = 1`).one();

    return Response.json({
      connected: state?.connected === 1,
      accountId: state?.account_id ?? this.accountId,
      lastHeartbeat: state?.last_heartbeat,
      lastError: state?.last_error,
      mode: this.executionMode,
      gatewayUrl: this.gatewayUrl,
    });
  }

  private updateConnectionState(connected: boolean, error: string | null): void {
    this.sql.exec(
      `UPDATE ibkr_connection
       SET connected = ?, last_heartbeat = ?, last_error = ?, updated_at = ?
       WHERE id = 1`,
      connected ? 1 : 0,
      connected ? new Date().toISOString() : null,
      error,
      new Date().toISOString()
    );
  }

  private async executeOrder(request: Request): Promise<Response> {
    const body = await request.json<{
      conid?: number;
      ticker?: string;
      side: 'BUY' | 'SELL';
      quantity: number;
      orderType: 'LMT' | 'MKT';
      price?: number;
      tif?: 'DAY' | 'GTC' | 'IOC';
      hedgeStrategy: string;
      relatedMarketId?: string;
    }>();

    if (!body.conid && !body.ticker) {
      return Response.json({ error: 'conid or ticker required' }, { status: 400 });
    }

    const nowIso = new Date().toISOString();
    const orderId = deterministicId(
      'ibkr_order',
      body.conid ?? '',
      body.ticker ?? '',
      body.side,
      body.quantity,
      body.hedgeStrategy,
      nowIso
    );

    let conid = body.conid;
    if (!conid && body.ticker) {
      const contract = await this.resolveContract(body.ticker);
      if (!contract) {
        return Response.json({
          success: false,
          orderId,
          error: `Contract not found for ticker: ${body.ticker}`,
        });
      }
      conid = contract.conid;
    }

    if (!conid) {
      return Response.json({
        success: false,
        orderId,
        error: 'Could not resolve contract ID',
      });
    }

    const order: IBKROrder = {
      conid,
      side: body.side,
      quantity: body.quantity,
      orderType: body.orderType,
      price: body.price,
      tif: body.tif ?? 'DAY',
    };

    if (this.executionMode === 'PAPER') {
      return this.executePaperOrder(orderId, order, body.hedgeStrategy, body.relatedMarketId);
    } else if (this.executionMode === 'LIVE') {
      return this.executeLiveOrder(orderId, order, body.hedgeStrategy, body.relatedMarketId);
    } else {
      return Response.json({
        success: false,
        orderId,
        error: 'Execution is disabled',
      });
    }
  }

  private async executePaperOrder(
    orderId: string,
    order: IBKROrder,
    hedgeStrategy: string,
    relatedMarketId?: string
  ): Promise<Response> {
    const fillPrice = order.price ?? 100;

    this.storeOrder({
      order_id: orderId,
      conid: order.conid,
      ticker: `CONID_${order.conid}`,
      side: order.side,
      order_type: order.orderType,
      quantity: order.quantity,
      limit_price: order.price ?? null,
      status: 'Filled',
      filled_qty: order.quantity,
      avg_fill_price: fillPrice,
      hedge_strategy: hedgeStrategy,
      related_market_id: relatedMarketId ?? '',
      execution_mode: 'PAPER',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      evidence_hash: null,
    });

    this.updatePosition(order.conid, order.side, order.quantity, fillPrice);

    await this.logAudit('IBKR_PAPER_ORDER_FILLED', {
      orderId,
      conid: order.conid,
      side: order.side,
      quantity: order.quantity,
      fillPrice,
    });

    return Response.json({
      success: true,
      orderId,
      mode: 'PAPER',
      status: 'Filled',
      fillQty: order.quantity,
      fillPrice,
    });
  }

  private async executeLiveOrder(
    orderId: string,
    order: IBKROrder,
    hedgeStrategy: string,
    relatedMarketId?: string
  ): Promise<Response> {
    if (!this.isConnected) {
      return Response.json({
        success: false,
        orderId,
        error: 'Not connected to IBKR gateway',
      }, { status: 400 });
    }

    try {
      const orderPayload = {
        orders: [{
          conid: order.conid,
          orderType: order.orderType,
          side: order.side,
          quantity: order.quantity,
          price: order.price,
          tif: order.tif,
        }],
      };

      const response = await this.ibkrFetch(
        `/iserver/account/${this.accountId}/orders`,
        'POST',
        orderPayload
      );

      const responseText = await response.text();
      const evidenceHash = await this.storeIBKREvidence(
        `/iserver/account/${this.accountId}/orders`,
        responseText
      );

      const data = JSON.parse(responseText) as Array<{
        order_id: string;
        order_status: string;
      }>;

      const firstOrder = data?.[0];
      if (!firstOrder) {
        return Response.json({
          success: false,
          orderId,
          error: 'No order response from IBKR',
          evidenceHash,
        });
      }

      const ibkrOrderId = firstOrder.order_id;

      this.storeOrder({
        order_id: ibkrOrderId,
        conid: order.conid,
        ticker: `CONID_${order.conid}`,
        side: order.side,
        order_type: order.orderType,
        quantity: order.quantity,
        limit_price: order.price ?? null,
        status: firstOrder.order_status,
        filled_qty: 0,
        avg_fill_price: null,
        hedge_strategy: hedgeStrategy,
        related_market_id: relatedMarketId ?? '',
        execution_mode: 'LIVE',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        evidence_hash: evidenceHash,
      });

      await this.logAudit('IBKR_LIVE_ORDER_SUBMITTED', {
        orderId: ibkrOrderId,
        conid: order.conid,
        side: order.side,
        quantity: order.quantity,
        evidenceHash,
      }, evidenceHash);

      return Response.json({
        success: true,
        orderId: ibkrOrderId,
        mode: 'LIVE',
        status: firstOrder.order_status,
        evidenceHash,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      await this.logAudit('IBKR_ORDER_FAILED', {
        orderId,
        error: errorMessage,
      });

      return Response.json({
        success: false,
        orderId,
        error: errorMessage,
      }, { status: 500 });
    }
  }

  private async cancelOrder(request: Request): Promise<Response> {
    const { orderId } = await request.json<{ orderId: string }>();

    if (this.executionMode === 'PAPER') {
      this.sql.exec(
        `UPDATE ibkr_orders SET status = ?, updated_at = ? WHERE order_id = ?`,
        'Cancelled',
        new Date().toISOString(),
        orderId
      );

      return Response.json({ success: true, mode: 'PAPER' });
    }

    try {
      const response = await this.ibkrFetch(
        `/iserver/account/${this.accountId}/order/${orderId}`,
        'DELETE'
      );

      const evidenceHash = await this.storeIBKREvidence(
        `/iserver/account/${this.accountId}/order/${orderId}`,
        await response.text()
      );

      this.sql.exec(
        `UPDATE ibkr_orders SET status = ?, updated_at = ? WHERE order_id = ?`,
        'Cancelled',
        new Date().toISOString(),
        orderId
      );

      await this.logAudit('IBKR_ORDER_CANCELLED', { orderId, evidenceHash });

      return Response.json({ success: true, mode: 'LIVE', evidenceHash });
    } catch (error) {
      return Response.json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }, { status: 500 });
    }
  }

  private async getPositions(): Promise<Response> {
    if (this.executionMode === 'PAPER') {
      const positions = this.sql.exec<PositionRow>(
        `SELECT * FROM ibkr_positions WHERE position != 0`
      ).toArray();

      return Response.json({ mode: 'PAPER', positions });
    }

    try {
      const response = await this.ibkrFetch(`/portfolio/${this.accountId}/positions/0`);
      const positions = await response.json() as IBKRPosition[];

      const evidenceHash = await this.storeIBKREvidence(
        `/portfolio/${this.accountId}/positions/0`,
        JSON.stringify(positions)
      );

      return Response.json({
        mode: 'LIVE',
        positions,
        evidenceHash,
      });
    } catch (error) {
      return Response.json({
        error: error instanceof Error ? error.message : String(error),
      }, { status: 500 });
    }
  }

  private async syncPositions(): Promise<Response> {
    if (this.executionMode !== 'LIVE') {
      return Response.json({ error: 'Sync only available in LIVE mode' }, { status: 400 });
    }

    try {
      const response = await this.ibkrFetch(`/portfolio/${this.accountId}/positions/0`);
      const positions = await response.json() as IBKRPosition[];

      for (const pos of positions) {
        this.sql.exec(
          `INSERT OR REPLACE INTO ibkr_positions
           (conid, ticker, position, avg_cost, unrealized_pnl, realized_pnl, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          pos.conid,
          pos.ticker,
          pos.position,
          pos.avgCost,
          pos.unrealizedPnL,
          pos.realizedPnL,
          new Date().toISOString()
        );
      }

      await this.logAudit('IBKR_POSITIONS_SYNCED', {
        positionCount: positions.length,
      });

      return Response.json({ synced: true, positionCount: positions.length });
    } catch (error) {
      return Response.json({
        error: error instanceof Error ? error.message : String(error),
      }, { status: 500 });
    }
  }

  private updatePosition(conid: number, side: 'BUY' | 'SELL', quantity: number, price: number): void {
    const existing = this.sql.exec<PositionRow>(
      `SELECT * FROM ibkr_positions WHERE conid = ?`,
      conid
    ).one();

    const qtyDelta = side === 'BUY' ? quantity : -quantity;

    if (existing) {
      const newPosition = existing.position + qtyDelta;
      const totalCost = existing.position * existing.avg_cost + qtyDelta * price;
      const newAvgCost = newPosition !== 0 ? totalCost / newPosition : 0;

      this.sql.exec(
        `UPDATE ibkr_positions SET position = ?, avg_cost = ?, updated_at = ? WHERE conid = ?`,
        newPosition,
        newAvgCost,
        new Date().toISOString(),
        conid
      );
    } else {
      this.sql.exec(
        `INSERT INTO ibkr_positions (conid, ticker, position, avg_cost, unrealized_pnl, realized_pnl, updated_at)
         VALUES (?, ?, ?, ?, 0, 0, ?)`,
        conid,
        `CONID_${conid}`,
        qtyDelta,
        price,
        new Date().toISOString()
      );
    }
  }

  private async getAccount(): Promise<Response> {
    if (this.executionMode === 'PAPER') {
      return Response.json({
        mode: 'PAPER',
        account: {
          accountId: 'PAPER_ACCOUNT',
          currency: 'USD',
          netLiquidation: 100000,
          buyingPower: 100000,
          availableFunds: 100000,
        },
      });
    }

    try {
      const response = await this.ibkrFetch(`/portfolio/accounts`);
      const accounts = await response.json() as Array<{ accountId: string }>;

      return Response.json({
        mode: 'LIVE',
        accounts,
      });
    } catch (error) {
      return Response.json({
        error: error instanceof Error ? error.message : String(error),
      }, { status: 500 });
    }
  }

  private async getBalance(): Promise<Response> {
    if (this.executionMode === 'PAPER') {
      const positions = this.sql.exec<PositionRow>(
        `SELECT * FROM ibkr_positions`
      ).toArray();

      const portfolioValue = positions.reduce(
        (sum, p) => sum + Math.abs(p.position) * p.avg_cost,
        0
      );

      return Response.json({
        mode: 'PAPER',
        balance: {
          netLiquidation: 100000 + portfolioValue,
          buyingPower: 100000 - portfolioValue,
          availableFunds: 100000 - portfolioValue,
          portfolioValue,
        },
      });
    }

    try {
      const response = await this.ibkrFetch(`/portfolio/${this.accountId}/summary`);
      const summary = await response.json() as Record<string, { value: number }>;

      return Response.json({
        mode: 'LIVE',
        balance: {
          netLiquidation: summary.netliquidation?.value ?? 0,
          buyingPower: summary.buyingpower?.value ?? 0,
          availableFunds: summary.availablefunds?.value ?? 0,
        },
      });
    } catch (error) {
      return Response.json({
        error: error instanceof Error ? error.message : String(error),
      }, { status: 500 });
    }
  }

  private async getOrders(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const limit = parseInt(url.searchParams.get('limit') ?? '50');

    let orders: OrderRow[];
    if (status) {
      orders = this.sql.exec<OrderRow>(
        `SELECT * FROM ibkr_orders WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
        status,
        limit
      ).toArray();
    } else {
      orders = this.sql.exec<OrderRow>(
        `SELECT * FROM ibkr_orders ORDER BY created_at DESC LIMIT ?`,
        limit
      ).toArray();
    }

    return Response.json({
      mode: this.executionMode,
      orders,
    });
  }

  private async getOrderHistory(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') ?? '100');
    const strategy = url.searchParams.get('strategy');

    let orders: OrderRow[];
    if (strategy) {
      orders = this.sql.exec<OrderRow>(
        `SELECT * FROM ibkr_orders WHERE hedge_strategy = ? ORDER BY created_at DESC LIMIT ?`,
        strategy,
        limit
      ).toArray();
    } else {
      orders = this.sql.exec<OrderRow>(
        `SELECT * FROM ibkr_orders ORDER BY created_at DESC LIMIT ?`,
        limit
      ).toArray();
    }

    return Response.json({ orders });
  }

  private storeOrder(order: OrderRow): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO ibkr_orders (
        order_id, conid, ticker, side, order_type, quantity, limit_price,
        status, filled_qty, avg_fill_price, hedge_strategy, related_market_id,
        execution_mode, created_at, updated_at, evidence_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      order.order_id,
      order.conid,
      order.ticker,
      order.side,
      order.order_type,
      order.quantity,
      order.limit_price,
      order.status,
      order.filled_qty,
      order.avg_fill_price,
      order.hedge_strategy,
      order.related_market_id,
      order.execution_mode,
      order.created_at,
      order.updated_at,
      order.evidence_hash
    );
  }

  private async searchContract(request: Request): Promise<Response> {
    const { symbol, secType } = await request.json<{
      symbol: string;
      secType?: string;
    }>();

    if (this.executionMode === 'PAPER') {
      return Response.json({
        mode: 'PAPER',
        contracts: [{
          conid: (() => {
            const seed = `${symbol}|${secType ?? 'STK'}`;
            let hash = 0;
            for (let i = 0; i < seed.length; i++) {
              hash = (hash << 5) - hash + seed.charCodeAt(i);
              hash |= 0;
            }
            return Math.abs(hash % 1000000) + 1000;
          })(),
          symbol,
          secType: secType ?? 'STK',
          exchange: 'SMART',
          currency: 'USD',
        }],
      });
    }

    try {
      const response = await this.ibkrFetch(
        `/iserver/secdef/search?symbol=${encodeURIComponent(symbol)}&secType=${secType ?? 'STK'}`
      );
      const contracts = await response.json();

      return Response.json({
        mode: 'LIVE',
        contracts,
      });
    } catch (error) {
      return Response.json({
        error: error instanceof Error ? error.message : String(error),
      }, { status: 500 });
    }
  }

  private async getContractDetails(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const conid = url.searchParams.get('conid');

    if (!conid) {
      return Response.json({ error: 'conid required' }, { status: 400 });
    }

    const cached = this.sql.exec<{
      conid: number;
      ticker: string;
      name: string;
      sec_type: string;
      exchange: string;
      currency: string;
    }>(`SELECT * FROM ibkr_contracts WHERE conid = ?`, parseInt(conid)).one();

    if (cached) {
      return Response.json({
        contract: cached,
        cached: true,
      });
    }

    if (this.executionMode === 'PAPER') {
      return Response.json({
        mode: 'PAPER',
        contract: {
          conid: parseInt(conid),
          symbol: `SYMBOL_${conid}`,
          secType: 'STK',
          exchange: 'SMART',
          currency: 'USD',
        },
      });
    }

    try {
      const response = await this.ibkrFetch(`/iserver/contract/${conid}/info`);
      const contract = await response.json() as {
        conid: number;
        symbol: string;
        companyName: string;
        secType: string;
        exchange: string;
        currency: string;
      };

      this.sql.exec(
        `INSERT OR REPLACE INTO ibkr_contracts
         (conid, ticker, name, sec_type, exchange, currency, cached_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        contract.conid,
        contract.symbol,
        contract.companyName,
        contract.secType,
        contract.exchange,
        contract.currency,
        new Date().toISOString()
      );

      return Response.json({
        mode: 'LIVE',
        contract,
      });
    } catch (error) {
      return Response.json({
        error: error instanceof Error ? error.message : String(error),
      }, { status: 500 });
    }
  }

  private async resolveContract(ticker: string): Promise<{ conid: number } | null> {
    const cached = this.sql.exec<{ conid: number }>(
      `SELECT conid FROM ibkr_contracts WHERE ticker = ?`,
      ticker
    ).one();

    if (cached) {
      return cached;
    }

    if (this.executionMode === 'PAPER') {
      // Generate deterministic conid from ticker hash for paper trading
      const hash = await sha256String(ticker);
      const hashNum = parseInt(hash.slice(0, 8), 16);
      return { conid: Math.abs(hashNum % 1000000) + 1000 };
    }

    try {
      const response = await this.ibkrFetch(
        `/iserver/secdef/search?symbol=${encodeURIComponent(ticker)}&secType=STK`
      );
      const contracts = await response.json() as Array<{ conid: number }>;

      const firstContract = contracts?.[0];
      if (firstContract) {
        return { conid: firstContract.conid };
      }

      return null;
    } catch {
      return null;
    }
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

    await this.logAudit('IBKR_MODE_CHANGED', { previousMode, newMode: mode });

    return Response.json({
      success: true,
      previousMode,
      newMode: mode,
    });
  }

  private async getStatus(): Promise<Response> {
    const orderCount = this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM ibkr_orders`
    ).one();

    const positionCount = this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM ibkr_positions WHERE position != 0`
    ).one();

    return Response.json({
      agentName: this.agentName,
      executionMode: this.executionMode,
      connected: this.isConnected,
      accountId: this.accountId,
      lastHeartbeat: this.lastHeartbeat,
      gatewayUrl: this.gatewayUrl,
      stats: {
        totalOrders: orderCount?.count ?? 0,
        activePositions: positionCount?.count ?? 0,
      },
    });
  }

  private async ibkrFetch(
    path: string,
    method: string = 'GET',
    body?: unknown
  ): Promise<Response> {
    const url = `${this.gatewayUrl}${path}`;
    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    return fetch(url, options);
  }

  private async storeIBKREvidence(endpoint: string, responseText: string): Promise<string> {
    const rawBytes = new TextEncoder().encode(responseText);

    const input: StoreEvidenceInput = {
      source: 'ibkr_api',
      endpoint: `${this.gatewayUrl}${endpoint}`,
      rawBytes: rawBytes.buffer as ArrayBuffer,
      fetchedAt: new Date().toISOString(),
      requestMethod: 'GET',
    };

    const result = await storeEvidence(this.env, input);
    if (!result.ok) {
      throw result.error;
    }
    return result.value.evidenceHash;
  }
}
