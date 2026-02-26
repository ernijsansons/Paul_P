/**
 * Paul P - LLM Governance (P-07)
 *
 * Structured LLM scoring with:
 * - Prompt versioning
 * - Structured outputs with rule-text citations
 * - Regression tests
 * - Human review workflow
 */

import type { ResearchEnv } from '../../types/env';
import { sha256String } from '../evidence/hasher';
import { deterministicId } from '../utils/deterministic-id';

export type LLMScoringRunType =
  | 'ambiguity_score'
  | 'resolution_analysis'
  | 'equivalence_assessment'
  | 'rule_interpretation';

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

export interface PromptTemplate {
  version: string;
  runType: LLMScoringRunType;
  systemPrompt: string;
  userPromptTemplate: string;
}

// Prompt templates versioned for governance
const PROMPT_TEMPLATES: Record<LLMScoringRunType, PromptTemplate> = {
  ambiguity_score: {
    version: '1.0.0',
    runType: 'ambiguity_score',
    systemPrompt: `You are an expert analyst evaluating prediction market resolution criteria for ambiguity.

Your task is to score how ambiguous the resolution criteria are on a scale of 0.0 to 1.0:
- 0.0 = Completely unambiguous, clear resolution path
- 0.5 = Moderately ambiguous, some edge cases unclear
- 1.0 = Highly ambiguous, significant risk of disputed resolution

You MUST cite specific passages from the resolution criteria that support your score.

Respond ONLY with valid JSON in this exact format:
{
  "score": <number 0.0-1.0>,
  "reasoning": "<string explaining your analysis>",
  "citedPassages": ["<exact quote from criteria>", ...],
  "confidence": <number 0.0-1.0>,
  "warnings": ["<any concerns>", ...]
}`,
    userPromptTemplate: `Analyze the following prediction market for resolution ambiguity:

**Market Title:** {{marketTitle}}

**Resolution Criteria:**
{{resolutionCriteria}}

{{#if additionalContext}}
**Additional Context:**
{{additionalContext}}
{{/if}}

Provide your ambiguity score analysis.`,
  },

  resolution_analysis: {
    version: '1.0.0',
    runType: 'resolution_analysis',
    systemPrompt: `You are an expert analyst evaluating how a prediction market will resolve.

Analyze the resolution criteria carefully and determine:
1. What specific outcome would trigger YES resolution
2. What specific outcome would trigger NO resolution
3. What would trigger VOID/refund

You MUST cite specific passages from the resolution criteria.

Respond ONLY with valid JSON in this exact format:
{
  "score": <probability of YES resolution 0.0-1.0>,
  "reasoning": "<string explaining resolution path analysis>",
  "citedPassages": ["<exact quote from criteria>", ...],
  "confidence": <number 0.0-1.0>,
  "warnings": ["<any concerns>", ...]
}`,
    userPromptTemplate: `Analyze the resolution path for this prediction market:

**Market Title:** {{marketTitle}}

**Resolution Criteria:**
{{resolutionCriteria}}

{{#if additionalContext}}
**Additional Context:**
{{additionalContext}}
{{/if}}

Provide your resolution analysis.`,
  },

  equivalence_assessment: {
    version: '1.0.0',
    runType: 'equivalence_assessment',
    systemPrompt: `You are an expert analyst comparing two prediction markets for equivalence.

Evaluate whether these markets should be considered equivalent for cross-venue arbitrage:
- identical: Same resolution source, same criteria, same timing
- near_equivalent: Minor wording differences, same effective meaning
- similar_but_divergent: Same underlying event but different resolution criteria
- not_equivalent: Should never be paired for arbitrage

You MUST cite specific passages from both markets' criteria.

Respond ONLY with valid JSON in this exact format:
{
  "score": <1.0 for identical, 0.75 for near_equivalent, 0.5 for similar_but_divergent, 0.0 for not_equivalent>,
  "reasoning": "<string explaining equivalence analysis>",
  "citedPassages": ["<exact quote from criteria>", ...],
  "confidence": <number 0.0-1.0>,
  "warnings": ["<any concerns>", ...]
}`,
    userPromptTemplate: `Compare these two markets for equivalence:

**Market A ({{venueA}}):**
Title: {{marketATitle}}
Resolution Criteria: {{marketACriteria}}

**Market B ({{venueB}}):**
Title: {{marketBTitle}}
Resolution Criteria: {{marketBCriteria}}

Provide your equivalence assessment.`,
  },

  rule_interpretation: {
    version: '1.0.0',
    runType: 'rule_interpretation',
    systemPrompt: `You are an expert analyst interpreting prediction market resolution rules.

Given a specific scenario, determine how the market would resolve according to its rules.
Consider edge cases and potential disputes.

You MUST cite specific passages from the resolution criteria.

Respond ONLY with valid JSON in this exact format:
{
  "score": <probability this scenario resolves YES 0.0-1.0>,
  "reasoning": "<string explaining interpretation>",
  "citedPassages": ["<exact quote from criteria>", ...],
  "confidence": <number 0.0-1.0>,
  "warnings": ["<any concerns>", ...]
}`,
    userPromptTemplate: `Interpret how this market would resolve given the scenario:

**Market Title:** {{marketTitle}}

**Resolution Criteria:**
{{resolutionCriteria}}

**Scenario:**
{{scenario}}

Provide your rule interpretation.`,
  },
};

