import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResearchEnv } from '../../src/types/env';
import type { ModelId } from '../../src/lib/llm/routing.types';
import { executeWithRouting } from '../../src/lib/llm/routing.policy';
import { modelIdToString } from '../../src/lib/llm/routing.types';

interface BoundStatement {
  bind: (...args: unknown[]) => BoundStatement;
  run: () => Promise<unknown>;
  first: <T = unknown>() => Promise<T | null>;
  all: <T = unknown>() => Promise<{ results: T[] }>;
}

function createMockEnv(overrides?: Partial<ResearchEnv>): ResearchEnv {
  const db = {
    prepare: vi.fn((query: string) => {
      const stmt: BoundStatement = {
        bind: () => stmt,
        run: async () => ({ success: true }),
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

  return {
    ENVIRONMENT: 'test',
    SYSTEM_NAME: 'paul-p-test',
    DB: db,
    R2_EVIDENCE: {} as ResearchEnv['R2_EVIDENCE'],
    KV_CACHE: {} as ResearchEnv['KV_CACHE'],
    AI: {} as ResearchEnv['AI'],
    ANTHROPIC_API_KEY: 'anthropic-test',
    RESEARCH_AGENT: {} as ResearchEnv['RESEARCH_AGENT'],
    AUDIT_REPORTER: {} as ResearchEnv['AUDIT_REPORTER'],
    COMPLIANCE: {} as ResearchEnv['COMPLIANCE'],
    ...overrides,
  };
}

describe('LLM Routing Integration', () => {
  let env: ResearchEnv;

  beforeEach(() => {
    env = createMockEnv();
    vi.clearAllMocks();
  });

  it('forced model override beats normal routing', async () => {
    env = createMockEnv({
      LLM_ROUTING_FORCE_MODEL: 'google:gemini-3-flash-preview',
    });

    const seen: string[] = [];

    const result = await executeWithRouting(
      env,
      'ambiguity_score',
      1500,
      400,
      async (modelId: ModelId) => {
        seen.push(modelIdToString(modelId));
        return {
          response: 'ok',
          usage: { inputTokens: 1500, outputTokens: 400, cachedTokens: 0, costUsd: 0.02 },
        };
      }
    );

    expect(result.success).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe('google:gemini-3-flash-preview');
    expect(result.decision.overrideUsed).toBe(true);
  });

  it('invalid forced override fails closed', async () => {
    env = createMockEnv({
      LLM_ROUTING_FORCE_MODEL: 'google:not-real',
    });

    const result = await executeWithRouting(
      env,
      'general_enrichment',
      500,
      150,
      async () => ({
        response: 'unexpected',
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 },
      })
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_FORCED_MODEL');
  });

  it('uses deterministic fallback order when primary fails', async () => {
    const seen: string[] = [];

    const result = await executeWithRouting(
      env,
      'ambiguity_score',
      1200,
      300,
      async (modelId: ModelId) => {
        const id = modelIdToString(modelId);
        seen.push(id);

        if (seen.length === 1) {
          throw new Error('primary failed');
        }

        return {
          response: 'fallback-ok',
          usage: { inputTokens: 1200, outputTokens: 300, cachedTokens: 0, costUsd: 0.01 },
        };
      }
    );

    expect(result.success).toBe(true);
    expect(seen[0]).toBe('anthropic:claude-opus-4-6');
    expect(seen[1]).toBe('moonshot:kimi-k2.5');
    expect(result.decision.resolvedModelId).toBe('moonshot:kimi-k2.5');
  });
});
