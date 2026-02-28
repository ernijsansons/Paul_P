/**
 * Paul P - LLM Drift Sweep Persistence + Compatibility
 *
 * Supports both drift sweep schemas that exist across migrations:
 * - 0005_llm_governance.sql: blocked_deployment/run_at
 * - 0017_phase_gate_signoffs.sql: deploy_allowed/sweep_at
 */

import type { Env } from '../../types/env';
import { deterministicId } from '../utils/deterministic-id';

export interface DriftSweepRecordInput {
  sweepType: 'prompt_version_change' | 'model_version_change' | 'nightly_stability';
  baselinePromptVersion: string;
  baselineModelId: string;
  candidatePromptVersion: string;
  candidateModelId: string;
  goldSetSize: number;
  meanScoreDelta: number;
  maxScoreDelta: number;
  promptInjectionPassRate: number;
  passed: boolean;
  failureReasons: string[];
  runAt?: string;
}

type DbLike = Pick<Env, 'DB'>;

/**
 * Persist a drift sweep into whichever schema is available.
 */
export async function recordDriftSweep(
  env: DbLike,
  input: DriftSweepRecordInput
): Promise<{ id: string; storedWith: 'schema_0005' | 'schema_0017' }> {
  const runAt = input.runAt ?? new Date().toISOString();
  const id = deterministicId(
    'llm-drift-sweep',
    input.sweepType,
    input.candidatePromptVersion,
    input.candidateModelId,
    runAt
  );
  const failuresJson = JSON.stringify(input.failureReasons);

  // Primary schema (0005)
  try {
    await env.DB.prepare(
      `
      INSERT INTO llm_drift_sweeps (
        id, sweep_type,
        baseline_prompt_version, baseline_model_id,
        candidate_prompt_version, candidate_model_id,
        gold_set_size, mean_score_delta, max_score_delta, rank_order_changes,
        prompt_injection_pass_rate,
        mean_delta_threshold, max_delta_threshold, injection_pass_threshold,
        passed, blocked_deployment, failure_reasons, run_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
      .bind(
        id,
        input.sweepType,
        input.baselinePromptVersion,
        input.baselineModelId,
        input.candidatePromptVersion,
        input.candidateModelId,
        input.goldSetSize,
        input.meanScoreDelta,
        input.maxScoreDelta,
        0, // rank_order_changes
        input.promptInjectionPassRate,
        0.10, // mean_delta_threshold
        0.25, // max_delta_threshold
        1.0, // injection_pass_threshold
        input.passed ? 1 : 0,
        input.passed ? 0 : 1, // blocked_deployment
        failuresJson,
        runAt
      )
      .run();

    return { id, storedWith: 'schema_0005' };
  } catch {
    // Fallback schema (0017)
    const deployAllowed = input.passed ? 1 : 0;
    const passRate = input.passed ? 1 : 0;
    const rankOrderStable = input.passed ? 1 : 0;

    await env.DB.prepare(
      `
      INSERT INTO llm_drift_sweeps (
        id, prompt_version, prompt_type, test_count,
        pass_rate, max_delta, correlation, rank_order_stable,
        adversarial_pass_rate, deploy_allowed, failures, sweep_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
      .bind(
        id,
        input.candidatePromptVersion,
        input.sweepType,
        input.goldSetSize,
        passRate,
        input.maxScoreDelta,
        input.passed ? 1.0 : 0.0,
        rankOrderStable,
        input.promptInjectionPassRate,
        deployAllowed,
        failuresJson,
        runAt
      )
      .run();

    return { id, storedWith: 'schema_0017' };
  }
}

/**
 * Return true if deployment should be blocked based on recent sweeps.
 */
export async function hasRecentDriftBlock(
  env: DbLike,
  lookbackDays = 7
): Promise<boolean> {
  // Primary schema (0005)
  try {
    const row = await env.DB.prepare(
      `
      SELECT COUNT(*) as blocked
      FROM llm_drift_sweeps
      WHERE blocked_deployment = 1
        AND run_at > datetime('now', ?)
    `
    )
      .bind(`-${lookbackDays} days`)
      .first<{ blocked: number }>();
    return (row?.blocked ?? 0) > 0;
  } catch {
    // Fallback schema (0017)
    const row = await env.DB.prepare(
      `
      SELECT COUNT(*) as blocked
      FROM llm_drift_sweeps
      WHERE deploy_allowed = 0
        AND sweep_at > datetime('now', ?)
    `
    )
      .bind(`-${lookbackDays} days`)
      .first<{ blocked: number }>();
    return (row?.blocked ?? 0) > 0;
  }
}

/**
 * Latest deployment-allowed decision, null if no sweeps.
 */
export async function getLatestDriftDecision(
  env: DbLike
): Promise<boolean | null> {
  // Primary schema (0005)
  try {
    const row = await env.DB.prepare(
      `
      SELECT blocked_deployment
      FROM llm_drift_sweeps
      ORDER BY run_at DESC
      LIMIT 1
    `
    ).first<{ blocked_deployment: number }>();

    if (!row) return null;
    return row.blocked_deployment !== 1;
  } catch {
    // Fallback schema (0017)
    const row = await env.DB.prepare(
      `
      SELECT deploy_allowed
      FROM llm_drift_sweeps
      ORDER BY sweep_at DESC
      LIMIT 1
    `
    ).first<{ deploy_allowed: number }>();

    if (!row) return null;
    return row.deploy_allowed === 1;
  }
}
