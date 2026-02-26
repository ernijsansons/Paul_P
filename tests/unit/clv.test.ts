/**
 * Paul P - CLV Computation Tests
 *
 * CLV Sign Convention (P-01 CRITICAL):
 *   CLV = closing_line_price - entry_price
 *   POSITIVE CLV = edge (entered at better price than closing consensus)
 */

import { describe, it, expect } from 'vitest';
import {
  computeCLV,
  computeCLVForYesBuyer,
  computeCLVForNoBuyer,
  computeCLVStatistics,
  scoreCLVConsistency,
  inferMarketClass,
  type CLVResult,
} from '../../src/lib/scoring/clv';

describe('CLV Sign Convention (P-01)', () => {
  it('should compute positive CLV for YES buyer who bought cheaper than close', () => {
    // Scenario: bought YES at $0.40, market closed at $0.50
    // Edge = you bought cheaper than closing consensus
    const result = computeCLVForYesBuyer(0.40, 0.50, 'political');

    expect(result.clv).toBeCloseTo(0.10);
    expect(result.clvCents).toBeCloseTo(10);
    expect(result.side).toBe('YES');
    expect(result.isValid).toBe(true);
  });

  it('should compute negative CLV for YES buyer who bought more expensive than close', () => {
    // Scenario: bought YES at $0.60, market closed at $0.50
    // No edge = you overpaid
    const result = computeCLVForYesBuyer(0.60, 0.50, 'political');

    expect(result.clv).toBeCloseTo(-0.10);
    expect(result.clvCents).toBeCloseTo(-10);
    expect(result.side).toBe('YES');
  });

  it('should compute positive CLV for NO buyer who bought cheaper than close', () => {
    // Scenario: bought NO at $0.40 (YES at $0.60), NO closed at $0.50
    // Edge = you bought NO cheaper than closing NO price
    const result = computeCLVForNoBuyer(0.40, 0.50, 'political');

    expect(result.clv).toBeCloseTo(0.10);
    expect(result.clvCents).toBeCloseTo(10);
    expect(result.side).toBe('NO');
  });

  it('should compute negative CLV for NO buyer who bought more expensive than close', () => {
    // Scenario: bought NO at $0.60, NO closed at $0.50
    const result = computeCLVForNoBuyer(0.60, 0.50, 'political');

    expect(result.clv).toBeCloseTo(-0.10);
    expect(result.clvCents).toBeCloseTo(-10);
    expect(result.side).toBe('NO');
  });

  it('should compute zero CLV when entry equals closing', () => {
    const result = computeCLVForYesBuyer(0.50, 0.50, 'political');

    expect(result.clv).toBeCloseTo(0);
    expect(result.clvCents).toBeCloseTo(0);
  });
});

describe('CLV Quality Score Validation', () => {
  it('should mark CLV as valid when quality score >= 0.5', () => {
    const result = computeCLV(0.40, 0.50, 'YES', 'political', 0.6);

    expect(result.isValid).toBe(true);
    expect(result.qualityScore).toBe(0.6);
  });

  it('should mark CLV as invalid when quality score < 0.5', () => {
    const result = computeCLV(0.40, 0.50, 'YES', 'political', 0.4);

    expect(result.isValid).toBe(false);
    expect(result.qualityScore).toBe(0.4);
  });

  it('should default to quality score 1.0 when not provided', () => {
    const result = computeCLVForYesBuyer(0.40, 0.50, 'political');

    expect(result.qualityScore).toBe(1.0);
    expect(result.isValid).toBe(true);
  });
});

describe('CLV Market Class Methods', () => {
  it('should use correct closing line method for political markets', () => {
    const result = computeCLVForYesBuyer(0.40, 0.50, 'political');
    expect(result.closingLineMethod).toBe('T-60min');
  });

  it('should use correct closing line method for sports markets', () => {
    const result = computeCLVForYesBuyer(0.40, 0.50, 'sports');
    expect(result.closingLineMethod).toBe('last-trade');
  });

  it('should use correct closing line method for weather markets', () => {
    const result = computeCLVForYesBuyer(0.40, 0.50, 'weather');
    expect(result.closingLineMethod).toBe('T-5min');
  });

  it('should use correct closing line method for mentions markets', () => {
    const result = computeCLVForYesBuyer(0.40, 0.50, 'mentions');
    expect(result.closingLineMethod).toBe('T-30sec');
  });

  it('should use correct closing line method for crypto markets', () => {
    const result = computeCLVForYesBuyer(0.40, 0.50, 'crypto');
    expect(result.closingLineMethod).toBe('T-60sec');
  });
});

