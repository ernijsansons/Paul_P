/**
 * Kelly Criterion Sizing Tests (P-10)
 */
import { describe, it, expect } from 'vitest';
import {
  computeRawKelly,
  computeCV,
  monteCarloAdjustment,
  computeKellySize,
  batchKellySizing,
  type KellyInput,
  type MonteCarloConfig,
} from '../../../src/lib/strategy/kelly-sizing';

describe('Kelly Criterion Sizing', () => {
  describe('computeRawKelly', () => {
    it('returns positive Kelly for YES side with edge', () => {
      // Fair prob 60%, market at 50% → edge exists
      const kelly = computeRawKelly(0.6, 0.5, 'YES');
      expect(kelly).toBeGreaterThan(0);
      expect(kelly).toBeCloseTo(0.2, 2); // (0.6 - 0.5) / 0.5 = 0.2
    });

    it('returns positive Kelly for NO side with edge', () => {
      // Fair prob 40%, market at 50% → betting NO has edge
      const kelly = computeRawKelly(0.4, 0.5, 'NO');
      expect(kelly).toBeGreaterThan(0);
      expect(kelly).toBeCloseTo(0.2, 2);
    });

    it('returns negative Kelly when no edge exists', () => {
      // Fair prob 40%, market at 50% → betting YES has negative edge
      const kelly = computeRawKelly(0.4, 0.5, 'YES');
      expect(kelly).toBeLessThan(0);
    });

    it('returns zero for invalid probabilities', () => {
      expect(computeRawKelly(0, 0.5, 'YES')).toBe(0);
      expect(computeRawKelly(1, 0.5, 'YES')).toBe(0);
      expect(computeRawKelly(0.5, 0, 'YES')).toBe(0);
      expect(computeRawKelly(0.5, 1, 'YES')).toBe(0);
    });

    it('returns zero Kelly when fair prob equals market price', () => {
      const kelly = computeRawKelly(0.5, 0.5, 'YES');
      expect(Math.abs(kelly)).toBeLessThan(0.001);
    });

    it('handles extreme edge cases correctly', () => {
      // Very high confidence: fair prob 95%, market at 50%
      const highConfidence = computeRawKelly(0.95, 0.5, 'YES');
      expect(highConfidence).toBeGreaterThan(0.5);

      // Low confidence: fair prob 51%, market at 50%
      const lowConfidence = computeRawKelly(0.51, 0.5, 'YES');
      expect(lowConfidence).toBeGreaterThan(0);
      expect(lowConfidence).toBeLessThan(0.1);
    });
  });

  describe('computeCV', () => {
    it('returns default CV for insufficient data', () => {
      expect(computeCV([])).toBe(0.3);
      expect(computeCV([1, 2])).toBe(0.3);
      expect(computeCV([1, 2, 3, 4])).toBe(0.3);
    });

    it('calculates CV correctly for sample data', () => {
      // Mean = 10, values: 8, 9, 10, 11, 12
      // StdDev ≈ 1.41, CV = 1.41/10 ≈ 0.141
      const cv = computeCV([8, 9, 10, 11, 12]);
      expect(cv).toBeCloseTo(0.141, 1);
    });

    it('returns default CV for near-zero mean', () => {
      const cv = computeCV([0.0001, -0.0001, 0.00005, -0.00005, 0.00002]);
      expect(cv).toBe(0.3);
    });

    it('handles negative returns', () => {
      const cv = computeCV([-5, -3, -4, -6, -2]);
      expect(cv).toBeGreaterThan(0);
    });
  });

  describe('monteCarloAdjustment', () => {
    it('reduces Kelly fraction based on CV', () => {
      const rawKelly = 0.2;
      const config: MonteCarloConfig = { simulations: 10000, assumedCV: 0.3 };
      const adjusted = monteCarloAdjustment(rawKelly, config);

      // With CV = 0.3, adjustment factor = 1/(1+0.09) ≈ 0.917
      expect(adjusted).toBeLessThan(rawKelly);
      expect(adjusted).toBeCloseTo(rawKelly * (1 / 1.09), 2);
    });

    it('uses historical returns CV when provided', () => {
      const rawKelly = 0.2;
      const config: MonteCarloConfig = {
        simulations: 10000,
        historicalReturns: [8, 9, 10, 11, 12], // CV ≈ 0.141
      };
      const adjusted = monteCarloAdjustment(rawKelly, config);

      // With lower CV, adjustment should be less aggressive
      expect(adjusted).toBeGreaterThan(rawKelly * 0.9);
    });

    it('preserves sign of Kelly fraction', () => {
      const negative = monteCarloAdjustment(-0.1, { simulations: 10000 });
      expect(negative).toBeLessThan(0);
    });
  });

  describe('computeKellySize', () => {
    const baseInput: KellyInput = {
      fairProbability: 0.6,
      marketPrice: 0.5,
      side: 'YES',
      bankroll: 10000,
      maxPositionPct: 5,
    };

    it('calculates full Kelly result with edge', () => {
      const result = computeKellySize(baseInput);

      expect(result.hasEdge).toBe(true);
      expect(result.kellyFraction).toBeGreaterThan(0);
      expect(result.adjustedFraction).toBeGreaterThan(0);
      expect(result.adjustedFraction).toBeLessThanOrEqual(result.kellyFraction);
      expect(result.positionSize).toBeLessThanOrEqual(500); // 5% of 10000
      expect(result.expectedEdge).toBeGreaterThan(0);
      expect(result.confidenceAdjustment).toBeGreaterThan(0);
      expect(result.confidenceAdjustment).toBeLessThanOrEqual(1);
    });

    it('returns zero position when no edge exists', () => {
      const noEdgeInput: KellyInput = {
        ...baseInput,
        fairProbability: 0.4, // Below market price for YES bet
      };
      const result = computeKellySize(noEdgeInput);

      expect(result.hasEdge).toBe(false);
      expect(result.adjustedFraction).toBe(0);
      expect(result.positionSize).toBe(0);
    });

    it('caps position at maxPositionPct', () => {
      const highEdgeInput: KellyInput = {
        ...baseInput,
        fairProbability: 0.95, // Very high confidence
        maxPositionPct: 2,
      };
      const result = computeKellySize(highEdgeInput);

      expect(result.adjustedFraction).toBeLessThanOrEqual(0.02);
      expect(result.positionSize).toBeLessThanOrEqual(200); // 2% of 10000
    });

    it('handles NO side correctly', () => {
      const noSideInput: KellyInput = {
        fairProbability: 0.3, // Market overpriced
        marketPrice: 0.5,
        side: 'NO',
        bankroll: 10000,
      };
      const result = computeKellySize(noSideInput);

      expect(result.hasEdge).toBe(true);
      expect(result.expectedEdge).toBe(20); // (0.5 - 0.3) * 100
    });

    it('uses custom Monte Carlo config', () => {
      const config: MonteCarloConfig = {
        simulations: 10000,
        assumedCV: 0.5, // Higher uncertainty
      };
      const result = computeKellySize(baseInput, config);

      // Higher CV should lead to more conservative sizing
      const defaultResult = computeKellySize(baseInput);
      // Use toBeCloseTo to handle floating point precision
      expect(result.adjustedFraction).toBeLessThanOrEqual(defaultResult.adjustedFraction);
    });
  });

  describe('batchKellySizing', () => {
    const opportunities = [
      { id: 'opp1', fairProbability: 0.6, marketPrice: 0.5, side: 'YES' as const },
      { id: 'opp2', fairProbability: 0.7, marketPrice: 0.5, side: 'YES' as const },
      { id: 'opp3', fairProbability: 0.4, marketPrice: 0.5, side: 'NO' as const },
      { id: 'opp4', fairProbability: 0.5, marketPrice: 0.5, side: 'YES' as const }, // No edge
    ];

    it('filters out opportunities without edge', () => {
      const results = batchKellySizing(opportunities, 10000);

      const ids = results.map(r => r.id);
      expect(ids).not.toContain('opp4');
      expect(results.length).toBe(3);
    });

    it('respects maxTotalAllocation', () => {
      const results = batchKellySizing(opportunities, 10000, {
        maxTotalAllocation: 10, // Only 10% total
      });

      const totalAllocation = results.reduce((sum, r) => sum + r.kellyResult.adjustedFraction, 0);
      expect(totalAllocation).toBeLessThanOrEqual(0.1);
    });

    it('respects maxSinglePosition', () => {
      const results = batchKellySizing(opportunities, 10000, {
        maxSinglePosition: 3, // Max 3% per position
      });

      for (const result of results) {
        expect(result.kellyResult.adjustedFraction).toBeLessThanOrEqual(0.03);
      }
    });

    it('returns empty array when no opportunities have edge', () => {
      const noEdgeOpps = [
        { id: 'opp1', fairProbability: 0.4, marketPrice: 0.5, side: 'YES' as const },
      ];
      const results = batchKellySizing(noEdgeOpps, 10000);

      expect(results.length).toBe(0);
    });

    it('scales down when total allocation exceeds limit', () => {
      const manyOpps = Array.from({ length: 20 }, (_, i) => ({
        id: `opp${i}`,
        fairProbability: 0.7,
        marketPrice: 0.5,
        side: 'YES' as const,
      }));

      const results = batchKellySizing(manyOpps, 10000, {
        maxTotalAllocation: 50,
        maxSinglePosition: 5,
      });

      const totalAllocation = results.reduce((sum, r) => sum + r.kellyResult.adjustedFraction, 0);
      // Use toBeCloseTo to handle floating point precision (0.5 with tolerance)
      expect(totalAllocation).toBeCloseTo(0.5, 5);
    });
  });
});
