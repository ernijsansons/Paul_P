/**
 * Paul P - LLM Governance (P-07)
 *
 * Structured LLM scoring with:
 * - Prompt versioning (via prompt-loader.ts)
 * - Structured outputs with rule-text citations
 * - Regression tests
 * - Human review workflow
 * - Multi-provider routing with budget enforcement (via executor.ts)
 *
 * This module builds scoring-specific functionality on top of the unified
 * executor layer. Agents should use routeAndExecuteGovernedLLMCall for general
 * LLM work, or the scoring functions here for market analysis.
 */

import type { ResearchEnv } from '../../types/env';
import { sha256String } from '../evidence/hasher';
import { deterministicId } from '../utils/deterministic-id';
import {
  executeRoutedScoringCall,
  type LLMExecutionInput,
} from '../llm/executor';
import {
  loadPromptWithHash,
  getPromptVersion as getPromptVersionFromLoader,
  type LLMScoringRunType,
} from '../llm/prompt-loader';

// Re-export for backward compatibility
export type { LLMScoringRunType };

export interface LLMScoringInput {
  runType: LLMScoringRunType;
  targetEntityType: 'market' | 'market_pair';
  targetEntityId: string;
  marketTitle: string;
  resolutionCriteria: string;
  additionalContext?: Record<string, unknown>;
}

export interface LLMScoringOutput {
  score: number; // 0.0 to 1.0
  reasoning: string;
  citedPassages: string[]; // Exact passages from resolution criteria
  confidence: number; // 0.0 to 1.0
  warnings?: string[];
}

export interface LLMScoringRun {
  id: string;
  runType: LLMScoringRunType;
  targetEntityType: 'market' | 'market_pair';
  targetEntityId: string;
  promptTemplateVersion: string;
  promptTemplateHash: string;
  modelId: string;
  inputText: string;
  inputHash: string;
  outputJson: LLMScoringOutput;
  outputScore: number;
  citedRulePassages: string[];
  confidence: number;
  flaggedForHumanReview: boolean;
  humanOverrideScore?: number;
  humanOverrideReason?: string;
  regressionTestId?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  createdAt: string;
}

/**
 * Storage compatibility mapping:
 * legacy schemas constrain rule interpretation runs to `rule_interpretation`.
 */
const STORAGE_RUN_TYPE_ALIASES: Partial<Record<LLMScoringRunType, string>> = {
  invariant_explanation: 'rule_interpretation',
};

function toStorageRunType(runType: LLMScoringRunType): string {
  return STORAGE_RUN_TYPE_ALIASES[runType] ?? runType;
}

// ============================================================
// MAIN SCORING FUNCTIONS
// ============================================================

/**
 * Run an LLM scoring task with full governance.
 * This now routes through the production routing layer by default.
 */
export async function runLLMScoring(
  env: ResearchEnv,
  input: LLMScoringInput
): Promise<LLMScoringRun> {
  return runLLMScoringWithRouting(env, input);
}

/**
 * Run an LLM scoring task with routing layer (multi-provider, budget-enforced)
 *
 * This function uses the unified executor layer to:
 * - Select the appropriate model based on run type
 * - Enforce budget limits
 * - Handle fallbacks on provider failures
 * - Log routing decisions and audit events
 */
export async function runLLMScoringWithRouting(
  env: ResearchEnv,
  input: LLMScoringInput
): Promise<LLMScoringRun> {
  // Load prompt template with hash
  const template = await loadPromptWithHash(input.runType);

  // Build variables for prompt rendering
  const variables: Record<string, string | undefined> = {
    marketTitle: input.marketTitle,
    resolutionCriteria: input.resolutionCriteria,
    additionalContext: input.additionalContext
      ? JSON.stringify(input.additionalContext, null, 2)
      : undefined,
    ...((input.additionalContext as Record<string, string>) ?? {}),
  };

  // Build input text for storage
  const inputText = JSON.stringify({
    marketTitle: input.marketTitle,
    resolutionCriteria: input.resolutionCriteria,
    additionalContext: input.additionalContext,
  });

  // Execute through the unified executor layer
  const executionInput: LLMExecutionInput = {
    runType: input.runType,
    variables,
    metadata: {
      targetEntityType: input.targetEntityType,
      targetEntityId: input.targetEntityId,
    },
  };

  const result = await executeRoutedScoringCall(env, executionInput);

  const createdAt = new Date().toISOString();
  const inputHash = await sha256String(inputText);
  const runId = deterministicId(
    'llm',
    input.runType,
    input.targetEntityType,
    input.targetEntityId,
    template.version,
    inputHash,
    createdAt
  );

  // Handle execution failure
  if (!result.success || !result.parsedOutput) {
    const errorOutput: LLMScoringOutput = result.parsedOutput ?? {
      score: 0.5,
      reasoning: `Execution failed: ${result.error?.message ?? 'Unknown error'}`,
      citedPassages: [],
      confidence: 0.0,
      warnings: [
        `Error code: ${result.error?.code ?? 'UNKNOWN'}`,
        result.error?.message ?? '',
      ],
    };

    const run: LLMScoringRun = {
      id: runId,
      runType: input.runType,
      targetEntityType: input.targetEntityType,
      targetEntityId: input.targetEntityId,
      promptTemplateVersion: template.version,
      promptTemplateHash: template.hash,
      modelId: result.modelId ?? 'routing:none',
      inputText,
      inputHash,
      outputJson: errorOutput,
      outputScore: errorOutput.score,
      citedRulePassages: errorOutput.citedPassages,
      confidence: errorOutput.confidence,
      flaggedForHumanReview: true,
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      costUsd: result.usage?.costUsd,
      createdAt,
    };

    await storeScoringRun(env, run);
    return run;
  }

  // Successful execution with parsed output
  const output = result.parsedOutput;

  // Determine if human review is needed
  const flaggedForHumanReview =
    output.confidence < 0.7 ||
    (output.warnings?.length ?? 0) > 0 ||
    output.citedPassages.length === 0;

  const run: LLMScoringRun = {
    id: runId,
    runType: input.runType,
    targetEntityType: input.targetEntityType,
    targetEntityId: input.targetEntityId,
    promptTemplateVersion: template.version,
    promptTemplateHash: template.hash,
    modelId: result.modelId ?? 'routing:none',
    inputText,
    inputHash,
    outputJson: output,
    outputScore: output.score,
    citedRulePassages: output.citedPassages,
    confidence: output.confidence,
    flaggedForHumanReview,
    inputTokens: result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
    costUsd: result.usage?.costUsd,
    createdAt,
  };

  // Store the run in D1
  await storeScoringRun(env, run);

  return run;
}

