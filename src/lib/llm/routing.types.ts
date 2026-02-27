/**
 * Paul P - LLM Routing Types
 *
 * Production routing contracts for deterministic, auditable model selection.
 * This module intentionally keeps a closed run-type enum and closed route classes.
 */

// ============================================================
// RUN TYPES (CLOSED SET)
// ============================================================

/**
 * Closed run-type set for all routed LLM calls.
 * This is the policy surface for routing and budgeting.
 */
export type LLMRoutingRunType =
  | 'ambiguity_score'
  | 'equivalence_assessment'
  | 'resolution_analysis'
  | 'invariant_explanation'
  | 'postmortem_summary'
  | 'wallet_cluster_synthesis'
  | 'signal_scanning'
  | 'general_enrichment';

/**
 * Compatibility alias retained for existing imports.
 */
export type LLMRunType = LLMRoutingRunType;

export const ALL_RUN_TYPES: readonly LLMRoutingRunType[] = [
  'ambiguity_score',
  'equivalence_assessment',
  'resolution_analysis',
  'invariant_explanation',
  'postmortem_summary',
  'wallet_cluster_synthesis',
  'signal_scanning',
  'general_enrichment',
] as const;

// ============================================================
// ROUTE CLASSES (CLOSED SET)
// ============================================================

/**
 * Route class layer decouples business intent from provider model IDs.
 *
 * deterministic_hard_control is fail-closed: no LLM allowed.
 */
export type LLMRoutingClass =
  | 'deterministic_hard_control'
  | 'premium_cognition'
  | 'scanner_fastpath'
  | 'synthesis_long_context'
  | 'cheap_enrichment';

/**
 * Compatibility alias retained for existing imports.
 */
export type RouteClass = LLMRoutingClass;

export const ALL_ROUTE_CLASSES: readonly LLMRoutingClass[] = [
  'deterministic_hard_control',
  'premium_cognition',
  'scanner_fastpath',
  'synthesis_long_context',
  'cheap_enrichment',
] as const;

// ============================================================
// PROVIDERS / MODEL IDS
// ============================================================

export type LLMProvider = 'anthropic' | 'minimax' | 'moonshot' | 'google' | 'cloudflare';

/**
 * Canonical resolved model IDs used in policy/manifest.
 * These are real provider IDs.
 */
export type ResolvedModelId =
  | 'anthropic:claude-opus-4-6'
  | 'minimax:MiniMax-M2.5-highspeed'
  | 'moonshot:kimi-k2.5'
  | 'google:gemini-3-flash-preview'
  | 'cloudflare:@cf/meta/llama-3.1-70b-instruct';

export const ALL_RESOLVED_MODEL_IDS: readonly ResolvedModelId[] = [
  'anthropic:claude-opus-4-6',
  'minimax:MiniMax-M2.5-highspeed',
  'moonshot:kimi-k2.5',
  'google:gemini-3-flash-preview',
  'cloudflare:@cf/meta/llama-3.1-70b-instruct',
] as const;

export interface ModelId {
  provider: LLMProvider;
  model: string;
}

export function modelIdToString(modelId: ModelId): string {
  return `${modelId.provider}:${modelId.model}`;
}

export function parseResolvedModelId(value: ResolvedModelId): ModelId {
  const [provider, ...rest] = value.split(':');
  return {
    provider: provider as LLMProvider,
    model: rest.join(':'),
  };
}

// ============================================================
// CACHE / PRICING / MODEL CONFIG
// ============================================================

/**
 * Provider-specific cache semantics (explicit, non-boolean).
 */
export type LLMCacheStrategy =
  | 'none'
  | 'anthropic_prompt_cache'
  | 'gemini_context_cache'
  | 'minimax_prompt_cache'
  | 'moonshot_prompt_cache';

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  cachedInputPer1M?: number;
}

export interface LLMModelConfig {
  resolvedModelId: ResolvedModelId;
  provider: LLMProvider;
  providerModelId: string;
  defaultTemperature: number;
  defaultMaxTokens: number;
  cacheStrategy: LLMCacheStrategy;
  pricing: ModelPricing;
  isPreview: boolean;
  stabilityNote?: string;
  intendedUse: string;
}

export interface RouteClassConfig {
  routeClass: LLMRoutingClass;
  llmAllowed: boolean;
  defaultModelId?: ResolvedModelId;
  fallbackModelIds: ResolvedModelId[];
}

export interface RoutingRule {
  runType: LLMRoutingRunType;
  routeClass: LLMRoutingClass;
  rationale: string;
  budgetCategory: BudgetCategory;
}

// ============================================================
// ROUTING INPUT / DECISION / ERRORS
// ============================================================

export interface LLMRoutingInput {
  runType: LLMRoutingRunType;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  strategyId?: string;
  forceModel?: ResolvedModelId;
  forceRouteClass?: LLMRoutingClass;
  isHighestStakes?: boolean;
  metadata?: Record<string, unknown>;
  overrideReason?: string;
}

