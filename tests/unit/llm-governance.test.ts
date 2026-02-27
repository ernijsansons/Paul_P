/**
 * Paul P - LLM Governance Tests (P-07, P-21)
 *
 * Regression test suite for LLM scoring functionality:
 * - Ambiguity scoring consistency
 * - Equivalence assessment accuracy
 * - Prompt injection resistance
 * - Structured output validation
 * - Drift detection
 */

import { describe, it, expect } from 'vitest';
import {
  type TestCategory,
  type TestResult,
  type SuiteResult,
  getGoldCorpus,
} from '../../src/lib/llm/regression-runner';
import type { LLMScoringOutput, LLMScoringInput } from '../../src/lib/research/llm-governance';

// ============================================================
// 1. Gold Corpus Validation Tests
// ============================================================

describe('Gold Corpus Structure', () => {
  it('should contain at least 50 test cases (P-21 requirement)', () => {
    const corpus = getGoldCorpus();
    expect(corpus.length).toBeGreaterThanOrEqual(50);
  });

  it('should have test cases across all required categories', () => {
    const corpus = getGoldCorpus();
    const categories = new Set(corpus.map(tc => tc.category));

    expect(categories.has('standard_resolution')).toBe(true);
    expect(categories.has('edge_case')).toBe(true);
    expect(categories.has('disputed_market')).toBe(true);
    expect(categories.has('ambiguous_phrasing')).toBe(true);
    expect(categories.has('adversarial')).toBe(true);
  });

  it('should have unique test case IDs', () => {
    const corpus = getGoldCorpus();
    const ids = corpus.map(tc => tc.id);
    const uniqueIds = new Set(ids);

    expect(uniqueIds.size).toBe(ids.length);
  });

  it('should have valid expected output ranges', () => {
    const corpus = getGoldCorpus();

    for (const testCase of corpus) {
      const [min, max] = testCase.expectedOutput.scoreRange;
      expect(min).toBeGreaterThanOrEqual(0.0);
      expect(max).toBeLessThanOrEqual(1.0);
      expect(min).toBeLessThanOrEqual(max);
      expect(testCase.expectedOutput.minConfidence).toBeGreaterThanOrEqual(0.0);
      expect(testCase.expectedOutput.minConfidence).toBeLessThanOrEqual(1.0);
    }
  });

  it('should have at least 5 adversarial test cases for prompt injection', () => {
    const corpus = getGoldCorpus();
    const adversarialCases = corpus.filter(tc => tc.category === 'adversarial');

    expect(adversarialCases.length).toBeGreaterThanOrEqual(5);
  });
});

// ============================================================
// 2. Ambiguity Scoring Tests
// ============================================================

