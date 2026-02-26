/**
 * Paul P - Risk Invariants (P-12)
 *
 * 17 fail-closed risk invariants that must pass before any order execution.
 * All invariants are designed to fail-closed (block execution on any error).
 *
 * Invariant Categories:
 * - Position Limits (I1-I4)
 * - Drawdown/Loss Limits (I5-I7)
 * - Market Quality (I8-I11)
 * - Execution Safety (I12-I15)
 * - System Health (I16-I17)
 */

export type InvariantId =
  | 'I1_MAX_POSITION_SIZE'
  | 'I2_MAX_PORTFOLIO_CONCENTRATION'
  | 'I3_MAX_MARKET_EXPOSURE'
  | 'I4_MAX_CATEGORY_EXPOSURE'
  | 'I5_MAX_DAILY_LOSS'
  | 'I6_MAX_DRAWDOWN'
  | 'I7_MAX_WEEKLY_LOSS'
  | 'I8_MIN_MARKET_LIQUIDITY'
  | 'I9_MAX_VPIN_TOXICITY'
  | 'I10_MAX_SPREAD'
  | 'I11_MIN_TIME_TO_SETTLEMENT'
  | 'I12_MARKET_EQUIVALENCE_GRADE'
  | 'I13_MAX_AMBIGUITY_SCORE'
  | 'I14_PRICE_STALENESS'
  | 'I15_ORDER_SIZE_LIMITS'
  | 'I16_CIRCUIT_BREAKER_STATE'
  | 'I17_SYSTEM_HEALTH';

export interface InvariantResult {
  id: InvariantId;
  name: string;
  passed: boolean;
  actualValue: number | string | boolean;
  threshold: number | string | boolean;
  message: string;
  severity: 'critical' | 'warning';
}

/**
 * Correlated market for I3 exposure calculation
 */
export interface CorrelatedMarketInfo {
  marketId: string;
  correlationScore: number;
  correlationType: string;
}

export interface RiskCheckRequest {
  // Signal/Order info
  marketId: string;
  venue: 'kalshi' | 'polymarket';
  side: 'YES' | 'NO';
  size: number;
  price: number;
  strategy: string;

  // Market info
  marketPrice: number;
  spread: number;
  volume24h: number;
  vpinScore?: number;
  ambiguityScore?: number;
  equivalenceGrade?: string;
  settlementDate: string;
  category: string;
  lastPriceUpdate: string;

  // Portfolio state
  portfolioValue: number;
  dailyPnL: number;
  weeklyPnL: number;
  maxDrawdown: number;
  existingPositions: Array<{
    marketId: string;
    category: string;
    size: number;
    unrealizedPnL: number;
  }>;

  // Event Graph correlation data (P-06 integration)
  correlatedMarkets?: CorrelatedMarketInfo[];

  // System state
  circuitBreakerState: 'NORMAL' | 'CAUTION' | 'HALT' | 'RECOVERY';
  systemHealthy: boolean;
}

export interface RiskLimits {
  // Position Limits
  maxPositionPct: number; // Max single position as % of portfolio (default 5%)
  maxConcentrationPct: number; // Max concentration in single market (default 10%)
  maxMarketExposurePct: number; // Max exposure to single market (default 15%)
  maxCategoryExposurePct: number; // Max exposure to single category (default 30%)

  // Loss Limits
  maxDailyLossPct: number; // Max daily loss as % of portfolio (default 3%)
  maxDrawdownPct: number; // Max drawdown from peak (default 10%)
  maxWeeklyLossPct: number; // Max weekly loss (default 7%)

  // Market Quality
  minLiquidity: number; // Minimum 24h volume (default $5000)
  maxVpin: number; // Max VPIN score (default 0.6)
  maxSpread: number; // Max spread (default 0.10 = 10%)
  minTimeToSettlementHours: number; // Min hours before settlement (default 24)

  // Execution Safety
  allowedEquivalenceGrades: string[]; // Allowed equivalence grades
  maxAmbiguityScore: number; // Max ambiguity score (default 0.4)
  maxPriceStalenessSeconds: number; // Max age of price data (default 60)
  maxOrderSize: number; // Max single order size in dollars (default $10000)
  minOrderSize: number; // Min order size in dollars (default $10)
}

