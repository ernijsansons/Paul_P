/**
 * Execution Quality Tests (Phase B)
 * Tests execution grade computation, slippage tracking, and kill switch detection
 */
import { describe, it, expect } from 'vitest';
import {
  computeExecutionGrade,
  computeExpectedSlippage,
  createExecutionQualityReport,
  computeExecutionMetrics,
  formatExecutionSummary,
  type ExecutionGrade,
  type ExecutionQualityReport,
} from '../../../src/lib/execution/quality';

// ============================================================
// GRADE COMPUTATION TESTS
// ============================================================

describe('computeExecutionGrade', () => {
  describe('EXCELLENT grade (slippage < 50% of expected)', () => {
    it('should return EXCELLENT when slippage ratio < 0.5', () => {
      const grade = computeExecutionGrade(0.3, 0.1);
      expect(grade).toBe('EXCELLENT');
    });

    it('should return EXCELLENT at boundary (0.49)', () => {
      const grade = computeExecutionGrade(0.49, 0.2);
      expect(grade).toBe('EXCELLENT');
    });

    it('should return EXCELLENT with zero slippage', () => {
      const grade = computeExecutionGrade(0, 0);
      expect(grade).toBe('EXCELLENT');
    });
  });

  describe('GOOD grade (50% <= slippage < 100% of expected)', () => {
    it('should return GOOD when slippage ratio = 0.5', () => {
      const grade = computeExecutionGrade(0.5, 0.1);
      expect(grade).toBe('GOOD');
    });

    it('should return GOOD when slippage ratio = 0.75', () => {
      const grade = computeExecutionGrade(0.75, 0.2);
      expect(grade).toBe('GOOD');
    });

    it('should return GOOD at boundary (0.99)', () => {
      const grade = computeExecutionGrade(0.99, 0.3);
      expect(grade).toBe('GOOD');
    });
  });

  describe('ACCEPTABLE grade (100% <= slippage < 150% of expected)', () => {
    it('should return ACCEPTABLE when slippage ratio = 1.0', () => {
      const grade = computeExecutionGrade(1.0, 0.1);
      expect(grade).toBe('ACCEPTABLE');
    });

    it('should return ACCEPTABLE when slippage ratio = 1.25', () => {
      const grade = computeExecutionGrade(1.25, 0.2);
      expect(grade).toBe('ACCEPTABLE');
    });

    it('should return ACCEPTABLE at boundary (1.49)', () => {
      const grade = computeExecutionGrade(1.49, 0.3);
      expect(grade).toBe('ACCEPTABLE');
    });
  });

  describe('POOR grade (slippage >= 150% of expected)', () => {
    it('should return POOR when slippage ratio = 1.5', () => {
      const grade = computeExecutionGrade(1.5, 0.1);
      expect(grade).toBe('POOR');
    });

    it('should return POOR when slippage ratio = 2.0', () => {
      const grade = computeExecutionGrade(2.0, 0.5);
      expect(grade).toBe('POOR');
    });

    it('should return POOR for very high slippage', () => {
      const grade = computeExecutionGrade(5.0, 1.0);
      expect(grade).toBe('POOR');
    });
  });
});

// ============================================================
// EXPECTED SLIPPAGE COMPUTATION TESTS
// ============================================================

describe('computeExpectedSlippage', () => {
  describe('base slippage from spread', () => {
    it('should compute base slippage as 25% of spread', () => {
      // With spread=4¢, base = 1¢
      const slippage = computeExpectedSlippage(4, 10, 500, 0.3, 10000);
      // Base: 4 * 0.25 = 1.0
      // Impact ratio: min(1, 500/10000) = 0.05, impact = 4 * 0.05 * 0.5 = 0.1
      // Toxicity: (1.0 + 0.1) * 0.25 * (1 + 0.3) = 0.357
      // Total: ~1.457
      expect(slippage).toBeGreaterThan(1.0);
      expect(slippage).toBeLessThan(2.0);
    });

    it('should increase slippage with wider spreads', () => {
      const slippage2 = computeExpectedSlippage(2, 10, 500, 0.3, 10000);
      const slippage10 = computeExpectedSlippage(10, 10, 500, 0.3, 10000);
      expect(slippage10).toBeGreaterThan(slippage2);
    });
  });

  describe('impact from order size relative to depth', () => {
    it('should increase impact with larger order size', () => {
      const small = computeExpectedSlippage(4, 5, 100, 0.3, 1000);
      const large = computeExpectedSlippage(4, 50, 500, 0.3, 1000);
      expect(large).toBeGreaterThan(small);
    });

    it('should increase impact as depth shrinks', () => {
      const deepMarket = computeExpectedSlippage(4, 20, 1000, 0.3, 10000);
      const shallowMarket = computeExpectedSlippage(4, 20, 1000, 0.3, 1000);
      expect(shallowMarket).toBeGreaterThan(deepMarket);
    });
  });

  describe('toxicity adjustment from VPIN', () => {
    it('should increase slippage with higher VPIN', () => {
      const lowToxicity = computeExpectedSlippage(4, 10, 500, 0.2, 10000);
      const highToxicity = computeExpectedSlippage(4, 10, 500, 0.8, 10000);
      expect(highToxicity).toBeGreaterThan(lowToxicity);
    });

    it('should return minimum of 0.1 cents', () => {
      const slippage = computeExpectedSlippage(0.1, 1, 1, 0, 1000000);
      expect(slippage).toBeGreaterThanOrEqual(0.1);
    });
  });

  describe('edge cases', () => {
    it('should handle zero depth gracefully', () => {
      const slippage = computeExpectedSlippage(4, 10, 500, 0.3, 0);
      expect(slippage).toBeGreaterThan(0);
    });

    it('should handle zero order size', () => {
      const slippage = computeExpectedSlippage(4, 0, 0, 0.3, 10000);
      expect(slippage).toBeGreaterThan(0);
    });
  });
});

