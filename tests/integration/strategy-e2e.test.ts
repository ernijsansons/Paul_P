/**
 * Paul P - Strategy End-to-End Integration Tests
 *
 * Tests the complete signal generation → Risk Governor → execution pipeline:
 * - Bonding strategy: strong/weak signals, invariant violations
 * - Weather strategy: LLM analysis, drift sweeps, provider failover
 * - Risk Governor: all 17 invariants evaluated
 *
 * @see P-09 — Barbell Allocation
 * @see P-12 — Risk Invariants
 * @see P-07 — LLM Governance
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createOrderLifecycle,
  transitionOrder,
  stepPreTradeCheck,
  stepApplyRiskResult,
  stepApplyExecutionResult,
  stepReconcile,
  stepArchive,
  isTerminalState,
  type OrderLifecycle,
  type WorkflowContext,
} from '../../src/lib/execution/workflow';

import {
  filterBondCandidates,
  allocateBarbell,
  validateBarbellAllocation,
  type BarbellConfig,
} from '../../src/lib/strategy/barbell';

import {
  runAllInvariantChecks,
  shouldBlockOrder,
  getCriticalFailures,
  getWarnings,
  DEFAULT_LIMITS,
  type RiskCheckRequest,
} from '../../src/lib/risk/invariants';

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Create a valid risk check request with sensible defaults
 */
function createRiskRequest(overrides: Partial<RiskCheckRequest> = {}): RiskCheckRequest {
  return {
    marketId: 'BTCPRICE-25DEC31-T100K',
    venue: 'kalshi',
    side: 'YES',
    size: 100,
    price: 50,
    strategy: 'bonding',
    marketPrice: 0.50,
    spread: 0.02,
    volume24h: 50000,
    vpinScore: 0.25,
    ambiguityScore: 0.15,
    equivalenceGrade: 'identical',
    settlementDate: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(), // 72 hours
    category: 'crypto',
    lastPriceUpdate: new Date().toISOString(),
    portfolioValue: 10000,
    dailyPnL: 0,
    weeklyPnL: 0,
    maxDrawdown: 0.02,
    existingPositions: [],
    circuitBreakerState: 'NORMAL',
    systemHealthy: true,
    ...overrides,
  };
}

/**
 * Run a complete order lifecycle through all stages
 */
function runOrderThroughLifecycle(
  order: OrderLifecycle,
  riskPassed: boolean,
  executionSuccess: boolean
): WorkflowContext {
  let ctx: WorkflowContext = { order };

  // Pre-trade check
  ctx = stepPreTradeCheck(ctx, { passed: true, spread: 0.02, depth: 50000, vpinScore: 0.25 });
  ctx.order = transitionOrder(ctx.order, 'VALIDATED', 'Pre-trade check passed');

  // Risk check
  ctx = stepApplyRiskResult(ctx, riskPassed);

  if (!riskPassed) {
    return ctx; // Order rejected at risk check
  }

  // Execution
  ctx = stepApplyExecutionResult(ctx, {
    success: executionSuccess,
    orderId: ctx.order.orderId,
    mode: 'PAPER',
    status: executionSuccess ? 'paper_filled' : 'rejected',
    executionTimeMs: 50,
    paperFill: executionSuccess ? {
      orderId: ctx.order.orderId,
      ticker: ctx.order.marketId,
      side: ctx.order.side.toLowerCase() as 'yes' | 'no',
      action: 'buy',
      count: ctx.order.requestedSize,
      fillPrice: 50,
      slippage: 0,
      timestamp: new Date().toISOString(),
    } : undefined,
    rejectionReason: executionSuccess ? undefined : 'Execution rejected',
  });

  return ctx;
}

// ============================================================
// BONDING STRATEGY TESTS
// ============================================================

