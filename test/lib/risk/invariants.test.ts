/**
 * Risk Invariants Tests (P-12)
 *
 * Tests for all 17 fail-closed risk invariants.
 */
import { describe, it, expect } from 'vitest';
import {
  checkMaxPositionSize,
  checkMaxConcentration,
  checkMaxMarketExposure,
  checkMaxCategoryExposure,
  checkMaxDailyLoss,
  checkMaxDrawdown,
  checkMaxWeeklyLoss,
  checkMinLiquidity,
  checkMaxVpin,
  checkMaxSpread,
  checkMinTimeToSettlement,
  checkEquivalenceGrade,
  checkMaxAmbiguityScore,
  checkPriceStaleness,
  checkOrderSizeLimits,
  checkCircuitBreakerState,
  checkSystemHealth,
  runAllInvariantChecks,
  getFailedInvariants,
  getCriticalFailures,
  getWarnings,
  shouldBlockOrder,
  DEFAULT_LIMITS,
  type RiskCheckRequest,
  type RiskLimits,
} from '../../../src/lib/risk/invariants';

// Helper to create a valid base request
const createBaseRequest = (overrides: Partial<RiskCheckRequest> = {}): RiskCheckRequest => ({
  marketId: 'test-market',
  venue: 'kalshi',
  side: 'YES',
  size: 100,
  price: 50,
  strategy: 'test-strategy',
  marketPrice: 0.50,
  spread: 0.02,
  volume24h: 10000,
  vpinScore: 0.3,
  ambiguityScore: 0.2,
  equivalenceGrade: 'identical',
  settlementDate: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(), // 48 hours from now
  category: 'politics',
  lastPriceUpdate: new Date().toISOString(),
  portfolioValue: 10000,
  dailyPnL: 0,
  weeklyPnL: 0,
  maxDrawdown: 0.02,
  existingPositions: [],
  circuitBreakerState: 'NORMAL',
  systemHealthy: true,
  ...overrides,
});