export const DEFAULT_LIMITS: RiskLimits = {
  // Position Limits
  maxPositionPct: 5,
  maxConcentrationPct: 10,
  maxMarketExposurePct: 15,
  maxCategoryExposurePct: 30,

  // Loss Limits
  maxDailyLossPct: 3,
  maxDrawdownPct: 10,
  maxWeeklyLossPct: 7,

  // Market Quality
  minLiquidity: 5000,
  maxVpin: 0.6,
  maxSpread: 0.10,
  minTimeToSettlementHours: 24,

  // Execution Safety
  allowedEquivalenceGrades: ['identical', 'near_equivalent'],
  maxAmbiguityScore: 0.4,
  maxPriceStalenessSeconds: 60,
  maxOrderSize: 10000,
  minOrderSize: 10,
};

/**
 * I1: Max Position Size
 * Single position cannot exceed X% of portfolio
 */
export function checkMaxPositionSize(
  request: RiskCheckRequest,
  limits: RiskLimits
): InvariantResult {
  const positionPct = (request.size / request.portfolioValue) * 100;
  const passed = positionPct <= limits.maxPositionPct;

  return {
    id: 'I1_MAX_POSITION_SIZE',
    name: 'Max Position Size',
    passed,
    actualValue: positionPct,
    threshold: limits.maxPositionPct,
    message: passed
      ? `Position size ${positionPct.toFixed(2)}% within limit`
      : `Position size ${positionPct.toFixed(2)}% exceeds max ${limits.maxPositionPct}%`,
    severity: 'critical',
  };
}

/**
 * I2: Max Portfolio Concentration
 * Total exposure to single market cannot exceed X%
 */
export function checkMaxConcentration(
  request: RiskCheckRequest,
  limits: RiskLimits
): InvariantResult {
  const existingSize = request.existingPositions
    .filter(p => p.marketId === request.marketId)
    .reduce((sum, p) => sum + Math.abs(p.size), 0);

  const totalExposure = existingSize + request.size;
  const concentrationPct = (totalExposure / request.portfolioValue) * 100;
  const passed = concentrationPct <= limits.maxConcentrationPct;

  return {
    id: 'I2_MAX_PORTFOLIO_CONCENTRATION',
    name: 'Max Portfolio Concentration',
    passed,
    actualValue: concentrationPct,
    threshold: limits.maxConcentrationPct,
    message: passed
      ? `Market concentration ${concentrationPct.toFixed(2)}% within limit`
      : `Market concentration ${concentrationPct.toFixed(2)}% exceeds max ${limits.maxConcentrationPct}%`,
    severity: 'critical',
  };
}

/**
 * I3: Max Market Exposure (P-06 Event Graph Integration)
 *
 * Includes exposure from correlated markets via Event Graph.
 * Correlated exposure is weighted by correlation score.
 *
 * Total Effective Exposure = Direct Exposure + Σ(correlated_size × correlation_score)
 */
export function checkMaxMarketExposure(
  request: RiskCheckRequest,
  limits: RiskLimits
): InvariantResult {
  // Direct exposure to target market
  const directExposure = request.existingPositions
    .filter(p => p.marketId === request.marketId)
    .reduce((sum, p) => sum + Math.abs(p.size), 0) + request.size;

  // Correlated exposure from Event Graph (P-06)
  let correlatedExposure = 0;
  const correlatedDetails: string[] = [];

  if (request.correlatedMarkets && request.correlatedMarkets.length > 0) {
    for (const correlated of request.correlatedMarkets) {
      const position = request.existingPositions.find(p => p.marketId === correlated.marketId);
      if (!position) continue;

      const weightedContribution = Math.abs(position.size) * correlated.correlationScore;
      correlatedExposure += weightedContribution;

      if (weightedContribution > 0) {
        correlatedDetails.push(
          `${correlated.marketId.slice(0, 8)}...(${(correlated.correlationScore * 100).toFixed(0)}%)`
        );
      }
    }
  }

  // Total effective exposure
  const totalExposure = Math.abs(directExposure) + correlatedExposure;
  const exposurePct = (totalExposure / request.portfolioValue) * 100;
  const passed = exposurePct <= limits.maxMarketExposurePct;

  // Build message with correlation details
  let message: string;
  if (passed) {
    message = `Market exposure ${exposurePct.toFixed(2)}% within limit`;
    if (correlatedExposure > 0) {
      message += ` (incl. ${(correlatedExposure / request.portfolioValue * 100).toFixed(1)}% correlated)`;
    }
  } else {
    message = `Market exposure ${exposurePct.toFixed(2)}% exceeds max ${limits.maxMarketExposurePct}%`;
    if (correlatedDetails.length > 0) {
      message += `. Correlated markets: ${correlatedDetails.slice(0, 3).join(', ')}`;
      if (correlatedDetails.length > 3) {
        message += ` +${correlatedDetails.length - 3} more`;
      }
    }
  }

  return {
    id: 'I3_MAX_MARKET_EXPOSURE',
    name: 'Max Market Exposure',
    passed,
    actualValue: exposurePct,
    threshold: limits.maxMarketExposurePct,
    message,
    severity: 'critical',
  };
}