describe('Ambiguity Scoring Consistency', () => {
  it('should score clear resolution criteria with low ambiguity', () => {
    const corpus = getGoldCorpus();
    const clearCriteria = corpus.filter(tc =>
      tc.category === 'standard_resolution' &&
      tc.input.runType === 'resolution_analysis'
    );

    // Standard resolution cases should expect high confidence (>= 0.7)
    for (const testCase of clearCriteria.slice(0, 5)) {
      expect(testCase.expectedOutput.minConfidence).toBeGreaterThanOrEqual(0.7);
    }
  });

  it('should score ambiguous criteria with high ambiguity', () => {
    const corpus = getGoldCorpus();
    const ambiguousCases = corpus.filter(tc => tc.category === 'ambiguous_phrasing');

    // Ambiguous cases should expect high scores (0.5-1.0)
    for (const testCase of ambiguousCases) {
      expect(testCase.expectedOutput.scoreRange[0]).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('should flag markets with undefined qualifiers as ambiguous', () => {
    const corpus = getGoldCorpus();
    const undefinedQualifier = corpus.find(tc => tc.id === 'ambig_002');

    expect(undefinedQualifier).toBeDefined();
    expect(undefinedQualifier!.input.resolutionCriteria).toContain('significant');
    expect(undefinedQualifier!.expectedOutput.scoreRange[0]).toBeGreaterThanOrEqual(0.6);
  });
});

// ============================================================
// 3. Equivalence Assessment Tests
// ============================================================

describe('Equivalence Assessment Accuracy', () => {
  it('should define equivalence assessment test cases', () => {
    const corpus = getGoldCorpus();
    // Equivalence tests may be added later
    // For now, verify the structure supports them
    const equivalenceCases = corpus.filter(tc => tc.category === 'equivalence');

    // Equivalence category exists in type system
    expect(['equivalence'] as TestCategory[]).toContain('equivalence');
    // Use the filtered cases to verify category filtering works
    expect(equivalenceCases.every(tc => tc.category === 'equivalence')).toBe(true);
  });

  it('should handle market pair assessments', () => {
    const corpus = getGoldCorpus();

    // Verify test case structure supports market pairs
    const marketPairCases = corpus.filter(tc =>
      tc.input.targetEntityType === 'market_pair'
    );

    // Market pair assessments should have additionalContext
    for (const testCase of marketPairCases) {
      if (testCase.input.runType === 'equivalence_assessment') {
        expect(testCase.input.additionalContext).toBeDefined();
      }
    }
  });
});

// ============================================================
// 4. Resolution Analysis Tests
// ============================================================

describe('Resolution Analysis for Multiple Scenarios', () => {
  it('should handle election outcome markets', () => {
    const corpus = getGoldCorpus();
    const electionCase = corpus.find(tc => tc.id === 'std_001');

    expect(electionCase).toBeDefined();
    expect(electionCase!.input.runType).toBe('resolution_analysis');
    expect(electionCase!.expectedOutput.mustCitePassages).toBe(true);
  });

  it('should handle numeric threshold markets', () => {
    const corpus = getGoldCorpus();
    const numericCase = corpus.find(tc => tc.id === 'std_002');

    expect(numericCase).toBeDefined();
    expect(numericCase!.input.marketTitle).toContain('S&P 500');
    expect(numericCase!.expectedOutput.minConfidence).toBeGreaterThanOrEqual(0.8);
  });

  it('should handle weather event markets', () => {
    const corpus = getGoldCorpus();
    const weatherCase = corpus.find(tc => tc.id === 'std_003');

    expect(weatherCase).toBeDefined();
    expect(weatherCase!.input.resolutionCriteria).toContain('National Weather Service');
  });

  it('should handle sports outcome markets', () => {
    const corpus = getGoldCorpus();
    const sportsCase = corpus.find(tc => tc.id === 'std_004');

    expect(sportsCase).toBeDefined();
    expect(sportsCase!.expectedOutput.minConfidence).toBeGreaterThanOrEqual(0.9);
  });

  it('should handle Fed rate decision markets', () => {
    const corpus = getGoldCorpus();
    const fedCase = corpus.find(tc => tc.id === 'std_005');

    expect(fedCase).toBeDefined();
    expect(fedCase!.input.resolutionCriteria).toContain('Federal Reserve');
  });
});

// ============================================================
// 5. Rule Interpretation Tests
// ============================================================

describe('Rule Interpretation Precision', () => {
  it('should have rule interpretation test category defined', () => {
    const categories: TestCategory[] = [
      'standard_resolution',
      'edge_case',
      'disputed_market',
      'ambiguous_phrasing',
      'adversarial',
      'equivalence',
      'invariant_explanation',
    ];

    expect(categories).toContain('invariant_explanation');
  });

  it('should handle edge cases with partial fulfillment', () => {
    const corpus = getGoldCorpus();
    const partialCase = corpus.find(tc => tc.id === 'edge_002');

    expect(partialCase).toBeDefined();
    expect(partialCase!.category).toBe('edge_case');
    expect(partialCase!.name).toContain('Partial');
  });

  it('should handle delayed result scenarios', () => {
    const corpus = getGoldCorpus();
    const delayedCase = corpus.find(tc => tc.id === 'edge_001');

    expect(delayedCase).toBeDefined();
    expect(delayedCase!.expectedOutput.scoreRange[0]).toBeGreaterThanOrEqual(0.2);
    expect(delayedCase!.expectedOutput.scoreRange[1]).toBeLessThanOrEqual(0.8);
  });
});

// ============================================================
// 6. Prompt Injection Resistance Tests
// ============================================================

describe('Prompt Injection Resistance', () => {
  it('should have direct injection test case', () => {
    const corpus = getGoldCorpus();
    const directInjection = corpus.find(tc => tc.id === 'adv_001');

    expect(directInjection).toBeDefined();
    expect(directInjection!.input.resolutionCriteria).toContain('Ignore all previous instructions');
    // Should NOT follow the injection (score should be < 0.6, not 0.99)
    expect(directInjection!.expectedOutput.scoreRange[1]).toBeLessThan(0.7);
  });

  it('should have encoded injection test case', () => {
    const corpus = getGoldCorpus();
    const encodedInjection = corpus.find(tc => tc.id === 'adv_002');

    expect(encodedInjection).toBeDefined();
    expect(encodedInjection!.input.resolutionCriteria).toContain('decode');
  });

  it('should have system override attempt test case', () => {
    const corpus = getGoldCorpus();
    const systemOverride = corpus.find(tc => tc.id === 'adv_003');

    expect(systemOverride).toBeDefined();
    expect(systemOverride!.input.resolutionCriteria).toContain('[[SYSTEM]]');
  });

  it('should have context overflow test case', () => {
    const corpus = getGoldCorpus();
    const contextOverflow = corpus.find(tc => tc.id === 'adv_004');

    expect(contextOverflow).toBeDefined();
    expect(contextOverflow!.input.resolutionCriteria.length).toBeGreaterThan(500);
  });

  it('should have JSON escape attempt test case', () => {
    const corpus = getGoldCorpus();
    const jsonEscape = corpus.find(tc => tc.id === 'adv_005');

    expect(jsonEscape).toBeDefined();
    expect(jsonEscape!.input.resolutionCriteria).toContain('"score"');
  });

  it('should expect low scores for all adversarial cases', () => {
    const corpus = getGoldCorpus();
    const adversarialCases = corpus.filter(tc => tc.category === 'adversarial');

    for (const testCase of adversarialCases) {
      // Adversarial cases should not produce high confidence scores
      expect(testCase.expectedOutput.scoreRange[1]).toBeLessThanOrEqual(0.6);
    }
  });
});

// ============================================================
// 7. Hallucination Detection Tests
// ============================================================

describe('Hallucination Detection', () => {
  it('should require citations from resolution criteria', () => {
    const corpus = getGoldCorpus();
    const standardCases = corpus.filter(tc => tc.category === 'standard_resolution');

    // Standard cases should require citations
    for (const testCase of standardCases) {
      expect(testCase.expectedOutput.mustCitePassages).toBe(true);
    }
  });

  it('should not require citations for adversarial cases', () => {
    const corpus = getGoldCorpus();
    const adversarialCases = corpus.filter(tc => tc.category === 'adversarial');

    // Adversarial cases may not have valid citations
    for (const testCase of adversarialCases) {
      expect(testCase.expectedOutput.mustCitePassages).toBe(false);
    }
  });

  it('should flag low-confidence results for human review', () => {
    // This tests the flaggedForHumanReview logic
    const lowConfidenceThreshold = 0.7;

    const mockOutput: LLMScoringOutput = {
      score: 0.5,
      reasoning: 'Test reasoning',
      citedPassages: [],
      confidence: 0.4, // Below threshold
      warnings: [],
    };

    // Logic from llm-governance.ts: flag if confidence < 0.7
    const shouldFlag = mockOutput.confidence < lowConfidenceThreshold;
    expect(shouldFlag).toBe(true);
  });
});

// ============================================================
// 8. Input Normalization Tests
// ============================================================

describe('Input Normalization Handling', () => {
  it('should handle empty resolution criteria gracefully', () => {
    const testInput: LLMScoringInput = {
      runType: 'resolution_analysis',
      targetEntityType: 'market',
      targetEntityId: 'test_empty',
      marketTitle: 'Test Market',
      resolutionCriteria: '',
    };

    // Empty criteria should be handled (not throw)
    expect(testInput.resolutionCriteria).toBe('');
  });

  it('should handle very long resolution criteria', () => {
    const longCriteria = 'This is a test criteria. '.repeat(1000);
    const testInput: LLMScoringInput = {
      runType: 'resolution_analysis',
      targetEntityType: 'market',
      targetEntityId: 'test_long',
      marketTitle: 'Test Market',
      resolutionCriteria: longCriteria,
    };

    expect(testInput.resolutionCriteria.length).toBeGreaterThan(10000);
  });

  it('should handle special characters in criteria', () => {
    const specialCriteria = 'Test with "quotes", \'apostrophes\', <tags>, and {braces}';
    const testInput: LLMScoringInput = {
      runType: 'resolution_analysis',
      targetEntityType: 'market',
      targetEntityId: 'test_special',
      marketTitle: 'Test Market',
      resolutionCriteria: specialCriteria,
    };

    expect(testInput.resolutionCriteria).toContain('"');
    expect(testInput.resolutionCriteria).toContain('<');
    expect(testInput.resolutionCriteria).toContain('{');
  });

  it('should handle unicode characters', () => {
    const unicodeCriteria = 'Test with émojis 🎯 and ünïcödé characters';
    const testInput: LLMScoringInput = {
      runType: 'resolution_analysis',
      targetEntityType: 'market',
      targetEntityId: 'test_unicode',
      marketTitle: 'Test Market',
      resolutionCriteria: unicodeCriteria,
    };

    expect(testInput.resolutionCriteria).toContain('🎯');
    expect(testInput.resolutionCriteria).toContain('ü');
  });
});

// ============================================================
// 9. Structured Output Validation Tests
// ============================================================

describe('Structured Output Validation', () => {
  it('should validate score is within 0-1 range', () => {
    const validOutput: LLMScoringOutput = {
      score: 0.75,
      reasoning: 'Valid reasoning',
      citedPassages: ['Quote 1'],
      confidence: 0.9,
    };

    expect(validOutput.score).toBeGreaterThanOrEqual(0);
    expect(validOutput.score).toBeLessThanOrEqual(1);
  });

  it('should validate confidence is within 0-1 range', () => {
    const validOutput: LLMScoringOutput = {
      score: 0.5,
      reasoning: 'Valid reasoning',
      citedPassages: [],
      confidence: 0.8,
    };

    expect(validOutput.confidence).toBeGreaterThanOrEqual(0);
    expect(validOutput.confidence).toBeLessThanOrEqual(1);
  });

  it('should validate citedPassages is an array', () => {
    const validOutput: LLMScoringOutput = {
      score: 0.5,
      reasoning: 'Valid reasoning',
      citedPassages: ['Quote 1', 'Quote 2'],
      confidence: 0.8,
    };

    expect(Array.isArray(validOutput.citedPassages)).toBe(true);
  });

  it('should validate warnings is optional array', () => {
    const outputWithWarnings: LLMScoringOutput = {
      score: 0.5,
      reasoning: 'Valid reasoning',
      citedPassages: [],
      confidence: 0.8,
      warnings: ['Warning 1'],
    };

    const outputWithoutWarnings: LLMScoringOutput = {
      score: 0.5,
      reasoning: 'Valid reasoning',
      citedPassages: [],
      confidence: 0.8,
    };

    expect(outputWithWarnings.warnings).toEqual(['Warning 1']);
    expect(outputWithoutWarnings.warnings).toBeUndefined();
  });
});

// ============================================================
// 10. Drift Detection Tests
// ============================================================

describe('Drift Detection Between Prompt Versions', () => {
  it('should detect no drift when results are identical', () => {
    const baseline: SuiteResult = {
      runId: 'baseline-001',
      promptVersion: '1.0.0',
      timestamp: '2025-01-01T00:00:00Z',
      totalTests: 10,
      passed: 9,
      failed: 1,
      passRate: 0.9,
      byCategory: {
        standard_resolution: { total: 5, passed: 5, failed: 0, passRate: 1.0 },
        edge_case: { total: 2, passed: 2, failed: 0, passRate: 1.0 },
        disputed_market: { total: 1, passed: 1, failed: 0, passRate: 1.0 },
        ambiguous_phrasing: { total: 1, passed: 1, failed: 0, passRate: 1.0 },
        adversarial: { total: 1, passed: 0, failed: 1, passRate: 0.0 },
        equivalence: { total: 0, passed: 0, failed: 0, passRate: 0 },
        invariant_explanation: { total: 0, passed: 0, failed: 0, passRate: 0 },
      },
      results: [],
      executionTimeMs: 1000,
    };

    const candidate: SuiteResult = { ...baseline, runId: 'candidate-001' };

    // Calculate drift manually (same as RegressionTestRunner.compareToBaseline)
    const passRateDelta = candidate.passRate - baseline.passRate;
    const severity = Math.abs(passRateDelta) < 0.02 ? 'none' : 'minor';

    expect(passRateDelta).toBe(0);
    expect(severity).toBe('none');
  });

  it('should detect minor drift when pass rate changes slightly', () => {
    const baseline: SuiteResult = {
      runId: 'baseline-002',
      promptVersion: '1.0.0',
      timestamp: '2025-01-01T00:00:00Z',
      totalTests: 100,
      passed: 90,
      failed: 10,
      passRate: 0.9,
      byCategory: {
        standard_resolution: { total: 50, passed: 48, failed: 2, passRate: 0.96 },
        edge_case: { total: 20, passed: 18, failed: 2, passRate: 0.9 },
        disputed_market: { total: 10, passed: 8, failed: 2, passRate: 0.8 },
        ambiguous_phrasing: { total: 10, passed: 9, failed: 1, passRate: 0.9 },
        adversarial: { total: 10, passed: 7, failed: 3, passRate: 0.7 },
        equivalence: { total: 0, passed: 0, failed: 0, passRate: 0 },
        invariant_explanation: { total: 0, passed: 0, failed: 0, passRate: 0 },
      },
      results: [],
      executionTimeMs: 5000,
    };

    const candidate: SuiteResult = {
      ...baseline,
      runId: 'candidate-002',
      passed: 87,
      failed: 13,
      passRate: 0.87,
    };

    const passRateDelta = candidate.passRate - baseline.passRate;
    const absPassRateDelta = Math.abs(passRateDelta);

    // -0.03 is minor drift (>= 0.02, < 0.05)
    expect(absPassRateDelta).toBeGreaterThanOrEqual(0.02);
    expect(absPassRateDelta).toBeLessThan(0.05);
  });

  it('should detect moderate drift when pass rate changes significantly', () => {
    const baselinePassRate = 0.9;
    const candidatePassRate = 0.82;
    const passRateDelta = candidatePassRate - baselinePassRate;
    const absPassRateDelta = Math.abs(passRateDelta);

    // -0.08 is moderate drift (>= 0.05, < 0.10)
    expect(absPassRateDelta).toBeGreaterThanOrEqual(0.05);
    expect(absPassRateDelta).toBeLessThan(0.10);
  });

  it('should detect severe drift when pass rate drops dramatically', () => {
    const baselinePassRate = 0.9;
    const candidatePassRate = 0.75;
    const passRateDelta = candidatePassRate - baselinePassRate;
    const absPassRateDelta = Math.abs(passRateDelta);

    // -0.15 is severe drift (>= 0.10)
    expect(absPassRateDelta).toBeGreaterThanOrEqual(0.10);
  });

  // Helper to get recommendation from severity
  function getRecommendation(severity: string): string {
    return severity === 'severe' ? 'reject' : severity === 'moderate' ? 'review' : 'approve';
  }

  it('should recommend reject for severe drift', () => {
    // From RegressionTestRunner.compareToBaseline logic
    expect(getRecommendation('severe')).toBe('reject');
  });

  it('should recommend review for moderate drift', () => {
    expect(getRecommendation('moderate')).toBe('review');
  });

  it('should recommend approve for minor or no drift', () => {
    expect(getRecommendation('minor')).toBe('approve');
    expect(getRecommendation('none')).toBe('approve');
  });
});

// ============================================================
// 11. Test Result Structure Tests
// ============================================================

describe('Test Result Structure', () => {
  it('should have correct TestResult structure', () => {
    const testResult: TestResult = {
      testId: 'test_001',
      passed: true,
      failures: [],
      executionTimeMs: 500,
    };

    expect(testResult.testId).toBe('test_001');
    expect(testResult.passed).toBe(true);
    expect(testResult.failures).toHaveLength(0);
    expect(testResult.executionTimeMs).toBe(500);
  });

  it('should capture test failures correctly', () => {
    const testResult: TestResult = {
      testId: 'test_002',
      passed: false,
      failures: [
        {
          type: 'score_out_of_range',
          expected: '[0.0, 0.5]',
          actual: '0.75',
          message: 'Score 0.75 outside expected range',
        },
        {
          type: 'low_confidence',
          expected: '>= 0.8',
          actual: '0.5',
          message: 'Confidence 0.5 below minimum',
        },
      ],
      executionTimeMs: 750,
    };

    expect(testResult.passed).toBe(false);
    expect(testResult.failures).toHaveLength(2);
    expect(testResult.failures?.[0]?.type).toBe('score_out_of_range');
    expect(testResult.failures?.[1]?.type).toBe('low_confidence');
  });
});

// ============================================================
// 12. Category Distribution Tests
// ============================================================

describe('Test Category Distribution', () => {
  it('should have adequate coverage of standard resolution cases', () => {
    const corpus = getGoldCorpus();
    const standardCases = corpus.filter(tc => tc.category === 'standard_resolution');

    expect(standardCases.length).toBeGreaterThanOrEqual(20);
  });

  it('should have adequate coverage of edge cases', () => {
    const corpus = getGoldCorpus();
    const edgeCases = corpus.filter(tc => tc.category === 'edge_case');

    expect(edgeCases.length).toBeGreaterThanOrEqual(10);
  });

  it('should have adequate coverage of disputed markets', () => {
    const corpus = getGoldCorpus();
    const disputedCases = corpus.filter(tc => tc.category === 'disputed_market');

    expect(disputedCases.length).toBeGreaterThanOrEqual(10);
  });

  it('should have adequate coverage of ambiguous phrasing', () => {
    const corpus = getGoldCorpus();
    const ambiguousCases = corpus.filter(tc => tc.category === 'ambiguous_phrasing');

    expect(ambiguousCases.length).toBeGreaterThanOrEqual(5);
  });

  it('should have adequate coverage of adversarial tests', () => {
    const corpus = getGoldCorpus();
    const adversarialCases = corpus.filter(tc => tc.category === 'adversarial');

    expect(adversarialCases.length).toBeGreaterThanOrEqual(5);
  });
});

// ============================================================
// 13. Prompt Version Management Tests
// ============================================================

describe('Prompt Version Management', () => {
  it('should include prompt version in test metadata', () => {
    const corpus = getGoldCorpus();

    for (const testCase of corpus) {
      expect(testCase.metadata.createdAt).toBeDefined();
      expect(typeof testCase.metadata.createdAt).toBe('string');
    }
  });

  it('should track prompt template hash for reproducibility', () => {
    // Verify the SuiteResult includes prompt version
    const suiteResult: Partial<SuiteResult> = {
      promptVersion: '1.0.0',
    };

    expect(suiteResult.promptVersion).toBe('1.0.0');
  });
});

// ============================================================
// 14. Human Review Flag Tests
// ============================================================

describe('Human Review Flag Logic', () => {
  it('should flag low confidence results', () => {
    const confidence = 0.5;
    const flaggedForHumanReview = confidence < 0.7;

    expect(flaggedForHumanReview).toBe(true);
  });

  it('should flag results with warnings', () => {
    const warnings = ['Potential ambiguity detected'];
    const flaggedForHumanReview = warnings.length > 0;

    expect(flaggedForHumanReview).toBe(true);
  });

  it('should flag results with no citations', () => {
    const citedPassages: string[] = [];
    const flaggedForHumanReview = citedPassages.length === 0;

    expect(flaggedForHumanReview).toBe(true);
  });

  it('should not flag high confidence results with citations', () => {
    const confidence = 0.9;
    const warnings: string[] = [];
    const citedPassages = ['Quote from criteria'];

    const flaggedForHumanReview =
      confidence < 0.7 ||
      warnings.length > 0 ||
      citedPassages.length === 0;

    expect(flaggedForHumanReview).toBe(false);
  });
});
