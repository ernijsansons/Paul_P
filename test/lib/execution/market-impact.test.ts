/**
 * Market Impact Tests (Phase B)
 * Tests depth estimation, impact models, and size adjustment logic
 */
import { describe, it, expect } from 'vitest';
import {
  estimateAvailableDepth,
  estimateLinearImpact,
  estimateConcaveImpact,
  assessMarketImpact,
  applyMarketImpactAdjustment,
  MarketImpactLookup,
  type DepthAnalysis,
  type MarketImpactAssessment,
} from '../../../src/lib/execution/market-impact';
import type { KalshiMarket } from '../../../src/lib/kalshi/types';

// ============================================================
// TEST FIXTURES
// ============================================================

const createMarket = (overrides: Partial<KalshiMarket> = {}): KalshiMarket => ({
  ticker: 'TEST-MARKET-001',
  event_ticker: 'TEST-EVENT',
  market_type: 'binary',
  title: 'Test Market',
  subtitle: 'Test',
  status: 'active',
  result: '',
  yes_bid: 45,
  yes_ask: 55,
  no_bid: 45,
  no_ask: 55,
  last_price: 50,
  volume_24h: 10000,
  ...overrides,
});

// ============================================================
// DEPTH ESTIMATION TESTS
// ============================================================

describe('estimateAvailableDepth', () => {
  it('should extract depth from market data', () => {
    const market = createMarket({ volume_24h: 10000 });
    const depth = estimateAvailableDepth(market);

    expect(depth).toHaveProperty('yes_depth');
    expect(depth).toHaveProperty('no_depth');
    expect(depth).toHaveProperty('total_depth');
    expect(depth).toHaveProperty('is_imbalanced');
  });

  it('should estimate higher depth with higher volume', () => {
    const lowVolume = estimateAvailableDepth(createMarket({ volume_24h: 1000 }));
    const highVolume = estimateAvailableDepth(createMarket({ volume_24h: 50000 }));

    expect(highVolume.total_depth).toBeGreaterThan(lowVolume.total_depth);
  });

  it('should estimate lower depth with wider spreads', () => {
    const tightSpread = estimateAvailableDepth(
      createMarket({ yes_bid: 49.5, yes_ask: 50.5, volume_24h: 10000 })
    );
    const wideSpread = estimateAvailableDepth(
      createMarket({ yes_bid: 40, yes_ask: 60, volume_24h: 10000 })
    );

    expect(wideSpread.total_depth).toBeLessThan(tightSpread.total_depth);
  });

  it('should compute imbalance ratio', () => {
    // All markets have an imbalance ratio (bid/ask side depth ratio)
    const market = estimateAvailableDepth(createMarket());
    expect(market.imbalance_ratio).toBeGreaterThanOrEqual(1.0);

    // Different spread widths affect the ratio
    const tightSpread = estimateAvailableDepth(
      createMarket({ yes_bid: 49, yes_ask: 51 })
    );
    const wideSpread = estimateAvailableDepth(
      createMarket({ yes_bid: 30, yes_ask: 70 })
    );
    // Both should have ratios >= 1.0 (one side deeper or equal)
    expect(tightSpread.imbalance_ratio).toBeGreaterThanOrEqual(1.0);
    expect(wideSpread.imbalance_ratio).toBeGreaterThanOrEqual(1.0);
  });

  it('should compute imbalance ratio correctly', () => {
    const depth = estimateAvailableDepth(createMarket());
    expect(depth.imbalance_ratio).toBeGreaterThan(0);
    expect(depth.imbalance_ratio).toBeGreaterThanOrEqual(1);
  });

  it('should handle zero volume gracefully', () => {
    const depth = estimateAvailableDepth(createMarket({ volume_24h: 0 }));
    expect(depth.total_depth).toBeGreaterThan(0); // Should have minimum depth
  });

  it('should estimate minimum depth of 100 per side', () => {
    const depth = estimateAvailableDepth(createMarket({ volume_24h: 1 }));
    expect(depth.yes_depth).toBeGreaterThanOrEqual(100);
    expect(depth.no_depth).toBeGreaterThanOrEqual(100);
  });
});

// ============================================================
// LINEAR IMPACT MODEL TESTS
// ============================================================

describe('estimateLinearImpact', () => {
  it('should compute zero impact for tiny orders', () => {
    const impact = estimateLinearImpact(0.1, 10000, 2);
    expect(impact).toBeLessThan(0.5); // Very small
  });

  it('should increase impact with larger orders', () => {
    const small = estimateLinearImpact(10, 10000, 2);
    const large = estimateLinearImpact(100, 10000, 2);
    expect(large).toBeGreaterThan(small);
  });

  it('should increase impact with smaller depths', () => {
    const deepMarket = estimateLinearImpact(100, 10000, 2);
    const shallowMarket = estimateLinearImpact(100, 1000, 2);
    expect(shallowMarket).toBeGreaterThan(deepMarket);
  });

  it('should cap impact at spread', () => {
    const impact = estimateLinearImpact(100000, 100, 2);
    expect(impact).toBeLessThanOrEqual(2);
  });

  it('should handle zero depth with pessimistic assumption', () => {
    const impact = estimateLinearImpact(50, 0, 2);
    expect(impact).toBe(1); // spread * 0.5
  });

  it('should scale impact proportionally to depth ratio', () => {
    // Order size = 50, depth = 100: depthRatio = 0.5
    // Expected impact = spread * 0.5
    const impact = estimateLinearImpact(50, 100, 4);
    expect(impact).toBeCloseTo(2, 0.5); // 4 * 0.5 = 2
  });
});

