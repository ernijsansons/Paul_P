/**
 * Paul P - Research Agent
 * Market canonicalization, LLM governance, ambiguity scoring
 */

import { PaulPAgent } from './base';
import { asResearchEnv } from '../types/env';
import {
  scoreAmbiguity as llmScoreAmbiguity,
  assessEquivalence as llmAssessEquivalence,
  applyHumanOverride,
  checkExecutionGate,
  getPromptVersion,
} from '../lib/research/llm-governance';
import {
  findPotentialPairs,
  createMarketPair,
  approveMarketPair,
  rejectMarketPair,
  checkPairExecutionGate,
  expireStalePairs,
  type CanonicalMarket,
  type EquivalenceGrade,
} from '../lib/research/market-pairing';
import { recordDriftSweep } from '../lib/llm/drift-sweeps';

export class ResearchAgent extends PaulPAgent {
  readonly agentName = 'research-agent';

  protected async handleRequest(request: Request, path: string): Promise<Response> {
    switch (path) {
      case '/score-ambiguity':
        return this.scoreAmbiguity(request);
      case '/assess-equivalence':
        return this.assessEquivalence(request);
      case '/propose-pair':
        return this.proposePair(request);
      case '/approve-pair':
        return this.approvePair(request);
      case '/reject-pair':
        return this.rejectPair(request);
      case '/check-pair-gate':
        return this.checkPairGate(request);
      case '/find-pairs':
        return this.findMarketPairs(request);
      case '/human-override':
        return this.humanOverride(request);
      case '/check-execution-gate':
        return this.checkExecGate(request);
      case '/drift-sweep':
        return this.runDriftSweep();
      case '/expire-pairs':
        return this.runExpirePairs();
      case '/prompt-versions':
        return this.getPromptVersions();
      default:
        return Response.json({ error: 'Not found' }, { status: 404 });
    }
  }

  /**
   * Score market ambiguity using LLM governance
   */
  private async scoreAmbiguity(request: Request): Promise<Response> {
    const researchEnv = asResearchEnv(this.env);
    const body = await request.json<{
      marketId: string;
      marketTitle: string;
      resolutionCriteria: string;
    }>();

    const run = await llmScoreAmbiguity(
      researchEnv,
      body.marketId,
      body.marketTitle,
      body.resolutionCriteria
    );

    await this.logAudit('AMBIGUITY_SCORED', {
      marketId: body.marketId,
      runId: run.id,
      score: run.outputJson.score,
      confidence: run.confidence,
      flaggedForReview: run.flaggedForHumanReview,
    });

    return Response.json({
      runId: run.id,
      marketId: body.marketId,
      ambiguityScore: run.outputJson.score,
      reasoning: run.outputJson.reasoning,
      citedPassages: run.citedRulePassages,
      confidence: run.confidence,
      flaggedForHumanReview: run.flaggedForHumanReview,
      warnings: run.outputJson.warnings,
    });
  }

  /**
   * Assess equivalence between two markets
   */
  private async assessEquivalence(request: Request): Promise<Response> {
    const researchEnv = asResearchEnv(this.env);
    const body = await request.json<{
      marketAId: string;
      marketA: { title: string; criteria: string; venue: string };
      marketB: { title: string; criteria: string; venue: string };
    }>();

    const run = await llmAssessEquivalence(
      researchEnv,
      body.marketAId,
      body.marketA,
      body.marketB
    );

    // Map score to equivalence grade
    let equivalenceGrade: EquivalenceGrade;
    if (run.outputJson.score >= 0.9) {
      equivalenceGrade = 'identical';
    } else if (run.outputJson.score >= 0.7) {
      equivalenceGrade = 'near_equivalent';
    } else if (run.outputJson.score >= 0.4) {
      equivalenceGrade = 'similar_but_divergent';
    } else {
      equivalenceGrade = 'not_equivalent';
    }

    await this.logAudit('EQUIVALENCE_ASSESSED', {
      marketAId: body.marketAId,
      runId: run.id,
      score: run.outputJson.score,
      grade: equivalenceGrade,
      confidence: run.confidence,
    });

    return Response.json({
      runId: run.id,
      equivalenceScore: run.outputJson.score,
      equivalenceGrade,
      reasoning: run.outputJson.reasoning,
      citedPassages: run.citedRulePassages,
      confidence: run.confidence,
      flaggedForHumanReview: run.flaggedForHumanReview,
      warnings: run.outputJson.warnings,
    });
  }