// ============================================================
// EXECUTION QUALITY REPORT TESTS
// ============================================================

describe('createExecutionQualityReport', () => {
  const baseReport = {
    orderId: 'order-1',
    ticker: 'TEST-MARKET',
    side: 'yes' as const,
    limitPrice: 50,
    fillPrice: 50.5,
    orderSize: 10,
    edgePercent: 2.0,
    marketSpread: 2,
    vpin: 0.4,
    marketDepth: 5000,
    timeOfDay: '10:30',
  };

  it('should compute realized slippage as absolute difference', () => {
    const report = createExecutionQualityReport(
      ...Object.values(baseReport)
    );
    expect(report.realizedSlippage).toBe(0.5); // 50.5 - 50
  });

  it('should compute slippage ratio correctly', () => {
    const report = createExecutionQualityReport(
      ...Object.values(baseReport)
    );
    // Realized = 0.5, Expected should be computed by formula
    expect(report.slippageRatio).toBeGreaterThan(0);
    expect(report.slippageRatio).toBeLessThan(2);
  });

  it('should compute slippage vs edge ratio', () => {
    const report = createExecutionQualityReport(
      ...Object.values(baseReport)
    );
    // Slippage = 0.5¢, Edge = 2.0%, so ratio = (0.5/50/100) / 0.02 = 0.05
    expect(report.slippageVsEdgeRatio).toBeGreaterThan(0);
  });

  it('should assign execution grade based on slippage ratio', () => {
    const report = createExecutionQualityReport(
      ...Object.values(baseReport)
    );
    expect(['EXCELLENT', 'GOOD', 'ACCEPTABLE', 'POOR']).toContain(
      report.executionGrade
    );
  });

  it('should include all report fields', () => {
    const report = createExecutionQualityReport(
      ...Object.values(baseReport)
    );
    expect(report).toHaveProperty('orderId');
    expect(report).toHaveProperty('ticker');
    expect(report).toHaveProperty('side');
    expect(report).toHaveProperty('limitPrice');
    expect(report).toHaveProperty('fillPrice');
    expect(report).toHaveProperty('orderSize');
    expect(report).toHaveProperty('edgePercent');
    expect(report).toHaveProperty('realizedSlippage');
    expect(report).toHaveProperty('expectedSlippage');
    expect(report).toHaveProperty('slippageRatio');
    expect(report).toHaveProperty('slippageVsEdgeRatio');
    expect(report).toHaveProperty('executionGrade');
    expect(report).toHaveProperty('timestamp');
  });

  it('should handle NO side correctly', () => {
    const noReport = createExecutionQualityReport(
      'order-2',
      'TEST-MARKET',
      'no' as const,
      50,
      49.8,
      10,
      2.0,
      2,
      0.4,
      5000,
      '10:30'
    );
    expect(noReport.side).toBe('no');
    expect(noReport.realizedSlippage).toBeCloseTo(0.2, 1);
  });
});

// ============================================================
// EXECUTION METRICS TESTS
// ============================================================

