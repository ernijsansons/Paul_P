/**
 * Execution Policy Engine Tests (P-14)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  validateExecutionRequest,
  checkTradingHours,
  transformToKalshiOrder,
  simulatePaperFill,
  createRateLimitState,
  updateRateLimitState,
  getExecutionPolicy,
  customizePolicy,
  calculateExecutionPriority,
  sortExecutionQueue,
  PAPER_TRADING_POLICY,
  LIVE_TRADING_POLICY,
  DISABLED_POLICY,
  type ExecutionRequest,
  type ExecutionPolicy,
  type RateLimitState,
  type TradingHours,
  type QueuedExecution,
} from '../../../src/lib/execution/policy';
import type { KalshiMarket } from '../../../src/lib/kalshi/types';

// Helper to create a valid execution request
const createRequest = (overrides: Partial<ExecutionRequest> = {}): ExecutionRequest => ({
  orderId: 'test-order-1',
  signal: {
    marketId: 'TEST-MARKET-123',
    side: 'YES',
    modelProbability: 0.65,
    marketPrice: 0.50,
    edge: 0.15,
    confidence: 0.8,
  },
  requestedSize: 10,
  maxPrice: 55,
  orderType: 'limit',
  timeInForce: 'day',
  source: 'test-strategy',
  timestamp: new Date().toISOString(),
  ...overrides,
});

// Helper to create a valid market
const createMarket = (overrides: Partial<KalshiMarket> = {}): KalshiMarket => ({
  ticker: 'TEST-MARKET-123',
  event_ticker: 'TEST-EVENT',
  market_type: 'binary',
  title: 'Test Market',
  subtitle: 'Test subtitle',
  status: 'active',
  result: '',
  yes_bid: 48,
  yes_ask: 52,
  no_bid: 48,
  no_ask: 52,
  last_price: 50,
  volume: 10000,
  volume_24h: 5000,
  open_interest: 1000,
  settlement_time: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
  expiration_time: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
  category: 'politics',
  ...overrides,
});

describe('Execution Policy Engine', () => {
  describe('Default Policies', () => {
    it('PAPER_TRADING_POLICY has correct defaults', () => {
      expect(PAPER_TRADING_POLICY.mode).toBe('PAPER');
      expect(PAPER_TRADING_POLICY.maxOrdersPerMinute).toBe(10);
      expect(PAPER_TRADING_POLICY.maxOrdersPerHour).toBe(100);
      expect(PAPER_TRADING_POLICY.maxDailyVolume).toBe(100000);
      expect(PAPER_TRADING_POLICY.maxSingleOrderSize).toBe(100);
      expect(PAPER_TRADING_POLICY.paperTradeSlippage).toBe(1);
      expect(PAPER_TRADING_POLICY.requireRiskApproval).toBe(true);
    });

    it('LIVE_TRADING_POLICY has stricter limits', () => {
      expect(LIVE_TRADING_POLICY.mode).toBe('LIVE');
      expect(LIVE_TRADING_POLICY.maxOrdersPerMinute).toBeLessThan(PAPER_TRADING_POLICY.maxOrdersPerMinute);
      expect(LIVE_TRADING_POLICY.maxDailyVolume).toBeLessThan(PAPER_TRADING_POLICY.maxDailyVolume);
      expect(LIVE_TRADING_POLICY.minOrderSpacingMs).toBeGreaterThan(PAPER_TRADING_POLICY.minOrderSpacingMs);
    });

    it('DISABLED_POLICY blocks all trading', () => {
      expect(DISABLED_POLICY.mode).toBe('DISABLED');
      expect(DISABLED_POLICY.maxOrdersPerMinute).toBe(0);
      expect(DISABLED_POLICY.maxOrdersPerHour).toBe(0);
      expect(DISABLED_POLICY.maxDailyVolume).toBe(0);
    });
  });

  describe('validateExecutionRequest', () => {
    let rateLimitState: RateLimitState;

    beforeEach(() => {
      rateLimitState = createRateLimitState();
    });

    it('validates a valid request', () => {
      const request = createRequest();
      const market = createMarket();
      const result = validateExecutionRequest(request, market, PAPER_TRADING_POLICY, rateLimitState);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects when execution disabled', () => {
      const request = createRequest();
      const market = createMarket();
      const result = validateExecutionRequest(request, market, DISABLED_POLICY, rateLimitState);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Execution is disabled');
    });

    it('rejects inactive market', () => {
      const request = createRequest();
      const market = createMarket({ status: 'closed' });
      const result = validateExecutionRequest(request, market, PAPER_TRADING_POLICY, rateLimitState);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('not active'))).toBe(true);
    });

    it('rejects blocked tickers', () => {
      const request = createRequest();
      const market = createMarket();
      const policy: ExecutionPolicy = {
        ...PAPER_TRADING_POLICY,
        blockedTickers: ['TEST-MARKET-123'],
      };
      const result = validateExecutionRequest(request, market, policy, rateLimitState);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('blocked'))).toBe(true);
    });

    it('rejects disallowed categories', () => {
      const request = createRequest();
      const market = createMarket({ category: 'sports' });
      const policy: ExecutionPolicy = {
        ...PAPER_TRADING_POLICY,
        allowedMarketCategories: ['politics', 'economics'],
      };
      const result = validateExecutionRequest(request, market, policy, rateLimitState);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Category'))).toBe(true);
    });

    it('rejects oversized orders', () => {
      const request = createRequest({ requestedSize: 200 }); // > 100 max
      const market = createMarket();
      const result = validateExecutionRequest(request, market, PAPER_TRADING_POLICY, rateLimitState);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Order size'))).toBe(true);
    });

    it('rejects zero or negative size', () => {
      const request = createRequest({ requestedSize: 0 });
      const market = createMarket();
      const result = validateExecutionRequest(request, market, PAPER_TRADING_POLICY, rateLimitState);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('must be positive'))).toBe(true);
    });

    it('rejects when rate limit exceeded', () => {
      const request = createRequest();
      const market = createMarket();
      const limitedState: RateLimitState = {
        ...rateLimitState,
        ordersThisMinute: 100, // Exceeded
      };
      const result = validateExecutionRequest(request, market, PAPER_TRADING_POLICY, limitedState);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Rate limit'))).toBe(true);
    });

    it('rejects when order spacing too short', () => {
      const request = createRequest();
      const market = createMarket();
      const recentState: RateLimitState = {
        ...rateLimitState,
        lastOrderTime: Date.now() - 100, // 100ms ago
      };
      const result = validateExecutionRequest(request, market, PAPER_TRADING_POLICY, recentState);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Order spacing'))).toBe(true);
    });

    it('rejects when daily volume exceeded', () => {
      const request = createRequest({ requestedSize: 50, maxPrice: 50 }); // 2500 notional
      const market = createMarket();
      const volumeState: RateLimitState = {
        ...rateLimitState,
        volumeToday: 99000, // Nearly at limit
      };
      const result = validateExecutionRequest(request, market, PAPER_TRADING_POLICY, volumeState);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Daily volume'))).toBe(true);
    });

    it('rejects invalid price', () => {
      const request = createRequest({ maxPrice: 0 });
      const market = createMarket();
      const result = validateExecutionRequest(request, market, PAPER_TRADING_POLICY, rateLimitState);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Price'))).toBe(true);
    });

    it('warns on wide spread', () => {
      const request = createRequest();
      const market = createMarket({ yes_bid: 40, yes_ask: 60 }); // 20 cent spread
      const result = validateExecutionRequest(request, market, PAPER_TRADING_POLICY, rateLimitState);

      expect(result.warnings.some(w => w.includes('spread'))).toBe(true);
    });

    it('warns on low volume', () => {
      const request = createRequest();
      const market = createMarket({ volume_24h: 50 }); // < 100
      const result = validateExecutionRequest(request, market, PAPER_TRADING_POLICY, rateLimitState);

      expect(result.warnings.some(w => w.includes('volume'))).toBe(true);
    });

    it('warns when near settlement', () => {
      const request = createRequest();
      const market = createMarket({
        settlement_time: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 min
      });
      const result = validateExecutionRequest(request, market, PAPER_TRADING_POLICY, rateLimitState);

      expect(result.warnings.some(w => w.includes('settles'))).toBe(true);
    });
  });

  describe('checkTradingHours', () => {
    it('allows trading when hours disabled', () => {
      const hours: TradingHours = {
        enabled: false,
        startHourUTC: 0,
        endHourUTC: 24,
        tradingDays: [0, 1, 2, 3, 4, 5, 6],
        blackoutPeriods: [],
      };
      const result = checkTradingHours(hours);
      expect(result.allowed).toBe(true);
    });

    it('blocks trading on non-trading days', () => {
      const now = new Date();
      const currentDay = now.getUTCDay();
      const hours: TradingHours = {
        enabled: true,
        startHourUTC: 0,
        endHourUTC: 24,
        tradingDays: [(currentDay + 1) % 7], // Not today
        blackoutPeriods: [],
      };
      const result = checkTradingHours(hours);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not a trading day');
    });

    it('blocks trading during blackout periods', () => {
      const now = Date.now();
      const hours: TradingHours = {
        enabled: true,
        startHourUTC: 0,
        endHourUTC: 24,
        tradingDays: [0, 1, 2, 3, 4, 5, 6],
        blackoutPeriods: [
          {
            name: 'Test Blackout',
            startTime: new Date(now - 60000).toISOString(),
            endTime: new Date(now + 60000).toISOString(),
            reason: 'Testing',
          },
        ],
      };
      const result = checkTradingHours(hours);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Blackout');
    });
  });

  describe('transformToKalshiOrder', () => {
    it('transforms YES order correctly', () => {
      const request = createRequest({
        signal: { ...createRequest().signal, side: 'YES' },
        maxPrice: 55,
      });
      const order = transformToKalshiOrder(request, PAPER_TRADING_POLICY);

      expect(order.ticker).toBe('TEST-MARKET-123');
      expect(order.client_order_id).toBe('test-order-1');
      expect(order.side).toBe('yes');
      expect(order.action).toBe('buy');
      expect(order.yes_price).toBe(55);
      expect(order.no_price).toBeUndefined();
    });

    it('transforms NO order correctly', () => {
      const request = createRequest({
        signal: { ...createRequest().signal, side: 'NO' },
        maxPrice: 45,
      });
      const order = transformToKalshiOrder(request, PAPER_TRADING_POLICY);

      expect(order.side).toBe('no');
      expect(order.no_price).toBe(45);
      expect(order.yes_price).toBeUndefined();
    });

    it('caps order size at policy max', () => {
      const request = createRequest({ requestedSize: 200 });
      const order = transformToKalshiOrder(request, PAPER_TRADING_POLICY);

      expect(order.count).toBe(100); // Policy max
    });
  });

  describe('simulatePaperFill', () => {
    it('simulates fill with slippage', () => {
      const request = createRequest({
        signal: { ...createRequest().signal, side: 'YES' },
        requestedSize: 10,
      });
      const market = createMarket({ yes_ask: 52 });
      const fill = simulatePaperFill(request, market, PAPER_TRADING_POLICY);

      expect(fill.orderId).toBe('test-order-1');
      expect(fill.ticker).toBe('TEST-MARKET-123');
      expect(fill.side).toBe('yes');
      expect(fill.action).toBe('buy');
      expect(fill.count).toBe(10);
      expect(fill.fillPrice).toBe(53); // 52 + 1 slippage
      expect(fill.slippage).toBe(1);
    });

    it('caps fill price at 99', () => {
      const request = createRequest({
        signal: { ...createRequest().signal, side: 'YES' },
      });
      const market = createMarket({ yes_ask: 99 });
      const policy: ExecutionPolicy = { ...PAPER_TRADING_POLICY, paperTradeSlippage: 5 };
      const fill = simulatePaperFill(request, market, policy);

      expect(fill.fillPrice).toBe(99);
    });

    it('handles NO side correctly', () => {
      const request = createRequest({
        signal: { ...createRequest().signal, side: 'NO' },
      });
      const market = createMarket({ no_ask: 48 });
      const fill = simulatePaperFill(request, market, PAPER_TRADING_POLICY);

      expect(fill.side).toBe('no');
      expect(fill.fillPrice).toBe(49); // 48 + 1 slippage
    });
  });

  describe('Rate Limit Management', () => {
    describe('createRateLimitState', () => {
      it('creates initial state with zeroed counters', () => {
        const state = createRateLimitState();
        expect(state.ordersThisMinute).toBe(0);
        expect(state.ordersThisHour).toBe(0);
        expect(state.volumeToday).toBe(0);
        expect(state.lastOrderTime).toBe(0);
      });
    });

    describe('updateRateLimitState', () => {
      it('increments counters', () => {
        const state = createRateLimitState();
        const updated = updateRateLimitState(state, 1000);

        expect(updated.ordersThisMinute).toBe(1);
        expect(updated.ordersThisHour).toBe(1);
        expect(updated.volumeToday).toBe(1000);
        expect(updated.lastOrderTime).toBeGreaterThan(0);
      });

      it('resets minute window after 60s', () => {
        const oldState: RateLimitState = {
          ordersThisMinute: 5,
          ordersThisHour: 10,
          volumeToday: 5000,
          lastOrderTime: Date.now() - 120000, // 2 min ago
          minuteWindowStart: Date.now() - 120000,
          hourWindowStart: Date.now() - 1800000, // 30 min ago
          dayWindowStart: Date.now() - 3600000,
        };
        const updated = updateRateLimitState(oldState, 1000);

        expect(updated.ordersThisMinute).toBe(1); // Reset then incremented
      });
    });
  });

  describe('Policy Selection', () => {
    it('getExecutionPolicy returns correct policy', () => {
      expect(getExecutionPolicy('PAPER').mode).toBe('PAPER');
      expect(getExecutionPolicy('LIVE').mode).toBe('LIVE');
      expect(getExecutionPolicy('DISABLED').mode).toBe('DISABLED');
    });

    it('customizePolicy merges overrides', () => {
      const custom = customizePolicy(PAPER_TRADING_POLICY, {
        maxOrdersPerMinute: 5,
        maxSingleOrderSize: 50,
      });

      expect(custom.maxOrdersPerMinute).toBe(5);
      expect(custom.maxSingleOrderSize).toBe(50);
      expect(custom.maxOrdersPerHour).toBe(PAPER_TRADING_POLICY.maxOrdersPerHour); // Unchanged
    });

    it('customizePolicy merges trading hours', () => {
      const custom = customizePolicy(PAPER_TRADING_POLICY, {
        tradingHours: { enabled: true },
      });

      expect(custom.tradingHours.enabled).toBe(true);
      expect(custom.tradingHours.tradingDays).toEqual(PAPER_TRADING_POLICY.tradingHours.tradingDays);
    });
  });

  describe('Execution Queue', () => {
    describe('calculateExecutionPriority', () => {
      it('calculates priority based on edge and confidence', () => {
        const highEdge = createRequest({
          signal: { ...createRequest().signal, edge: 0.20, confidence: 0.8 },
        });
        const lowEdge = createRequest({
          signal: { ...createRequest().signal, edge: 0.05, confidence: 0.5 },
        });

        const highPriority = calculateExecutionPriority(highEdge);
        const lowPriority = calculateExecutionPriority(lowEdge);

        expect(highPriority).toBeGreaterThan(lowPriority);
      });

      it('caps priority at 100', () => {
        const extreme = createRequest({
          signal: { ...createRequest().signal, edge: 0.50, confidence: 1.0 },
        });
        const priority = calculateExecutionPriority(extreme);

        expect(priority).toBeLessThanOrEqual(100);
      });
    });

    describe('sortExecutionQueue', () => {
      it('sorts by priority descending', () => {
        const queue: QueuedExecution[] = [
          { request: createRequest(), priority: 30, queuedAt: 1000, retryCount: 0, maxRetries: 3 },
          { request: createRequest(), priority: 70, queuedAt: 2000, retryCount: 0, maxRetries: 3 },
          { request: createRequest(), priority: 50, queuedAt: 3000, retryCount: 0, maxRetries: 3 },
        ];

        const sorted = sortExecutionQueue(queue);

        expect(sorted[0]!.priority).toBe(70);
        expect(sorted[1]!.priority).toBe(50);
        expect(sorted[2]!.priority).toBe(30);
      });

      it('sorts by queue time for equal priority', () => {
        const queue: QueuedExecution[] = [
          { request: createRequest(), priority: 50, queuedAt: 3000, retryCount: 0, maxRetries: 3 },
          { request: createRequest(), priority: 50, queuedAt: 1000, retryCount: 0, maxRetries: 3 },
          { request: createRequest(), priority: 50, queuedAt: 2000, retryCount: 0, maxRetries: 3 },
        ];

        const sorted = sortExecutionQueue(queue);

        expect(sorted[0]!.queuedAt).toBe(1000);
        expect(sorted[1]!.queuedAt).toBe(2000);
        expect(sorted[2]!.queuedAt).toBe(3000);
      });

      it('does not mutate original array', () => {
        const queue: QueuedExecution[] = [
          { request: createRequest(), priority: 30, queuedAt: 1000, retryCount: 0, maxRetries: 3 },
          { request: createRequest(), priority: 70, queuedAt: 2000, retryCount: 0, maxRetries: 3 },
        ];

        const sorted = sortExecutionQueue(queue);

        expect(queue[0]!.priority).toBe(30); // Original unchanged
        expect(sorted[0]!.priority).toBe(70);
      });
    });
  });
});