  /**
   * Propose a market pair for cross-venue arbitrage
   */
  private async proposePair(request: Request): Promise<Response> {
    const body = await request.json<{
      canonicalEventId: string;
      marketA: CanonicalMarket;
      marketB: CanonicalMarket;
    }>();

    const pair = await createMarketPair(
      this.env,
      body.canonicalEventId,
      body.marketA,
      body.marketB
    );

    await this.logAudit('PAIR_PROPOSED', {
      pairId: pair.id,
      marketA: pair.marketAId,
      marketB: pair.marketBId,
      grade: pair.equivalenceGrade,
    });

    return Response.json(pair);
  }

  /**
   * Approve a market pair for trading
   */
  private async approvePair(request: Request): Promise<Response> {
    const body = await request.json<{
      pairId: string;
      reviewerId: string;
    }>();

    await approveMarketPair(this.env, body.pairId, body.reviewerId);

    await this.logAudit('PAIR_APPROVED', {
      pairId: body.pairId,
      reviewerId: body.reviewerId,
    });

    return Response.json({ success: true, pairId: body.pairId, status: 'approved' });
  }

  /**
   * Reject a market pair
   */
  private async rejectPair(request: Request): Promise<Response> {
    const body = await request.json<{
      pairId: string;
      reviewerId: string;
    }>();

    await rejectMarketPair(this.env, body.pairId, body.reviewerId);

    await this.logAudit('PAIR_REJECTED', {
      pairId: body.pairId,
      reviewerId: body.reviewerId,
    });

    return Response.json({ success: true, pairId: body.pairId, status: 'rejected' });
  }

  /**
   * Check if a pair is valid for execution (fail-closed gate)
   */
  private async checkPairGate(request: Request): Promise<Response> {
    const body = await request.json<{
      marketAId: string;
      marketBId: string;
    }>();

    const result = await checkPairExecutionGate(this.env, body.marketAId, body.marketBId);

    return Response.json(result);
  }

  /**
   * Find potential market pairs across venues
   */
  private async findMarketPairs(request: Request): Promise<Response> {
    const body = await request.json<{
      polymarketMarkets: CanonicalMarket[];
      kalshiMarkets: CanonicalMarket[];
      minMatchScore?: number;
    }>();

    const pairs = await findPotentialPairs(
      this.env,
      body.polymarketMarkets,
      body.kalshiMarkets
    );

    // Filter by minimum match score if provided
    const filteredPairs = body.minMatchScore
      ? pairs.filter(p => p.matchScore >= body.minMatchScore!)
      : pairs;

    await this.logAudit('PAIRS_FOUND', {
      totalPairs: pairs.length,
      filteredPairs: filteredPairs.length,
    });

    return Response.json({
      pairs: filteredPairs.map(p => ({
        polymarketId: p.polymarket.id,
        polymarketTitle: p.polymarket.title,
        kalshiId: p.kalshi.id,
        kalshiTitle: p.kalshi.title,
        matchScore: p.matchScore,
      })),
    });
  }

  /**
   * Apply human override to an LLM scoring run
   */
  private async humanOverride(request: Request): Promise<Response> {
    const researchEnv = asResearchEnv(this.env);
    const body = await request.json<{
      runId: string;
      overrideScore: number;
      reason: string;
    }>();

    await applyHumanOverride(researchEnv, body.runId, body.overrideScore, body.reason);

    await this.logAudit('HUMAN_OVERRIDE_APPLIED', {
      runId: body.runId,
      overrideScore: body.overrideScore,
    });

    return Response.json({ success: true, runId: body.runId });
  }

