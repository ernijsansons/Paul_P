/**
 * Paul P - LLM Routing Policy
 *
 * Deterministic routing policy with explicit precedence:
 * 1) explicit forced override
 * 2) safety-critical / premium-cognition run types
 * 3) strategy-specific mappings
 * 4) default low-cost enrichment
 */

import type { ResearchEnv } from '../../types/env';
import type {
  BudgetCategory,
  LLMModelConfig,
  LLMRoutingClass,
  LLMRoutingInput,
  LLMRoutingRunType,
  LLMRunType,
  ModelId,
  RouteClassConfig,
  RouteClass,
  RoutingDecision,
  RoutingResolutionSource,
  RoutingResult,
  RoutingRule,
  TokenUsage,
  ResolvedModelId,
} from './routing.types';
import {
  LLMRoutingPolicyError,
  isValidResolvedModelId,
  isValidRouteClass,
  parseResolvedModelId,
  ALL_RUN_TYPES,
} from './routing.types';
import {
  computeEstimatedCost,
  getDefaultModelIdForRouteClass,
  getFallbackModelIdsForRouteClass,
  getModelConfig,
  getRouteClassConfig,
} from './routing.manifest';
import { checkBudget, recordUsage } from './routing.budget';
import { deterministicId } from '../utils/deterministic-id';
import { sha256String } from '../evidence/hasher';

// ============================================================
// RULE TABLES
// ============================================================

const PREMIUM_RUN_TYPES: ReadonlySet<LLMRoutingRunType> = new Set([
  'ambiguity_score',
  'equivalence_assessment',
  'resolution_analysis',
  'invariant_explanation',
]);

const RUN_TYPE_DEFAULT_CLASS: Record<LLMRoutingRunType, LLMRoutingClass> = {
  ambiguity_score: 'premium_cognition',
  equivalence_assessment: 'premium_cognition',
  resolution_analysis: 'premium_cognition',
  invariant_explanation: 'premium_cognition',
  postmortem_summary: 'cheap_enrichment',
  wallet_cluster_synthesis: 'synthesis_long_context',
  signal_scanning: 'scanner_fastpath',
  general_enrichment: 'cheap_enrichment',
};

const BUDGET_CATEGORY_BY_RUN_TYPE: Record<LLMRoutingRunType, BudgetCategory> = {
  ambiguity_score: 'research_scoring',
  equivalence_assessment: 'research_scoring',
  resolution_analysis: 'research_scoring',
  invariant_explanation: 'trading_validation',
  postmortem_summary: 'governance_audit',
  wallet_cluster_synthesis: 'research_scoring',
  signal_scanning: 'ingestion_classification',
  general_enrichment: 'ingestion_classification',
};

function strategyRouteClass(strategyId?: string): LLMRoutingClass | undefined {
  if (!strategyId) return undefined;
  const normalized = strategyId.toLowerCase();
  if (normalized.includes('smart-money')) return 'synthesis_long_context';
  if (normalized.includes('xvsignal')) return 'scanner_fastpath';
  return undefined;
}

function routeReasonFor(
  source: RoutingResolutionSource,
  runType: LLMRoutingRunType,
  routeClass: LLMRoutingClass,
  strategyId?: string
): string {
  if (source === 'forced_override') {
    return `Forced override selected route class ${routeClass} for run type ${runType}.`;
  }
  if (source === 'safety_critical') {
    return `Safety-critical run type ${runType} routed to premium cognition.`;
  }
  if (source === 'strategy_specific') {
    return `Strategy-specific mapping (${strategyId ?? 'unknown'}) selected ${routeClass}.`;
  }
  return `Default low-cost mapping selected ${routeClass} for run type ${runType}.`;
}

// ============================================================
// CORE POLICY FUNCTIONS
// ============================================================

export function getBudgetCategoryForRunType(runType: LLMRoutingRunType): BudgetCategory {
  return BUDGET_CATEGORY_BY_RUN_TYPE[runType];
}