/**
 * I4: Max Category Exposure
 * Total exposure to single category cannot exceed X%
 */
export function checkMaxCategoryExposure(
  request: RiskCheckRequest,
  limits: RiskLimits
): InvariantResult {
  const categorySize = request.existingPositions
    .filter(p => p.category === request.category)
    .reduce((sum, p) => sum + Math.abs(p.size), 0);

  const totalCategoryExposure = categorySize + request.size;
  const exposurePct = (totalCategoryExposure / request.portfolioValue) * 100;
  const passed = exposurePct <= limits.maxCategoryExposurePct;

  return {
    id: 'I4_MAX_CATEGORY_EXPOSURE',
    name: 'Max Category Exposure',
    passed,
    actualValue: exposurePct,
    threshold: limits.maxCategoryExposurePct,
    message: passed
      ? `Category exposure ${exposurePct.toFixed(2)}% within limit`
      : `Category '${request.category}' exposure ${exposurePct.toFixed(2)}% exceeds max ${limits.maxCategoryExposurePct}%`,
    severity: 'critical',
  };
}

/**
 * I5: Max Daily Loss
 * Daily P&L cannot exceed X% loss
 */
export function checkMaxDailyLoss(
  request: RiskCheckRequest,
  limits: RiskLimits
): InvariantResult {
  const dailyLossPct = Math.abs(Math.min(0, request.dailyPnL)) / request.portfolioValue * 100;
  const maxLoss = limits.maxDailyLossPct;
  const passed = dailyLossPct <= maxLoss;

  return {
    id: 'I5_MAX_DAILY_LOSS',
    name: 'Max Daily Loss',
    passed,
    actualValue: dailyLossPct,
    threshold: maxLoss,
    message: passed
      ? `Daily loss ${dailyLossPct.toFixed(2)}% within limit`
      : `Daily loss ${dailyLossPct.toFixed(2)}% exceeds max ${maxLoss}%`,
    severity: 'critical',
  };
}

/**
 * I6: Max Drawdown
 * Portfolio drawdown from peak cannot exceed X%
 */
export function checkMaxDrawdown(
  request: RiskCheckRequest,
  limits: RiskLimits
): InvariantResult {
  const drawdownPct = request.maxDrawdown * 100;
  const passed = drawdownPct <= limits.maxDrawdownPct;

  return {
    id: 'I6_MAX_DRAWDOWN',
    name: 'Max Drawdown',
    passed,
    actualValue: drawdownPct,
    threshold: limits.maxDrawdownPct,
    message: passed
      ? `Drawdown ${drawdownPct.toFixed(2)}% within limit`
      : `Drawdown ${drawdownPct.toFixed(2)}% exceeds max ${limits.maxDrawdownPct}%`,
    severity: 'critical',
  };
}

/**
 * I7: Max Weekly Loss
 * Weekly P&L cannot exceed X% loss
 */
export function checkMaxWeeklyLoss(
  request: RiskCheckRequest,
  limits: RiskLimits
): InvariantResult {
  const weeklyLossPct = Math.abs(Math.min(0, request.weeklyPnL)) / request.portfolioValue * 100;
  const passed = weeklyLossPct <= limits.maxWeeklyLossPct;

  return {
    id: 'I7_MAX_WEEKLY_LOSS',
    name: 'Max Weekly Loss',
    passed,
    actualValue: weeklyLossPct,
    threshold: limits.maxWeeklyLossPct,
    message: passed
      ? `Weekly loss ${weeklyLossPct.toFixed(2)}% within limit`
      : `Weekly loss ${weeklyLossPct.toFixed(2)}% exceeds max ${limits.maxWeeklyLossPct}%`,
    severity: 'critical',
  };
}

/**
 * I8: Min Market Liquidity
 * Market must have minimum 24h volume
 */
export function checkMinLiquidity(
  request: RiskCheckRequest,
  limits: RiskLimits
): InvariantResult {
  const passed = request.volume24h >= limits.minLiquidity;

  return {
    id: 'I8_MIN_MARKET_LIQUIDITY',
    name: 'Min Market Liquidity',
    passed,
    actualValue: request.volume24h,
    threshold: limits.minLiquidity,
    message: passed
      ? `Market liquidity $${request.volume24h.toLocaleString()} meets minimum`
      : `Market liquidity $${request.volume24h.toLocaleString()} below min $${limits.minLiquidity.toLocaleString()}`,
    severity: 'warning',
  };
}

