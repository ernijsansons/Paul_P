/**
 * Paul P - Execution Policy Engine (P-14)
 *
 * Controls execution behavior including:
 * - Paper trading vs live execution modes
 * - Order validation and transformation
 * - Rate limiting and throttling
 * - Timing windows (market hours, blackout periods)
 * - Position sizing limits per execution policy
 */

import type { KalshiOrderRequest, KalshiOrder, KalshiMarket } from '../kalshi/types';

// ============================================================
// EXECUTION MODE TYPES
// ============================================================

export type ExecutionMode = 'PAPER' | 'LIVE' | 'DISABLED';

export interface ExecutionPolicy {
  mode: ExecutionMode;
  maxOrdersPerMinute: number;
  maxOrdersPerHour: number;
  maxDailyVolume: number; // Maximum daily notional volume in cents
  maxSingleOrderSize: number; // Maximum contracts per order
  minOrderSpacingMs: number; // Minimum time between orders
  allowedMarketCategories: string[]; // Empty = all allowed
  blockedTickers: string[]; // Specific tickers to never trade
  tradingHours: TradingHours;
  paperTradeSlippage: number; // Simulated slippage for paper trading (cents)
  requireRiskApproval: boolean; // Must get RiskGovernor approval
}

export interface TradingHours {
  enabled: boolean;
  startHourUTC: number; // 0-23
  endHourUTC: number; // 0-23
  tradingDays: number[]; // 0=Sunday, 6=Saturday
  blackoutPeriods: BlackoutPeriod[];
}

export interface BlackoutPeriod {
  name: string;
  startTime: string; // ISO 8601
  endTime: string; // ISO 8601
  reason: string;
}

// ============================================================
// ORDER VALIDATION TYPES
// ============================================================

export interface OrderValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  adjustedOrder?: KalshiOrderRequest;
}

export interface ExecutionRequest {
  orderId: string;
  signal: {
    marketId: string;
    side: 'YES' | 'NO';
    modelProbability: number;
    marketPrice: number;
    edge: number;
    confidence: number;
  };
  requestedSize: number;
  maxPrice: number; // Maximum price willing to pay (cents)
  orderType: 'limit' | 'market';
  timeInForce?: 'day' | 'gtc' | 'ioc';
  source: string; // Strategy that generated this signal
  timestamp: string;
}

export interface ExecutionResult {
  success: boolean;
  orderId: string;
  mode: ExecutionMode;
  status: 'submitted' | 'rejected' | 'paper_filled' | 'queued';
  order?: KalshiOrder;
  paperFill?: PaperFill;
  rejectionReason?: string;
  executionTimeMs: number;
}

export interface PaperFill {
  orderId: string;
  ticker: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  count: number;
  fillPrice: number;
  slippage: number;
  timestamp: string;
}

// ============================================================
// RATE LIMITING
// ============================================================

export interface RateLimitState {
  ordersThisMinute: number;
  ordersThisHour: number;
  volumeToday: number;
  lastOrderTime: number;
  minuteWindowStart: number;
  hourWindowStart: number;
  dayWindowStart: number;
}

// ============================================================
// DEFAULT POLICIES
// ============================================================

export const PAPER_TRADING_POLICY: ExecutionPolicy = {
  mode: 'PAPER',
  maxOrdersPerMinute: 10,
  maxOrdersPerHour: 100,
  maxDailyVolume: 100000, // $1,000 notional
  maxSingleOrderSize: 100,
  minOrderSpacingMs: 1000,
  allowedMarketCategories: [],
  blockedTickers: [],
  tradingHours: {
    enabled: false,
    startHourUTC: 0,
    endHourUTC: 24,
    tradingDays: [0, 1, 2, 3, 4, 5, 6],
    blackoutPeriods: [],
  },
  paperTradeSlippage: 1, // 1 cent slippage
  requireRiskApproval: true,
};

export const LIVE_TRADING_POLICY: ExecutionPolicy = {
  mode: 'LIVE',
  maxOrdersPerMinute: 5,
  maxOrdersPerHour: 50,
  maxDailyVolume: 50000, // $500 notional
  maxSingleOrderSize: 50,
  minOrderSpacingMs: 5000,
  allowedMarketCategories: [], // Empty = all allowed
  blockedTickers: [],
  tradingHours: {
    enabled: true,
    startHourUTC: 13, // 9 AM ET
    endHourUTC: 21, // 5 PM ET
    tradingDays: [1, 2, 3, 4, 5], // Monday-Friday
    blackoutPeriods: [],
  },
  paperTradeSlippage: 0,
  requireRiskApproval: true,
};

export const DISABLED_POLICY: ExecutionPolicy = {
  mode: 'DISABLED',
  maxOrdersPerMinute: 0,
  maxOrdersPerHour: 0,
  maxDailyVolume: 0,
  maxSingleOrderSize: 0,
  minOrderSpacingMs: Infinity,
  allowedMarketCategories: [],
  blockedTickers: [],
  tradingHours: {
    enabled: true,
    startHourUTC: 0,
    endHourUTC: 0,
    tradingDays: [],
    blackoutPeriods: [],
  },
  paperTradeSlippage: 0,
  requireRiskApproval: true,
};