describe('Risk Invariants (17 Checks)', () => {
  describe('I1: Max Position Size', () => {
    it('passes when position within limit', () => {
      const request = createBaseRequest({ size: 400, portfolioValue: 10000 }); // 4%
      const result = checkMaxPositionSize(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(true);
      expect(result.id).toBe('I1_MAX_POSITION_SIZE');
      expect(result.severity).toBe('critical');
    });

    it('fails when position exceeds limit', () => {
      const request = createBaseRequest({ size: 600, portfolioValue: 10000 }); // 6%
      const result = checkMaxPositionSize(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(false);
      expect(result.message).toContain('exceeds');
    });

    it('passes at exact limit', () => {
      const request = createBaseRequest({ size: 500, portfolioValue: 10000 }); // 5%
      const result = checkMaxPositionSize(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(true);
    });
  });

  describe('I2: Max Portfolio Concentration', () => {
    it('passes with no existing positions', () => {
      const request = createBaseRequest({ size: 800 }); // 8% < 10%
      const result = checkMaxConcentration(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(true);
    });

    it('fails when combined exposure exceeds limit', () => {
      const request = createBaseRequest({
        size: 600,
        existingPositions: [
          { marketId: 'test-market', category: 'politics', size: 600, unrealizedPnL: 0 },
        ],
      }); // 6% + 6% = 12%
      const result = checkMaxConcentration(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(false);
    });

    it('ignores positions in other markets', () => {
      const request = createBaseRequest({
        size: 800,
        existingPositions: [
          { marketId: 'other-market', category: 'politics', size: 500, unrealizedPnL: 0 },
        ],
      });
      const result = checkMaxConcentration(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(true);
    });
  });

  describe('I3: Max Market Exposure', () => {
    it('passes within exposure limit', () => {
      const request = createBaseRequest({ size: 1000 }); // 10% < 15%
      const result = checkMaxMarketExposure(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(true);
    });

    it('fails when exposure exceeds limit', () => {
      const request = createBaseRequest({
        size: 1000,
        existingPositions: [
          { marketId: 'test-market', category: 'politics', size: 600, unrealizedPnL: 0 },
        ],
      }); // 10% + 6% = 16%
      const result = checkMaxMarketExposure(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(false);
    });
  });

  describe('I4: Max Category Exposure', () => {
    it('passes within category limit', () => {
      const request = createBaseRequest({ size: 2000, category: 'politics' }); // 20% < 30%
      const result = checkMaxCategoryExposure(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(true);
    });

    it('fails when category exposure exceeds limit', () => {
      const request = createBaseRequest({
        size: 1500,
        category: 'politics',
        existingPositions: [
          { marketId: 'other-market', category: 'politics', size: 2000, unrealizedPnL: 0 },
        ],
      }); // 15% + 20% = 35%
      const result = checkMaxCategoryExposure(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(false);
      expect(result.message).toContain('politics');
    });

    it('ignores positions in other categories', () => {
      const request = createBaseRequest({
        size: 2000,
        category: 'politics',
        existingPositions: [
          { marketId: 'other-market', category: 'sports', size: 2000, unrealizedPnL: 0 },
        ],
      });
      const result = checkMaxCategoryExposure(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(true);
    });
  });

  describe('I5: Max Daily Loss', () => {
    it('passes with no daily loss', () => {
      const request = createBaseRequest({ dailyPnL: 100 }); // Profit
      const result = checkMaxDailyLoss(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(true);
    });

    it('passes with loss within limit', () => {
      const request = createBaseRequest({ dailyPnL: -200 }); // 2% loss < 3%
      const result = checkMaxDailyLoss(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(true);
    });

    it('fails when daily loss exceeds limit', () => {
      const request = createBaseRequest({ dailyPnL: -400 }); // 4% loss > 3%
      const result = checkMaxDailyLoss(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(false);
    });
  });

  describe('I6: Max Drawdown', () => {
    it('passes with small drawdown', () => {
      const request = createBaseRequest({ maxDrawdown: 0.05 }); // 5% < 10%
      const result = checkMaxDrawdown(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(true);
    });

    it('fails when drawdown exceeds limit', () => {
      const request = createBaseRequest({ maxDrawdown: 0.12 }); // 12% > 10%
      const result = checkMaxDrawdown(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(false);
    });
  });

  describe('I7: Max Weekly Loss', () => {
    it('passes with weekly loss within limit', () => {
      const request = createBaseRequest({ weeklyPnL: -500 }); // 5% < 7%
      const result = checkMaxWeeklyLoss(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(true);
    });

    it('fails when weekly loss exceeds limit', () => {
      const request = createBaseRequest({ weeklyPnL: -800 }); // 8% > 7%
      const result = checkMaxWeeklyLoss(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(false);
    });
  });

  describe('I8: Min Market Liquidity', () => {
    it('passes with sufficient liquidity', () => {
      const request = createBaseRequest({ volume24h: 10000 }); // > $5000
      const result = checkMinLiquidity(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(true);
      expect(result.severity).toBe('warning');
    });

    it('fails with low liquidity', () => {
      const request = createBaseRequest({ volume24h: 3000 }); // < $5000
      const result = checkMinLiquidity(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(false);
    });
  });

  describe('I9: Max VPIN Toxicity', () => {
    it('passes with low VPIN', () => {
      const request = createBaseRequest({ vpinScore: 0.4 }); // < 0.6
      const result = checkMaxVpin(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(true);
    });

    it('fails with high VPIN', () => {
      const request = createBaseRequest({ vpinScore: 0.7 }); // > 0.6
      const result = checkMaxVpin(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(false);
      expect(result.message).toContain('toxic');
    });

    it('handles undefined VPIN as 0', () => {
      const request = createBaseRequest({ vpinScore: undefined });
      const result = checkMaxVpin(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(true);
    });
  });

  describe('I10: Max Spread', () => {
    it('passes with tight spread', () => {
      const request = createBaseRequest({ spread: 0.05 }); // 5% < 10%
      const result = checkMaxSpread(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(true);
    });

    it('fails with wide spread', () => {
      const request = createBaseRequest({ spread: 0.15 }); // 15% > 10%
      const result = checkMaxSpread(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(false);
    });
  });

  describe('I11: Min Time to Settlement', () => {
    it('passes with sufficient time', () => {
      const settlementDate = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(); // 48h
      const request = createBaseRequest({ settlementDate });
      const result = checkMinTimeToSettlement(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(true);
      expect(result.severity).toBe('critical');
    });

    it('fails when settlement too soon', () => {
      const settlementDate = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(); // 12h
      const request = createBaseRequest({ settlementDate });
      const result = checkMinTimeToSettlement(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(false);
    });
  });

  describe('I12: Market Equivalence Grade', () => {
    it('passes with identical grade', () => {
      const request = createBaseRequest({ equivalenceGrade: 'identical' });
      const result = checkEquivalenceGrade(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(true);
    });

    it('passes with near_equivalent grade', () => {
      const request = createBaseRequest({ equivalenceGrade: 'near_equivalent' });
      const result = checkEquivalenceGrade(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(true);
    });

    it('passes with not_evaluated', () => {
      const request = createBaseRequest({ equivalenceGrade: undefined });
      const result = checkEquivalenceGrade(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(true);
    });

    it('fails with different grade', () => {
      const request = createBaseRequest({ equivalenceGrade: 'different' });
      const result = checkEquivalenceGrade(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(false);
    });
  });

  describe('I13: Max Ambiguity Score', () => {
    it('passes with low ambiguity', () => {
      const request = createBaseRequest({ ambiguityScore: 0.2 }); // < 0.4
      const result = checkMaxAmbiguityScore(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(true);
    });

    it('fails with high ambiguity', () => {
      const request = createBaseRequest({ ambiguityScore: 0.5 }); // > 0.4
      const result = checkMaxAmbiguityScore(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(false);
    });
  });

  describe('I14: Price Staleness', () => {
    it('passes with fresh price data', () => {
      const request = createBaseRequest({ lastPriceUpdate: new Date().toISOString() });
      const result = checkPriceStaleness(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(true);
    });

    it('fails with stale price data', () => {
      const staleTime = new Date(Date.now() - 120 * 1000).toISOString(); // 2 minutes ago
      const request = createBaseRequest({ lastPriceUpdate: staleTime });
      const result = checkPriceStaleness(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(false);
    });
  });

  describe('I15: Order Size Limits', () => {
    it('passes within size limits', () => {
      const request = createBaseRequest({ size: 500 }); // $500 within $10-$10000
      const result = checkOrderSizeLimits(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(true);
    });

    it('fails when order too large', () => {
      const request = createBaseRequest({ size: 15000 }); // > $10000
      const result = checkOrderSizeLimits(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(false);
      expect(result.message).toContain('exceeds max');
    });

    it('fails when order too small', () => {
      const request = createBaseRequest({ size: 5 }); // < $10
      const result = checkOrderSizeLimits(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(false);
      expect(result.message).toContain('below min');
    });
  });

  describe('I16: Circuit Breaker State', () => {
    it('passes in NORMAL state', () => {
      const request = createBaseRequest({ circuitBreakerState: 'NORMAL' });
      const result = checkCircuitBreakerState(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(true);
    });

    it('passes in CAUTION state', () => {
      const request = createBaseRequest({ circuitBreakerState: 'CAUTION' });
      const result = checkCircuitBreakerState(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(true);
    });

    it('passes in RECOVERY state', () => {
      const request = createBaseRequest({ circuitBreakerState: 'RECOVERY' });
      const result = checkCircuitBreakerState(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(true);
    });

    it('fails in HALT state', () => {
      const request = createBaseRequest({ circuitBreakerState: 'HALT' });
      const result = checkCircuitBreakerState(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(false);
      expect(result.message).toContain('HALT');
    });
  });

  describe('I17: System Health', () => {
    it('passes when system healthy', () => {
      const request = createBaseRequest({ systemHealthy: true });
      const result = checkSystemHealth(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(true);
    });

    it('fails when system unhealthy', () => {
      const request = createBaseRequest({ systemHealthy: false });
      const result = checkSystemHealth(request, DEFAULT_LIMITS);
      expect(result.passed).toBe(false);
      expect(result.message).toContain('health check failed');
    });
  });

  describe('runAllInvariantChecks', () => {
    it('runs all 17 invariants', () => {
      const request = createBaseRequest();
      const results = runAllInvariantChecks(request);
      expect(results.length).toBe(17);
    });

    it('all pass for valid request', () => {
      const request = createBaseRequest();
      const results = runAllInvariantChecks(request);
      const failures = results.filter(r => !r.passed);
      expect(failures.length).toBe(0);
    });

    it('uses custom limits when provided', () => {
      const request = createBaseRequest({ size: 800 }); // 8%
      const customLimits: RiskLimits = { ...DEFAULT_LIMITS, maxPositionPct: 3 };
      const results = runAllInvariantChecks(request, customLimits);
      const positionCheck = results.find(r => r.id === 'I1_MAX_POSITION_SIZE');
      expect(positionCheck?.passed).toBe(false);
    });
  });

  describe('getFailedInvariants', () => {
    it('returns only failed invariants', () => {
      const request = createBaseRequest({
        size: 600, // Exceeds 5%
        volume24h: 3000, // Below $5000
      });
      const results = runAllInvariantChecks(request);
      const failures = getFailedInvariants(results);

      expect(failures.every(r => !r.passed)).toBe(true);
      expect(failures.some(r => r.id === 'I1_MAX_POSITION_SIZE')).toBe(true);
      expect(failures.some(r => r.id === 'I8_MIN_MARKET_LIQUIDITY')).toBe(true);
    });
  });

  describe('getCriticalFailures', () => {
    it('returns only critical failures', () => {
      const request = createBaseRequest({
        size: 600, // Exceeds 5% - critical
        volume24h: 3000, // Below $5000 - warning
      });
      const results = runAllInvariantChecks(request);
      const critical = getCriticalFailures(results);

      expect(critical.every(r => r.severity === 'critical')).toBe(true);
      expect(critical.some(r => r.id === 'I1_MAX_POSITION_SIZE')).toBe(true);
      expect(critical.some(r => r.id === 'I8_MIN_MARKET_LIQUIDITY')).toBe(false);
    });
  });

  describe('getWarnings', () => {
    it('returns only warnings', () => {
      const request = createBaseRequest({
        volume24h: 3000, // Below $5000 - warning
        vpinScore: 0.7, // High VPIN - warning
      });
      const results = runAllInvariantChecks(request);
      const warnings = getWarnings(results);

      expect(warnings.every(r => r.severity === 'warning')).toBe(true);
      expect(warnings.some(r => r.id === 'I8_MIN_MARKET_LIQUIDITY')).toBe(true);
      expect(warnings.some(r => r.id === 'I9_MAX_VPIN_TOXICITY')).toBe(true);
    });
  });

  describe('shouldBlockOrder', () => {
    it('returns true for critical failures', () => {
      const request = createBaseRequest({ size: 600 }); // Exceeds limit
      const results = runAllInvariantChecks(request);
      expect(shouldBlockOrder(results)).toBe(true);
    });

    it('returns false for warnings only', () => {
      const request = createBaseRequest({
        volume24h: 3000, // Warning only
      });
      const results = runAllInvariantChecks(request);
      expect(shouldBlockOrder(results)).toBe(false);
    });

    it('returns false when all pass', () => {
      const request = createBaseRequest();
      const results = runAllInvariantChecks(request);
      expect(shouldBlockOrder(results)).toBe(false);
    });

    it('blocks on circuit breaker HALT', () => {
      const request = createBaseRequest({ circuitBreakerState: 'HALT' });
      const results = runAllInvariantChecks(request);
      expect(shouldBlockOrder(results)).toBe(true);
    });

    it('blocks on system unhealthy', () => {
      const request = createBaseRequest({ systemHealthy: false });
      const results = runAllInvariantChecks(request);
      expect(shouldBlockOrder(results)).toBe(true);
    });
  });

  describe('Fail-Closed Behavior', () => {
    it('all critical invariants have critical severity', () => {
      const request = createBaseRequest();
      const results = runAllInvariantChecks(request);

      const criticalIds = [
        'I1_MAX_POSITION_SIZE',
        'I2_MAX_PORTFOLIO_CONCENTRATION',
        'I3_MAX_MARKET_EXPOSURE',
        'I4_MAX_CATEGORY_EXPOSURE',
        'I5_MAX_DAILY_LOSS',
        'I6_MAX_DRAWDOWN',
        'I7_MAX_WEEKLY_LOSS',
        'I11_MIN_TIME_TO_SETTLEMENT',
        'I12_MARKET_EQUIVALENCE_GRADE',
        'I14_PRICE_STALENESS',
        'I15_ORDER_SIZE_LIMITS',
        'I16_CIRCUIT_BREAKER_STATE',
        'I17_SYSTEM_HEALTH',
      ];

      for (const id of criticalIds) {
        const result = results.find(r => r.id === id);
        expect(result?.severity).toBe('critical');
      }
    });

    it('warning invariants have warning severity', () => {
      const request = createBaseRequest();
      const results = runAllInvariantChecks(request);

      const warningIds = [
        'I8_MIN_MARKET_LIQUIDITY',
        'I9_MAX_VPIN_TOXICITY',
        'I10_MAX_SPREAD',
        'I13_MAX_AMBIGUITY_SCORE',
      ];

      for (const id of warningIds) {
        const result = results.find(r => r.id === id);
        expect(result?.severity).toBe('warning');
      }
    });
  });
});