export function getRoutingRule(runType: LLMRoutingRunType): RoutingRule {
  const routeClass = RUN_TYPE_DEFAULT_CLASS[runType];
  if (!routeClass) {
    throw new LLMRoutingPolicyError(
      'UNKNOWN_RUN_TYPE',
      `Unknown run type: ${runType}. Routing is fail-closed.`
    );
  }

  const resolutionSource: RoutingResolutionSource = PREMIUM_RUN_TYPES.has(runType)
    ? 'safety_critical'
    : 'default_low_cost';

  return {
    runType,
    routeClass,
    rationale: routeReasonFor(resolutionSource, runType, routeClass),
    budgetCategory: getBudgetCategoryForRunType(runType),
  };
}

export function getAllRoutingRules(): RoutingRule[] {
  return [...ALL_RUN_TYPES].map((runType) => getRoutingRule(runType));
}

export function validateRoutingCompleteness(
  runTypes: LLMRoutingRunType[] = [...ALL_RUN_TYPES]
): { valid: boolean; missing: LLMRoutingRunType[] } {
  const missing = runTypes.filter((runType) => !RUN_TYPE_DEFAULT_CLASS[runType]);
  return { valid: missing.length === 0, missing };
}

/**
 * Resolve route class with strict precedence.
 */
export function resolveRouteClass(input: LLMRoutingInput): LLMRoutingClass {
  // 1) explicit forced override
  if (input.forceRouteClass) {
    return input.forceRouteClass;
  }

  // 2) safety-critical / premium-cognition run types
  if (input.isHighestStakes || PREMIUM_RUN_TYPES.has(input.runType)) {
    return 'premium_cognition';
  }

  // 3) strategy-specific route mappings
  const strategyClass = strategyRouteClass(input.strategyId);
  if (strategyClass) {
    return strategyClass;
  }

  // 4) default low-cost enrichment
  return RUN_TYPE_DEFAULT_CLASS[input.runType] ?? 'cheap_enrichment';
}

function resolveRouteClassWithSource(input: LLMRoutingInput): {
  routeClass: LLMRoutingClass;
  source: RoutingResolutionSource;
} {
  if (input.forceRouteClass) {
    return { routeClass: input.forceRouteClass, source: 'forced_override' };
  }
  if (input.isHighestStakes || PREMIUM_RUN_TYPES.has(input.runType)) {
    return { routeClass: 'premium_cognition', source: 'safety_critical' };
  }
  const strategyClass = strategyRouteClass(input.strategyId);
  if (strategyClass) {
    return { routeClass: strategyClass, source: 'strategy_specific' };
  }
  return {
    routeClass: RUN_TYPE_DEFAULT_CLASS[input.runType] ?? 'cheap_enrichment',
    source: 'default_low_cost',
  };
}

export function validateForcedModel(
  forcedModel: ResolvedModelId | undefined
): { valid: boolean; reason?: string } {
  if (!forcedModel) {
    return { valid: true };
  }
  if (!isValidResolvedModelId(forcedModel)) {
    return { valid: false, reason: `Forced model ${forcedModel} is not in routing manifest.` };
  }
  return { valid: true };
}

function assertModelAllowed(routeClass: LLMRoutingClass): RouteClassConfig {
  const config = getRouteClassConfig(routeClass);
  if (!config.llmAllowed) {
    throw new LLMRoutingPolicyError(
      'DETERMINISTIC_HARD_CONTROL_FORBIDDEN',
      'LLM route requested for deterministic hard control path; this is forbidden by policy.'
    );
  }
  return config;
}

export function getModelForRun(input: LLMRoutingInput): LLMModelConfig {
  const routeClass = resolveRouteClass(input);
  assertModelAllowed(routeClass);

  // precedence #1 forceModel
  if (input.forceModel) {
    const forced = validateForcedModel(input.forceModel);
    if (!forced.valid) {
      throw new LLMRoutingPolicyError('INVALID_FORCED_MODEL', forced.reason ?? 'Invalid forceModel');
    }
    return getModelConfig(input.forceModel);
  }

  const defaultModelId = getDefaultModelIdForRouteClass(routeClass);
  if (!defaultModelId) {
    throw new LLMRoutingPolicyError(
      'UNKNOWN_RUN_TYPE',
      `No default model configured for route class ${routeClass}.`
    );
  }
  return getModelConfig(defaultModelId);
}

