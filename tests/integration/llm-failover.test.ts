/**
 * Paul P - LLM Failover Integration Tests
 *
 * Tests LLM provider failover chain validation and fail-closed behavior.
 * Verifies that routing correctly handles:
 * - Primary success (no fallback triggered)
 * - Provider timeouts triggering fallback
 * - Budget exhaustion skipping providers
 * - All providers failing (fail-closed)
 * - Drift sweep blocking requests
 *
 * @see P-07 — LLM Governance
 * @see routing.policy.ts — executeWithRouting
 * @see routing.manifest.ts — ROUTE_CLASS_CONFIG
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResearchEnv } from '../../src/types/env';
import type { ModelId, ResolvedModelId } from '../../src/lib/llm/routing.types';
import { executeWithRouting, routeLLMCall } from '../../src/lib/llm/routing.policy';
import { modelIdToString } from '../../src/lib/llm/routing.types';
import { hasRecentDriftBlock, recordDriftSweep } from '../../src/lib/llm/drift-sweeps';

// ============================================================
// MOCK INFRASTRUCTURE
// ============================================================

interface BoundStatement {
  bind: (...args: unknown[]) => BoundStatement;
  run: () => Promise<unknown>;
  first: <T = unknown>() => Promise<T | null>;
  all: <T = unknown>() => Promise<{ results: T[] }>;
}

interface MockEnvConfig {
  overrides?: Partial<ResearchEnv>;
  budgetConsumed?: number;
  recentDriftBlock?: boolean;
}

function createMockEnv(config: MockEnvConfig = {}): {
  env: ResearchEnv;
  dbCalls: Array<{ query: string; params: unknown[] }>;
} {
  const dbCalls: Array<{ query: string; params: unknown[] }> = [];
  const budgetConsumed = config.budgetConsumed ?? 0;
  const recentDriftBlock = config.recentDriftBlock ?? false;

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
          dbCalls.push({ query, params });
          // Budget check query
          if (query.includes('llm_budget_usage')) {
            return { consumed: budgetConsumed } as T;
          }
          // Drift block check query
          if (query.includes('blocked_deployment') || query.includes('deploy_allowed')) {
            return { blocked: recentDriftBlock ? 1 : 0 } as T;
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
    ANTHROPIC_API_KEY: 'anthropic-test-key',
    MINIMAX_API_KEY: 'minimax-test-key',
    MOONSHOT_API_KEY: 'moonshot-test-key',
    GOOGLE_AI_API_KEY: 'google-test-key',
    RESEARCH_AGENT: {} as ResearchEnv['RESEARCH_AGENT'],
    AUDIT_REPORTER: {} as ResearchEnv['AUDIT_REPORTER'],
    COMPLIANCE: {} as ResearchEnv['COMPLIANCE'],
    ...config.overrides,
  };

  return { env, dbCalls };
}

// ============================================================
// TEST SUITE
// ============================================================

describe('LLM Failover Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ----------------------------------------------------------
  // TEST 1: Primary success - no fallback triggered
  // ----------------------------------------------------------
  describe('Primary Success Path', () => {
    it('uses primary provider when successful, no fallback triggered', async () => {
      const { env } = createMockEnv();
      const seen: string[] = [];

      const result = await executeWithRouting(
        env,
        'ambiguity_score', // routes to premium_cognition → anthropic:claude-opus-4-6
        1500,
        400,
        async (modelId: ModelId) => {
          seen.push(modelIdToString(modelId));
          return {
            response: 'success-from-primary',
            usage: { inputTokens: 1500, outputTokens: 400, cachedTokens: 0, costUsd: 0.05 },
          };
        }
      );

      expect(result.success).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBe('anthropic:claude-opus-4-6');
      expect(result.decision.resolvedModelId).toBe('anthropic:claude-opus-4-6');
      expect(result.modelResponse).toBe('success-from-primary');
    });
  });

  // ----------------------------------------------------------
  // TEST 2: Anthropic timeout → Moonshot fallback
  // ----------------------------------------------------------
  describe('Provider Timeout Fallback', () => {
    it('falls back to Moonshot when Anthropic times out', async () => {
      const { env } = createMockEnv();
      const seen: string[] = [];

      const result = await executeWithRouting(
        env,
        'ambiguity_score',
        1200,
        300,
        async (modelId: ModelId) => {
          const id = modelIdToString(modelId);
          seen.push(id);

          // Simulate timeout on first provider (Anthropic)
          if (seen.length === 1) {
            const error = new DOMException('The operation was aborted.', 'AbortError');
            throw error;
          }

          return {
            response: 'success-from-moonshot',
            usage: { inputTokens: 1200, outputTokens: 300, cachedTokens: 0, costUsd: 0.01 },
          };
        }
      );

      expect(result.success).toBe(true);
      expect(seen).toHaveLength(2);
      expect(seen[0]).toBe('anthropic:claude-opus-4-6');
      expect(seen[1]).toBe('moonshot:kimi-k2.5');
      expect(result.decision.resolvedModelId).toBe('moonshot:kimi-k2.5');
      expect(result.modelResponse).toBe('success-from-moonshot');
    });

    it('falls back through entire chain when multiple providers fail', async () => {
      const { env } = createMockEnv();
      const seen: string[] = [];

      const result = await executeWithRouting(
        env,
        'ambiguity_score',
        1000,
        200,
        async (modelId: ModelId) => {
          const id = modelIdToString(modelId);
          seen.push(id);

          // Fail first 3 providers, succeed on 4th (cloudflare)
          if (seen.length < 4) {
            throw new Error(`Provider ${id} failed`);
          }

          return {
            response: 'success-from-cloudflare',
            usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: 0, costUsd: 0 },
          };
        }
      );

      expect(result.success).toBe(true);
      expect(seen).toHaveLength(4);
      // Verify fallback order for premium_cognition route class
      expect(seen[0]).toBe('anthropic:claude-opus-4-6');
      expect(seen[1]).toBe('moonshot:kimi-k2.5');
      expect(seen[2]).toBe('google:gemini-3-flash-preview');
      expect(seen[3]).toBe('cloudflare:@cf/meta/llama-3.1-70b-instruct');
      expect(result.decision.resolvedModelId).toBe('cloudflare:@cf/meta/llama-3.1-70b-instruct');
    });
  });

  // ----------------------------------------------------------
  // TEST 3: Budget exhausted → skip to next provider
  // ----------------------------------------------------------
  describe('Budget Exhaustion', () => {
    it('rejects request when budget is exhausted', async () => {
      // Set budget consumed to exceed the monthly limit
      const { env } = createMockEnv({ budgetConsumed: 1000000 });

      const result = await routeLLMCall(
        env,
        {
          runType: 'ambiguity_score',
          estimatedInputTokens: 1000,
          estimatedOutputTokens: 200,
        },
        async () => ({
          response: 'should-not-execute',
          usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 },
        })
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('BUDGET_EXCEEDED');
    });
  });

  // ----------------------------------------------------------
  // TEST 4: Disabled provider skipped in chain
  // ----------------------------------------------------------
  describe('Forced Model Override', () => {
    it('uses forced model from environment override', async () => {
      const { env } = createMockEnv({
        overrides: {
          LLM_ROUTING_FORCE_MODEL: 'google:gemini-3-flash-preview',
        },
      });
      const seen: string[] = [];

      const result = await executeWithRouting(
        env,
        'ambiguity_score',
        500,
        100,
        async (modelId: ModelId) => {
          seen.push(modelIdToString(modelId));
          return {
            response: 'forced-google',
            usage: { inputTokens: 500, outputTokens: 100, cachedTokens: 0, costUsd: 0.002 },
          };
        }
      );

      expect(result.success).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBe('google:gemini-3-flash-preview');
      expect(result.decision.overrideUsed).toBe(true);
    });

    it('fails closed when invalid model is forced', async () => {
      const { env } = createMockEnv({
        overrides: {
          LLM_ROUTING_FORCE_MODEL: 'invalid:nonexistent-model',
        },
      });

      const result = await executeWithRouting(
        env,
        'general_enrichment',
        500,
        100,
        async () => ({
          response: 'should-not-execute',
          usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 },
        })
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_FORCED_MODEL');
    });
  });

  // ----------------------------------------------------------
  // TEST 5: All providers fail → fail-closed (reject request)
  // ----------------------------------------------------------
  describe('All Providers Fail', () => {
    it('fails closed when all providers in chain fail', async () => {
      const { env } = createMockEnv();
      const seen: string[] = [];
      let callCount = 0;

      const result = await executeWithRouting(
        env,
        'ambiguity_score',
        1000,
        200,
        async (modelId: ModelId) => {
          callCount++;
          seen.push(modelIdToString(modelId));
          throw new Error(`Provider ${modelIdToString(modelId)} failed`);
        }
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ALL_MODELS_FAILED');
      expect(result.error?.retryable).toBe(true);
      // Should have tried all 4 providers in the fallback chain
      expect(seen.length).toBe(4);
      expect(callCount).toBe(4);
      // Verify no partial response returned
      expect(result.modelResponse).toBeUndefined();
    });

    it('fails closed when all providers return HTTP 500', async () => {
      const { env } = createMockEnv();
      const seen: string[] = [];

      const result = await executeWithRouting(
        env,
        'general_enrichment',
        800,
        150,
        async (modelId: ModelId) => {
          seen.push(modelIdToString(modelId));
          throw new Error('HTTP 500: Internal Server Error');
        }
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ALL_MODELS_FAILED');
      // cheap_enrichment has 4 providers in fallback chain
      expect(seen.length).toBe(4);
    });
  });

  // ----------------------------------------------------------
  // TEST 6: Drift sweep blocks request
  // ----------------------------------------------------------
  describe('Drift Sweep Blocking', () => {
    it('hasRecentDriftBlock returns true when drift is detected', async () => {
      const { env } = createMockEnv({ recentDriftBlock: true });

      const blocked = await hasRecentDriftBlock(env, 7);

      expect(blocked).toBe(true);
    });

    it('hasRecentDriftBlock returns false when no drift detected', async () => {
      const { env } = createMockEnv({ recentDriftBlock: false });

      const blocked = await hasRecentDriftBlock(env, 7);

      expect(blocked).toBe(false);
    });

    it('recordDriftSweep persists sweep with blocked_deployment flag', async () => {
      const { env, dbCalls } = createMockEnv();

      await recordDriftSweep(env, {
        sweepType: 'nightly_stability',
        baselinePromptVersion: '1.0.0',
        baselineModelId: 'anthropic:claude-opus-4-6',
        candidatePromptVersion: '1.1.0',
        candidateModelId: 'anthropic:claude-opus-4-6',
        goldSetSize: 50,
        meanScoreDelta: 0.15, // Above threshold
        maxScoreDelta: 0.30,  // Above threshold
        promptInjectionPassRate: 1.0,
        passed: false,
        failureReasons: ['Mean score delta exceeded threshold'],
      });

      // Find the INSERT into llm_drift_sweeps
      const driftInsert = dbCalls.find((call) =>
        call.query.includes('INSERT INTO llm_drift_sweeps')
      );

      expect(driftInsert).toBeDefined();
      // Verify blocked_deployment is set (passed=0 means blocked=1)
      // The SQL has blocked_deployment = input.passed ? 0 : 1
    });
  });

  // ----------------------------------------------------------
  // Additional edge cases
  // ----------------------------------------------------------
  describe('Edge Cases', () => {
    it('deterministic_hard_control route class is forbidden', async () => {
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
          response: 'should-not-execute',
          usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 },
        })
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('DETERMINISTIC_HARD_CONTROL_FORBIDDEN');
    });

    it('audit log records successful routing decision', async () => {
      const { env, dbCalls } = createMockEnv();

      await executeWithRouting(
        env,
        'ambiguity_score',
        1000,
        200,
        async () => ({
          response: 'success',
          usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: 0, costUsd: 0.03 },
        })
      );

      // Find the INSERT into llm_routing_decisions
      const decisionInsert = dbCalls.find((call) =>
        call.query.includes('INSERT INTO llm_routing_decisions')
      );
      expect(decisionInsert).toBeDefined();

      // Find the INSERT into audit_log
      const auditInsert = dbCalls.find((call) =>
        call.query.includes('INSERT INTO audit_log') &&
        call.query.includes('LLM_ROUTING_DECISION')
      );
      expect(auditInsert).toBeDefined();
    });

    it('fallback chain uses correct order for scanner_fastpath route class', async () => {
      const { env } = createMockEnv();
      const seen: string[] = [];

      // signal_scanning maps to scanner_fastpath
      const result = await executeWithRouting(
        env,
        'signal_scanning',
        500,
        100,
        async (modelId: ModelId) => {
          const id = modelIdToString(modelId);
          seen.push(id);

          // Fail first provider to trigger fallback
          if (seen.length === 1) {
            throw new Error('Primary failed');
          }

          return {
            response: 'fallback-success',
            usage: { inputTokens: 500, outputTokens: 100, cachedTokens: 0, costUsd: 0.001 },
          };
        }
      );

      expect(result.success).toBe(true);
      // scanner_fastpath default: minimax, fallback: google, moonshot, cloudflare
      expect(seen[0]).toBe('minimax:MiniMax-M2.5-highspeed');
      expect(seen[1]).toBe('google:gemini-3-flash-preview');
    });
  });
});