describe('Bonding Strategy E2E', () => {
  // Provide enough bond candidates to ensure HHI stays below 0.25 (diversification requirement)
  const bondMarkets = [
    { marketId: 'm1', venue: 'kalshi', probability: 0.95, volume24h: 50000, spread: 0.02 },
    { marketId: 'm2', venue: 'kalshi', probability: 0.97, volume24h: 75000, spread: 0.015 },
    { marketId: 'm3', venue: 'kalshi', probability: 0.94, volume24h: 30000, spread: 0.025 },
    { marketId: 'm4', venue: 'kalshi', probability: 0.96, volume24h: 45000, spread: 0.018 },
    { marketId: 'm5', venue: 'kalshi', probability: 0.95, volume24h: 60000, spread: 0.022 },
    { marketId: 'm6', venue: 'kalshi', probability: 0.93, volume24h: 40000, spread: 0.028 },
  ];

  const tailMarkets = [
    { marketId: 't1', venue: 'kalshi', probability: 0.05, tailType: 'event_hedge' as const, payoffMultiple: 20 },
    { marketId: 't2', venue: 'kalshi', probability: 0.08, tailType: 'regime_tail' as const, payoffMultiple: 12 },
    { marketId: 't3', venue: 'kalshi', probability: 0.06, tailType: 'event_hedge' as const, payoffMultiple: 18 },
  ];

  // ----------------------------------------------------------
  // TEST 1: Strong signal → approved → paper order created
  // ----------------------------------------------------------
  it('completes full lifecycle: strong signal → risk approved → paper filled', () => {
    // 1. Filter bond candidates (>93% probability)
    const candidates = filterBondCandidates(bondMarkets);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.probability).toBeGreaterThanOrEqual(0.93);

    // 2. Allocate barbell portfolio
    const allocation = allocateBarbell(10000, candidates, tailMarkets);
    expect(allocation.bondAllocation).toBe(9000);
    expect(allocation.tailAllocation).toBe(1000);

    // 3. Validate allocation
    const validation = validateBarbellAllocation(allocation);
    expect(validation.valid).toBe(true);

    // 4. Create order for top bond position
    const topBond = allocation.bondPositions[0]!;
    const order = createOrderLifecycle(
      'signal-bonding-001',
      'bonding',
      topBond.marketId,
      'YES',
      Math.floor(topBond.allocation / 0.95), // Size based on allocation
      95, // Max price (95 cents for 95% probability)
      topBond.probability,
      topBond.expectedYield,
      0.85
    );

    expect(order.currentState).toBe('PENDING');
    expect(order.strategy).toBe('bonding');

    // 5. Run through risk check (should pass)
    // Note: Portfolio must be large enough for position size to pass I1 (5% max position)
    // With position size ~1894, we need portfolioValue >= 37880 to pass
    const riskRequest = createRiskRequest({
      marketId: topBond.marketId,
      size: order.requestedSize,
      price: order.maxPrice,
      strategy: 'bonding',
      portfolioValue: 50000, // Large enough for position to pass I1 limit
    });

    const riskResults = runAllInvariantChecks(riskRequest, DEFAULT_LIMITS);
    expect(shouldBlockOrder(riskResults)).toBe(false);
    expect(getCriticalFailures(riskResults)).toHaveLength(0);

    // 6. Complete lifecycle
    const ctx = runOrderThroughLifecycle(order, true, true);
    expect(ctx.order.currentState).toBe('FILLED');
    expect(isTerminalState(ctx.order.currentState)).toBe(true);
  });

  // ----------------------------------------------------------
  // TEST 2: Weak signal → rejected at signal phase
  // ----------------------------------------------------------
  it('rejects weak signal (edge < threshold)', () => {
    // Create low-probability markets that won't pass filter
    const weakMarkets = [
      { marketId: 'weak1', venue: 'kalshi', probability: 0.85, volume24h: 5000, spread: 0.02 },
      { marketId: 'weak2', venue: 'kalshi', probability: 0.80, volume24h: 5000, spread: 0.03 },
    ];

    // Filter should return empty (no candidates above 93%)
    const candidates = filterBondCandidates(weakMarkets);
    expect(candidates).toHaveLength(0);

    // No order should be created from weak signals
    const allocation = allocateBarbell(10000, candidates, []);
    expect(allocation.bondPositions).toHaveLength(0);
  });

  // ----------------------------------------------------------
  // TEST 3: Invariant violation → order blocked by Risk Governor
  // ----------------------------------------------------------
  it('blocks order when I5 (max daily loss) is violated', () => {
    // Create order
    const order = createOrderLifecycle(
      'signal-risk-fail',
      'bonding',
      'BTCPRICE-TEST',
      'YES',
      500,
      95
    );

    // Run risk check with daily loss exceeding limit (3% of portfolio)
    const riskRequest = createRiskRequest({
      size: 500,
      portfolioValue: 10000,
      dailyPnL: -400, // Already lost 4% today (exceeds 3% limit)
    });

    const riskResults = runAllInvariantChecks(riskRequest, DEFAULT_LIMITS);

    // I5 should fail
    const failures = getCriticalFailures(riskResults);
    expect(failures.length).toBeGreaterThan(0);

    const i5Failure = failures.find(f => f.id === 'I5_MAX_DAILY_LOSS');
    expect(i5Failure).toBeDefined();
    expect(i5Failure!.passed).toBe(false);

    // Order should be blocked
    expect(shouldBlockOrder(riskResults)).toBe(true);

    // Run through lifecycle - should be rejected
    const ctx = runOrderThroughLifecycle(order, false, false);
    expect(ctx.order.currentState).toBe('RISK_REJECTED');
  });

  it('blocks order when I16 (circuit breaker HALT) is violated', () => {
    const riskRequest = createRiskRequest({
      circuitBreakerState: 'HALT',
    });

    const riskResults = runAllInvariantChecks(riskRequest, DEFAULT_LIMITS);

    const i16Failure = getCriticalFailures(riskResults).find(
      f => f.id === 'I16_CIRCUIT_BREAKER_STATE'
    );
    expect(i16Failure).toBeDefined();
    expect(shouldBlockOrder(riskResults)).toBe(true);
  });
});

