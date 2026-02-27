/**
 * Paul P - LLM Execution Layer
 *
 * Canonical entry point: routeAndExecuteGovernedLLMCall
 *
 * Call flow:
 * 1. Load versioned prompt template
 * 2. Render prompt with input variables
 * 3. Route to model via routeLLMCall (routing.policy.ts)
 * 4. Dispatch to provider via dispatchLLMRequest (providers.ts)
 * 5. Log audit events (LLM_CALL_COMPLETED, LLM_CALL_FAILED, LLM_PROVIDER_KEY_MISSING)
 * 6. Return normalized response
 *
 * @see P-07 — LLM Governance
 * @see P-22 — Security (key scope separation)
 */

import type { ResearchEnv } from '../../types/env';
import type {
  LLMRoutingRunType,
  TokenUsage,
  ResolvedModelId,
  LLMModelConfig,
} from './routing.types';
import { routeLLMCall } from './routing.policy';
import { computeEstimatedCost } from './routing.manifest';
import {
  dispatchLLMRequest,
  extractProviderKeys,
  LLMProviderKeyError,
  type LLMRequest,
  type ProviderKeys,
} from './providers';
import {
  loadPromptWithHash,
  renderPrompt,
  type LLMScoringRunType,
  type LoadedPrompt,
} from './prompt-loader';
import { deterministicId } from '../utils/deterministic-id';

// ============================================================
// TYPES
// ============================================================

/**
 * Input for executeRoutedLLMCall.
 */
