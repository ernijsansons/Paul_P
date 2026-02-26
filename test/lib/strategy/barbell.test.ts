/**
 * Barbell Allocation Strategy Tests (P-09, P-18)
 */
import { describe, it, expect } from 'vitest';
import {
  calculateHerfindahl,
  filterBondCandidates,
  categorizeTail,
  allocateBarbell,
  validateBarbellAllocation,
  calculateExpectedReturn,
  type TailType,
  type BarbellConfig,
} from '../../../src/lib/strategy/barbell';

describe('Barbell Allocation Strategy', () => {
  describe('calculateHerfindahl', () => {
    it('returns 0 for empty allocations', () => {
      expect(calculateHerfindahl([])).toBe(0);
    });

    it('returns 1 for single allocation', () => {
      expect(calculateHerfindahl([100])).toBe(1);
    });

    it('returns 0.5 for two equal allocations', () => {
      const hhi = calculateHerfindahl([50, 50]);
      expect(hhi).toBeCloseTo(0.5, 2);
    });

    it('returns lower HHI for more diversified portfolio', () => {
      const concentrated = calculateHerfindahl([80, 10, 10]);
      const diversified = calculateHerfindahl([33, 33, 34]);
      expect(diversified).toBeLessThan(concentrated);
    });

    it('calculates correct HHI for 5 equal positions', () => {
      const hhi = calculateHerfindahl([20, 20, 20, 20, 20]);
      expect(hhi).toBeCloseTo(0.2, 2); // 5 * (0.2)^2 = 0.2
    });
  });

  describe('filterBondCandidates', () => {
    const markets = [
      { marketId: 'm1', venue: 'kalshi', probability: 0.95, volume24h: 5000, spread: 0.02 },
      { marketId: 'm2', venue: 'kalshi', probability: 0.85, volume24h: 5000, spread: 0.02 }, // Below threshold
      { marketId: 'm3', venue: 'polymarket', probability: 0.95, volume24h: 5000, spread: 0.02 }, // Wrong venue
      { marketId: 'm4', venue: 'kalshi', probability: 0.95, volume24h: 500, spread: 0.02 }, // Low volume
      { marketId: 'm5', venue: 'kalshi', probability: 0.95, volume24h: 5000, spread: 0.10 }, // High spread
      { marketId: 'm6', venue: 'kalshi', probability: 0.97, volume24h: 10000, spread: 0.01 },
    ];

    it('filters for Kalshi-only markets', () => {
      const candidates = filterBondCandidates(markets);
      expect(candidates.every(c => c.venue === 'kalshi')).toBe(true);
    });

    it('filters for high probability markets (>= 93%)', () => {
      const candidates = filterBondCandidates(markets);
      expect(candidates.every(c => c.probability >= 0.93)).toBe(true);
      expect(candidates.find(c => c.marketId === 'm2')).toBeUndefined();
    });

    it('filters out low liquidity markets', () => {
      const candidates = filterBondCandidates(markets);
      expect(candidates.find(c => c.marketId === 'm4')).toBeUndefined();
    });

    it('filters out high spread markets', () => {
      const candidates = filterBondCandidates(markets);
      expect(candidates.find(c => c.marketId === 'm5')).toBeUndefined();
    });

    it('calculates expected yield correctly', () => {
      const candidates = filterBondCandidates(markets);
      const m1 = candidates.find(c => c.marketId === 'm1');
      expect(m1?.expectedYield).toBeCloseTo((1 - 0.95) / 0.95, 3);
    });

    it('sorts by yield descending', () => {
      const candidates = filterBondCandidates(markets);
      for (let i = 1; i < candidates.length; i++) {
        expect(candidates[i - 1]!.expectedYield).toBeGreaterThanOrEqual(candidates[i]!.expectedYield);
      }
    });

    it('respects custom config thresholds', () => {
      const customConfig: Partial<BarbellConfig> = { minBondProbability: 0.90 };
      const candidates = filterBondCandidates(markets, customConfig);
      expect(candidates.find(c => c.probability === 0.85)).toBeUndefined();
      expect(candidates.find(c => c.probability >= 0.90)).toBeDefined();
    });
  });

  describe('categorizeTail', () => {
    it('categorizes war-related markets as event_hedge', () => {
      const market = { marketId: 'm1', description: 'Will there be a war in region X?' };
      expect(categorizeTail(market)).toBe('event_hedge');
    });

    it('categorizes crisis markets as event_hedge', () => {
      const market = { marketId: 'm1', tags: ['crisis', 'emergency'] };
      expect(categorizeTail(market)).toBe('event_hedge');
    });

    it('categorizes Fed rate markets as regime_tail', () => {
      const market = { marketId: 'm1', description: 'Will the Fed raise interest rates?' };
      expect(categorizeTail(market)).toBe('regime_tail');
    });

    it('categorizes recession markets as regime_tail', () => {
      const market = { marketId: 'm1', category: 'macro', description: 'Will there be a recession?' };
      expect(categorizeTail(market)).toBe('regime_tail');
    });

    it('categorizes unmatched markets as diversifier', () => {
      const market = { marketId: 'm1', description: 'Will team X win the championship?' };
      expect(categorizeTail(market)).toBe('diversifier');
    });

    it('handles missing fields gracefully', () => {
      const market = { marketId: 'm1' };
      expect(categorizeTail(market)).toBe('diversifier');
    });
  });

  describe('allocateBarbell', () => {
    const bondCandidates = [
      { marketId: 'b1', venue: 'kalshi', probability: 0.95, expectedYield: 0.053 },
      { marketId: 'b2', venue: 'kalshi', probability: 0.94, expectedYield: 0.064 },
      { marketId: 'b3', venue: 'kalshi', probability: 0.96, expectedYield: 0.042 },
    ];

    const tailCandidates = [
      { marketId: 't1', venue: 'kalshi', probability: 0.05, tailType: 'event_hedge' as TailType, payoffMultiple: 20 },
      { marketId: 't2', venue: 'kalshi', probability: 0.10, tailType: 'regime_tail' as TailType, payoffMultiple: 10 },
      { marketId: 't3', venue: 'kalshi', probability: 0.08, tailType: 'diversifier' as TailType, payoffMultiple: 12 },
    ];

    it('allocates 90/10 by default', () => {
      const allocation = allocateBarbell(10000, bondCandidates, tailCandidates);
      expect(allocation.bondAllocation).toBe(9000);
      expect(allocation.tailAllocation).toBe(1000);
    });

    it('respects maxSingleBondPct', () => {
      const allocation = allocateBarbell(10000, bondCandidates, tailCandidates);
      const maxBond = 9000 * 0.2; // 20% of bond allocation
      allocation.bondPositions.forEach(b => {
        expect(b.allocation).toBeLessThanOrEqual(maxBond);
      });
    });

    it('respects maxSingleTailPct', () => {
      const allocation = allocateBarbell(10000, bondCandidates, tailCandidates);
      const maxTail = 1000 * 0.4; // 40% of tail allocation
      allocation.tailPositions.forEach(t => {
        expect(t.allocation).toBeLessThanOrEqual(maxTail);
      });
    });

    it('prioritizes event_hedge allocations', () => {
      const allocation = allocateBarbell(10000, bondCandidates, tailCandidates);
      const eventHedgePositions = allocation.tailPositions.filter(t => t.tailType === 'event_hedge');
      expect(eventHedgePositions.length).toBeGreaterThan(0);
    });

    it('calculates Herfindahl index', () => {
      const allocation = allocateBarbell(10000, bondCandidates, tailCandidates);
      expect(allocation.herfindahlIndex).toBeGreaterThan(0);
      expect(allocation.herfindahlIndex).toBeLessThanOrEqual(1);
    });

    it('tracks event hedge percentage', () => {
      const allocation = allocateBarbell(10000, bondCandidates, tailCandidates);
      expect(allocation.eventHedgePct).toBeGreaterThanOrEqual(0);
      expect(allocation.eventHedgePct).toBeLessThanOrEqual(100);
    });

    it('validates allocation and reports errors', () => {
      // No bond candidates
      const noBodsAllocation = allocateBarbell(10000, [], tailCandidates);
      expect(noBodsAllocation.isValid).toBe(false);
      expect(noBodsAllocation.validationErrors).toContain('No bond positions allocated');
    });

    it('respects custom bond/tail percentages', () => {
      const customConfig: Partial<BarbellConfig> = { bondPct: 80, tailPct: 20 };
      const allocation = allocateBarbell(10000, bondCandidates, tailCandidates, customConfig);
      expect(allocation.bondAllocation).toBe(8000);
      expect(allocation.tailAllocation).toBe(2000);
    });
  });

  describe('validateBarbellAllocation', () => {
    const createValidAllocation = () => ({
      totalCapital: 10000,
      bondAllocation: 9000,
      tailAllocation: 1000,
      bondPositions: [
        { marketId: 'b1', venue: 'kalshi', probability: 0.95, allocation: 3000, expectedReturn: 0.05 },
        { marketId: 'b2', venue: 'kalshi', probability: 0.94, allocation: 3000, expectedReturn: 0.06 },
        { marketId: 'b3', venue: 'kalshi', probability: 0.96, allocation: 3000, expectedReturn: 0.04 },
      ],
      tailPositions: [
        { marketId: 't1', venue: 'kalshi', tailType: 'event_hedge' as TailType, probability: 0.05, allocation: 400, maxLoss: 400, payoffMultiple: 20 },
        { marketId: 't2', venue: 'kalshi', tailType: 'regime_tail' as TailType, probability: 0.10, allocation: 300, maxLoss: 300, payoffMultiple: 10 },
        { marketId: 't3', venue: 'kalshi', tailType: 'diversifier' as TailType, probability: 0.08, allocation: 300, maxLoss: 300, payoffMultiple: 12 },
      ],
      herfindahlIndex: 0.15,
      eventHedgePct: 40,
      isValid: true,
      validationErrors: [],
    });

    it('validates correct allocation', () => {
      const allocation = createValidAllocation();
      const result = validateBarbellAllocation(allocation);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('detects bond ratio deviation', () => {
      const allocation = createValidAllocation();
      allocation.bondAllocation = 7000; // Should be 9000
      const result = validateBarbellAllocation(allocation);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Bond allocation'))).toBe(true);
    });

    it('detects excessive concentration', () => {
      const allocation = createValidAllocation();
      allocation.herfindahlIndex = 0.3; // Above default 0.25 max
      const result = validateBarbellAllocation(allocation);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('concentrated'))).toBe(true);
    });

    it('detects insufficient event hedge', () => {
      const allocation = createValidAllocation();
      allocation.eventHedgePct = 20; // Below default 30% min
      const result = validateBarbellAllocation(allocation);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('event hedge'))).toBe(true);
    });

    it('detects low probability bonds', () => {
      const allocation = createValidAllocation();
      allocation.bondPositions[0]!.probability = 0.85; // Below 93%
      const result = validateBarbellAllocation(allocation);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('bonds below min probability'))).toBe(true);
    });

    it('respects custom config', () => {
      const allocation = createValidAllocation();
      allocation.herfindahlIndex = 0.3;
      const customConfig: Partial<BarbellConfig> = { maxHerfindahl: 0.35 };
      const result = validateBarbellAllocation(allocation, customConfig);
      expect(result.valid).toBe(true);
    });
  });

  describe('calculateExpectedReturn', () => {
    it('calculates bond return correctly', () => {
      const allocation = {
        totalCapital: 10000,
        bondAllocation: 9000,
        tailAllocation: 1000,
        bondPositions: [
          { marketId: 'b1', venue: 'kalshi', probability: 0.95, allocation: 5000, expectedReturn: 0.05 },
          { marketId: 'b2', venue: 'kalshi', probability: 0.94, allocation: 4000, expectedReturn: 0.06 },
        ],
        tailPositions: [],
        herfindahlIndex: 0.2,
        eventHedgePct: 0,
        isValid: true,
        validationErrors: [],
      };

      const result = calculateExpectedReturn(allocation);
      // 5000 * 0.05 + 4000 * 0.06 = 250 + 240 = 490
      expect(result.bondReturn).toBe(490);
    });

    it('calculates tail return correctly', () => {
      const allocation = {
        totalCapital: 10000,
        bondAllocation: 9000,
        tailAllocation: 1000,
        bondPositions: [],
        tailPositions: [
          { marketId: 't1', venue: 'kalshi', tailType: 'event_hedge' as TailType, probability: 0.05, allocation: 500, maxLoss: 500, payoffMultiple: 20 },
          { marketId: 't2', venue: 'kalshi', tailType: 'regime_tail' as TailType, probability: 0.10, allocation: 500, maxLoss: 500, payoffMultiple: 10 },
        ],
        herfindahlIndex: 0.2,
        eventHedgePct: 50,
        isValid: true,
        validationErrors: [],
      };

      const result = calculateExpectedReturn(allocation);
      // Tail 1: 0.1 * 500 * 20 - 0.9 * 500 = 1000 - 450 = 550
      // Tail 2: 0.1 * 500 * 10 - 0.9 * 500 = 500 - 450 = 50
      // Total: 600
      expect(result.tailReturn).toBe(600);
    });

    it('calculates max drawdown', () => {
      const allocation = {
        totalCapital: 10000,
        bondAllocation: 9000,
        tailAllocation: 1000,
        bondPositions: [
          { marketId: 'b1', venue: 'kalshi', probability: 0.95, allocation: 9000, expectedReturn: 0.05 },
        ],
        tailPositions: [
          { marketId: 't1', venue: 'kalshi', tailType: 'event_hedge' as TailType, probability: 0.05, allocation: 1000, maxLoss: 1000, payoffMultiple: 20 },
        ],
        herfindahlIndex: 0.2,
        eventHedgePct: 100,
        isValid: true,
        validationErrors: [],
      };

      const result = calculateExpectedReturn(allocation);
      // Max bond loss: 9000 * 0.1 = 900
      // Max tail loss: 1000
      // Total: 1900 / 10000 = 0.19
      expect(result.maxDrawdown).toBeCloseTo(0.19, 2);
    });
  });
});
