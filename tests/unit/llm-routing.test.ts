import { describe, expect, it, vi } from 'vitest';

import type { ResearchEnv } from '../../src/types/env';
import type { LLMRoutingInput, ResolvedModelId } from '../../src/lib/llm/routing.types';
import {
  getModelForRun,
  resolveRouteClass,
  routeLLMCall,
  validateForcedModel,
} from '../../src/lib/llm/routing.policy';
import {
  DEFAULT_BUDGET_ASSUMPTIONS,
  deriveBudgetEnvelopesFromAssumptions,
  projectBudgetFromAssumptions,
} from '../../src/lib/llm/routing.budget';

interface BoundStatement {
  bind: (...args: unknown[]) => BoundStatement;
  run: () => Promise<unknown>;
  first: <T = unknown>() => Promise<T | null>;
  all: <T = unknown>() => Promise<{ results: T[] }>;
}

function createMockEnv(overrides?: Partial<ResearchEnv>): {
  env: ResearchEnv;
  dbCalls: Array<{ query: string; params: unknown[] }>;
} {
  const dbCalls: Array<{ query: string; params: unknown[] }> = [];

  const db = {
    prepare: vi.fn((query: string) => {
      let params: unknown[] = [];
      const stmt: BoundStatement = {
        bind: (...args: unknown[]) => {
          params = args;
          return stmt;
        },
        run: async () => {
          dbCalls.push({ query, params });
          return { success: true };
        },
        first: async <T>() => {
          if (query.includes('llm_budget_usage')) {
            return { consumed: 0 } as T;
          }
          return null;
        },
        all: async <T>() => ({ results: [] as T[] }),
      };
      return stmt;
    }),
  } as unknown as ResearchEnv['DB'];

  const env: ResearchEnv = {
    ENVIRONMENT: 'test',
    SYSTEM_NAME: 'paul-p-test',
    DB: db,
    R2_EVIDENCE: {} as ResearchEnv['R2_EVIDENCE'],
    KV_CACHE: {} as ResearchEnv['KV_CACHE'],
    AI: {} as ResearchEnv['AI'],
    ANTHROPIC_API_KEY: 'test-key',
    MINIMAX_API_KEY: 'minimax-test-key',
    MOONSHOT_API_KEY: 'moonshot-test-key',
    GOOGLE_AI_API_KEY: 'google-test-key',
    RESEARCH_AGENT: {} as ResearchEnv['RESEARCH_AGENT'],
    AUDIT_REPORTER: {} as ResearchEnv['AUDIT_REPORTER'],
    COMPLIANCE: {} as ResearchEnv['COMPLIANCE'],
    ...overrides,
  };

  return { env, dbCalls };
}

describe('Routing Policy Precedence', () => {
  it('override beats normal routing', () => {
    const routeClass = resolveRouteClass({
      runType: 'ambiguity_score',
      estimatedInputTokens: 100,
      estimatedOutputTokens: 50,
      forceRouteClass: 'cheap_enrichment',
    });

    expect(routeClass).toBe('cheap_enrichment');
  });

  it('same input produces same routing result', () => {
    const input: LLMRoutingInput = {
      runType: 'resolution_analysis',
      estimatedInputTokens: 1000,
      estimatedOutputTokens: 300,
      strategyId: 'strategy-a',
    };

    const classA = resolveRouteClass(input);
    const classB = resolveRouteClass(input);
    const modelA = getModelForRun(input);
    const modelB = getModelForRun(input);

    expect(classA).toBe(classB);
    expect(modelA.resolvedModelId).toBe(modelB.resolvedModelId);
  });
});

describe('Run Type Mapping', () => {
  it('ambiguity_score resolves to premium_cognition', () => {
    expect(
      resolveRouteClass({
        runType: 'ambiguity_score',
        estimatedInputTokens: 100,
        estimatedOutputTokens: 50,
      })
    ).toBe('premium_cognition');
  });

  it('equivalence_assessment resolves to premium_cognition', () => {
    expect(
      resolveRouteClass({
        runType: 'equivalence_assessment',
        estimatedInputTokens: 100,
        estimatedOutputTokens: 50,
      })
    ).toBe('premium_cognition');
  });

  it('invariant_explanation resolves to premium_cognition', () => {
    expect(
      resolveRouteClass({
        runType: 'invariant_explanation',
        estimatedInputTokens: 100,
        estimatedOutputTokens: 50,
      })
    ).toBe('premium_cognition');
  });

  it('signal_scanning resolves to scanner_fastpath', () => {
    expect(
      resolveRouteClass({
        runType: 'signal_scanning',
        estimatedInputTokens: 100,
        estimatedOutputTokens: 50,
      })
    ).toBe('scanner_fastpath');
  });

  it('xvsignal strategy routes to scanner_fastpath', () => {
    expect(
      resolveRouteClass({
        runType: 'general_enrichment',
        strategyId: 'xvsignal-core',
        estimatedInputTokens: 100,
        estimatedOutputTokens: 50,
      })
    ).toBe('scanner_fastpath');
  });

  it('wallet_cluster_synthesis resolves to synthesis_long_context', () => {
    expect(
      resolveRouteClass({
        runType: 'wallet_cluster_synthesis',
        estimatedInputTokens: 100,
        estimatedOutputTokens: 50,
      })
    ).toBe('synthesis_long_context');
  });

  it('smart-money strategy routes to synthesis_long_context', () => {
    expect(
      resolveRouteClass({
        runType: 'general_enrichment',
        strategyId: 'smart-money-core',
        estimatedInputTokens: 100,
        estimatedOutputTokens: 50,
      })
    ).toBe('synthesis_long_context');
  });

  it('default case resolves to cheap_enrichment', () => {
    expect(
      resolveRouteClass({
        runType: 'general_enrichment',
        estimatedInputTokens: 100,
        estimatedOutputTokens: 50,
        strategyId: 'neutral-strategy',
      })
    ).toBe('cheap_enrichment');
  });
});

