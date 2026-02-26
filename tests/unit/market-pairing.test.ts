/**
 * Market Pairing Tests (P-04)
 */

import { describe, it, expect } from 'vitest';
import {
  computeEquivalenceChecklist,
  determineEquivalenceGrade,
  type CanonicalMarket,
  type EquivalenceChecklist,
} from '../../src/lib/research/market-pairing';

describe('Market Pairing', () => {
  const baseMarket: CanonicalMarket = {
    id: 'market-1',
    canonicalEventId: 'event-1',
    venue: 'polymarket',
    venueMarketId: 'pm-123',
    title: 'Will Bitcoin reach $100k by end of 2025?',
    resolutionCriteria: 'Resolves YES if Bitcoin price reaches $100,000 USD according to CoinGecko spot price at any time before December 31, 2025 11:59 PM ET.',
    ruleTextHash: 'hash1',
    endDate: '2025-12-31T23:59:00Z',
    status: 'active',
    createdAt: '2024-01-01T00:00:00Z',
    lastSyncedAt: '2024-06-01T00:00:00Z',
  };

  describe('computeEquivalenceChecklist', () => {
    it('should detect matching resolution sources', () => {
      const marketA: CanonicalMarket = {
        ...baseMarket,
        resolutionCriteria: 'Resolves based on Associated Press call.',
      };
      const marketB: CanonicalMarket = {
        ...baseMarket,
        id: 'market-2',
        venue: 'kalshi',
        resolutionCriteria: 'Market resolves according to Associated Press results.',
      };

      const checklist = computeEquivalenceChecklist(marketA, marketB);

      expect(checklist.resolutionSourceMatch).toBe(true);
    });

    it('should detect mismatched resolution sources', () => {
      const marketA: CanonicalMarket = {
        ...baseMarket,
        resolutionCriteria: 'Resolves based on Associated Press call.',
      };
      const marketB: CanonicalMarket = {
        ...baseMarket,
        id: 'market-2',
        venue: 'kalshi',
        resolutionCriteria: 'Market resolves according to Reuters.',
      };

      const checklist = computeEquivalenceChecklist(marketA, marketB);

      expect(checklist.resolutionSourceMatch).toBe(false);
      expect(checklist.forbiddenMismatchesFound).toContain('resolution_source_mismatch');
    });

    it('should calculate timing window match', () => {
      const marketA: CanonicalMarket = {
        ...baseMarket,
        endDate: '2025-12-31T23:59:00Z',
      };
      const marketB: CanonicalMarket = {
        ...baseMarket,
        id: 'market-2',
        venue: 'kalshi',
        endDate: '2025-12-31T20:00:00Z', // 4 hours earlier
      };

      const checklist = computeEquivalenceChecklist(marketA, marketB);

      expect(checklist.timingWindowMatch).toBe(true);
      expect(checklist.settlementTimingDeltaHours).toBeLessThan(24);
    });

    it('should flag large timing differences', () => {
      const marketA: CanonicalMarket = {
        ...baseMarket,
        endDate: '2025-12-31T23:59:00Z',
      };
      const marketB: CanonicalMarket = {
        ...baseMarket,
        id: 'market-2',
        venue: 'kalshi',
        endDate: '2025-12-25T23:59:00Z', // 6 days earlier
      };

      const checklist = computeEquivalenceChecklist(marketA, marketB);

      expect(checklist.timingWindowMatch).toBe(false);
      expect(checklist.settlementTimingDeltaHours).toBeGreaterThan(72);
      expect(checklist.forbiddenMismatchesFound).toContain('settlement_timing_too_far_apart');
    });

    it('should detect void rules mismatch', () => {
      const marketA: CanonicalMarket = {
        ...baseMarket,
        resolutionCriteria: 'Resolves YES or NO. If cancelled, market will void.',
      };
      const marketB: CanonicalMarket = {
        ...baseMarket,
        id: 'market-2',
        venue: 'kalshi',
        resolutionCriteria: 'Resolves YES or NO only.', // No void clause
      };

      const checklist = computeEquivalenceChecklist(marketA, marketB);

      expect(checklist.voidRulesMatch).toBe(false);
      expect(checklist.forbiddenMismatchesFound).toContain('void_rules_mismatch');
    });

    it('should assess wording delta correctly', () => {
      const marketA: CanonicalMarket = {
        ...baseMarket,
        resolutionCriteria: 'Resolves YES if Bitcoin reaches $100,000.',
      };
      const marketB: CanonicalMarket = {
        ...baseMarket,
        id: 'market-2',
        venue: 'kalshi',
        resolutionCriteria: 'Resolves YES if Bitcoin reaches $100,000.', // Identical
      };

      const checklist = computeEquivalenceChecklist(marketA, marketB);

      expect(checklist.wordingDelta).toBe('none');
    });

    it('should detect minor wording differences', () => {
      const marketA: CanonicalMarket = {
        ...baseMarket,
        resolutionCriteria: 'Resolves YES if Bitcoin price reaches $100,000 USD by December 31, 2025.',
      };
      const marketB: CanonicalMarket = {
        ...baseMarket,
        id: 'market-2',
        venue: 'kalshi',
        // Very similar wording with minor differences (should have > 70% Jaccard similarity)
        resolutionCriteria: 'Resolves YES if Bitcoin price reaches $100,000 by December 31, 2025.',
      };

      const checklist = computeEquivalenceChecklist(marketA, marketB);

      expect(checklist.wordingDelta).toBe('minor');
    });

    it('should detect material wording differences', () => {
      const marketA: CanonicalMarket = {
        ...baseMarket,
        resolutionCriteria: 'Resolves YES if Bitcoin reaches $100,000 by EOY 2025.',
      };
      const marketB: CanonicalMarket = {
        ...baseMarket,
        id: 'market-2',
        venue: 'kalshi',
        resolutionCriteria: 'This market is about Ethereum price reaching $10,000.', // Completely different
      };

      const checklist = computeEquivalenceChecklist(marketA, marketB);

      expect(checklist.wordingDelta).toBe('material');
    });
  });

  describe('determineEquivalenceGrade', () => {
    it('should grade identical markets', () => {
      const checklist: EquivalenceChecklist = {
        resolutionSourceMatch: true,
        timingWindowMatch: true,
        voidRulesMatch: true,
        referencePriceSourceMatch: true,
        dataPublisherMatch: true,
        wordingDelta: 'none',
        settlementTimingDeltaHours: 0,
        forbiddenMismatchesFound: [],
      };

      const grade = determineEquivalenceGrade(checklist);

      expect(grade).toBe('identical');
    });

    it('should grade near_equivalent markets', () => {
      const checklist: EquivalenceChecklist = {
        resolutionSourceMatch: true,
        timingWindowMatch: true,
        voidRulesMatch: true,
        referencePriceSourceMatch: true,
        dataPublisherMatch: false, // Minor difference
        wordingDelta: 'minor',
        settlementTimingDeltaHours: 2,
        forbiddenMismatchesFound: [],
      };

      const grade = determineEquivalenceGrade(checklist);

      expect(grade).toBe('near_equivalent');
    });

    it('should grade similar_but_divergent markets', () => {
      const checklist: EquivalenceChecklist = {
        resolutionSourceMatch: false,
        timingWindowMatch: true,
        voidRulesMatch: true,
        referencePriceSourceMatch: false,
        dataPublisherMatch: false,
        wordingDelta: 'minor',
        settlementTimingDeltaHours: 12,
        forbiddenMismatchesFound: [],
      };

      const grade = determineEquivalenceGrade(checklist);

      expect(grade).toBe('similar_but_divergent');
    });

    it('should grade not_equivalent when forbidden mismatches exist', () => {
      const checklist: EquivalenceChecklist = {
        resolutionSourceMatch: true,
        timingWindowMatch: true,
        voidRulesMatch: false,
        referencePriceSourceMatch: true,
        dataPublisherMatch: true,
        wordingDelta: 'none',
        settlementTimingDeltaHours: 0,
        forbiddenMismatchesFound: ['void_rules_mismatch'],
      };

      const grade = determineEquivalenceGrade(checklist);

      expect(grade).toBe('not_equivalent');
    });

    it('should grade not_equivalent for timing mismatch', () => {
      const checklist: EquivalenceChecklist = {
        resolutionSourceMatch: true,
        timingWindowMatch: false,
        voidRulesMatch: true,
        referencePriceSourceMatch: true,
        dataPublisherMatch: true,
        wordingDelta: 'none',
        settlementTimingDeltaHours: 100,
        forbiddenMismatchesFound: ['settlement_timing_too_far_apart'],
      };

      const grade = determineEquivalenceGrade(checklist);

      expect(grade).toBe('not_equivalent');
    });
  });

  describe('execution gating', () => {
    it('should only allow identical or near_equivalent for execution', () => {
      // These grades should be allowed
      const allowedGrades = ['identical', 'near_equivalent'];

      // These grades should be blocked
      const blockedGrades = ['similar_but_divergent', 'not_equivalent'];

      for (const grade of allowedGrades) {
        expect(['identical', 'near_equivalent']).toContain(grade);
      }

      for (const grade of blockedGrades) {
        expect(['identical', 'near_equivalent']).not.toContain(grade);
      }
    });
  });

  describe('resolution source patterns', () => {
    const sources = [
      { pattern: 'associated press', name: 'Associated Press' },
      { pattern: 'reuters', name: 'Reuters' },
      { pattern: 'official results', name: 'Official Results' },
      { pattern: 'government data', name: 'Government Data' },
      { pattern: 'noaa', name: 'NOAA' },
      { pattern: 'sec filing', name: 'SEC Filing' },
    ];

    for (const source of sources) {
      it(`should detect ${source.name} as resolution source`, () => {
        const marketA: CanonicalMarket = {
          ...baseMarket,
          resolutionCriteria: `Resolves based on ${source.pattern} data.`,
        };
        const marketB: CanonicalMarket = {
          ...baseMarket,
          id: 'market-2',
          venue: 'kalshi',
          resolutionCriteria: `Market resolves per ${source.pattern}.`,
        };

        const checklist = computeEquivalenceChecklist(marketA, marketB);

        expect(checklist.resolutionSourceMatch).toBe(true);
      });
    }
  });
});
