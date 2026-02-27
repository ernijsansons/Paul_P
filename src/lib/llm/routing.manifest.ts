/**
 * Paul P - LLM Routing Manifest
 *
 * Central model/provider manifest with real model IDs and route-class defaults.
 * Business logic resolves route classes; this file resolves model details.
 */

import type {
  LLMModelConfig,
  LLMRoutingClass,
  ModelId,
  ResolvedModelId,
  RouteClassConfig,
  TokenUsage,
} from './routing.types';
import { parseResolvedModelId } from './routing.types';

// ============================================================
// MODEL MANIFEST (SOURCE OF TRUTH)
// ============================================================

export const MODEL_MANIFEST: Record<ResolvedModelId, LLMModelConfig> = {
  'anthropic:claude-opus-4-6': {
    resolvedModelId: 'anthropic:claude-opus-4-6',
    provider: 'anthropic',
    providerModelId: 'claude-opus-4-6',
    defaultTemperature: 0.1,
    defaultMaxTokens: 4096,
    cacheStrategy: 'anthropic_prompt_cache',
    pricing: {
      inputPer1M: 15,
      outputPer1M: 75,
      cachedInputPer1M: 1.5,
    },
    isPreview: false,
    intendedUse: 'Premium reasoning for ambiguity/equivalence/resolution-critical analysis.',
  },
  'minimax:MiniMax-M2.5-highspeed': {
    resolvedModelId: 'minimax:MiniMax-M2.5-highspeed',
    provider: 'minimax',
    providerModelId: 'MiniMax-M2.5-highspeed',
    defaultTemperature: 0.1,
    defaultMaxTokens: 2048,
    cacheStrategy: 'minimax_prompt_cache',
    pricing: {
      inputPer1M: 0.15,
      outputPer1M: 0.6,
    },
    isPreview: false,
    intendedUse: 'Low-latency scanner fastpath for high-volume signal scanning.',
  },
  'moonshot:kimi-k2.5': {
    resolvedModelId: 'moonshot:kimi-k2.5',
    provider: 'moonshot',
    providerModelId: 'kimi-k2.5',
    defaultTemperature: 0.1,
    defaultMaxTokens: 4096,
    cacheStrategy: 'moonshot_prompt_cache',
    pricing: {
      inputPer1M: 0.12,
      outputPer1M: 0.48,
    },
    isPreview: false,
    intendedUse: 'Long-context synthesis for wallet clustering and cross-document reasoning.',
  },
  'google:gemini-3-flash-preview': {
    resolvedModelId: 'google:gemini-3-flash-preview',
    provider: 'google',
    providerModelId: 'gemini-3-flash-preview',
    defaultTemperature: 0.1,
    defaultMaxTokens: 8192,
    cacheStrategy: 'gemini_context_cache',
    pricing: {
      inputPer1M: 0.1,
      outputPer1M: 0.4,
    },
    isPreview: true,
    // Keep this note explicit and centralized to avoid scattered hardcoding.
    stabilityNote:
      'Gemini 3 Flash is a preview dependency; replace via manifest mapping, not business logic.',
    intendedUse: 'Cheap enrichment and fallback for cost-sensitive non-blocking tasks.',
  },
  'cloudflare:@cf/meta/llama-3.1-70b-instruct': {
    resolvedModelId: 'cloudflare:@cf/meta/llama-3.1-70b-instruct',
    provider: 'cloudflare',
    providerModelId: '@cf/meta/llama-3.1-70b-instruct',
    defaultTemperature: 0.1,
    defaultMaxTokens: 2048,
    cacheStrategy: 'none',
    pricing: {
      inputPer1M: 0,
      outputPer1M: 0,
    },
    isPreview: false,
    intendedUse: 'Last-resort fallback when external provider keys are unavailable.',
  },
};

// ============================================================
// ROUTE CLASS CONFIG
// ============================================================

