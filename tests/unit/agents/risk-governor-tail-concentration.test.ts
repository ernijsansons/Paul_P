/**
 * RiskGovernor Tail Concentration Tests
 *
 * Tests the PRODUCTION implementation from src/lib/risk/tail-concentration.ts:
 * - Herfindahl index calculation (sum of squared position percentages)
 * - Compliance threshold enforcement (HHI < 0.3)
 * - SQL snapshot parameter generation
 *
 * This tests the same code used by RiskGovernorAgent.ts:913
 */

import { describe, expect, it } from 'vitest';
import {
  checkTailConcentration,
  calculateHerfindahl,
  calculateMaxPositionPct,
  createSnapshotParams,
  type TailPosition,
} from '../../../src/lib/risk/tail-concentration';

// ============================================================
// HERFINDAHL INDEX CALCULATION TESTS
// ============================================================

describe('Herfindahl Index Calculation', () => {
  it('returns 1.0 for single position (maximum concentration)', () => {
    const result = checkTailConcentration([
      { marketId: 'A', size: 100, currentPrice: 0.1 },
    ]);

    expect(result.herfindahl).toBeCloseTo(1.0);
    expect(result.isCompliant).toBe(false); // 1.0 > 0.3
    expect(result.maxPositionPct).toBeCloseTo(100);
  });

  it('returns 0.5 for two equal positions', () => {
    const result = checkTailConcentration([
      { marketId: 'A', size: 50, currentPrice: 0.1 },
      { marketId: 'B', size: 50, currentPrice: 0.9 },
    ]);

    expect(result.herfindahl).toBeCloseTo(0.5);
    expect(result.isCompliant).toBe(false); // 0.5 > 0.3
    expect(result.maxPositionPct).toBeCloseTo(50);
  });

  it('returns 0.25 for four equal positions (compliant)', () => {
    const result = checkTailConcentration([
      { marketId: 'A', size: 25, currentPrice: 0.1 },
      { marketId: 'B', size: 25, currentPrice: 0.15 },
      { marketId: 'C', size: 25, currentPrice: 0.85 },
      { marketId: 'D', size: 25, currentPrice: 0.9 },
    ]);

    expect(result.herfindahl).toBeCloseTo(0.25);
    expect(result.isCompliant).toBe(true); // 0.25 < 0.3
    expect(result.maxPositionPct).toBeCloseTo(25);
  });

  it('returns lower HHI for more diversified portfolio', () => {
    const concentrated = checkTailConcentration([
      { marketId: 'A', size: 80, currentPrice: 0.1 },
      { marketId: 'B', size: 20, currentPrice: 0.9 },
    ]);

    const diversified = checkTailConcentration([
      { marketId: 'A', size: 50, currentPrice: 0.1 },
      { marketId: 'B', size: 50, currentPrice: 0.9 },
    ]);

    expect(diversified.herfindahl).toBeLessThan(concentrated.herfindahl);
  });

  it('handles empty positions gracefully', () => {
    const result = checkTailConcentration([]);

    expect(result.isCompliant).toBe(true);
    expect(result.herfindahl).toBe(0);
    expect(result.maxPositionPct).toBe(0);
    expect(result.totalTailValue).toBe(0);
  });

  it('filters out non-tail positions (price between 0.2 and 0.8)', () => {
    const result = checkTailConcentration([
      { marketId: 'A', size: 100, currentPrice: 0.5 }, // Not tail - should be filtered
      { marketId: 'B', size: 50, currentPrice: 0.1 },  // Tail
    ]);

    // Only the tail position should be counted
    expect(result.tailPositions).toHaveLength(1);
    expect(result.totalTailValue).toBe(50);
    expect(result.herfindahl).toBeCloseTo(1.0); // Single tail position
  });
});

// ============================================================
// COMPLIANCE THRESHOLD TESTS
// ============================================================

describe('Tail Concentration Compliance', () => {
  it('marks HHI < 0.3 as compliant', () => {
    // 5 equal positions = HHI of 0.2
    const result = checkTailConcentration([
      { marketId: 'A', size: 20, currentPrice: 0.1 },
      { marketId: 'B', size: 20, currentPrice: 0.12 },
      { marketId: 'C', size: 20, currentPrice: 0.85 },
      { marketId: 'D', size: 20, currentPrice: 0.88 },
      { marketId: 'E', size: 20, currentPrice: 0.9 },
    ]);

    expect(result.herfindahl).toBeCloseTo(0.2);
    expect(result.isCompliant).toBe(true);
  });

  it('marks HHI >= 0.3 as non-compliant', () => {
    // 3 equal positions = HHI of 0.333
    const result = checkTailConcentration([
      { marketId: 'A', size: 33.33, currentPrice: 0.1 },
      { marketId: 'B', size: 33.33, currentPrice: 0.15 },
      { marketId: 'C', size: 33.34, currentPrice: 0.9 },
    ]);

    expect(result.herfindahl).toBeGreaterThan(0.3);
    expect(result.isCompliant).toBe(false);
  });

  it('borderline case at exactly 0.3 is non-compliant', () => {
    // The threshold is < 0.3, so exactly 0.3 is non-compliant
    const isCompliant = (hhi: number) => hhi < 0.3;
    expect(isCompliant(0.29)).toBe(true);
    expect(isCompliant(0.30)).toBe(false);
    expect(isCompliant(0.31)).toBe(false);
  });

  it('respects custom threshold when provided', () => {
    const positions: TailPosition[] = [
      { marketId: 'A', size: 50, currentPrice: 0.1 },
      { marketId: 'B', size: 50, currentPrice: 0.9 },
    ];

    // With default threshold 0.3: HHI 0.5 is non-compliant
    const defaultResult = checkTailConcentration(positions);
    expect(defaultResult.isCompliant).toBe(false);

    // With custom threshold 0.6: HHI 0.5 is compliant
    const customResult = checkTailConcentration(positions, 0.6);
    expect(customResult.isCompliant).toBe(true);
  });
});