describe('Override and Fail-Closed Controls', () => {
  it('invalid override fails closed', async () => {
    const { env } = createMockEnv({
      LLM_ROUTING_FORCE_MODEL: 'anthropic:not-a-real-model',
    });

    const result = await routeLLMCall(
      env,
      {
        runType: 'general_enrichment',
        estimatedInputTokens: 100,
        estimatedOutputTokens: 50,
      },
      async () => ({
        response: 'ok',
        usage: { inputTokens: 100, outputTokens: 50, cachedTokens: 0, costUsd: 0.01 },
      })
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_FORCED_MODEL');
  });

  it('validateForcedModel rejects unknown model IDs', () => {
    const result = validateForcedModel('anthropic:not-a-real-model' as ResolvedModelId);
    expect(result.valid).toBe(false);
  });

  it('deterministic_hard_control cannot pass through wrapper', async () => {
    const { env } = createMockEnv();

    const result = await routeLLMCall(
      env,
      {
        runType: 'general_enrichment',
        forceRouteClass: 'deterministic_hard_control',
        estimatedInputTokens: 100,
        estimatedOutputTokens: 50,
      },
      async () => ({
        response: 'should-not-run',
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 },
      })
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DETERMINISTIC_HARD_CONTROL_FORBIDDEN');
  });
});

describe('Audit Logging', () => {
  it('audit log payload contains route class and resolved model', async () => {
    const { env, dbCalls } = createMockEnv();

    const result = await routeLLMCall(
      env,
      {
        runType: 'ambiguity_score',
        estimatedInputTokens: 1200,
        estimatedOutputTokens: 300,
      },
      async () => ({
        response: 'ok',
        usage: { inputTokens: 1200, outputTokens: 300, cachedTokens: 0, costUsd: 0.05 },
      })
    );

    expect(result.success).toBe(true);

    const decisionInsert = dbCalls.find((call) =>
      call.query.includes('INSERT INTO llm_routing_decisions')
    );
    expect(decisionInsert).toBeDefined();

    const params = decisionInsert?.params ?? [];
    expect(params[3]).toBe('premium_cognition');

    const selectedModel = JSON.parse(String(params[4])) as {
      resolvedModelId?: string;
      provider?: string;
    };

    expect(selectedModel.resolvedModelId).toBe(result.decision.resolvedModelId);
    expect(selectedModel.provider).toBe(result.decision.resolvedProvider);
  });
});

describe('Budget Projection', () => {
  it('budget projection is derived from assumptions', () => {
    const base = projectBudgetFromAssumptions(DEFAULT_BUDGET_ASSUMPTIONS);
    const doubled = projectBudgetFromAssumptions({
      ...DEFAULT_BUDGET_ASSUMPTIONS,
      callsPerDay: DEFAULT_BUDGET_ASSUMPTIONS.callsPerDay * 2,
    });

    expect(base.projectedDailyCostUsd).toBeGreaterThan(0);
    expect(base.projectedMonthlyCostUsd).toBeCloseTo(
      base.projectedDailyCostUsd * DEFAULT_BUDGET_ASSUMPTIONS.daysPerMonth,
      8
    );
    expect(doubled.projectedMonthlyCostUsd).toBeGreaterThan(base.projectedMonthlyCostUsd);
  });

  it('budget envelopes are derived, not fixed constants', () => {
    const envelopesA = deriveBudgetEnvelopesFromAssumptions(DEFAULT_BUDGET_ASSUMPTIONS);
    const envelopesB = deriveBudgetEnvelopesFromAssumptions({
      ...DEFAULT_BUDGET_ASSUMPTIONS,
      safetyMultiplier: DEFAULT_BUDGET_ASSUMPTIONS.safetyMultiplier * 1.2,
    });

    expect(envelopesB.research_scoring.monthlyLimitUsd).toBeGreaterThan(
      envelopesA.research_scoring.monthlyLimitUsd
    );
  });
});