// ============================================================
// MAIN WRAPPER
// ============================================================

export type LLMExecutor<T> = (
  modelConfig: LLMModelConfig
) => Promise<{ response: T; usage: TokenUsage }>;

function normalizeInputFromEnv(env: ResearchEnv, input: LLMRoutingInput): LLMRoutingInput {
  const forcedModelFromEnv = env.LLM_ROUTING_FORCE_MODEL;
  const forcedRouteFromEnv = env.LLM_ROUTING_FORCE_ROUTE_CLASS;

  let effective = { ...input };

  if (!effective.forceModel && forcedModelFromEnv) {
    if (isValidResolvedModelId(forcedModelFromEnv)) {
      effective = {
        ...effective,
        forceModel: forcedModelFromEnv,
        overrideReason: effective.overrideReason ?? 'Environment forced model override',
      };
    } else {
      throw new LLMRoutingPolicyError(
        'INVALID_FORCED_MODEL',
        `Environment forced model ${forcedModelFromEnv} is not in manifest.`
      );
    }
  }

  if (!effective.forceRouteClass && forcedRouteFromEnv) {
    if (!isValidRouteClass(forcedRouteFromEnv)) {
      throw new LLMRoutingPolicyError(
        'INVALID_FORCED_ROUTE_CLASS',
        `Environment forced route class ${forcedRouteFromEnv} is not supported.`
      );
    }
    effective = {
      ...effective,
      forceRouteClass: forcedRouteFromEnv,
      overrideReason: effective.overrideReason ?? 'Environment forced route-class override',
    };
  }

  return effective;
}