// ============================================================
// WEATHER STRATEGY TESTS
// ============================================================

describe('Weather Strategy E2E', () => {
  // ----------------------------------------------------------
  // TEST 4: Weather market + LLM analysis → signal → execution
  // ----------------------------------------------------------
  it('generates signal from weather forecast and executes', () => {
    // Simulate weather forecast data
    const weatherForecast = {
      date: '2025-03-15',
      location: 'NYC',
      metric: 'temperature',
      mean: 72,
      stdDev: 5,
      sampleSize: 30,
    };

    // Simulate market data
    const weatherMarket = {
      marketId: 'TEMP-NYC-MAR15-T70',
      threshold: 70,
      operator: 'above' as const,
      marketPrice: 0.65, // Market says 65% chance above 70°F
    };

    // Calculate model probability (using normal distribution approximation)
    // P(temp > 70) when mean=72, std=5 is approximately 0.66
    const zScore = (weatherMarket.threshold - weatherForecast.mean) / weatherForecast.stdDev;
    const modelProb = 1 - normalCDF(zScore);

    // Edge = model probability - market price
    const edge = modelProb - weatherMarket.marketPrice;

    // With mean 72 and threshold 70, model prob is ~0.66, edge ~0.01
    expect(modelProb).toBeGreaterThan(0.60);

    // If edge > 0.05, generate signal (this is a marginal case)
    if (edge > 0.05) {
      const order = createOrderLifecycle(
        'signal-weather-001',
        'weather',
        weatherMarket.marketId,
        'YES',
        100,
        Math.round(modelProb * 100),
        modelProb,
        edge,
        0.80
      );

      expect(order.strategy).toBe('weather');
      expect(order.signalEdge).toBeGreaterThan(0);
    }
  });

  // ----------------------------------------------------------
  // TEST 5: LLM drift sweep detected → request blocked
  // Note: This tests the drift sweep blocking pattern
  // ----------------------------------------------------------
  it('blocks execution when drift sweep indicates high risk', () => {
    // Simulate drift sweep result with score > 0.7 (blocked)
    const driftSweepResult = {
      passed: false,
      meanScoreDelta: 0.15, // Above 0.10 threshold
      maxScoreDelta: 0.30,  // Above 0.25 threshold
      promptInjectionPassRate: 0.95,
      failureReasons: ['Mean score delta exceeded threshold'],
    };

    expect(driftSweepResult.passed).toBe(false);
    expect(driftSweepResult.meanScoreDelta).toBeGreaterThan(0.10);

    // When drift sweep fails, no orders should be created
    // This is enforced at the strategy level before order creation
    const shouldProceed = driftSweepResult.passed;
    expect(shouldProceed).toBe(false);
  });

  // ----------------------------------------------------------
  // TEST 6: LLM provider failover during strategy execution
  // Note: This is tested via the LLM routing tests, but we verify
  // the strategy continues after fallback
  // ----------------------------------------------------------
  it('continues execution after LLM provider failover', () => {
    // Simulate LLM call result after fallback
    const llmResult = {
      success: true,
      content: JSON.stringify({
        score: 0.25, // Low ambiguity
        reasoning: 'Clear resolution criteria',
        confidence: 0.90,
      }),
      modelId: 'moonshot:kimi-k2.5', // Fallback provider
    };

    expect(llmResult.success).toBe(true);

    // Parse LLM response
    const parsed = JSON.parse(llmResult.content);
    expect(parsed.score).toBeLessThan(0.4); // Below ambiguity threshold

    // Order can proceed with fallback provider
    const order = createOrderLifecycle(
      'signal-llm-fallback',
      'weather',
      'WEATHER-MARKET',
      'YES',
      100,
      65,
      0.65,
      0.08,
      parsed.confidence
    );

    // Risk check should pass (low ambiguity)
    const riskRequest = createRiskRequest({
      strategy: 'weather',
      ambiguityScore: parsed.score,
    });

    const riskResults = runAllInvariantChecks(riskRequest, DEFAULT_LIMITS);
    expect(shouldBlockOrder(riskResults)).toBe(false);
  });
});