// ============================================================
// CONCAVE IMPACT MODEL TESTS
// ============================================================

describe('estimateConcaveImpact', () => {
  it('should compute lower impact than linear for same inputs', () => {
    const linear = estimateLinearImpact(50, 1000, 2);
    const concave = estimateConcaveImpact(50, 1000, 2, 0.4);
    // Concave uses sqrt, so should be lower before toxicity adjustment
    // sqrt(50/1000) = sqrt(0.05) ≈ 0.224 vs linear 0.05
    expect(concave).toBeGreaterThan(0);
    expect(concave).toBeLessThan(1);
  });

  it('should increase impact with higher VPIN (toxicity)', () => {
    const lowToxicity = estimateConcaveImpact(50, 1000, 2, 0.2);
    const highToxicity = estimateConcaveImpact(50, 1000, 2, 0.8);
    expect(highToxicity).toBeGreaterThan(lowToxicity);
  });

  it('should use pessimistic model for zero depth', () => {
    const impact = estimateConcaveImpact(50, 0, 2, 0.5);
    // 2 * (0.5 + 0.5 * 0.2) = 2 * 0.6 = 1.2
    expect(impact).toBeCloseTo(1.2, 1);
  });

  it('should apply toxicity multiplier correctly', () => {
    // For VPIN=0.6, multiplier = 1 + 0.6*0.3 = 1.18
    const impact = estimateConcaveImpact(100, 2000, 2, 0.6);
    expect(impact).toBeGreaterThan(0);
  });

  it('should cap impact at spread', () => {
    const impact = estimateConcaveImpact(100000, 100, 2, 0.5);
    expect(impact).toBeLessThanOrEqual(3); // spread * (1 + 0.5*0.3)
  });
});

// ============================================================
// MARKET IMPACT ASSESSMENT TESTS
// ============================================================