describe('computeExecutionMetrics', () => {
  const createReport = (grade: ExecutionGrade, slippageVsEdge: number): ExecutionQualityReport => ({
    orderId: `order-${grade}`,
    ticker: 'TEST',
    side: 'yes',
    limitPrice: 50,
    expectedSlippage: 1.0,
    realizedSlippage: grade === 'EXCELLENT' ? 0.3 : grade === 'GOOD' ? 0.7 : grade === 'ACCEPTABLE' ? 1.2 : 2.0,
    slippageRatio: grade === 'EXCELLENT' ? 0.3 : grade === 'GOOD' ? 0.7 : grade === 'ACCEPTABLE' ? 1.2 : 2.0,
    executionGrade: grade,
    edgePercent: 1.5,
    slippageVsEdgeRatio: slippageVsEdge,
    fillPrice: 50.5,
    orderSize: 10,
    orderNotional: 500,
    marketDepth: 5000,
    marketSpread: 2,
    vpin: 0.4,
    timestamp: new Date().toISOString(),
  });

  it('should aggregate empty report list', () => {
    const metrics = computeExecutionMetrics([]);
    expect(metrics.totalOrders).toBe(0);
    expect(metrics.excellentCount).toBe(0);
    expect(metrics.goodCount).toBe(0);
    expect(metrics.averageSlippage).toBe(0);
    expect(metrics.killSwitchTriggered).toBe(false);
  });

  it('should count grades correctly', () => {
    const reports = [
      createReport('EXCELLENT', 0.1),
      createReport('GOOD', 0.3),
      createReport('ACCEPTABLE', 0.4),
      createReport('POOR', 0.6),
    ];
    const metrics = computeExecutionMetrics(reports);
    expect(metrics.totalOrders).toBe(4);
    expect(metrics.excellentCount).toBe(1);
    expect(metrics.goodCount).toBe(1);
    expect(metrics.acceptableCount).toBe(1);
    expect(metrics.poorCount).toBe(1);
  });

  it('should compute average grade score', () => {
    // 4=excellent, 3=good, 2=acceptable, 1=poor
    // (4 + 3 + 2 + 1) / 4 = 2.5
    const reports = [
      createReport('EXCELLENT', 0.1),
      createReport('GOOD', 0.3),
      createReport('ACCEPTABLE', 0.4),
      createReport('POOR', 0.6),
    ];
    const metrics = computeExecutionMetrics(reports);
    expect(metrics.averageGradeScore).toBe(2.5);
  });

  it('should detect kill switch trigger (slippageVsEdge > 0.5)', () => {
    const reports = [
      createReport('ACCEPTABLE', 0.4), // No trigger
      createReport('POOR', 0.6), // Trigger
    ];
    const metrics = computeExecutionMetrics(reports);
    expect(metrics.killSwitchTriggered).toBe(true);
    expect(metrics.killSwitchCount).toBe(1);
  });

  it('should not trigger kill switch if all slippageVsEdge <= 0.5', () => {
    const reports = [
      createReport('EXCELLENT', 0.1),
      createReport('GOOD', 0.3),
      createReport('ACCEPTABLE', 0.5), // Boundary, not triggered
    ];
    const metrics = computeExecutionMetrics(reports);
    expect(metrics.killSwitchTriggered).toBe(false);
    expect(metrics.killSwitchCount).toBe(0);
  });

  it('should compute average slippage across reports', () => {
    // Slippages: 0.3, 0.7, 1.2, 2.0
    // Average: 1.05
    const reports = [
      createReport('EXCELLENT', 0.1),
      createReport('GOOD', 0.3),
      createReport('ACCEPTABLE', 0.4),
      createReport('POOR', 0.6),
    ];
    const metrics = computeExecutionMetrics(reports);
    expect(metrics.averageSlippage).toBeCloseTo(1.05, 1);
  });
});

// ============================================================
// EXECUTION SUMMARY FORMATTING TESTS
// ============================================================

describe('formatExecutionSummary', () => {
  it('should format grade distribution', () => {
    const metrics = {
      totalOrders: 10,
      excellentCount: 5,
      goodCount: 3,
      acceptableCount: 1,
      poorCount: 1,
      averageSlippage: 0.5,
      averageSlippageRatio: 0.75,
      averageGradeScore: 3.4,
      killSwitchTriggered: false,
      killSwitchCount: 0,
    };
    const summary = formatExecutionSummary(metrics);
    expect(summary).toContain('5E/3G/1A/1P');
  });

  it('should include average slippage in cents', () => {
    const metrics = {
      totalOrders: 5,
      excellentCount: 2,
      goodCount: 2,
      acceptableCount: 1,
      poorCount: 0,
      averageSlippage: 0.25,
      averageSlippageRatio: 0.5,
      averageGradeScore: 3.2,
      killSwitchTriggered: false,
      killSwitchCount: 0,
    };
    const summary = formatExecutionSummary(metrics);
    expect(summary).toContain('25.0');
    expect(summary.toLowerCase()).toContain('slippage');
  });

  it('should include kill switch status', () => {
    const metricsTriggered = {
      totalOrders: 3,
      excellentCount: 1,
      goodCount: 1,
      acceptableCount: 1,
      poorCount: 0,
      averageSlippage: 0.75,
      averageSlippageRatio: 1.0,
      averageGradeScore: 2.7,
      killSwitchTriggered: true,
      killSwitchCount: 1,
    };
    const summary = formatExecutionSummary(metricsTriggered);
    expect(summary.toLowerCase()).toContain('kill switch');
  });
});