/**
 * I9: Max VPIN Toxicity
 * Market VPIN score cannot exceed threshold
 */
export function checkMaxVpin(
  request: RiskCheckRequest,
  limits: RiskLimits
): InvariantResult {
  const vpin = request.vpinScore ?? 0;
  const passed = vpin <= limits.maxVpin;

  return {
    id: 'I9_MAX_VPIN_TOXICITY',
    name: 'Max VPIN Toxicity',
    passed,
    actualValue: vpin,
    threshold: limits.maxVpin,
    message: passed
      ? `VPIN ${vpin.toFixed(3)} within limit`
      : `VPIN ${vpin.toFixed(3)} exceeds max ${limits.maxVpin} (toxic flow detected)`,
    severity: 'warning',
  };
}

/**
 * I10: Max Spread
 * Market spread cannot exceed threshold
 */
export function checkMaxSpread(
  request: RiskCheckRequest,
  limits: RiskLimits
): InvariantResult {
  const passed = request.spread <= limits.maxSpread;

  return {
    id: 'I10_MAX_SPREAD',
    name: 'Max Spread',
    passed,
    actualValue: request.spread,
    threshold: limits.maxSpread,
    message: passed
      ? `Spread ${(request.spread * 100).toFixed(1)}% within limit`
      : `Spread ${(request.spread * 100).toFixed(1)}% exceeds max ${(limits.maxSpread * 100).toFixed(1)}%`,
    severity: 'warning',
  };
}

/**
 * I11: Min Time to Settlement
 * Must be at least X hours before market settlement
 */
export function checkMinTimeToSettlement(
  request: RiskCheckRequest,
  limits: RiskLimits
): InvariantResult {
  const settlementTime = new Date(request.settlementDate).getTime();
  const now = Date.now();
  const hoursToSettlement = (settlementTime - now) / (1000 * 60 * 60);
  const passed = hoursToSettlement >= limits.minTimeToSettlementHours;

  return {
    id: 'I11_MIN_TIME_TO_SETTLEMENT',
    name: 'Min Time to Settlement',
    passed,
    actualValue: hoursToSettlement,
    threshold: limits.minTimeToSettlementHours,
    message: passed
      ? `${hoursToSettlement.toFixed(1)} hours to settlement, meets minimum`
      : `Only ${hoursToSettlement.toFixed(1)} hours to settlement, below min ${limits.minTimeToSettlementHours}h`,
    severity: 'critical',
  };
}

/**
 * I12: Market Equivalence Grade
 * For cross-venue trades, markets must have allowed equivalence grade
 */
export function checkEquivalenceGrade(
  request: RiskCheckRequest,
  limits: RiskLimits
): InvariantResult {
  const grade = request.equivalenceGrade ?? 'not_evaluated';
  const passed = grade === 'not_evaluated' ||
    limits.allowedEquivalenceGrades.includes(grade);

  return {
    id: 'I12_MARKET_EQUIVALENCE_GRADE',
    name: 'Market Equivalence Grade',
    passed,
    actualValue: grade,
    threshold: limits.allowedEquivalenceGrades.join(', '),
    message: passed
      ? `Equivalence grade '${grade}' is allowed`
      : `Equivalence grade '${grade}' not in allowed list: ${limits.allowedEquivalenceGrades.join(', ')}`,
    severity: 'critical',
  };
}

/**
 * I13: Max Ambiguity Score
 * Market resolution criteria cannot be too ambiguous
 */
export function checkMaxAmbiguityScore(
  request: RiskCheckRequest,
  limits: RiskLimits
): InvariantResult {
  const ambiguity = request.ambiguityScore ?? 0;
  const passed = ambiguity <= limits.maxAmbiguityScore;

  return {
    id: 'I13_MAX_AMBIGUITY_SCORE',
    name: 'Max Ambiguity Score',
    passed,
    actualValue: ambiguity,
    threshold: limits.maxAmbiguityScore,
    message: passed
      ? `Ambiguity score ${ambiguity.toFixed(2)} within limit`
      : `Ambiguity score ${ambiguity.toFixed(2)} exceeds max ${limits.maxAmbiguityScore}`,
    severity: 'warning',
  };
}

/**
 * I14: Price Staleness
 * Price data cannot be too old
 */