// ============================================================
// VALIDATION FUNCTIONS
// ============================================================

/**
 * Validate an execution request against the policy
 */
export function validateExecutionRequest(
  request: ExecutionRequest,
  market: KalshiMarket,
  policy: ExecutionPolicy,
  rateLimitState: RateLimitState
): OrderValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Check execution mode
  if (policy.mode === 'DISABLED') {
    errors.push('Execution is disabled');
    return { valid: false, errors, warnings };
  }

  // 2. Check market is active
  if (market.status !== 'active') {
    errors.push(`Market ${market.ticker} is not active (status: ${market.status})`);
  }

  // 3. Check blocked tickers
  if (policy.blockedTickers.includes(market.ticker)) {
    errors.push(`Ticker ${market.ticker} is blocked by policy`);
  }

  // 4. Check allowed categories
  if (
    policy.allowedMarketCategories.length > 0 &&
    !policy.allowedMarketCategories.includes(market.category)
  ) {
    errors.push(`Category ${market.category} not in allowed list`);
  }

  // 5. Check order size
  if (request.requestedSize > policy.maxSingleOrderSize) {
    errors.push(
      `Order size ${request.requestedSize} exceeds max ${policy.maxSingleOrderSize}`
    );
  }

  if (request.requestedSize <= 0) {
    errors.push('Order size must be positive');
  }

  // 6. Check rate limits
  const now = Date.now();
  if (rateLimitState.ordersThisMinute >= policy.maxOrdersPerMinute) {
    errors.push(
      `Rate limit: ${policy.maxOrdersPerMinute} orders per minute exceeded`
    );
  }

  if (rateLimitState.ordersThisHour >= policy.maxOrdersPerHour) {
    errors.push(
      `Rate limit: ${policy.maxOrdersPerHour} orders per hour exceeded`
    );
  }

  // 7. Check order spacing
  const timeSinceLastOrder = now - rateLimitState.lastOrderTime;
  if (timeSinceLastOrder < policy.minOrderSpacingMs) {
    errors.push(
      `Order spacing: ${policy.minOrderSpacingMs}ms required, only ${timeSinceLastOrder}ms elapsed`
    );
  }

  // 8. Check daily volume
  const orderNotional = request.requestedSize * request.maxPrice;
  if (rateLimitState.volumeToday + orderNotional > policy.maxDailyVolume) {
    errors.push(
      `Daily volume limit: would exceed ${policy.maxDailyVolume} cents`
    );
  }

  // 9. Check trading hours
  if (policy.tradingHours.enabled) {
    const tradingHoursResult = checkTradingHours(policy.tradingHours);
    if (!tradingHoursResult.allowed) {
      errors.push(`Outside trading hours: ${tradingHoursResult.reason}`);
    }
  }

  // 10. Check price reasonableness
  if (request.maxPrice < 1 || request.maxPrice > 99) {
    errors.push(`Price ${request.maxPrice} must be between 1-99 cents`);
  }

  // 11. Check market liquidity (warnings only)
  const spread = market.yes_ask - market.yes_bid;
  if (spread > 10) {
    warnings.push(`Wide spread: ${spread} cents`);
  }

  if (market.volume_24h < 100) {
    warnings.push(`Low volume: ${market.volume_24h} contracts in 24h`);
  }

  // 12. Check time to settlement
  const settlementTime = new Date(market.settlement_time).getTime();
  const hoursToSettlement = (settlementTime - now) / (1000 * 60 * 60);
  if (hoursToSettlement < 1) {
    warnings.push(`Market settles in ${hoursToSettlement.toFixed(1)} hours`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Check if current time is within trading hours
 */
export function checkTradingHours(hours: TradingHours): {
  allowed: boolean;
  reason: string;
} {
  const now = new Date();
  const currentHourUTC = now.getUTCHours();
  const currentDay = now.getUTCDay();

  // Check trading days
  if (!hours.tradingDays.includes(currentDay)) {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return {
      allowed: false,
      reason: `${dayNames[currentDay]} is not a trading day`,
    };
  }

  // Check trading hours
  if (currentHourUTC < hours.startHourUTC || currentHourUTC >= hours.endHourUTC) {
    return {
      allowed: false,
      reason: `Current hour ${currentHourUTC} UTC outside ${hours.startHourUTC}-${hours.endHourUTC}`,
    };
  }

  // Check blackout periods
  for (const blackout of hours.blackoutPeriods) {
    const start = new Date(blackout.startTime).getTime();
    const end = new Date(blackout.endTime).getTime();
    if (now.getTime() >= start && now.getTime() <= end) {
      return {
        allowed: false,
        reason: `Blackout period: ${blackout.name} - ${blackout.reason}`,
      };
    }
  }

  return { allowed: true, reason: '' };
}

/**
 * Transform execution request to Kalshi order format
 */
export function transformToKalshiOrder(
  request: ExecutionRequest,
  policy: ExecutionPolicy
): KalshiOrderRequest {
  const side = request.signal.side.toLowerCase() as 'yes' | 'no';

  return {
    ticker: request.signal.marketId,
    client_order_id: request.orderId,
    side,
    action: 'buy',
    count: Math.min(request.requestedSize, policy.maxSingleOrderSize),
    type: request.orderType,
    yes_price: side === 'yes' ? request.maxPrice : undefined,
    no_price: side === 'no' ? request.maxPrice : undefined,
  };
}

/**
 * Simulate a paper trade fill
 */
export function simulatePaperFill(
  request: ExecutionRequest,
  market: KalshiMarket,
  policy: ExecutionPolicy
): PaperFill {
  const side = request.signal.side.toLowerCase() as 'yes' | 'no';

  // Get the relevant ask price
  const askPrice = side === 'yes' ? market.yes_ask : market.no_ask;

  // Apply slippage (worse price for us)
  const slippage = policy.paperTradeSlippage;
  const fillPrice = Math.min(askPrice + slippage, 99);

  return {
    orderId: request.orderId,
    ticker: request.signal.marketId,
    side,
    action: 'buy',
    count: request.requestedSize,
    fillPrice,
    slippage,
    timestamp: new Date().toISOString(),
  };
}

// ============================================================
// RATE LIMIT MANAGEMENT
// ============================================================

/**
 * Create initial rate limit state
 */
export function createRateLimitState(): RateLimitState {
  const now = Date.now();
  return {
    ordersThisMinute: 0,
    ordersThisHour: 0,
    volumeToday: 0,
    lastOrderTime: 0,
    minuteWindowStart: now,
    hourWindowStart: now,
    dayWindowStart: getStartOfDayUTC(),
  };
}

/**
 * Update rate limit state after an order
 */
export function updateRateLimitState(
  state: RateLimitState,
  orderNotional: number
): RateLimitState {
  const now = Date.now();
  const newState = { ...state };

  // Reset minute window if needed
  if (now - state.minuteWindowStart >= 60000) {
    newState.ordersThisMinute = 0;
    newState.minuteWindowStart = now;
  }

  // Reset hour window if needed
  if (now - state.hourWindowStart >= 3600000) {
    newState.ordersThisHour = 0;
    newState.hourWindowStart = now;
  }

  // Reset day window if needed
  const startOfDay = getStartOfDayUTC();
  if (state.dayWindowStart < startOfDay) {
    newState.volumeToday = 0;
    newState.dayWindowStart = startOfDay;
  }

  // Increment counters
  newState.ordersThisMinute++;
  newState.ordersThisHour++;
  newState.volumeToday += orderNotional;
  newState.lastOrderTime = now;

  return newState;
}

/**
 * Get start of current UTC day in milliseconds
 */
function getStartOfDayUTC(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

// ============================================================
// POLICY SELECTION
// ============================================================

/**
 * Get execution policy based on mode
 */
export function getExecutionPolicy(mode: ExecutionMode): ExecutionPolicy {
  switch (mode) {
    case 'PAPER':
      return { ...PAPER_TRADING_POLICY };
    case 'LIVE':
      return { ...LIVE_TRADING_POLICY };
    case 'DISABLED':
    default:
      return { ...DISABLED_POLICY };
  }
}

/**
 * Merge custom policy settings with defaults
 */
export function customizePolicy(
  basePolicy: ExecutionPolicy,
  overrides: Partial<ExecutionPolicy>
): ExecutionPolicy {
  return {
    ...basePolicy,
    ...overrides,
    tradingHours: {
      ...basePolicy.tradingHours,
      ...(overrides.tradingHours ?? {}),
    },
  };
}

// ============================================================
// EXECUTION QUEUE
// ============================================================

export interface QueuedExecution {
  request: ExecutionRequest;
  priority: number;
  queuedAt: number;
  retryCount: number;
  maxRetries: number;
}

/**
 * Calculate execution priority based on edge and confidence
 */
export function calculateExecutionPriority(request: ExecutionRequest): number {
  // Higher edge and confidence = higher priority
  // Priority scale: 0-100
  const edgeScore = Math.min(request.signal.edge / 0.20, 1) * 50;
  const confidenceScore = request.signal.confidence * 50;
  return Math.round(edgeScore + confidenceScore);
}

/**
 * Sort execution queue by priority (descending)
 */
export function sortExecutionQueue(queue: QueuedExecution[]): QueuedExecution[] {
  return [...queue].sort((a, b) => {
    // Primary: priority (higher first)
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }
    // Secondary: queue time (earlier first)
    return a.queuedAt - b.queuedAt;
  });
}