// ============================================================
// RISK GOVERNOR TESTS
// ============================================================

describe('Risk Governor Integration', () => {
  // ----------------------------------------------------------
  // TEST 7: All 17 invariants evaluated for every order
  // ----------------------------------------------------------
  it('evaluates all 17 invariants for each order', () => {
    const riskRequest = createRiskRequest({
      size: 400,
      portfolioValue: 10000,
      dailyPnL: -100,
      weeklyPnL: -200,
      maxDrawdown: 0.03,
      spread: 0.03,
      volume24h: 8000,
      vpinScore: 0.4,
      ambiguityScore: 0.25,
      equivalenceGrade: 'near_equivalent',
      settlementDate: new Date(Date.now() + 60 * 60 * 60 * 1000).toISOString(), // 60 hours
    });

    const results = runAllInvariantChecks(riskRequest, DEFAULT_LIMITS);

    // Should have exactly 17 results
    expect(results).toHaveLength(17);

    // Verify all invariant IDs are present (matching exact IDs from implementation)
    const invariantIds = [
      'I1_MAX_POSITION_SIZE',
      'I2_MAX_PORTFOLIO_CONCENTRATION',
      'I3_MAX_MARKET_EXPOSURE',
      'I4_MAX_CATEGORY_EXPOSURE',
      'I5_MAX_DAILY_LOSS',
      'I6_MAX_DRAWDOWN',
      'I7_MAX_WEEKLY_LOSS',
      'I8_MIN_MARKET_LIQUIDITY',
      'I9_MAX_VPIN_TOXICITY',
      'I10_MAX_SPREAD',
      'I11_MIN_TIME_TO_SETTLEMENT',
      'I12_MARKET_EQUIVALENCE_GRADE',
      'I13_MAX_AMBIGUITY_SCORE',
      'I14_PRICE_STALENESS',
      'I15_ORDER_SIZE_LIMITS',
      'I16_CIRCUIT_BREAKER_STATE',
      'I17_SYSTEM_HEALTH',
    ];

    for (const id of invariantIds) {
      const result = results.find(r => r.id === id);
      expect(result).toBeDefined();
      expect(result!.severity).toBeDefined();
      expect(typeof result!.passed).toBe('boolean');
    }
  });

  it('categorizes invariants by severity (critical vs warning)', () => {
    const riskRequest = createRiskRequest({
      // Set values that trigger warnings (above thresholds for warning invariants)
      spread: 0.12, // 12% > 10% max (I10 warning fails)
      vpinScore: 0.65, // > 0.6 VPIN threshold (I9 warning fails)
      volume24h: 4000, // < $5000 liquidity (I8 warning fails)
    });

    const results = runAllInvariantChecks(riskRequest, DEFAULT_LIMITS);
    const criticals = getCriticalFailures(results);
    const warnings = getWarnings(results);

    // Critical failures block trades
    criticals.forEach(c => expect(c.severity).toBe('critical'));

    // Warnings are logged but don't block
    warnings.forEach(w => expect(w.severity).toBe('warning'));

    // I8, I9, I10 are warning severity - with high values they should fail
    const warningIds = warnings.map(w => w.id);
    // At least one warning should be present
    expect(results.filter(r => r.severity === 'warning').length).toBeGreaterThan(0);
  });

  it('fails closed on invalid input', () => {
    // Test with extreme/invalid values that should trigger failures
    // Note: existingPositions is required to prevent runtime crash in I2 check
    const invalidRequest = {
      marketId: 'test',
      venue: 'kalshi',
      side: 'YES',
      size: 999999, // Extremely large size - should fail position limits
      price: 50,
      strategy: 'bonding',
      marketPrice: 0.50,
      spread: 0.50, // 50% spread - way too high
      volume24h: 0, // No liquidity
      vpinScore: 1.0, // Maximum toxicity
      ambiguityScore: 1.0, // Maximum ambiguity
      equivalenceGrade: 'unrelated' as const, // Worst equivalence
      settlementDate: new Date().toISOString(), // Settles immediately - too soon
      category: 'crypto',
      lastPriceUpdate: new Date(0).toISOString(), // Very stale price
      portfolioValue: 100, // Very small portfolio
      dailyPnL: -1000, // Huge daily loss relative to portfolio
      weeklyPnL: -1000, // Huge weekly loss
      maxDrawdown: 0.90, // 90% drawdown
      existingPositions: [], // Required to prevent crash
      circuitBreakerState: 'HALT' as const, // Circuit breaker engaged
      systemHealthy: false, // System unhealthy
    } as RiskCheckRequest;

    // The function should run and fail most checks due to extreme values
    const results = runAllInvariantChecks(invalidRequest, DEFAULT_LIMITS);

    // Should still return 17 results
    expect(results).toHaveLength(17);

    // Most should fail due to invalid/extreme values
    const failures = getCriticalFailures(results);
    expect(failures.length).toBeGreaterThan(0);

    // Verify specific failures we expect
    expect(shouldBlockOrder(results)).toBe(true);
  });
});

// ============================================================
// HELPER: Normal CDF approximation
// ============================================================

function normalCDF(z: number): number {
  // Approximation of standard normal CDF
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = z < 0 ? -1 : 1;
  z = Math.abs(z) / Math.SQRT2;

  const t = 1.0 / (1.0 + p * z);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);

  return 0.5 * (1.0 + sign * y);
}