/**
 * Simple template rendering (replace {{variable}} placeholders)
 */
function renderTemplate(
  template: string,
  variables: Record<string, string | undefined>
): string {
  let result = template;

  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    result = result.replace(regex, value ?? '');
  }

  // Handle conditional blocks {{#if variable}}...{{/if}}
  for (const [key, value] of Object.entries(variables)) {
    const ifRegex = new RegExp(
      `\\{\\{#if ${key}\\}\\}([\\s\\S]*?)\\{\\{/if\\}\\}`,
      'g'
    );
    result = result.replace(ifRegex, value ? '$1' : '');
  }

  return result;
}

/**
 * Call the LLM via Cloudflare AI binding
 */
async function callLLM(
  env: ResearchEnv,
  systemPrompt: string,
  userPrompt: string
): Promise<LLMScoringOutput> {
  // Use any available text generation model via the AI binding
  // Type assertion needed as model names may not be in the static type definitions
  const response = await (env.AI.run as (model: string, input: unknown) => Promise<unknown>)(
    '@cf/meta/llama-3.1-70b-instruct',
    {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 2000,
      temperature: 0.1, // Low temperature for consistent scoring
    }
  );

  // Parse the response - it should be JSON
  const responseText = typeof response === 'string'
    ? response
    : (response as { response?: string }).response ?? '';

  try {
    const parsed = JSON.parse(responseText) as LLMScoringOutput;

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

    return parsed;
  } catch (error) {
    // If parsing fails, return a low-confidence result
    return {
      score: 0.5,
      reasoning: `Failed to parse LLM response: ${error instanceof Error ? error.message : String(error)}`,
      citedPassages: [],
      confidence: 0.0,
      warnings: ['LLM response parsing failed', responseText.slice(0, 500)],
    };
  }
}

/**
 * Run an LLM scoring task with full governance
 */
export async function runLLMScoring(
  env: ResearchEnv,
  input: LLMScoringInput
): Promise<LLMScoringRun> {
  const template = PROMPT_TEMPLATES[input.runType];
  const promptHash = await sha256String(template.systemPrompt + template.userPromptTemplate);

  // Render the user prompt
  const userPrompt = renderTemplate(template.userPromptTemplate, {
    marketTitle: input.marketTitle,
    resolutionCriteria: input.resolutionCriteria,
    additionalContext: input.additionalContext
      ? JSON.stringify(input.additionalContext, null, 2)
      : undefined,
    ...((input.additionalContext as Record<string, string>) ?? {}),
  });

  // Call the LLM
  const output = await callLLM(env, template.systemPrompt, userPrompt);

  const createdAt = new Date().toISOString();

  // Determine if human review is needed
  const flaggedForHumanReview =
    output.confidence < 0.7 ||
    (output.warnings?.length ?? 0) > 0 ||
    output.citedPassages.length === 0;

  // Build input text for storage
  const inputText = JSON.stringify({
    marketTitle: input.marketTitle,
    resolutionCriteria: input.resolutionCriteria,
    additionalContext: input.additionalContext,
  });
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

  const run: LLMScoringRun = {
    id: runId,
    runType: input.runType,
    targetEntityType: input.targetEntityType,
    targetEntityId: input.targetEntityId,
    promptTemplateVersion: template.version,
    promptTemplateHash: promptHash,
    modelId: '@cf/meta/llama-3.1-70b-instruct',
    inputText,
    inputHash,
    outputJson: output,
    outputScore: output.score,
    citedRulePassages: output.citedPassages,
    confidence: output.confidence,
    flaggedForHumanReview,
    createdAt,
  };

  // Store the run in D1
  await storeScoringRun(env, run);

  return run;
}

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
    run.runType,
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
  return PROMPT_TEMPLATES[runType].version;
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
