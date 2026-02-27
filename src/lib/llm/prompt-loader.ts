/**
 * Paul P - Versioned Prompt Loader
 *
 * Centralized prompt template management with versioning and hash computation.
 * Prompts are loaded by run type and rendered with input variables.
 *
 * @see P-07 — LLM Governance
 */

import { sha256String } from '../evidence/hasher';

// ============================================================
// TYPES
// ============================================================

export type LLMScoringRunType =
  | 'ambiguity_score'
  | 'resolution_analysis'
  | 'equivalence_assessment'
  | 'invariant_explanation';

export interface PromptTemplate {
  readonly version: string;
  readonly runType: LLMScoringRunType;
  readonly systemPrompt: string;
  readonly userPromptTemplate: string;
}

export interface LoadedPrompt extends PromptTemplate {
  readonly hash: string;
}

// ============================================================
// PROMPT TEMPLATES (SOURCE OF TRUTH)
// ============================================================

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

// ============================================================
// PROMPT LOADING
// ============================================================

/**
 * Load a prompt template by run type.
 *
 * @throws Error if run type is unknown
 */
export function loadPrompt(runType: LLMScoringRunType): PromptTemplate {
  const template = PROMPT_TEMPLATES[runType];
  if (!template) {
    throw new Error(`Unknown prompt run type: ${runType}`);
  }
  return template;
}

/**
 * Load a prompt template with computed hash.
 */
export async function loadPromptWithHash(runType: LLMScoringRunType): Promise<LoadedPrompt> {
  const template = loadPrompt(runType);
  const hash = await getPromptHash(runType);
  return { ...template, hash };
}

/**
 * Get the SHA-256 hash of a prompt template.
 */
export async function getPromptHash(runType: LLMScoringRunType): Promise<string> {
  const template = loadPrompt(runType);
  return sha256String(template.systemPrompt + template.userPromptTemplate);
}

/**
 * Get prompt template version for a run type.
 */
export function getPromptVersion(runType: LLMScoringRunType): string {
  return loadPrompt(runType).version;
}

/**
 * Get all available run types.
 */
export function getAllRunTypes(): LLMScoringRunType[] {
  return Object.keys(PROMPT_TEMPLATES) as LLMScoringRunType[];
}

// ============================================================
// TEMPLATE RENDERING
// ============================================================

/**
 * Render a prompt template with input variables.
 * Replaces {{variable}} placeholders and handles {{#if variable}}...{{/if}} conditionals.
 */
export function renderPrompt(
  template: PromptTemplate,
  variables: Record<string, string | undefined>
): string {
  return renderTemplate(template.userPromptTemplate, variables);
}

/**
 * Simple template rendering (replace {{variable}} placeholders)
 */
export function renderTemplate(
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

// ============================================================
// VALIDATION
// ============================================================

/**
 * Check if a run type is a valid scoring run type.
 */
export function isValidScoringRunType(runType: string): runType is LLMScoringRunType {
  return runType in PROMPT_TEMPLATES;
}

/**
 * Validate that all prompt templates have required fields.
 */
export function validateAllPrompts(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const [runType, template] of Object.entries(PROMPT_TEMPLATES)) {
    if (!template.version) {
      errors.push(`${runType}: missing version`);
    }
    if (!template.systemPrompt) {
      errors.push(`${runType}: missing systemPrompt`);
    }
    if (!template.userPromptTemplate) {
      errors.push(`${runType}: missing userPromptTemplate`);
    }
  }

  return { valid: errors.length === 0, errors };
}