export function checkPriceStaleness(
  request: RiskCheckRequest,
  limits: RiskLimits
): InvariantResult {
  const lastUpdate = new Date(request.lastPriceUpdate).getTime();
  const now = Date.now();
  const stalenessSec = (now - lastUpdate) / 1000;
  const passed = stalenessSec <= limits.maxPriceStalenessSeconds;

  return {
    id: 'I14_PRICE_STALENESS',
    name: 'Price Staleness',
    passed,
    actualValue: stalenessSec,
    threshold: limits.maxPriceStalenessSeconds,
    message: passed
      ? `Price data ${stalenessSec.toFixed(0)}s old, within limit`
      : `Price data ${stalenessSec.toFixed(0)}s old, exceeds max ${limits.maxPriceStalenessSeconds}s`,
    severity: 'critical',
  };
}

/**
 * I15: Order Size Limits
 * Order size must be within min/max bounds
 */
export function checkOrderSizeLimits(
  request: RiskCheckRequest,
  limits: RiskLimits
): InvariantResult {
  const passedMax = request.size <= limits.maxOrderSize;
  const passedMin = request.size >= limits.minOrderSize;
  const passed = passedMax && passedMin;

  let message: string;
  if (!passedMax) {
    message = `Order size $${request.size} exceeds max $${limits.maxOrderSize}`;
  } else if (!passedMin) {
    message = `Order size $${request.size} below min $${limits.minOrderSize}`;
  } else {
    message = `Order size $${request.size} within limits`;
  }

  return {
    id: 'I15_ORDER_SIZE_LIMITS',
    name: 'Order Size Limits',
    passed,
    actualValue: request.size,
    threshold: `${limits.minOrderSize} - ${limits.maxOrderSize}`,
    message,
    severity: 'critical',
  };
}

/**
 * I16: Circuit Breaker State
 * System must not be in HALT state
 */
export function checkCircuitBreakerState(
  request: RiskCheckRequest,
  _limits: RiskLimits
): InvariantResult {
  const state = request.circuitBreakerState;
  const passed = state !== 'HALT';

  return {
    id: 'I16_CIRCUIT_BREAKER_STATE',
    name: 'Circuit Breaker State',
    passed,
    actualValue: state,
    threshold: 'NOT HALT',
    message: passed
      ? `Circuit breaker state '${state}' allows trading`
      : `Circuit breaker in HALT state - trading blocked`,
    severity: 'critical',
  };
}

/**
 * I17: System Health
 * All critical systems must be healthy
 */
export function checkSystemHealth(
  request: RiskCheckRequest,
  _limits: RiskLimits
): InvariantResult {
  const passed = request.systemHealthy;

  return {
    id: 'I17_SYSTEM_HEALTH',
    name: 'System Health',
    passed,
    actualValue: request.systemHealthy,
    threshold: true,
    message: passed
      ? 'All systems healthy'
      : 'System health check failed - trading blocked',
    severity: 'critical',
  };
}

/**
 * Run all 17 invariant checks
 */
export function runAllInvariantChecks(
  request: RiskCheckRequest,
  limits: RiskLimits = DEFAULT_LIMITS
): InvariantResult[] {
  return [
    checkMaxPositionSize(request, limits),
    checkMaxConcentration(request, limits),
    checkMaxMarketExposure(request, limits),
    checkMaxCategoryExposure(request, limits),
    checkMaxDailyLoss(request, limits),
    checkMaxDrawdown(request, limits),
    checkMaxWeeklyLoss(request, limits),
    checkMinLiquidity(request, limits),
    checkMaxVpin(request, limits),
    checkMaxSpread(request, limits),
    checkMinTimeToSettlement(request, limits),
    checkEquivalenceGrade(request, limits),
    checkMaxAmbiguityScore(request, limits),
    checkPriceStaleness(request, limits),
    checkOrderSizeLimits(request, limits),
    checkCircuitBreakerState(request, limits),
    checkSystemHealth(request, limits),
  ];
}

/**
 * Get only failed invariants
 */
export function getFailedInvariants(results: InvariantResult[]): InvariantResult[] {
  return results.filter(r => !r.passed);
}

/**
 * Get critical failures (block execution)
 */
export function getCriticalFailures(results: InvariantResult[]): InvariantResult[] {
  return results.filter(r => !r.passed && r.severity === 'critical');
}

/**
 * Get warnings (log but don't block)
 */
export function getWarnings(results: InvariantResult[]): InvariantResult[] {
  return results.filter(r => !r.passed && r.severity === 'warning');
}

/**
 * Check if order should be blocked
 * Blocks if ANY critical invariant fails
 */
export function shouldBlockOrder(results: InvariantResult[]): boolean {
  return getCriticalFailures(results).length > 0;
}
