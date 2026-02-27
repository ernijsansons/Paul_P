/**
 * Paul P - LLM Governance Re-exports
 *
 * Re-exports governance types and functions from the research module
 * for unified access via src/lib/llm barrel.
 *
 * @see P-07 — LLM Governance
 */

export {
  type LLMScoringInput,
  type LLMScoringOutput,
  type LLMScoringRun,
  runLLMScoring,
  runLLMScoringWithRouting,
  scoreAmbiguity,
  assessEquivalence,
  applyHumanOverride,
  checkExecutionGate,
  // Note: getPromptVersion is exported from prompt-loader.ts to avoid duplicate exports
} from '../research/llm-governance.js';
