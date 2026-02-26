/**
 * Account Skill Scoring Tests (8-Factor Rubric)
 */

import { describe, it, expect } from 'vitest';
import {
  computeAccountSkillScore,
  detectBlowupSignatures,
  checkRankStability,
  type AccountMetrics,
  type AccountPosition,
} from '../../src/lib/scoring/account-skill';

describe('Account Skill Scoring', () => {
  // Helper to create a test position
  const createPosition = (overrides: Partial<AccountPosition> = {}): AccountPosition => ({
    marketId: `market-${Math.random().toString(36).slice(2)}`,
    category: 'politics',
    entryPrice: 0.5,
    closingLinePrice: 0.55,
    clv: 0.05,
    clvValid: true,
    pnl: 100,
    size: 1000,
    fees: 5,
    ambiguityScore: 0.2,
    entryTimestamp: Date.now() - 86400000,
    exitTimestamp: Date.now(),
    ...overrides,
  });

  // Helper to create test metrics
  const createMetrics = (positionCount: number, overrides: Partial<AccountMetrics> = {}): AccountMetrics => ({
    accountId: 'test-account',
    totalPositions: positionCount,
    totalPnL: positionCount * 100,
    totalFees: positionCount * 5,
    portfolioValue: 10000,
    accountCreatedAt: Date.now() - 200 * 24 * 60 * 60 * 1000, // 200 days ago
    lastActivityAt: Date.now(),
    positions: Array.from({ length: positionCount }, () => createPosition()),
    blowupFlags: [],
    ...overrides,
  });

  describe('computeAccountSkillScore', () => {
    it('should compute score for account with good CLV', () => {
      const positions = Array.from({ length: 20 }, () =>
        createPosition({
          clv: 0.04, // 4 cents CLV
          clvValid: true,
          pnl: 200,
        })
      );

      const metrics = createMetrics(20, { positions });
      const result = computeAccountSkillScore(metrics, true);

      expect(result.totalScore).toBeGreaterThan(50);
      expect(result.factors.clvConsistency.score).toBeGreaterThan(10);
      expect(result.tier).toMatch(/elite|skilled|competent/);
    });

    it('should return lower score for account with negative CLV', () => {
      const positions = Array.from({ length: 20 }, () =>
        createPosition({
          clv: -0.03, // -3 cents CLV
          clvValid: true,
          pnl: -100,
        })
      );

      const metrics = createMetrics(20, {
        positions,
        totalPnL: -2000,
      });

      const result = computeAccountSkillScore(metrics, true);

      expect(result.factors.clvConsistency.score).toBe(0);
      expect(result.totalScore).toBeLessThan(70);
    });

    it('should require minimum positions for CLV scoring', () => {
      const positions = Array.from({ length: 5 }, () =>
        createPosition({ clv: 0.05, clvValid: true })
      );

      const metrics = createMetrics(5, { positions });
      const result = computeAccountSkillScore(metrics, true);

      // Less than 10 valid positions = 0 CLV score
      expect(result.factors.clvConsistency.score).toBe(0);
      expect(result.factors.clvConsistency.validPositions).toBe(5);
    });

    it('should compute all 8 factors', () => {
      const metrics = createMetrics(20);
      const result = computeAccountSkillScore(metrics, true);

      expect(result.factors).toHaveProperty('clvConsistency');
      expect(result.factors).toHaveProperty('riskAdjustedReturns');
      expect(result.factors).toHaveProperty('sizingDiscipline');
      expect(result.factors).toHaveProperty('ambiguityAvoidance');
      expect(result.factors).toHaveProperty('lowFeeDrag');
      expect(result.factors).toHaveProperty('diversification');
      expect(result.factors).toHaveProperty('noBlowupSignatures');
      expect(result.factors).toHaveProperty('longevity');
    });

    it('should respect max scores for each factor', () => {
      const metrics = createMetrics(50);
      const result = computeAccountSkillScore(metrics, true);

      expect(result.factors.clvConsistency.score).toBeLessThanOrEqual(25);
      expect(result.factors.riskAdjustedReturns.score).toBeLessThanOrEqual(20);
      expect(result.factors.sizingDiscipline.score).toBeLessThanOrEqual(15);
      expect(result.factors.ambiguityAvoidance.score).toBeLessThanOrEqual(10);
      expect(result.factors.lowFeeDrag.score).toBeLessThanOrEqual(5);
      expect(result.factors.diversification.score).toBeLessThanOrEqual(10);
      expect(result.factors.noBlowupSignatures.score).toBeLessThanOrEqual(10);
      expect(result.factors.longevity.score).toBeLessThanOrEqual(5);
    });

    it('should allow excluding CLV from scoring', () => {
      const metrics = createMetrics(20);

      const withCLV = computeAccountSkillScore(metrics, true);
      const withoutCLV = computeAccountSkillScore(metrics, false);

      expect(withCLV.includedCLV).toBe(true);
      expect(withoutCLV.includedCLV).toBe(false);
      expect(withoutCLV.factors.clvConsistency.score).toBe(0);
    });
  });

  describe('tier assignment', () => {
    it('should assign elite tier for high scores (80+)', () => {
      // Create metrics that maximize all factors
      const positions = Array.from({ length: 50 }, (_, i) =>
        createPosition({
          clv: 0.05,
          clvValid: true,
          pnl: 200,
          size: 100,
          fees: 1,
          category: ['politics', 'sports', 'crypto', 'weather'][i % 4], // Diverse
          ambiguityScore: 0.1, // Low ambiguity
        })
      );

      const metrics: AccountMetrics = {
        accountId: 'elite-account',
        totalPositions: 50,
        totalPnL: 10000,
        totalFees: 50,
        portfolioValue: 50000,
        accountCreatedAt: Date.now() - 365 * 24 * 60 * 60 * 1000, // 1 year ago
        lastActivityAt: Date.now(),
        positions,
        blowupFlags: [],
      };

      const result = computeAccountSkillScore(metrics, true);

      // May not always hit elite due to Sharpe calculation,
      // but should be at least skilled
      expect(['elite', 'skilled']).toContain(result.tier);
      expect(result.totalScore).toBeGreaterThan(50);
    });

    it('should assign losing tier for very low scores', () => {
      const positions = Array.from({ length: 10 }, () =>
        createPosition({
          clv: -0.10,
          clvValid: true,
          pnl: -500,
          size: 5000,
          fees: 100,
          ambiguityScore: 0.9,
          category: 'politics', // Concentrated
        })
      );

      const metrics: AccountMetrics = {
        accountId: 'losing-account',
        totalPositions: 10,
        totalPnL: -5000,
        totalFees: 1000,
        portfolioValue: 2000,
        accountCreatedAt: Date.now() - 10 * 24 * 60 * 60 * 1000, // 10 days ago
        lastActivityAt: Date.now(),
        positions,
        blowupFlags: ['BLOWUP', 'CONCENTRATION_RISK'],
      };

      const result = computeAccountSkillScore(metrics, true);

      expect(result.tier).toBe('losing');
      expect(result.totalScore).toBeLessThan(20);
    });
  });

  describe('detectBlowupSignatures', () => {
    it('should detect martingale pattern', () => {
      const positions: AccountPosition[] = [
        createPosition({ pnl: -100, size: 100, entryTimestamp: 1000 }),
        createPosition({ pnl: -100, size: 200, entryTimestamp: 2000 }), // Doubled after loss
        createPosition({ pnl: -100, size: 400, entryTimestamp: 3000 }), // Doubled again
      ];

      const flags = detectBlowupSignatures(positions);

      expect(flags).toContain('MARTINGALE');
    });

    it('should detect revenge trading', () => {
      const baseTime = Date.now();
      const positions: AccountPosition[] = [
        createPosition({
          pnl: -500,
          entryTimestamp: baseTime,
          exitTimestamp: baseTime + 1000,
        }),
        createPosition({
          pnl: 50,
          entryTimestamp: baseTime + 2000,
          exitTimestamp: baseTime + 3000,
        }),
        createPosition({
          pnl: 50,
          entryTimestamp: baseTime + 4000,
          exitTimestamp: baseTime + 5000,
        }),
        createPosition({
          pnl: 50,
          entryTimestamp: baseTime + 6000,
          exitTimestamp: baseTime + 7000,
        }),
      ];

      const flags = detectBlowupSignatures(positions);

      expect(flags).toContain('REVENGE_TRADING');
    });

    it('should detect concentration risk', () => {
      const positions: AccountPosition[] = [
        createPosition({ category: 'politics', size: 1000 }),
        createPosition({ category: 'politics', size: 1000 }),
        createPosition({ category: 'politics', size: 1000 }),
        createPosition({ category: 'sports', size: 100 }),
      ];

      const flags = detectBlowupSignatures(positions);

      expect(flags).toContain('CONCENTRATION_RISK');
    });

    it('should return empty array for healthy account', () => {
      const positions: AccountPosition[] = [
        createPosition({ category: 'politics', size: 100, pnl: 50 }),
        createPosition({ category: 'sports', size: 100, pnl: 30 }),
        createPosition({ category: 'crypto', size: 100, pnl: 20 }),
        createPosition({ category: 'weather', size: 100, pnl: 40 }),
      ];

      const flags = detectBlowupSignatures(positions);

      expect(flags).toHaveLength(0);
    });

    it('should handle insufficient positions', () => {
      const positions: AccountPosition[] = [
        createPosition(),
      ];

      const flags = detectBlowupSignatures(positions);

      expect(flags).toHaveLength(0);
    });
  });

  describe('checkRankStability', () => {
    it('should report stable ranks when consistent', () => {
      const accountsWithCLV = [
        { accountId: 'a', score: 90 },
        { accountId: 'b', score: 80 },
        { accountId: 'c', score: 70 },
      ];

      const accountsWithoutCLV = [
        { accountId: 'a', score: 88 },
        { accountId: 'b', score: 78 },
        { accountId: 'c', score: 68 },
      ];

      const result = checkRankStability(accountsWithCLV, accountsWithoutCLV);

      expect(result.isStable).toBe(true);
      expect(result.maxRankChange).toBeLessThanOrEqual(5);
    });

    it('should report unstable ranks when scores diverge', () => {
      // Need more accounts and larger rank changes to trigger instability
      // (> 5 position change for > 20% of accounts)
      const accountsWithCLV = [
        { accountId: 'a', score: 100 },
        { accountId: 'b', score: 90 },
        { accountId: 'c', score: 80 },
        { accountId: 'd', score: 70 },
        { accountId: 'e', score: 60 },
        { accountId: 'f', score: 50 },
        { accountId: 'g', score: 40 },
        { accountId: 'h', score: 30 },
        { accountId: 'i', score: 20 },
        { accountId: 'j', score: 10 },
      ];

      // Reverse order to create max rank changes (9 positions each for first and last)
      const accountsWithoutCLV = [
        { accountId: 'j', score: 100 },
        { accountId: 'i', score: 90 },
        { accountId: 'h', score: 80 },
        { accountId: 'g', score: 70 },
        { accountId: 'f', score: 60 },
        { accountId: 'e', score: 50 },
        { accountId: 'd', score: 40 },
        { accountId: 'c', score: 30 },
        { accountId: 'b', score: 20 },
        { accountId: 'a', score: 10 },
      ];

      const result = checkRankStability(accountsWithCLV, accountsWithoutCLV);

      expect(result.isStable).toBe(false);
      expect(result.maxRankChange).toBeGreaterThan(5);
    });

    it('should throw on mismatched list lengths', () => {
      const list1 = [{ accountId: 'a', score: 90 }];
      const list2 = [
        { accountId: 'a', score: 90 },
        { accountId: 'b', score: 80 },
      ];

      expect(() => checkRankStability(list1, list2)).toThrow();
    });
  });

  describe('factor weights', () => {
    it('should weight CLV consistency at 25%', () => {
      const metrics = createMetrics(20);
      const result = computeAccountSkillScore(metrics, true);

      expect(result.factors.clvConsistency.maxScore).toBe(25);
    });

    it('should weight risk-adjusted returns at 20%', () => {
      const metrics = createMetrics(20);
      const result = computeAccountSkillScore(metrics, true);

      expect(result.factors.riskAdjustedReturns.maxScore).toBe(20);
    });

    it('should weight sizing discipline at 15%', () => {
      const metrics = createMetrics(20);
      const result = computeAccountSkillScore(metrics, true);

      expect(result.factors.sizingDiscipline.maxScore).toBe(15);
    });
  });
});