async function storeRoutingDecision(env: ResearchEnv, decision: RoutingDecision): Promise<void> {
  const selectedModelPayload =
    decision.resolvedModelId && decision.resolvedProvider
      ? JSON.stringify({
          resolvedModelId: decision.resolvedModelId,
          provider: decision.resolvedProvider,
        })
      : JSON.stringify({ no_llm: true });

  const decisionHash = await sha256String(
    JSON.stringify({
      runType: decision.runType,
      routeClass: decision.routeClass,
      resolvedModelId: decision.resolvedModelId,
      resolutionSource: decision.resolutionSource,
    })
  );

  await env.DB.prepare(
    `
    INSERT INTO llm_routing_decisions (
      id, timestamp, run_type, route_class, selected_model,
      fallbacks_attempted, budget_category, projected_cost_usd,
      actual_cost_usd, latency_ms, success, failure_reason, decision_hash,
      strategy_id, override_used, override_reason, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  )
    .bind(
      decision.id,
      decision.timestamp,
      decision.runType,
      decision.routeClass,
      selectedModelPayload,
      JSON.stringify([]),
      decision.budgetCategory,
      decision.projectedCostUsd,
      decision.actualCostUsd ?? null,
      decision.latencyMs ?? null,
      decision.success ? 1 : 0,
      decision.failureReason ?? null,
      decisionHash,
      decision.strategyId ?? null,
      decision.overrideUsed ? 1 : 0,
      decision.overrideReason ?? null,
      decision.metadata ? JSON.stringify(decision.metadata) : null
    )
    .run();

  // Emit LLM_ROUTING_DECISION for EVERY persisted routing decision
  const routingAuditId = deterministicId(
    'llm-routing-decision',
    decision.runType,
    decision.routeClass,
    decision.timestamp
  );
  await env.DB.prepare(
    `
    INSERT INTO audit_log (id, event_type, entity_type, entity_id, payload, timestamp)
    VALUES (?, 'LLM_ROUTING_DECISION', 'llm_routing', ?, ?, ?)
  `
  )
    .bind(
      routingAuditId,
      decision.id,
      JSON.stringify({
        runType: decision.runType,
        routeClass: decision.routeClass,
        resolvedModelId: decision.resolvedModelId,
        resolutionSource: decision.resolutionSource,
        success: decision.success,
        projectedCostUsd: decision.projectedCostUsd,
        actualCostUsd: decision.actualCostUsd,
        budgetCategory: decision.budgetCategory,
        decisionHash,
      }),
      decision.timestamp
    )
    .run();

  // Additionally emit LLM_ROUTING_OVERRIDE for override cases (kept as-is)
  if (decision.overrideUsed) {
    const overrideAuditId = deterministicId(
      'llm-routing-override',
      decision.runType,
      decision.routeClass,
      decision.timestamp
    );
    await env.DB.prepare(
      `
      INSERT INTO audit_log (id, event_type, entity_type, entity_id, payload, timestamp)
      VALUES (?, 'LLM_ROUTING_OVERRIDE', 'llm_routing', ?, ?, ?)
    `
    )
      .bind(
        overrideAuditId,
        decision.id,
        JSON.stringify({
          runType: decision.runType,
          routeClass: decision.routeClass,
          resolvedModelId: decision.resolvedModelId,
          reason: decision.overrideReason ?? 'No override reason provided',
        }),
        decision.timestamp
      )
      .run();
  }
}

export async function routeLLMCall<T>(
  env: ResearchEnv,
  input: LLMRoutingInput,
  executor: LLMExecutor<T>
): Promise<RoutingResult<T>> {
  const timestamp = new Date().toISOString();
  let effectiveInput: LLMRoutingInput;
  try {
    effectiveInput = normalizeInputFromEnv(env, input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorCode =
      error instanceof LLMRoutingPolicyError ? error.code : 'INVALID_FORCED_MODEL';
    const decision: RoutingDecision = {
      id: deterministicId('route', input.runType, timestamp, 'invalid-env-override'),
      timestamp,
      runType: input.runType,
      routeClass: input.forceRouteClass ?? resolveRouteClass(input),
      routingReason: message,
      resolutionSource: 'forced_override',
      strategyId: input.strategyId,
      overrideUsed: true,
      overrideReason: input.overrideReason,
      projectedCostUsd: 0,
      budgetCategory: getBudgetCategoryForRunType(input.runType),
      success: false,
      failureReason: message,
      metadata: input.metadata,
    };
    await storeRoutingDecision(env, decision);
    return {
      success: false,
      decision,
      error: { code: errorCode, message, retryable: false },
    };
  }

  const { routeClass, source } = resolveRouteClassWithSource(effectiveInput);
  const routingReason = routeReasonFor(source, effectiveInput.runType, routeClass, effectiveInput.strategyId);
  const budgetCategory = getBudgetCategoryForRunType(effectiveInput.runType);

  if (routeClass === 'deterministic_hard_control') {
    const message =
      'LLM route requested for deterministic hard control path; this is forbidden by policy.';
    const decision: RoutingDecision = {
      id: deterministicId('route', effectiveInput.runType, timestamp, 'deterministic-hard-control'),
      timestamp,
      runType: effectiveInput.runType,
      routeClass,
      routingReason,
      resolutionSource: source,
      strategyId: effectiveInput.strategyId,
      overrideUsed: !!(effectiveInput.forceModel || effectiveInput.forceRouteClass),
      overrideReason: effectiveInput.overrideReason,
      projectedCostUsd: 0,
      budgetCategory,
      success: false,
      failureReason: message,
      metadata: effectiveInput.metadata,
    };
    await storeRoutingDecision(env, decision);
    return {
      success: false,
      decision,
      error: {
        code: 'DETERMINISTIC_HARD_CONTROL_FORBIDDEN',
        message,
        retryable: false,
      },
    };
  }

  let selectedModelConfig: LLMModelConfig;
  try {
    selectedModelConfig = getModelForRun(effectiveInput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const decision: RoutingDecision = {
      id: deterministicId('route', effectiveInput.runType, timestamp, 'invalid-model'),
      timestamp,
      runType: effectiveInput.runType,
      routeClass,
      routingReason,
      resolutionSource: source,
      strategyId: effectiveInput.strategyId,
      overrideUsed: !!(effectiveInput.forceModel || effectiveInput.forceRouteClass),
      overrideReason: effectiveInput.overrideReason,
      projectedCostUsd: 0,
      budgetCategory,
      success: false,
      failureReason: message,
      metadata: effectiveInput.metadata,
    };
    await storeRoutingDecision(env, decision);
    return {
      success: false,
      decision,
      error: { code: 'INVALID_FORCED_MODEL', message, retryable: false },
    };
  }

  const projectedCostUsd = computeEstimatedCost(
    selectedModelConfig.resolvedModelId,
    effectiveInput.estimatedInputTokens,
    effectiveInput.estimatedOutputTokens
  );

  const budget = await checkBudget(env, budgetCategory, projectedCostUsd);
  if (!budget.allowed) {
    const decision: RoutingDecision = {
      id: deterministicId('route', effectiveInput.runType, timestamp, 'budget-blocked'),
      timestamp,
      runType: effectiveInput.runType,
      routeClass,
      resolvedProvider: selectedModelConfig.provider,
      resolvedModelId: selectedModelConfig.resolvedModelId,
      routingReason,
      resolutionSource: source,
      strategyId: effectiveInput.strategyId,
      overrideUsed: !!(effectiveInput.forceModel || effectiveInput.forceRouteClass),
      overrideReason: effectiveInput.overrideReason,
      projectedCostUsd,
      budgetCategory,
      success: false,
      failureReason: `Budget exceeded: ${budget.reason}`,
      metadata: effectiveInput.metadata,
    };
    await storeRoutingDecision(env, decision);
    return {
      success: false,
      decision,
      error: {
        code: 'BUDGET_EXCEEDED',
        message: budget.reason,
        retryable: false,
      },
    };
  }

  const modelIdsToTry: ResolvedModelId[] = effectiveInput.forceModel
    ? [effectiveInput.forceModel]
    : [
        selectedModelConfig.resolvedModelId,
        ...getFallbackModelIdsForRouteClass(routeClass),
      ].filter(
        (value, index, self) => self.indexOf(value) === index
      );

  let lastErrorMessage = 'All models failed';
  for (const modelId of modelIdsToTry) {
    const currentModel = getModelConfig(modelId);
    try {
      const start = Date.now();
      const { response, usage } = await executor(currentModel);
      const latencyMs = Math.max(0, Date.now() - start);
      const actualCost =
        usage.costUsd > 0
          ? usage.costUsd
          : computeEstimatedCost(modelId, usage.inputTokens, usage.outputTokens, usage.cachedTokens);

      await recordUsage(env, budgetCategory, actualCost);

      const decision: RoutingDecision = {
        id: deterministicId('route', effectiveInput.runType, timestamp, modelId),
        timestamp,
        runType: effectiveInput.runType,
        routeClass,
        resolvedProvider: currentModel.provider,
        resolvedModelId: currentModel.resolvedModelId,
        routingReason,
        resolutionSource: source,
        strategyId: effectiveInput.strategyId,
        overrideUsed: !!(effectiveInput.forceModel || effectiveInput.forceRouteClass),
        overrideReason: effectiveInput.overrideReason,
        projectedCostUsd,
        actualCostUsd: actualCost,
        latencyMs,
        budgetCategory,
        success: true,
        metadata: {
          ...(effectiveInput.metadata ?? {}),
          routeClass,
          resolvedModelId: currentModel.resolvedModelId,
        },
      };
      await storeRoutingDecision(env, decision);
      return { success: true, decision, modelResponse: response, usage: { ...usage, costUsd: actualCost } };
    } catch (error) {
      lastErrorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  const decision: RoutingDecision = {
    id: deterministicId('route', effectiveInput.runType, timestamp, 'all-models-failed'),
    timestamp,
    runType: effectiveInput.runType,
    routeClass,
    resolvedProvider: selectedModelConfig.provider,
    resolvedModelId: selectedModelConfig.resolvedModelId,
    routingReason,
    resolutionSource: source,
    strategyId: effectiveInput.strategyId,
    overrideUsed: !!(effectiveInput.forceModel || effectiveInput.forceRouteClass),
    overrideReason: effectiveInput.overrideReason,
    projectedCostUsd,
    budgetCategory,
    success: false,
    failureReason: lastErrorMessage,
    metadata: effectiveInput.metadata,
  };
  await storeRoutingDecision(env, decision);
  return {
    success: false,
    decision,
    error: {
      code: 'ALL_MODELS_FAILED',
      message: lastErrorMessage,
      retryable: true,
    },
  };
}

// ============================================================
// COMPATIBILITY WRAPPERS
// ============================================================

/**
 * Legacy wrapper retained for existing callers/tests.
 * Internally routes through routeLLMCall.
 */
export async function executeWithRouting<T>(
  env: ResearchEnv,
  runType: LLMRoutingRunType,
  estimatedInputTokens: number,
  estimatedOutputTokens: number,
  executor: (modelId: ModelId) => Promise<{ response: T; usage: TokenUsage }>,
  options?: { strategyId?: string; metadata?: Record<string, unknown> }
): Promise<RoutingResult<T>> {
  return routeLLMCall(
    env,
    {
      runType,
      estimatedInputTokens,
      estimatedOutputTokens,
      strategyId: options?.strategyId,
      metadata: options?.metadata,
    },
    async (modelConfig) => executor(parseResolvedModelId(modelConfig.resolvedModelId))
  );
}

export async function computeRoutingDecision(
  runType: LLMRoutingRunType,
  estimatedInputTokens: number,
  estimatedOutputTokens: number
): Promise<{
  rule: RoutingRule;
  routeConfig: RouteClassConfig;
  selectedModel?: ModelId;
  selectedModelId?: ResolvedModelId;
  projectedCostUsd: number;
  decisionHash: string;
}> {
  const rule = getRoutingRule(runType);
  const routeConfig = getRouteClassConfig(rule.routeClass);
  const selectedModelId = routeConfig.defaultModelId;
  const selectedModel = selectedModelId ? parseResolvedModelId(selectedModelId) : undefined;
  const projectedCostUsd = selectedModelId
    ? computeEstimatedCost(selectedModelId, estimatedInputTokens, estimatedOutputTokens)
    : 0;
  const decisionHash = await sha256String(
    JSON.stringify({
      runType,
      routeClass: rule.routeClass,
      selectedModelId: selectedModelId ?? null,
      estimatedInputTokens,
      estimatedOutputTokens,
    })
  );

  return {
    rule,
    routeConfig,
    selectedModel,
    selectedModelId,
    projectedCostUsd,
    decisionHash,
  };
}

export function getRouteClassForRunType(
  runType: LLMRoutingRunType
): RouteClass {
  return getRoutingRule(runType).routeClass;
}

export async function getRecentDecisions(
  env: ResearchEnv,
  runType?: LLMRunType,
  limit: number = 100
): Promise<RoutingDecision[]> {
  let query = `SELECT * FROM llm_routing_decisions`;
  if (runType) {
    query += ` WHERE run_type = ?`;
  }
  query += ` ORDER BY timestamp DESC LIMIT ?`;

  const stmt = runType
    ? env.DB.prepare(query).bind(runType, limit)
    : env.DB.prepare(query).bind(limit);

  const rows = await stmt.all<{
    id: string;
    timestamp: string;
    run_type: string;
    route_class: string;
    selected_model: string;
    budget_category: string;
    projected_cost_usd: number;
    actual_cost_usd: number | null;
    latency_ms: number | null;
    success: number;
    failure_reason: string | null;
    strategy_id: string | null;
    override_used: number;
    override_reason: string | null;
    metadata: string | null;
  }>();

  return (rows.results ?? []).map((row) => {
    const parsedModel = JSON.parse(row.selected_model) as {
      resolvedModelId?: ResolvedModelId;
      provider?: string;
      no_llm?: boolean;
    };
    return {
      id: row.id,
      timestamp: row.timestamp,
      runType: row.run_type as LLMRoutingRunType,
      routeClass: row.route_class as LLMRoutingClass,
      resolvedProvider: parsedModel.provider as RoutingDecision['resolvedProvider'],
      resolvedModelId: parsedModel.resolvedModelId,
      routingReason:
        row.metadata && JSON.parse(row.metadata).routingReason
          ? (JSON.parse(row.metadata).routingReason as string)
          : `Persisted routing decision for ${row.run_type}`,
      resolutionSource:
        row.metadata && JSON.parse(row.metadata).resolutionSource
          ? (JSON.parse(row.metadata).resolutionSource as RoutingResolutionSource)
          : 'default_low_cost',
      budgetCategory: row.budget_category as BudgetCategory,
      projectedCostUsd: row.projected_cost_usd,
      actualCostUsd: row.actual_cost_usd ?? undefined,
      latencyMs: row.latency_ms ?? undefined,
      success: row.success === 1,
      failureReason: row.failure_reason ?? undefined,
      strategyId: row.strategy_id ?? undefined,
      overrideUsed: row.override_used === 1,
      overrideReason: row.override_reason ?? undefined,
      metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
    };
  });
}

export async function getRoutingStats(
  env: ResearchEnv,
  periodStart: string,
  periodEnd: string
): Promise<{
  totalDecisions: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  totalCostUsd: number;
  avgLatencyMs: number;
  byRouteClass: Record<LLMRoutingClass, { count: number; successRate: number; avgLatencyMs: number }>;
}> {
  const result = await env.DB.prepare(
    `
    SELECT
      route_class,
      COUNT(*) as total,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
      COALESCE(SUM(actual_cost_usd), 0) as total_cost,
      COALESCE(AVG(CASE WHEN latency_ms IS NOT NULL THEN latency_ms END), 0) as avg_latency
    FROM llm_routing_decisions
    WHERE timestamp >= ? AND timestamp < ?
    GROUP BY route_class
  `
  )
    .bind(periodStart, periodEnd)
    .all<{
      route_class: string;
      total: number;
      successes: number;
      total_cost: number;
      avg_latency: number;
    }>();

  const byRouteClass: Record<
    LLMRoutingClass,
    { count: number; successRate: number; avgLatencyMs: number }
  > = {
    deterministic_hard_control: { count: 0, successRate: 0, avgLatencyMs: 0 },
    premium_cognition: { count: 0, successRate: 0, avgLatencyMs: 0 },
    scanner_fastpath: { count: 0, successRate: 0, avgLatencyMs: 0 },
    synthesis_long_context: { count: 0, successRate: 0, avgLatencyMs: 0 },
    cheap_enrichment: { count: 0, successRate: 0, avgLatencyMs: 0 },
  };

  let totalDecisions = 0;
  let successCount = 0;
  let totalCostUsd = 0;
  let weightedLatency = 0;
  let latencyCount = 0;

  for (const row of result.results ?? []) {
    const routeClass = row.route_class as LLMRoutingClass;
    totalDecisions += row.total;
    successCount += row.successes;
    totalCostUsd += row.total_cost;
    weightedLatency += row.avg_latency * row.total;
    latencyCount += row.total;

    if (routeClass in byRouteClass) {
      byRouteClass[routeClass] = {
        count: row.total,
        successRate: row.total > 0 ? row.successes / row.total : 0,
        avgLatencyMs: row.avg_latency,
      };
    }
  }

  return {
    totalDecisions,
    successCount,
    failureCount: totalDecisions - successCount,
    successRate: totalDecisions > 0 ? successCount / totalDecisions : 0,
    totalCostUsd,
    avgLatencyMs: latencyCount > 0 ? weightedLatency / latencyCount : 0,
    byRouteClass,
  };
}