export type RoutingResolutionSource =
  | 'forced_override'
  | 'safety_critical'
  | 'strategy_specific'
  | 'default_low_cost';

export interface RoutingDecision {
  id: string;
  timestamp: string;
  runType: LLMRoutingRunType;
  routeClass: LLMRoutingClass;
  resolvedProvider?: LLMProvider;
  resolvedModelId?: ResolvedModelId;
  routingReason: string;
  resolutionSource: RoutingResolutionSource;
  strategyId?: string;
  overrideUsed: boolean;
  overrideReason?: string;
  projectedCostUsd: number;
  actualCostUsd?: number;
  latencyMs?: number;
  budgetCategory: BudgetCategory;
  success: boolean;
  failureReason?: string;
  metadata?: Record<string, unknown>;
}

export type LLMRoutingErrorCode =
  | 'DETERMINISTIC_HARD_CONTROL_FORBIDDEN'
  | 'INVALID_FORCED_MODEL'
  | 'INVALID_FORCED_ROUTE_CLASS'
  | 'BUDGET_EXCEEDED'
  | 'ALL_MODELS_FAILED'
  | 'UNKNOWN_RUN_TYPE';

export interface RoutingError {
  code: LLMRoutingErrorCode;
  message: string;
  retryable: boolean;
}

export interface RoutingResult<T = unknown> {
  success: boolean;
  decision: RoutingDecision;
  modelResponse?: T;
  usage?: TokenUsage;
  error?: RoutingError;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export class LLMRoutingPolicyError extends Error {
  readonly code: LLMRoutingErrorCode;

  constructor(code: LLMRoutingErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'LLMRoutingPolicyError';
  }
}

// ============================================================
// BUDGET TYPES
// ============================================================

export type BudgetCategory =
  | 'research_scoring'
  | 'trading_validation'
  | 'ingestion_classification'
  | 'governance_audit';

export const ALL_BUDGET_CATEGORIES: readonly BudgetCategory[] = [
  'research_scoring',
  'trading_validation',
  'ingestion_classification',
  'governance_audit',
] as const;

export interface BudgetEnvelope {
  category: BudgetCategory;
  dailyLimitUsd: number;
  monthlyLimitUsd: number;
  alertThresholdPct: number;
  hardCapPct: number;
}

export interface BudgetState {
  category: BudgetCategory;
  periodStart: string;
  periodType: 'daily' | 'monthly';
  limitUsd: number;
  consumedUsd: number;
  remainingUsd: number;
  percentUsed: number;
  isBlocked: boolean;
  lastUpdated: string;
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason: string;
  shouldAlert?: boolean;
  dailyState?: BudgetState;
  monthlyState?: BudgetState;
}

/**
 * Budget assumptions are explicit and deterministic.
 * Used for projection and default envelope derivation.
 */
export interface LLMBudgetAssumptions {
  callsPerDay: number;
  daysPerMonth: number;
  routeMix: Record<LLMRoutingClass, number>;
  categoryMix: Record<BudgetCategory, number>;
  avgInputTokensByRouteClass: Record<LLMRoutingClass, number>;
  avgOutputTokensByRouteClass: Record<LLMRoutingClass, number>;
  retryRate: number;
  cacheHitRate: number;
  safetyMultiplier: number;
}

export interface RouteClassBudgetBreakdown {
  routeClass: LLMRoutingClass;
  resolvedModelId?: ResolvedModelId;
  callsPerDay: number;
  projectedDailyCostUsd: number;
  projectedMonthlyCostUsd: number;
}

export interface BudgetProjection {
  assumptions: LLMBudgetAssumptions;
  projectedDailyCostUsd: number;
  projectedMonthlyCostUsd: number;
  byRouteClass: RouteClassBudgetBreakdown[];
}

// ============================================================
// FUNCTION TYPES
// ============================================================

export type ResolveRouteClassFn = (input: LLMRoutingInput) => LLMRoutingClass;
export type GetModelForRunFn = (input: LLMRoutingInput) => LLMModelConfig;
export type ValidateForcedModelFn = (
  forcedModel: ResolvedModelId | undefined
) => { valid: boolean; reason?: string };
export type RouteLLMCallFn<T> = (
  input: LLMRoutingInput,
  executor: (modelConfig: LLMModelConfig) => Promise<{ response: T; usage: TokenUsage }>
) => Promise<RoutingResult<T>>;

// ============================================================
// GUARDS
// ============================================================

export function isValidRunType(value: string): value is LLMRoutingRunType {
  return ALL_RUN_TYPES.includes(value as LLMRoutingRunType);
}

export function isValidRouteClass(value: string): value is LLMRoutingClass {
  return ALL_ROUTE_CLASSES.includes(value as LLMRoutingClass);
}

export function isValidBudgetCategory(value: string): value is BudgetCategory {
  return ALL_BUDGET_CATEGORIES.includes(value as BudgetCategory);
}

export function isValidResolvedModelId(value: string): value is ResolvedModelId {
  return ALL_RESOLVED_MODEL_IDS.includes(value as ResolvedModelId);
}
