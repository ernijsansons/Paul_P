/**
 * Paul P - Price Semantics Normalization Tests (P-16)
 *
 * Tests all 5 market mechanics types:
 * - binary_token
 * - orderbook_binary
 * - multi_outcome
 * - fee_adjusted
 * - void_risk
 */

import { describe, it, expect } from 'vitest';
import {
  normalizePrice,
  detectMechanics,
  kalshiCentsToNormalized,
  normalizedToKalshiCents,
} from '../../src/lib/utils/price-semantics';

describe('Binary Token Normalization (Polymarket Standard)', () => {
  it('should normalize standard binary token prices', () => {
    const result = normalizePrice({
      mechanics: 'binary_token',
      yesPrice: 0.60,
      noPrice: 0.40,
    });

    expect(result.pYes).toBeCloseTo(0.60);
    expect(result.pNo).toBeCloseTo(0.40);
    expect(result.pMid).toBeCloseTo(0.60); // (0.60 + (1 - 0.40)) / 2
    expect(result.isValid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('should handle YES + NO > $1.00 (overround)', () => {
    const result = normalizePrice({
      mechanics: 'binary_token',
      yesPrice: 0.55,
      noPrice: 0.50, // Sum = 1.05
    });

    expect(result.vig).toBeCloseTo(0.05);
    expect(result.warnings.some(w => w.includes('Token sum'))).toBe(true);
  });

  it('should handle YES + NO < $1.00 (potential arb)', () => {
    const result = normalizePrice({
      mechanics: 'binary_token',
      yesPrice: 0.48,
      noPrice: 0.48, // Sum = 0.96
    });

    expect(result.warnings.some(w => w.includes('potential arbitrage'))).toBe(true);
  });

  it('should mark as valid when sum is within acceptable range', () => {
    const result = normalizePrice({
      mechanics: 'binary_token',
      yesPrice: 0.50,
      noPrice: 0.50, // Sum = 1.00
    });

    expect(result.isValid).toBe(true);
  });

  it('should handle 50/50 market correctly', () => {
    const result = normalizePrice({
      mechanics: 'binary_token',
      yesPrice: 0.50,
      noPrice: 0.50,
    });

    expect(result.pMid).toBeCloseTo(0.50);
    expect(result.spread).toBeCloseTo(0);
  });
});

describe('Orderbook Binary Normalization (Kalshi)', () => {
  it('should normalize orderbook with bid/ask spread', () => {
    const result = normalizePrice({
      mechanics: 'orderbook_binary',
      yesBid: 0.55,
      yesAsk: 0.60,
      noBid: 0.38,
      noAsk: 0.42,
    });

    expect(result.pYes).toBeCloseTo(0.575); // mid of 0.55-0.60
    expect(result.spread).toBeCloseTo(0.05); // 0.60 - 0.55
    expect(result.isValid).toBe(true);
  });

  it('should detect crossed book (bid > ask)', () => {
    const result = normalizePrice({
      mechanics: 'orderbook_binary',
      yesBid: 0.65,
      yesAsk: 0.60, // Crossed!
      noBid: 0.35,
      noAsk: 0.40,
    });

    expect(result.warnings.some(w => w.includes('crossed book'))).toBe(true);
    expect(result.isValid).toBe(false);
  });

  it('should detect potential arbitrage in orderbook', () => {
    const result = normalizePrice({
      mechanics: 'orderbook_binary',
      yesBid: 0.45,
      yesAsk: 0.48,
      noBid: 0.45,
      noAsk: 0.48, // yesAsk + noAsk = 0.96 < 1.0
    });

    expect(result.warnings.some(w => w.includes('potential arbitrage'))).toBe(true);
  });

  it('should mark as invalid when spread is too wide', () => {
    const result = normalizePrice({
      mechanics: 'orderbook_binary',
      yesBid: 0.30,
      yesAsk: 0.60, // 30 cent spread
      noBid: 0.35,
      noAsk: 0.65,
    });

    expect(result.spread).toBeCloseTo(0.30);
    expect(result.isValid).toBe(false); // spread > 0.20
  });
});

describe('Multi-Outcome Normalization', () => {
  it('should normalize prices that sum to 1.0', () => {
    const result = normalizePrice({
      mechanics: 'multi_outcome',
      outcomePrices: [0.40, 0.35, 0.25], // Sum = 1.0
    });

    expect(result.pYes).toBeCloseTo(0.40); // max prob
    expect(result.isValid).toBe(true);
    expect(result.clvBasis).toBe('p_yes');
  });

  it('should normalize prices that do not sum to 1.0', () => {
    const result = normalizePrice({
      mechanics: 'multi_outcome',
      outcomePrices: [0.45, 0.40, 0.30], // Sum = 1.15
    });

    // Should normalize: 0.45/1.15 ≈ 0.391
    expect(result.pYes).toBeCloseTo(0.45 / 1.15);
    expect(result.vig).toBeCloseTo(0.15);
  });

  it('should flag deviation > 5% from 1.0', () => {
    const result = normalizePrice({
      mechanics: 'multi_outcome',
      outcomePrices: [0.50, 0.50, 0.20], // Sum = 1.20
    });

    expect(result.warnings.some(w => w.includes('deviates'))).toBe(true);
  });

  it('should handle insufficient outcomes', () => {
    const result = normalizePrice({
      mechanics: 'multi_outcome',
      outcomePrices: [0.60],
    });

    expect(result.isValid).toBe(false);
    expect(result.warnings.some(w => w.includes('outcomes'))).toBe(true);
  });
});

describe('Fee-Adjusted Normalization (Kalshi)', () => {
  it('should apply Kalshi taker fee to effective prices', () => {
    const result = normalizePrice({
      mechanics: 'fee_adjusted',
      yesBid: 0.55,
      yesAsk: 0.60,
      takerFeeBps: 107, // 1.07%
    });

    // Effective spread includes round-trip fees
    expect(result.spread).toBeGreaterThan(0.05); // Original spread + 2x fee
    expect(result.vig).toBeCloseTo(0.0214); // 2 * 1.07%
  });

  it('should flag when effective ask exceeds 1.0', () => {
    const result = normalizePrice({
      mechanics: 'fee_adjusted',
      yesBid: 0.97,
      yesAsk: 0.99,
      takerFeeBps: 200, // 2% fee
    });

    // 0.99 + 0.02 = 1.01 > 1.0
    expect(result.warnings.some(w => w.includes('Effective'))).toBe(true);
  });

  it('should use default Kalshi fee when not specified', () => {
    const result = normalizePrice({
      mechanics: 'fee_adjusted',
      yesBid: 0.50,
      yesAsk: 0.55,
    });

    // Default is 107 bps
    expect(result.vig).toBeCloseTo(0.0214);
  });
});

describe('Void Risk Normalization', () => {
  it('should adjust probabilities for void risk', () => {
    const result = normalizePrice({
      mechanics: 'void_risk',
      yesPrice: 0.60,
      noPrice: 0.40,
      voidProbability: 0.10, // 10% void chance
    });

    // Adjusted: 0.60 * 0.90 = 0.54
    expect(result.pYes).toBeCloseTo(0.54);
    expect(result.pNo).toBeCloseTo(0.36);
  });

  it('should warn for high void probability', () => {
    const result = normalizePrice({
      mechanics: 'void_risk',
      yesPrice: 0.60,
      noPrice: 0.40,
      voidProbability: 0.20,
    });

    expect(result.warnings.some(w => w.includes('void probability'))).toBe(true);
  });

  it('should mark as invalid when void probability > 50%', () => {
    const result = normalizePrice({
      mechanics: 'void_risk',
      yesPrice: 0.60,
      noPrice: 0.40,
      voidProbability: 0.60,
    });

    expect(result.isValid).toBe(false);
  });
});

describe('Market Mechanics Detection', () => {
  it('should detect void_risk when market has void history', () => {
    const mechanics = detectMechanics({
      venue: 'polymarket',
      hasOrderbook: true,
      outcomeCount: 2,
      voidHistory: true,
    });

    expect(mechanics).toBe('void_risk');
  });

  it('should detect multi_outcome for 3+ outcomes', () => {
    const mechanics = detectMechanics({
      venue: 'polymarket',
      hasOrderbook: true,
      outcomeCount: 5,
      voidHistory: false,
    });

    expect(mechanics).toBe('multi_outcome');
  });

  it('should detect fee_adjusted for Kalshi', () => {
    const mechanics = detectMechanics({
      venue: 'kalshi',
      hasOrderbook: true,
      outcomeCount: 2,
      voidHistory: false,
    });

    expect(mechanics).toBe('fee_adjusted');
  });

  it('should detect orderbook_binary for Polymarket with orderbook', () => {
    const mechanics = detectMechanics({
      venue: 'polymarket',
      hasOrderbook: true,
      outcomeCount: 2,
      voidHistory: false,
    });

    expect(mechanics).toBe('orderbook_binary');
  });

  it('should detect binary_token for simple Polymarket market', () => {
    const mechanics = detectMechanics({
      venue: 'polymarket',
      hasOrderbook: false,
      outcomeCount: 2,
      voidHistory: false,
    });

    expect(mechanics).toBe('binary_token');
  });
});

describe('Kalshi Price Conversion', () => {
  it('should convert cents to normalized price', () => {
    expect(kalshiCentsToNormalized(95)).toBeCloseTo(0.95);
    expect(kalshiCentsToNormalized(50)).toBeCloseTo(0.50);
    expect(kalshiCentsToNormalized(5)).toBeCloseTo(0.05);
  });

  it('should convert normalized price to cents', () => {
    expect(normalizedToKalshiCents(0.95)).toBe(95);
    expect(normalizedToKalshiCents(0.50)).toBe(50);
    expect(normalizedToKalshiCents(0.05)).toBe(5);
  });

  it('should round cents correctly', () => {
    expect(normalizedToKalshiCents(0.5567)).toBe(56); // Rounds
    expect(normalizedToKalshiCents(0.5534)).toBe(55);
  });
});