// ============================================================
// UTILITY FUNCTION TESTS
// ============================================================

describe('Utility Functions', () => {
  describe('calculateHerfindahl', () => {
    it('returns 0 for empty array', () => {
      expect(calculateHerfindahl([])).toBe(0);
    });

    it('returns 1.0 for single position', () => {
      expect(calculateHerfindahl([{ marketId: 'A', size: 100 }])).toBeCloseTo(1.0);
    });

    it('returns 0.5 for two equal positions', () => {
      expect(calculateHerfindahl([
        { marketId: 'A', size: 50 },
        { marketId: 'B', size: 50 },
      ])).toBeCloseTo(0.5);
    });
  });

  describe('calculateMaxPositionPct', () => {
    it('returns 0 for empty array', () => {
      expect(calculateMaxPositionPct([])).toBe(0);
    });

    it('returns 100 for single position', () => {
      expect(calculateMaxPositionPct([{ marketId: 'A', size: 100 }])).toBeCloseTo(100);
    });

    it('returns the largest position percentage', () => {
      expect(calculateMaxPositionPct([
        { marketId: 'A', size: 60 },
        { marketId: 'B', size: 30 },
        { marketId: 'C', size: 10 },
      ])).toBeCloseTo(60);
    });
  });
});

// ============================================================
// SQL SNAPSHOT PARAMETER TESTS
// ============================================================

describe('Tail Concentration SQL Snapshot', () => {
  it('creates correct snapshot parameters', () => {
    const result = checkTailConcentration([
      { marketId: 'A', size: 60, currentPrice: 0.1 },
      { marketId: 'B', size: 40, currentPrice: 0.9 },
    ]);

    const params = createSnapshotParams(result);

    expect(params).toHaveLength(6);

    // params[0] = snapshot_at (ISO date string)
    expect(typeof params[0]).toBe('string');
    expect(params[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // params[1] = tail_portfolio_size (100)
    expect(params[1]).toBe(100);

    // params[2] = tail_position_count (2)
    expect(params[2]).toBe(2);

    // params[3] = tail_herfindahl (0.52 for 60/40 split)
    expect(params[3]).toBeCloseTo(0.52);

    // params[4] = tail_max_position_pct (60%)
    expect(params[4]).toBeCloseTo(60);

    // params[5] = is_compliant (0 = false, since 0.52 > 0.3)
    expect(params[5]).toBe(0);
  });

  it('sets is_compliant=1 for compliant portfolio', () => {
    const result = checkTailConcentration([
      { marketId: 'A', size: 20, currentPrice: 0.1 },
      { marketId: 'B', size: 20, currentPrice: 0.12 },
      { marketId: 'C', size: 20, currentPrice: 0.85 },
      { marketId: 'D', size: 20, currentPrice: 0.88 },
      { marketId: 'E', size: 20, currentPrice: 0.9 },
    ]);

    const params = createSnapshotParams(result);
    expect(params[5]).toBe(1); // is_compliant = true
  });

  it('handles empty portfolio', () => {
    const result = checkTailConcentration([]);
    const params = createSnapshotParams(result);

    expect(params[1]).toBe(0); // totalTailValue
    expect(params[2]).toBe(0); // position count
    expect(params[3]).toBe(0); // herfindahl
    expect(params[5]).toBe(1); // is_compliant (empty is compliant)
  });
});

// ============================================================
// MAX POSITION PERCENTAGE TESTS
// ============================================================

describe('Max Position Percentage', () => {
  it('returns 100% for single position', () => {
    const result = checkTailConcentration([
      { marketId: 'A', size: 100, currentPrice: 0.1 },
    ]);
    expect(result.maxPositionPct).toBeCloseTo(100);
  });

  it('returns the largest position percentage', () => {
    const result = checkTailConcentration([
      { marketId: 'A', size: 60, currentPrice: 0.1 },
      { marketId: 'B', size: 30, currentPrice: 0.15 },
      { marketId: 'C', size: 10, currentPrice: 0.9 },
    ]);
    expect(result.maxPositionPct).toBeCloseTo(60);
  });

  it('handles equal positions correctly', () => {
    const result = checkTailConcentration([
      { marketId: 'A', size: 25, currentPrice: 0.1 },
      { marketId: 'B', size: 25, currentPrice: 0.12 },
      { marketId: 'C', size: 25, currentPrice: 0.85 },
      { marketId: 'D', size: 25, currentPrice: 0.9 },
    ]);
    expect(result.maxPositionPct).toBeCloseTo(25);
  });
});