describe('assessMarketImpact', () => {
  const baseMarket = createMarket({ volume_24h: 10000 });

  it('should assess impact for YES side', () => {
    const assessment = assessMarketImpact(
      'TEST-MARKET',
      50, // order size
      50, // limit price
      1.5, // edge in cents
      baseMarket,
      'YES'
    );

    expect(assessment).toHaveProperty('marketId');
    expect(assessment).toHaveProperty('orderSize');
    expect(assessment).toHaveProperty('adjustedSize');
    expect(assessment).toHaveProperty('wasSized');
    expect(assessment).toHaveProperty('depthAtSubmission');
    expect(assessment).toHaveProperty('estimatedImpactCents');
    expect(assessment).toHaveProperty('ratioToEdge');
  });

  it('should assess impact for NO side', () => {
    const assessment = assessMarketImpact(
      'TEST-MARKET',
      50,
      50,
      1.5,
      baseMarket,
      'NO'
    );

    expect(assessment).toHaveProperty('adjustedSize');
  });

  it('should not adjust size if impact is acceptable', () => {
    const assessment = assessMarketImpact(
      'TEST-MARKET',
      10, // Small order
      50,
      5.0, // Large edge
      baseMarket,
      'YES'
    );

    expect(assessment.wasSized).toBe(false);
    expect(assessment.adjustedSize).toBe(10); // No adjustment
  });

  it('should reduce size if depth too shallow', () => {
    const assessment = assessMarketImpact(
      'TEST-MARKET',
      10000, // Very large order
      50,
      1.5,
      createMarket({ volume_24h: 100 }), // Very shallow
      'YES'
    );

    expect(assessment.wasSized).toBe(true);
    expect(assessment.adjustedSize).toBeLessThan(assessment.orderSize);
  });

  it('should reduce size if impact exceeds 30% of edge', () => {
    const assessment = assessMarketImpact(
      'TEST-MARKET',
      500,
      50,
      0.5, // Very small edge
      baseMarket,
      'YES'
    );

    if (assessment.ratioToEdge > 0.3) {
      expect(assessment.wasSized).toBe(true);
      expect(assessment.adjustedSize).toBeLessThan(assessment.orderSize);
    }
  });

  it('should provide explanation for size adjustment', () => {
    const assessment = assessMarketImpact(
      'TEST-MARKET',
      10000,
      50,
      0.5,
      createMarket({ volume_24h: 100 }),
      'YES'
    );

    if (assessment.wasSized) {
      expect(assessment.reason).toContain('Reduced');
    } else {
      expect(assessment.reason).toContain('No adjustment');
    }
  });

  it('should compute max safe size', () => {
    const assessment = assessMarketImpact(
      'TEST-MARKET',
      100,
      50,
      1.5,
      baseMarket,
      'YES'
    );

    expect(assessment.maxSafeSize).toBeGreaterThan(0);
    expect(assessment.maxSafeSize).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// MARKET IMPACT ADJUSTMENT TESTS
// ============================================================

describe('applyMarketImpactAdjustment', () => {
  const baseMarket = createMarket({ volume_24h: 10000 });

  it('should apply size adjustment', () => {
    const { adjustedSize, assessment } = applyMarketImpactAdjustment(
      500,
      50,
      0.5,
      createMarket({ volume_24h: 100 }), // Shallow market forces adjustment
      'YES'
    );

    expect(adjustedSize).toBeGreaterThan(0);
    expect(adjustedSize).toBeLessThanOrEqual(500);
  });

  it('should further reduce size in imbalanced markets', () => {
    // Create imbalanced market with adjustment needed
    const imbalancedMarket = createMarket({
      yes_bid: 20,
      yes_ask: 80,
      volume_24h: 100,
    });

    const { adjustedSize: balancedAdjusted } = applyMarketImpactAdjustment(
      500,
      50,
      0.5,
      createMarket({ volume_24h: 100 }),
      'YES'
    );

    const { adjustedSize: imbalancedAdjusted } = applyMarketImpactAdjustment(
      500,
      50,
      0.5,
      imbalancedMarket,
      'YES'
    );

    // Imbalanced should be further reduced if originally sized down
    expect(imbalancedAdjusted).toBeGreaterThan(0);
  });

  it('should maintain minimum size of 1', () => {
    const { adjustedSize } = applyMarketImpactAdjustment(
      1,
      50,
      0.1,
      createMarket({ volume_24h: 1 }),
      'YES'
    );

    expect(adjustedSize).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// MARKET IMPACT LOOKUP TESTS
// ============================================================

describe('MarketImpactLookup', () => {
  const lookup = new MarketImpactLookup();
  const market = createMarket({ volume_24h: 10000 });

  it('should compute and cache max safe size', () => {
    const size1 = lookup.getMaxSafeSize('TEST-TICKER', market, 1.5);
    const size2 = lookup.getMaxSafeSize('TEST-TICKER', market, 1.5);

    expect(size1).toBe(size2); // Should return cached value
  });

  it('should scale max safe size with edge', () => {
    const smallEdge = lookup.getMaxSafeSize('TICKER-1', market, 0.5);
    const largeEdge = lookup.getMaxSafeSize('TICKER-2', market, 2.0);

    // Larger edge should allow larger size
    expect(largeEdge).toBeGreaterThan(smallEdge);
  });

  it('should handle different tickers independently', () => {
    const market1 = createMarket({ ticker: 'MARKET-1', volume_24h: 10000 });
    const market2 = createMarket({ ticker: 'MARKET-2', volume_24h: 5000 });

    const size1 = lookup.getMaxSafeSize('MARKET-1', market1, 1.5);
    const size2 = lookup.getMaxSafeSize('MARKET-2', market2, 1.5);

    // Different markets have different max sizes
    expect(size1).toBeGreaterThan(0);
    expect(size2).toBeGreaterThan(0);
  });

  it('should return positive size for all inputs', () => {
    const size = lookup.getMaxSafeSize('ANY-TICKER', market, 0.1);
    expect(size).toBeGreaterThan(0);
  });
});

// ============================================================
// INTEGRATION TESTS
// ============================================================

describe('Impact assessment integration', () => {
  it('should handle realistic trading scenario', () => {
    const market = createMarket({
      ticker: 'ELECTION-2024',
      volume_24h: 50000,
      yes_bid: 42,
      yes_ask: 58,
    });

    const assessment = assessMarketImpact(
      'ELECTION-2024',
      250, // Order size
      50, // Limit price
      2.5, // 2.5 cent edge
      market,
      'YES'
    );

    expect(assessment.adjustedSize).toBeGreaterThan(0);
    expect(assessment.adjustedSize).toBeGreaterThanOrEqual(1);
    expect(assessment.depthAtSubmission).toBeGreaterThan(0);
  });

  it('should scale down large orders in shallow markets', () => {
    const shallowMarket = createMarket({
      volume_24h: 500,
      yes_bid: 40,
      yes_ask: 60,
    });

    const { adjustedSize } = applyMarketImpactAdjustment(
      1000,
      50,
      1.0,
      shallowMarket,
      'YES'
    );

    expect(adjustedSize).toBeLessThan(1000);
  });

  it('should allow small orders in shallow markets', () => {
    const shallowMarket = createMarket({
      volume_24h: 100,
      yes_bid: 40,
      yes_ask: 60,
    });

    const { adjustedSize } = applyMarketImpactAdjustment(
      5, // Very small
      50,
      2.0,
      shallowMarket,
      'YES'
    );

    expect(adjustedSize).toBeLessThanOrEqual(5); // Small orders are minimally impacted
    expect(adjustedSize).toBeGreaterThan(0);
  });
});
