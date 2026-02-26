/**
 * VPIN Computation Tests (P-25)
 */

import { describe, it, expect } from 'vitest';
import {
  computeVPIN,
  createVPINBuckets,
  computeRollingVPIN,
  classifyFlow,
  updateVPIN,
  type Trade,
  type VPINBucket,
} from '../../src/lib/market-data/vpin';

describe('VPIN Computation', () => {
  describe('createVPINBuckets', () => {
    it('should create buckets from trades', () => {
      const trades: Trade[] = [
        { price: 0.55, volume: 100, timestamp: 1000 },
        { price: 0.45, volume: 100, timestamp: 1001 },
        { price: 0.60, volume: 100, timestamp: 1002 },
        { price: 0.40, volume: 100, timestamp: 1003 },
      ];
      const midpoints = [{ timestamp: 0, price: 0.50 }];

      const buckets = createVPINBuckets(trades, midpoints, { bucketSize: 100 });

      expect(buckets.length).toBeGreaterThan(0);
      expect(buckets[0]?.tradeCount).toBeGreaterThan(0);
    });

    it('should classify trades correctly based on midpoint', () => {
      // All buys (above midpoint)
      const buyTrades: Trade[] = [
        { price: 0.55, volume: 20, timestamp: 1000 },
        { price: 0.60, volume: 20, timestamp: 1001 },
      ];
      const midpoints = [{ timestamp: 0, price: 0.50 }];

      const buyBuckets = createVPINBuckets(buyTrades, midpoints, { bucketSize: 500 });

      // All volume should be buy volume
      const totalBuyVolume = buyBuckets.reduce((sum, b) => sum + b.buyVolume, 0);
      const totalSellVolume = buyBuckets.reduce((sum, b) => sum + b.sellVolume, 0);

      expect(totalBuyVolume).toBeGreaterThan(0);
      expect(totalSellVolume).toBe(0);
    });

    it('should respect bucket size', () => {
      const trades: Trade[] = [];
      // Create enough trades to fill multiple buckets
      for (let i = 0; i < 100; i++) {
        trades.push({ price: 0.50, volume: 50, timestamp: 1000 + i });
      }
      const midpoints = [{ timestamp: 0, price: 0.50 }];

      const buckets = createVPINBuckets(trades, midpoints, { bucketSize: 1000 });

      // With 100 trades x $25 notional each = $2500 total
      // Should create at least 2 buckets with $1000 bucket size
      expect(buckets.length).toBeGreaterThanOrEqual(2);
    });

    it('should handle empty trades array', () => {
      const buckets = createVPINBuckets([], [], { bucketSize: 1000 });
      expect(buckets).toEqual([]);
    });

    it('should use explicit trade side when provided', () => {
      const trades: Trade[] = [
        { price: 0.55, volume: 100, timestamp: 1000, side: 'sell' }, // Marked as sell despite price > midpoint
      ];
      const midpoints = [{ timestamp: 0, price: 0.50 }];

      const buckets = createVPINBuckets(trades, midpoints, { bucketSize: 1000 });

      expect(buckets[0]?.sellVolume).toBeGreaterThan(0);
      expect(buckets[0]?.buyVolume).toBe(0);
    });
  });

  describe('computeRollingVPIN', () => {
    it('should compute weighted average of bucket VPINs', () => {
      const buckets: VPINBucket[] = [
        { buyVolume: 50, sellVolume: 50, totalVolume: 100, vpin: 0.0, startTime: 0, endTime: 100, tradeCount: 2 },
        { buyVolume: 100, sellVolume: 0, totalVolume: 100, vpin: 1.0, startTime: 100, endTime: 200, tradeCount: 2 },
      ];

      const vpin = computeRollingVPIN(buckets);

      // Weighted average: (0.0 * 1 + 1.0 * 2) / (1 + 2) = 2/3 ≈ 0.667
      expect(vpin).toBeCloseTo(0.667, 2);
    });

    it('should use only last N buckets', () => {
      const buckets: VPINBucket[] = [];
      for (let i = 0; i < 60; i++) {
        buckets.push({
          buyVolume: 50,
          sellVolume: 50,
          totalVolume: 100,
          vpin: 0.5,
          startTime: i * 100,
          endTime: (i + 1) * 100,
          tradeCount: 2,
        });
      }

      const vpin = computeRollingVPIN(buckets, { rollingBuckets: 50 });

      // Should only use last 50 buckets
      expect(vpin).toBeCloseTo(0.5, 2);
    });

    it('should return 0 for empty buckets', () => {
      const vpin = computeRollingVPIN([]);
      expect(vpin).toBe(0);
    });
  });

  describe('classifyFlow', () => {
    it('should classify normal flow (VPIN < 0.3)', () => {
      const result = classifyFlow(0.2);

      expect(result.classification).toBe('normal');
      expect(result.edgeMultiplier).toBe(1.0);
      expect(result.shouldPause).toBe(false);
    });

    it('should classify elevated flow (0.3 <= VPIN < 0.6)', () => {
      const result = classifyFlow(0.45);

      expect(result.classification).toBe('elevated');
      expect(result.edgeMultiplier).toBe(1.5);
      expect(result.shouldPause).toBe(false);
    });

    it('should classify toxic flow (VPIN >= 0.6)', () => {
      const result = classifyFlow(0.7);

      expect(result.classification).toBe('toxic');
      expect(result.edgeMultiplier).toBe(0);
      expect(result.shouldPause).toBe(true);
    });

    it('should respect custom thresholds', () => {
      const result = classifyFlow(0.4, {
        normalThreshold: 0.5,
        elevatedThreshold: 0.8,
      });

      expect(result.classification).toBe('normal');
    });
  });

  describe('computeVPIN', () => {
    it('should return full VPIN result', () => {
      const trades: Trade[] = [
        { price: 0.55, volume: 100, timestamp: 1000 },
        { price: 0.45, volume: 100, timestamp: 1001 },
        { price: 0.55, volume: 100, timestamp: 1002 },
        { price: 0.45, volume: 100, timestamp: 1003 },
      ];
      const midpoints = [{ timestamp: 0, price: 0.50 }];

      const result = computeVPIN(trades, midpoints);

      expect(result).toHaveProperty('currentVPIN');
      expect(result).toHaveProperty('buckets');
      expect(result).toHaveProperty('flowClassification');
      expect(result).toHaveProperty('edgeMultiplier');
      expect(result).toHaveProperty('shouldPause');
      expect(result).toHaveProperty('lastUpdated');
      expect(result.currentVPIN).toBeGreaterThanOrEqual(0);
      expect(result.currentVPIN).toBeLessThanOrEqual(1);
    });

    it('should compute VPIN close to 0 for balanced flow', () => {
      const trades: Trade[] = [];
      for (let i = 0; i < 100; i++) {
        // Alternating buy/sell
        trades.push({
          price: i % 2 === 0 ? 0.55 : 0.45,
          volume: 20,
          timestamp: 1000 + i,
        });
      }
      const midpoints = [{ timestamp: 0, price: 0.50 }];

      const result = computeVPIN(trades, midpoints);

      // Balanced flow should have low VPIN
      expect(result.currentVPIN).toBeLessThan(0.3);
      expect(result.flowClassification).toBe('normal');
    });

    it('should compute VPIN close to 1 for one-sided flow', () => {
      const trades: Trade[] = [];
      for (let i = 0; i < 100; i++) {
        // All buys
        trades.push({
          price: 0.55,
          volume: 20,
          timestamp: 1000 + i,
        });
      }
      const midpoints = [{ timestamp: 0, price: 0.50 }];

      const result = computeVPIN(trades, midpoints);

      // One-sided flow should have high VPIN
      expect(result.currentVPIN).toBeGreaterThan(0.6);
      expect(result.flowClassification).toBe('toxic');
      expect(result.shouldPause).toBe(true);
    });
  });

  describe('updateVPIN', () => {
    it('should incrementally update VPIN with new trades', () => {
      const existingBuckets: VPINBucket[] = [
        { buyVolume: 500, sellVolume: 500, totalVolume: 1000, vpin: 0.0, startTime: 0, endTime: 100, tradeCount: 10 },
      ];

      const newTrades: Trade[] = [
        { price: 0.55, volume: 100, timestamp: 200 },
        { price: 0.55, volume: 100, timestamp: 201 },
      ];
      const midpoints = [{ timestamp: 0, price: 0.50 }];

      const result = updateVPIN(existingBuckets, newTrades, midpoints);

      expect(result.buckets.length).toBeGreaterThanOrEqual(1);
      expect(result).toHaveProperty('currentVPIN');
      expect(result).toHaveProperty('flowClassification');
    });

    it('should keep only rolling window of buckets', () => {
      const existingBuckets: VPINBucket[] = [];
      for (let i = 0; i < 60; i++) {
        existingBuckets.push({
          buyVolume: 500,
          sellVolume: 500,
          totalVolume: 1000,
          vpin: 0.0,
          startTime: i * 100,
          endTime: (i + 1) * 100,
          tradeCount: 10,
        });
      }

      const result = updateVPIN(existingBuckets, [], [], { rollingBuckets: 50 });

      expect(result.buckets.length).toBeLessThanOrEqual(50);
    });
  });
});
