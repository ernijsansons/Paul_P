/**
 * Paul P - LLM Governance (P-07)
 *
 * Structured LLM scoring with:
 * - Prompt versioning
 * - Structured outputs with rule-text citations
 * - Regression tests
 * - Human review workflow
 * - Multi-provider routing with budget enforcement
 */

import type { ResearchEnv } from '../../types/env';
import { sha256String } from '../evidence/hasher';
import { deterministicId } from '../utils/deterministic-id';
import type { ModelId, TokenUsage, LLMRunType, ResolvedModelId } from '../llm/routing.types';
import { modelIdToString, isValidResolvedModelId } from '../llm/routing.types';
import { executeWithRouting } from '../llm/routing.policy';
import { computeEstimatedCost } from '../llm/routing.manifest';

export type LLMScoringRunType =
  | 'ambiguity_score'
  | 'resolution_analysis'
  | 'equivalence_assessment'
  | 'invariant_explanation';

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

  invariant_explanation: {
    version: '1.0.0',
    runType: 'invariant_explanation',
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
 * Parse and validate LLM response JSON
 */
function parseAndValidateLLMResponse(responseText: string): LLMScoringOutput {
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

// ============================================================
// MULTI-PROVIDER LLM CALLS (for routing layer)
// ============================================================

/**
 * Call LLM via a specific provider based on ModelId
 */
async function callProviderLLM(
  env: ResearchEnv,
  modelId: ModelId,
  systemPrompt: string,
  userPrompt: string
): Promise<{ response: string; usage: { inputTokens: number; outputTokens: number } }> {
  switch (modelId.provider) {
    case 'cloudflare':
      return callCloudflareAI(env, modelId.model, systemPrompt, userPrompt);

    case 'anthropic':
      return callAnthropicAPI(env, modelId.model, systemPrompt, userPrompt);

    case 'minimax':
      return callMiniMaxAPI(env, modelId.model, systemPrompt, userPrompt);

    case 'moonshot':
      return callMoonshotAPI(env, modelId.model, systemPrompt, userPrompt);

    case 'google':
      return callGoogleAPI(env, modelId.model, systemPrompt, userPrompt);

    default:
      throw new Error(`Unknown provider: ${modelId.provider}`);
  }
}

/**
 * Call Cloudflare Workers AI
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

/**
 * Call Anthropic API (Claude models)
 */
async function callAnthropicAPI(
  env: ResearchEnv,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<{ response: string; usage: { inputTokens: number; outputTokens: number } }> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as {
    content: Array<{ type: string; text: string }>;
    usage: { input_tokens: number; output_tokens: number };
  };

  const responseText = data.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');

  return {
    response: responseText,
    usage: {
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
    },
  };
}

/**
 * Call MiniMax API
 */
async function callMiniMaxAPI(
  env: ResearchEnv,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<{ response: string; usage: { inputTokens: number; outputTokens: number } }> {
  // MiniMax API integration (placeholder - implement when API key is available)
  const apiKey = (env as unknown as { MINIMAX_API_KEY?: string }).MINIMAX_API_KEY;
  if (!apiKey) {
    throw new Error('MINIMAX_API_KEY not configured');
  }

  const response = await fetch('https://api.minimax.chat/v1/text/chatcompletion_v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 2000,
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`MiniMax API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; completion_tokens: number };
  };

  return {
    response: data.choices[0]?.message?.content ?? '',
    usage: {
      inputTokens: data.usage.prompt_tokens,
      outputTokens: data.usage.completion_tokens,
    },
  };
}

/**
 * Call Moonshot (Kimi) API
 */
async function callMoonshotAPI(
  env: ResearchEnv,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<{ response: string; usage: { inputTokens: number; outputTokens: number } }> {
  const apiKey = (env as unknown as { MOONSHOT_API_KEY?: string }).MOONSHOT_API_KEY;
  if (!apiKey) {
    throw new Error('MOONSHOT_API_KEY not configured');
  }

  const response = await fetch('https://api.moonshot.cn/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 2000,
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Moonshot API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; completion_tokens: number };
  };

  return {
    response: data.choices[0]?.message?.content ?? '',
    usage: {
      inputTokens: data.usage.prompt_tokens,
      outputTokens: data.usage.completion_tokens,
    },
  };
}

/**
 * Call Google Gemini API
 */
async function callGoogleAPI(
  env: ResearchEnv,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<{ response: string; usage: { inputTokens: number; outputTokens: number } }> {
  const apiKey = (env as unknown as { GOOGLE_AI_API_KEY?: string }).GOOGLE_AI_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_AI_API_KEY not configured');
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userPrompt }] }],
        generationConfig: {
          maxOutputTokens: 2000,
          temperature: 0.1,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    usageMetadata: { promptTokenCount: number; candidatesTokenCount: number };
  };

  const responseText = data.candidates[0]?.content?.parts
    .map((p) => p.text)
    .join('') ?? '';

  return {
    response: responseText,
    usage: {
      inputTokens: data.usageMetadata.promptTokenCount,
      outputTokens: data.usageMetadata.candidatesTokenCount,
    },
  };
}

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
 * This function uses the routing layer to:
 * - Select the appropriate model based on run type
 * - Enforce budget limits
 * - Handle fallbacks on provider failures
 * - Log routing decisions for audit
 */
export async function runLLMScoringWithRouting(
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

  // Build input text for storage
  const inputText = JSON.stringify({
    marketTitle: input.marketTitle,
    resolutionCriteria: input.resolutionCriteria,
    additionalContext: input.additionalContext,
  });

  // Estimate tokens for routing (rough: 4 chars per token)
  const estimatedInputTokens = Math.ceil(
    (template.systemPrompt.length + userPrompt.length) / 4
  );
  const estimatedOutputTokens = 500; // Conservative estimate

  // Execute with routing layer
  const routingResult = await executeWithRouting(
    env,
    input.runType as LLMRunType,
    estimatedInputTokens,
    estimatedOutputTokens,
    async (modelId: ModelId) => {
      const { response, usage } = await callProviderLLM(
        env,
        modelId,
        template.systemPrompt,
        userPrompt
      );

      // Compute cost
      const resolvedModelId = modelIdToString(modelId);
      const costUsd = computeEstimatedCost(
        isValidResolvedModelId(resolvedModelId)
          ? (resolvedModelId as ResolvedModelId)
          : 'cloudflare:@cf/meta/llama-3.1-70b-instruct',
        usage.inputTokens,
        usage.outputTokens,
        0
      );

      const tokenUsage: TokenUsage = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: 0,
        costUsd,
      };

      return { response, usage: tokenUsage };
    }
  );

  // Handle routing failure
  if (!routingResult.success) {
    const errorOutput: LLMScoringOutput = {
      score: 0.5,
      reasoning: `Routing failed: ${routingResult.error?.message ?? 'Unknown error'}`,
      citedPassages: [],
      confidence: 0.0,
      warnings: [
        `Routing error: ${routingResult.error?.code ?? 'UNKNOWN'}`,
        routingResult.error?.message ?? '',
      ],
    };

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

    const run: LLMScoringRun = {
      id: runId,
      runType: input.runType,
      targetEntityType: input.targetEntityType,
      targetEntityId: input.targetEntityId,
      promptTemplateVersion: template.version,
      promptTemplateHash: promptHash,
      modelId: routingResult.decision.resolvedModelId ?? 'routing:none',
      inputText,
      inputHash,
      outputJson: errorOutput,
      outputScore: errorOutput.score,
      citedRulePassages: errorOutput.citedPassages,
      confidence: errorOutput.confidence,
      flaggedForHumanReview: true,
      createdAt,
    };

    await storeScoringRun(env, run);
    return run;
  }

  // Parse successful response
  const output = parseAndValidateLLMResponse(routingResult.modelResponse as string);

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
    promptTemplateHash: promptHash,
    modelId: routingResult.decision.resolvedModelId ?? 'routing:none',
    inputText,
    inputHash,
    outputJson: output,
    outputScore: output.score,
    citedRulePassages: output.citedPassages,
    confidence: output.confidence,
    flaggedForHumanReview,
    inputTokens: routingResult.usage?.inputTokens,
    outputTokens: routingResult.usage?.outputTokens,
    costUsd: routingResult.usage?.costUsd,
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