// ============================================================
// STORAGE
// ============================================================

/**
 * Store scoring run in D1
 */
async function storeScoringRun(env: ResearchEnv, run: LLMScoringRun): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO llm_scoring_runs (
      id, run_type, target_entity_type, target_entity_id,
      prompt_template_version, prompt_template_hash, model_id,
      input_text, input_hash, output_json, output_score,
      cited_rule_passages, confidence, flagged_for_human_review,
      human_override_score, human_override_reason, regression_test_id,
      input_tokens, output_tokens, cost_usd, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    run.id,
    toStorageRunType(run.runType),
    run.targetEntityType,
    run.targetEntityId,
    run.promptTemplateVersion,
    run.promptTemplateHash,
    run.modelId,
    run.inputText,
    run.inputHash,
    JSON.stringify(run.outputJson),
    run.outputScore,
    JSON.stringify(run.citedRulePassages),
    run.confidence,
    run.flaggedForHumanReview ? 1 : 0,
    run.humanOverrideScore ?? null,
    run.humanOverrideReason ?? null,
    run.regressionTestId ?? null,
    run.inputTokens ?? null,
    run.outputTokens ?? null,
    run.costUsd ?? null,
    run.createdAt
  ).run();
}

// ============================================================
// CONVENIENCE FUNCTIONS
// ============================================================

/**
 * Score market ambiguity
 */
export async function scoreAmbiguity(
  env: ResearchEnv,
  marketId: string,
  marketTitle: string,
  resolutionCriteria: string
): Promise<LLMScoringRun> {
  return runLLMScoring(env, {
    runType: 'ambiguity_score',
    targetEntityType: 'market',
    targetEntityId: marketId,
    marketTitle,
    resolutionCriteria,
  });
}

/**
 * Assess market equivalence
 */
export async function assessEquivalence(
  env: ResearchEnv,
  marketPairId: string,
  marketA: { title: string; criteria: string; venue: string },
  marketB: { title: string; criteria: string; venue: string }
): Promise<LLMScoringRun> {
  return runLLMScoring(env, {
    runType: 'equivalence_assessment',
    targetEntityType: 'market_pair',
    targetEntityId: marketPairId,
    marketTitle: `${marketA.title} vs ${marketB.title}`,
    resolutionCriteria: '', // Not used for equivalence
    additionalContext: {
      venueA: marketA.venue,
      marketATitle: marketA.title,
      marketACriteria: marketA.criteria,
      venueB: marketB.venue,
      marketBTitle: marketB.title,
      marketBCriteria: marketB.criteria,
    },
  });
}

/**
 * Override a scoring run with human review
 */
export async function applyHumanOverride(
  env: ResearchEnv,
  runId: string,
  overrideScore: number,
  reason: string
): Promise<void> {
  await env.DB.prepare(`
    UPDATE llm_scoring_runs
    SET human_override_score = ?, human_override_reason = ?, flagged_for_human_review = 0
    WHERE id = ?
  `).bind(overrideScore, reason, runId).run();
}

/**
 * Get prompt template version for a run type
 */
export function getPromptVersion(runType: LLMScoringRunType): string {
  return getPromptVersionFromLoader(runType);
}

/**
 * Check if execution is gated by human review
 * Returns true if execution should proceed, false if blocked
 */
export async function checkExecutionGate(
  env: ResearchEnv,
  marketId: string
): Promise<{ canExecute: boolean; reason?: string }> {
  const result = await env.DB.prepare(`
    SELECT flagged_for_human_review, human_override_score
    FROM llm_scoring_runs
    WHERE target_entity_type = 'market' AND target_entity_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(marketId).first<{
    flagged_for_human_review: number;
    human_override_score: number | null;
  }>();

  if (!result) {
    return { canExecute: false, reason: 'No LLM scoring run found for market' };
  }

  if (result.flagged_for_human_review && result.human_override_score === null) {
    return { canExecute: false, reason: 'Awaiting human review' };
  }

  return { canExecute: true };
}