describe('CLV Statistics', () => {
  it('should compute correct statistics for multiple CLV results', () => {
    const results: CLVResult[] = [
      { clv: 0.05, clvCents: 5, closingLinePrice: 0.50, entryPrice: 0.45, side: 'YES', closingLineMethod: 'T-60min', isValid: true, qualityScore: 0.8 },
      { clv: 0.03, clvCents: 3, closingLinePrice: 0.50, entryPrice: 0.47, side: 'YES', closingLineMethod: 'T-60min', isValid: true, qualityScore: 0.7 },
      { clv: -0.02, clvCents: -2, closingLinePrice: 0.50, entryPrice: 0.52, side: 'YES', closingLineMethod: 'T-60min', isValid: true, qualityScore: 0.6 },
    ];

    const stats = computeCLVStatistics(results);

    expect(stats.meanCLV).toBeCloseTo(0.02); // (0.05 + 0.03 - 0.02) / 3
    expect(stats.meanCLVCents).toBeCloseTo(2);
    expect(stats.positiveCLVCount).toBe(2);
    expect(stats.negativeCLVCount).toBe(1);
    expect(stats.validCLVCount).toBe(3);
    expect(stats.clvConsistencyScore).toBeCloseTo(2/3);
  });

  it('should exclude invalid CLV from statistics', () => {
    const results: CLVResult[] = [
      { clv: 0.05, clvCents: 5, closingLinePrice: 0.50, entryPrice: 0.45, side: 'YES', closingLineMethod: 'T-60min', isValid: true, qualityScore: 0.8 },
      { clv: 0.10, clvCents: 10, closingLinePrice: 0.50, entryPrice: 0.40, side: 'YES', closingLineMethod: 'T-60min', isValid: false, qualityScore: 0.3 },
    ];

    const stats = computeCLVStatistics(results);

    expect(stats.validCLVCount).toBe(1);
    expect(stats.invalidCLVCount).toBe(1);
    expect(stats.meanCLV).toBeCloseTo(0.05); // Only valid result
  });
});

describe('CLV Scoring for Skill Rubric', () => {
  it('should score 25 points for mean CLV > +3 cents', () => {
    expect(scoreCLVConsistency(3.5, 20)).toBe(25);
  });

  it('should score 20 points for mean CLV +2 to +3 cents', () => {
    expect(scoreCLVConsistency(2.5, 20)).toBe(20);
  });

  it('should score 15 points for mean CLV +1 to +2 cents', () => {
    expect(scoreCLVConsistency(1.5, 20)).toBe(15);
  });

  it('should score 10 points for mean CLV 0 to +1 cents', () => {
    expect(scoreCLVConsistency(0.5, 20)).toBe(10);
  });

  it('should score 0 points for negative mean CLV', () => {
    expect(scoreCLVConsistency(-1, 20)).toBe(0);
  });

  it('should score 0 points if less than 10 valid positions', () => {
    expect(scoreCLVConsistency(5, 5)).toBe(0);
  });
});

describe('Market Class Inference', () => {
  it('should infer political for election-related categories', () => {
    expect(inferMarketClass('politics')).toBe('political');
    expect(inferMarketClass('US Elections')).toBe('political');
  });

  it('should infer sports for sports-related categories', () => {
    expect(inferMarketClass('sports')).toBe('sports');
    expect(inferMarketClass('NBA', ['basketball', 'game'])).toBe('sports');
  });

  it('should infer weather for weather-related categories', () => {
    expect(inferMarketClass('weather')).toBe('weather');
    expect(inferMarketClass(undefined, ['temperature', 'nyc'])).toBe('weather');
  });

  it('should infer crypto for crypto-related categories', () => {
    expect(inferMarketClass('crypto')).toBe('crypto');
    expect(inferMarketClass(undefined, ['btc', 'price'])).toBe('crypto');
  });

  it('should default to political for unknown categories', () => {
    expect(inferMarketClass('unknown')).toBe('political');
    expect(inferMarketClass()).toBe('political');
  });
});