/**
 * deterministic_hard_control intentionally has llmAllowed=false and no model.
 * This enforces fail-closed behavior with no fake sentinel model IDs.
 */
export const ROUTE_CLASS_CONFIG: Record<LLMRoutingClass, RouteClassConfig> = {
  deterministic_hard_control: {
    routeClass: 'deterministic_hard_control',
    llmAllowed: false,
    fallbackModelIds: [],
  },
  premium_cognition: {
    routeClass: 'premium_cognition',
    llmAllowed: true,
    defaultModelId: 'anthropic:claude-opus-4-6',
    fallbackModelIds: [
      'moonshot:kimi-k2.5',
      'google:gemini-3-flash-preview',
      'cloudflare:@cf/meta/llama-3.1-70b-instruct',
    ],
  },
  scanner_fastpath: {
    routeClass: 'scanner_fastpath',
    llmAllowed: true,
    defaultModelId: 'minimax:MiniMax-M2.5-highspeed',
    fallbackModelIds: [
      'google:gemini-3-flash-preview',
      'moonshot:kimi-k2.5',
      'cloudflare:@cf/meta/llama-3.1-70b-instruct',
    ],
  },
  synthesis_long_context: {
    routeClass: 'synthesis_long_context',
    llmAllowed: true,
    defaultModelId: 'moonshot:kimi-k2.5',
    fallbackModelIds: [
      'google:gemini-3-flash-preview',
      'anthropic:claude-opus-4-6',
      'cloudflare:@cf/meta/llama-3.1-70b-instruct',
    ],
  },
  cheap_enrichment: {
    routeClass: 'cheap_enrichment',
    llmAllowed: true,
    defaultModelId: 'google:gemini-3-flash-preview',
    fallbackModelIds: [
      'minimax:MiniMax-M2.5-highspeed',
      'moonshot:kimi-k2.5',
      'cloudflare:@cf/meta/llama-3.1-70b-instruct',
    ],
  },
};

// ============================================================
// HELPERS
// ============================================================

export function getModelConfig(modelId: ResolvedModelId): LLMModelConfig {
  const config = MODEL_MANIFEST[modelId];
  if (!config) {
    throw new Error(`Unknown model ID: ${modelId}`);
  }
  return config;
}

export function getRouteClassConfig(routeClass: LLMRoutingClass): RouteClassConfig {
  const config = ROUTE_CLASS_CONFIG[routeClass];
  if (!config) {
    throw new Error(`Unknown route class: ${routeClass}`);
  }
  return config;
}

export function getDefaultModelIdForRouteClass(
  routeClass: LLMRoutingClass
): ResolvedModelId | undefined {
  return getRouteClassConfig(routeClass).defaultModelId;
}

export function getFallbackModelIdsForRouteClass(routeClass: LLMRoutingClass): ResolvedModelId[] {
  return [...getRouteClassConfig(routeClass).fallbackModelIds];
}

export function toProviderModelId(modelId: ResolvedModelId): ModelId {
  return parseResolvedModelId(modelId);
}

/**
 * Deterministic cost estimate for one call.
 * cachedInputTokens can be passed directly or derived from cache-hit assumptions.
 */
export function computeEstimatedCost(
  modelId: ResolvedModelId,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number = 0
): number {
  const model = getModelConfig(modelId);
  const nonCachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const cachedRate = model.pricing.cachedInputPer1M ?? model.pricing.inputPer1M;

  const inputCost = (nonCachedInputTokens / 1_000_000) * model.pricing.inputPer1M;
  const cachedInputCost = (cachedInputTokens / 1_000_000) * cachedRate;
  const outputCost = (outputTokens / 1_000_000) * model.pricing.outputPer1M;
  return inputCost + cachedInputCost + outputCost;
}

export function computeActualCost(modelId: ResolvedModelId, usage: TokenUsage): number {
  return computeEstimatedCost(
    modelId,
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedTokens
  );
}