export interface LLMExecutionInput {
  /** Run type determines routing and prompt selection */
  readonly runType: LLMScoringRunType;
  /** Variables to render into the prompt template */
  readonly variables: Record<string, string | undefined>;
  /** Strategy ID for strategy-specific routing (optional) */
  readonly strategyId?: string;
  /** Force a specific model (testing/override only) */
  readonly forceModel?: ResolvedModelId;
  /** Additional metadata for audit trail */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Result from executeRoutedLLMCall.
 */
export interface LLMExecutionResult {
  readonly success: boolean;
  readonly content?: string;
  readonly routingDecisionId: string;
  readonly modelId?: ResolvedModelId;
  readonly usage?: TokenUsage;
  readonly promptHash: string;
  readonly promptVersion: string;
  readonly latencyMs?: number;
  readonly error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

// ============================================================
// AUDIT EVENT TYPES
// ============================================================

type LLMAuditEventType =
  | 'LLM_CALL_COMPLETED'
  | 'LLM_CALL_FAILED'
  | 'LLM_PROVIDER_KEY_MISSING';

// ============================================================
// AUDIT EVENT LOGGING
// ============================================================

/**
 * Log an LLM-related audit event.
 */
async function logAuditEvent(
  env: ResearchEnv,
  eventType: LLMAuditEventType,
  payload: Record<string, unknown>
): Promise<void> {
  const timestamp = new Date().toISOString();
  const auditId = deterministicId('llm-audit', eventType, timestamp, String(payload.runType ?? 'unknown'));

  await env.DB.prepare(`
    INSERT INTO audit_log (id, event_type, entity_type, entity_id, payload, timestamp)
    VALUES (?, ?, 'llm_call', ?, ?, ?)
  `).bind(
    auditId,
    eventType,
    String(payload.runType ?? 'unknown'),
    JSON.stringify(payload),
    timestamp
  ).run();
}

// ============================================================
// CLOUDFLARE AI FALLBACK
// ============================================================

/**
 * Call Cloudflare Workers AI as last-resort fallback.
 * Uses env.AI binding, not HTTP fetch.
 */
async function callCloudflareAI(
  env: ResearchEnv,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<{ response: string; usage: { inputTokens: number; outputTokens: number } }> {
  const response = await (env.AI.run as (model: string, input: unknown) => Promise<unknown>)(
    model,
    {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 2000,
      temperature: 0.1,
    }
  );

  const responseText = typeof response === 'string'
    ? response
    : (response as { response?: string }).response ?? '';

  // Estimate tokens (Workers AI doesn't return usage)
  const inputTokens = Math.ceil((systemPrompt.length + userPrompt.length) / 4);
  const outputTokens = Math.ceil(responseText.length / 4);

  return { response: responseText, usage: { inputTokens, outputTokens } };
}

// ============================================================
// MAIN EXECUTOR
// ============================================================

/**
 * Core LLM execution implementation.
 *
 * This function:
 * 1. Loads the versioned prompt template for the run type
 * 2. Extracts and validates ALL 4 required provider keys (fail-closed)
 * 3. Routes to the appropriate model via routeLLMCall
 * 4. Dispatches to the provider via dispatchLLMRequest
 * 5. Uses MODEL CONFIG for temperature/maxTokens/cacheStrategy (not hardcoded)
 * 6. Logs audit events (LLM_CALL_COMPLETED, LLM_CALL_FAILED, LLM_PROVIDER_KEY_MISSING)
 *
 * Prefer calling routeAndExecuteGovernedLLMCall (the canonical contract) unless
 * you have a specific reason to use this directly.
 *
 * @param env ResearchEnv with DB, AI, and API key secrets
 * @param input Execution input with run type, variables, and optional overrides
 * @returns Execution result with content, usage, and audit trail
 */
export async function executeRoutedLLMCall(
  env: ResearchEnv,
  input: LLMExecutionInput
): Promise<LLMExecutionResult> {
  const startMs = Date.now();

  // 1. Load versioned prompt template
  let prompt: LoadedPrompt;
  try {
    prompt = await loadPromptWithHash(input.runType);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      routingDecisionId: deterministicId('llm-exec', input.runType, new Date().toISOString(), 'prompt-error'),
      promptHash: 'unknown',
      promptVersion: 'unknown',
      error: {
        code: 'PROMPT_LOAD_ERROR',
        message,
        retryable: false,
      },
    };
  }

  // 2. Extract and validate ALL 4 provider keys (fail-closed)
  let keys: ProviderKeys;
  try {
    keys = extractProviderKeys(env);
  } catch (error) {
    const keyError = error instanceof LLMProviderKeyError ? error : null;

    // Log LLM_PROVIDER_KEY_MISSING audit event
    await logAuditEvent(env, 'LLM_PROVIDER_KEY_MISSING', {
      runType: input.runType,
      missingKeys: keyError?.secretName ?? 'unknown',
      errorMessage: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      routingDecisionId: deterministicId('llm-exec', input.runType, new Date().toISOString(), 'key-error'),
      promptHash: prompt.hash,
      promptVersion: prompt.version,
      error: {
        code: 'PROVIDER_KEY_MISSING',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      },
    };
  }

  // 3. Render the prompt with input variables
  const renderedUserPrompt = renderPrompt(prompt, input.variables);

  // Estimate tokens for routing
  const estimatedInputTokens = Math.ceil(
    (prompt.systemPrompt.length + renderedUserPrompt.length) / 4
  );
  const estimatedOutputTokens = 500; // Conservative estimate

  // 4. Route through routing layer with model config
  const routingResult = await routeLLMCall<string>(
    env,
    {
      runType: input.runType as LLMRoutingRunType,
      estimatedInputTokens,
      estimatedOutputTokens,
      strategyId: input.strategyId,
      forceModel: input.forceModel,
      metadata: input.metadata,
    },
    async (modelConfig: LLMModelConfig) => {
      // Handle Cloudflare AI separately (uses env.AI binding)
      if (modelConfig.provider === 'cloudflare') {
        const { response, usage } = await callCloudflareAI(
          env,
          modelConfig.providerModelId,
          prompt.systemPrompt,
          renderedUserPrompt
        );

        const tokenUsage: TokenUsage = {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedTokens: 0,
          costUsd: 0, // Cloudflare AI is free
        };

        return { response, usage: tokenUsage };
      }

      // 5. Build request using MODEL CONFIG (not hardcoded!)
      const request: LLMRequest = {
        modelId: modelConfig.providerModelId,
        provider: modelConfig.provider,
        systemPrompt: prompt.systemPrompt,
        userMessage: renderedUserPrompt,
        temperature: modelConfig.defaultTemperature,  // FROM CONFIG!
        maxTokens: modelConfig.defaultMaxTokens,      // FROM CONFIG!
        cacheStrategy: modelConfig.cacheStrategy,     // FROM CONFIG!
      };

      // 6. Dispatch to provider
      const response = await dispatchLLMRequest(request, keys);

      // Compute cost
      const costUsd = computeEstimatedCost(
        modelConfig.resolvedModelId,
        response.inputTokens,
        response.outputTokens,
        response.cachedInputTokens
      );

      const tokenUsage: TokenUsage = {
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        cachedTokens: response.cachedInputTokens,
        costUsd,
      };

      return { response: response.content, usage: tokenUsage };
    }
  );

  const latencyMs = Date.now() - startMs;

  // 7. Log audit event
  if (routingResult.success) {
    await logAuditEvent(env, 'LLM_CALL_COMPLETED', {
      runType: input.runType,
      modelId: routingResult.decision.resolvedModelId,
      latencyMs,
      costUsd: routingResult.usage?.costUsd,
      inputTokens: routingResult.usage?.inputTokens,
      outputTokens: routingResult.usage?.outputTokens,
      promptVersion: prompt.version,
      promptHash: prompt.hash,
    });

    return {
      success: true,
      content: routingResult.modelResponse,
      routingDecisionId: routingResult.decision.id,
      modelId: routingResult.decision.resolvedModelId,
      usage: routingResult.usage,
      promptHash: prompt.hash,
      promptVersion: prompt.version,
      latencyMs,
    };
  } else {
    await logAuditEvent(env, 'LLM_CALL_FAILED', {
      runType: input.runType,
      errorCode: routingResult.error?.code,
      errorMessage: routingResult.error?.message,
      promptVersion: prompt.version,
      promptHash: prompt.hash,
      latencyMs,
    });

    return {
      success: false,
      routingDecisionId: routingResult.decision.id,
      modelId: routingResult.decision.resolvedModelId,
      promptHash: prompt.hash,
      promptVersion: prompt.version,
      latencyMs,
      error: routingResult.error,
    };
  }
}

/**
 * routeAndExecuteGovernedLLMCall — Top-level governed executor contract.
 *
 * This is the canonical entry point for all governed LLM work. It is
 * semantically identical to executeRoutedLLMCall but provides the
 * contract name specified in P-07 LLM Governance.
 *
 * Agents and scoring flows SHOULD call this function directly.
 */
export async function routeAndExecuteGovernedLLMCall(
  env: ResearchEnv,
  input: LLMExecutionInput
): Promise<LLMExecutionResult> {
  return executeRoutedLLMCall(env, input);
}

/**
 * Convenience wrapper for scoring-specific execution.
 * Parses the LLM response as JSON scoring output.
 */
export async function executeRoutedScoringCall(
  env: ResearchEnv,
  input: LLMExecutionInput
): Promise<LLMExecutionResult & {
  parsedOutput?: {
    score: number;
    reasoning: string;
    citedPassages: string[];
    confidence: number;
    warnings?: string[];
  };
}> {
  const result = await routeAndExecuteGovernedLLMCall(env, input);

  if (!result.success || !result.content) {
    return result;
  }

  // Parse JSON response
  try {
    const parsed = JSON.parse(result.content) as {
      score: number;
      reasoning: string;
      citedPassages: string[];
      confidence: number;
      warnings?: string[];
    };

    // Validate required fields
    if (typeof parsed.score !== 'number' || parsed.score < 0 || parsed.score > 1) {
      throw new Error('Invalid score');
    }
    if (typeof parsed.reasoning !== 'string') {
      throw new Error('Missing reasoning');
    }
    if (!Array.isArray(parsed.citedPassages)) {
      parsed.citedPassages = [];
    }
    if (typeof parsed.confidence !== 'number') {
      parsed.confidence = 0.5;
    }

    return { ...result, parsedOutput: parsed };
  } catch (error) {
    // If parsing fails, return low-confidence result
    return {
      ...result,
      parsedOutput: {
        score: 0.5,
        reasoning: `Failed to parse LLM response: ${error instanceof Error ? error.message : String(error)}`,
        citedPassages: [],
        confidence: 0.0,
        warnings: ['LLM response parsing failed', result.content.slice(0, 500)],
      },
    };
  }
}