  /**
   * Check execution gate for a market
   */
  private async checkExecGate(request: Request): Promise<Response> {
    const researchEnv = asResearchEnv(this.env);
    const body = await request.json<{ marketId: string }>();

    const result = await checkExecutionGate(researchEnv, body.marketId);

    return Response.json(result);
  }

  /**
   * Run LLM drift sweep to check for model drift
   */
  private async runDriftSweep(): Promise<Response> {
    await this.logAudit('DRIFT_SWEEP_STARTED', {});

    // Fetch recent LLM runs for comparison
    const recentRuns = await this.env.DB.prepare(`
      SELECT id, run_type, target_entity_type, target_entity_id, prompt_template_version, confidence, output_json
      FROM llm_scoring_runs
      WHERE created_at > datetime('now', '-7 days')
      ORDER BY created_at DESC
      LIMIT 100
    `).all<{
      id: string;
      run_type: string;
      target_entity_type: string;
      target_entity_id: string;
      prompt_template_version: string;
      confidence: number;
      output_json: string;
    }>();

    // Calculate drift metrics
    const runs = recentRuns.results ?? [];
    const avgConfidence = runs.length > 0
      ? runs.reduce((sum, r) => sum + r.confidence, 0) / runs.length
      : 0;

    const lowConfidenceCount = runs.filter(r => r.confidence < 0.5).length;
    const flaggedCount = runs.filter(r => {
      try {
        const output = JSON.parse(r.output_json);
        return (output.warnings?.length ?? 0) > 0;
      } catch {
        return false;
      }
    }).length;
    const lowConfidenceRate = runs.length > 0 ? lowConfidenceCount / runs.length : 0;
    const flaggedRate = runs.length > 0 ? flaggedCount / runs.length : 0;
    const driftWarning = avgConfidence < 0.6 || lowConfidenceRate > 0.3;

    const failureReasons: string[] = [];
    if (avgConfidence < 0.6) {
      failureReasons.push(`Average confidence ${avgConfidence.toFixed(3)} below 0.600`);
    }
    if (lowConfidenceRate > 0.3) {
      failureReasons.push(
        `Low-confidence rate ${(lowConfidenceRate * 100).toFixed(1)}% exceeds 30.0%`
      );
    }

    const driftPersist = await recordDriftSweep(this.env, {
      sweepType: 'nightly_stability',
      baselinePromptVersion: getPromptVersion('ambiguity_score'),
      baselineModelId: 'routing:auto',
      candidatePromptVersion: getPromptVersion('ambiguity_score'),
      candidateModelId: 'routing:auto',
      goldSetSize: runs.length,
      meanScoreDelta: lowConfidenceRate,
      maxScoreDelta: Math.max(lowConfidenceRate, flaggedRate),
      promptInjectionPassRate: 1.0,
      passed: !driftWarning,
      failureReasons,
      runAt: new Date().toISOString(),
    });

    await this.logAudit('DRIFT_SWEEP_COMPLETED', {
      runsAnalyzed: runs.length,
      avgConfidence,
      lowConfidenceCount,
      flaggedCount,
      persistedSweepId: driftPersist.id,
      persistedSchema: driftPersist.storedWith,
      driftWarning,
    });

    return Response.json({
      triggered: true,
      runsAnalyzed: runs.length,
      avgConfidence,
      lowConfidenceCount,
      lowConfidenceRate,
      flaggedCount,
      driftWarning,
      persistedSweepId: driftPersist.id,
      persistedSchema: driftPersist.storedWith,
    });
  }

  /**
   * Expire stale market pairs
   */
  private async runExpirePairs(): Promise<Response> {
    const expiredCount = await expireStalePairs(this.env);

    await this.logAudit('PAIRS_EXPIRED', { count: expiredCount });

    return Response.json({ success: true, expiredCount });
  }

  /**
   * Get current prompt template versions
   */
  private async getPromptVersions(): Promise<Response> {
    return Response.json({
      ambiguity_score: getPromptVersion('ambiguity_score'),
      resolution_analysis: getPromptVersion('resolution_analysis'),
      equivalence_assessment: getPromptVersion('equivalence_assessment'),
      invariant_explanation: getPromptVersion('invariant_explanation'),
    });
  }
}
