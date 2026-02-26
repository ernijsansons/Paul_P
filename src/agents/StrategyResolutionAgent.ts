/**
 * Paul P - Strategy Resolution Agent
 * Resolution rule mispricing strategy
 *
 * Strategy Overview:
 * - Analyze market resolution criteria using LLM governance
 * - Score ambiguity of resolution rules
 * - Detect mispricing between market price and LLM-estimated probability
 * - Generate signals when edge > threshold and ambiguity < max
 * - Flag for human review when confidence < 0.8
 */

import { PaulPAgent } from './base';
import { runLLMScoring, scoreAmbiguity } from '../lib/research/llm-governance';
import { computeKellySize, type MonteCarloConfig } from '../lib/strategy/kelly-sizing';
import { asResearchEnv } from '../types/env';
import type { SqlStorageValue } from '@cloudflare/workers-types';

// Signal types for queue
export interface ResolutionSignal {
  signalId: string;
  strategy: 'resolution_mispricing';
  marketId: string;
  venue: 'kalshi' | 'polymarket';
  side: 'YES' | 'NO';
  targetSize: number;
  kellyFraction: number;
  expectedEdge: number;
  marketPrice: number;
  modelProbability: number;
  ambiguityScore: number;
  confidence: number;
  createdAt: string;
  expiresAt: string;
  metadata: {
    llmRunId: string;
    ambiguityRunId: string;
    citedPassages: string[];
    reasoning: string;
    flaggedForHumanReview: boolean;
  };
}

// Local tables row types (index signature required for SqlStorage)
interface ResolutionAnalysisRow extends Record<string, SqlStorageValue> {
  analysis_id: string;
  market_id: string;
  venue: string;
  market_title: string;
  resolution_criteria: string;
  llm_run_id: string;
  ambiguity_run_id: string;
  model_probability: number;
  ambiguity_score: number;
  confidence: number;
  cited_passages: string;
  reasoning: string;
  flagged_for_review: number;
  human_override_probability: number | null;
  analyzed_at: string;
  expires_at: string;
}

interface MispricingSignalRow extends Record<string, SqlStorageValue> {
  signal_id: string;
  analysis_id: string;
  market_id: string;
  venue: string;
  side: string;
  edge: number;
  kelly_fraction: number;
  target_size: number;
  market_price: number;
  model_probability: number;
  status: string;
  created_at: string;
  executed_at: string | null;
  execution_price: number | null;
}

interface ResolutionPositionRow extends Record<string, SqlStorageValue> {
  position_id: string;
  market_id: string;
  venue: string;
  analysis_id: string;
  side: string;
  entry_price: number;
  size: number;
  unrealized_pnl: number;
  realized_pnl: number;
  status: string;
  created_at: string;
  closed_at: string | null;
}

// @ts-expect-error - Reserved for future historical returns tracking
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface _ResolutionReturnRow {
  id: number;
  return_value: number;
  recorded_at: string;
}

// Market data for analysis - exported for external use
export interface MarketData {
  marketId: string;
  venue: 'kalshi' | 'polymarket';
  title: string;
  subtitle?: string;
  resolutionCriteria: string;
  currentPrice: number;
  volume24h?: number;
  endDate?: string;
}

// Configuration
interface ResolutionConfig {
  minEdgeThreshold: number; // Minimum edge to generate signal (default 0.10 = 10 cents)
  maxAmbiguityScore: number; // Maximum ambiguity allowed (default 0.4)
  minConfidence: number; // Minimum LLM confidence (default 0.7)
  humanReviewThreshold: number; // Below this confidence, flag for human review (default 0.8)
  maxPositionPct: number; // Maximum position size as % of bankroll
  analysisExpiryHours: number; // How long analysis results are valid
}

export class StrategyResolutionAgent extends PaulPAgent {
  readonly agentName = 'strategy-resolution';

  // Configuration
  private config: ResolutionConfig = {
    minEdgeThreshold: 0.10, // 10 cents
    maxAmbiguityScore: 0.4,
    minConfidence: 0.7,
    humanReviewThreshold: 0.8,
    maxPositionPct: 5,
    analysisExpiryHours: 24,
  };

  private monteCarloConfig: MonteCarloConfig = {
    simulations: 10000,
    assumedCV: 0.35, // Higher CV for resolution strategy due to model uncertainty
  };

  protected async initLocalTables(): Promise<void> {
    // Resolution analyses table
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS resolution_analyses (
        analysis_id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL,
        venue TEXT NOT NULL,
        market_title TEXT NOT NULL,
        resolution_criteria TEXT NOT NULL,
        llm_run_id TEXT NOT NULL,
        ambiguity_run_id TEXT NOT NULL,
        model_probability REAL NOT NULL,
        ambiguity_score REAL NOT NULL,
        confidence REAL NOT NULL,
        cited_passages TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        flagged_for_review INTEGER DEFAULT 0,
        human_override_probability REAL,
        analyzed_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )
    `);

    // Mispricing signals table
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS mispricing_signals (
        signal_id TEXT PRIMARY KEY,
        analysis_id TEXT NOT NULL,
        market_id TEXT NOT NULL,
        venue TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('YES', 'NO')),
        edge REAL NOT NULL,
        kelly_fraction REAL NOT NULL,
        target_size REAL NOT NULL,
        market_price REAL NOT NULL,
        model_probability REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        executed_at TEXT,
        execution_price REAL,
        FOREIGN KEY (analysis_id) REFERENCES resolution_analyses(analysis_id)
      )
    `);

    // Resolution positions table
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS resolution_positions (
        position_id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL,
        venue TEXT NOT NULL,
        analysis_id TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('YES', 'NO')),
        entry_price REAL NOT NULL,
        size REAL NOT NULL,
        unrealized_pnl REAL DEFAULT 0,
        realized_pnl REAL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        closed_at TEXT,
        FOREIGN KEY (analysis_id) REFERENCES resolution_analyses(analysis_id)
      )
    `);

    // Historical returns for CV calculation
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS resolution_returns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_value REAL NOT NULL,
        recorded_at TEXT NOT NULL
      )
    `);

    // Index for faster queries
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_analyses_market ON resolution_analyses(market_id)
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_signals_status ON mispricing_signals(status)
    `);
  }

  protected async handleRequest(request: Request, path: string): Promise<Response> {
    // Ensure tables exist
    await this.initLocalTables();

    switch (path) {
      case '/analyze-rules':
        return this.analyzeRules(request);
      case '/detect-mispricing':
        return this.detectMispricing(request);
      case '/generate-signals':
        return this.generateSignals(request);
      case '/get-analysis':
        return this.getAnalysis(request);
      case '/list-analyses':
        return this.listAnalyses(request);
      case '/apply-override':
        return this.applyHumanOverride(request);
      case '/positions':
        return this.getPositions();
      case '/positions/update':
        return this.updatePosition(request);
      case '/config':
        return this.getConfig();
      case '/config/update':
        return this.updateConfig(request);
      case '/status':
        return this.getStatus();
      case '/metrics':
        return this.getMetrics();
      default:
        return Response.json({ error: 'Not found' }, { status: 404 });
    }
  }

  /**
   * Analyze resolution rules for a market using LLM governance
   */
  private async analyzeRules(request: Request): Promise<Response> {
    const researchEnv = asResearchEnv(this.env);
    const body = await request.json<{
      marketId: string;
      venue: 'kalshi' | 'polymarket';
      title: string;
      subtitle?: string;
      resolutionCriteria: string;
      currentPrice?: number;
    }>();

    if (!body.marketId || !body.title || !body.resolutionCriteria) {
      return Response.json({ error: 'marketId, title, and resolutionCriteria required' }, { status: 400 });
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.analysisExpiryHours * 60 * 60 * 1000);
    const analysisId = `ra_${body.marketId}_${now.getTime()}`;

    // Step 1: Score ambiguity
    const ambiguityRun = await scoreAmbiguity(
      researchEnv,
      body.marketId,
      body.title,
      body.resolutionCriteria
    );

    // Step 2: Run resolution analysis LLM
    const resolutionRun = await runLLMScoring(researchEnv, {
      runType: 'resolution_analysis',
      targetEntityType: 'market',
      targetEntityId: body.marketId,
      marketTitle: body.title,
      resolutionCriteria: body.resolutionCriteria,
      additionalContext: body.subtitle ? { subtitle: body.subtitle } : undefined,
    });

    // Determine if human review is needed
    const flaggedForReview =
      resolutionRun.confidence < this.config.humanReviewThreshold ||
      ambiguityRun.outputJson.score > this.config.maxAmbiguityScore ||
      resolutionRun.flaggedForHumanReview ||
      ambiguityRun.flaggedForHumanReview;

    // Store analysis in local SQLite
    this.sql.exec(
      `INSERT INTO resolution_analyses (
        analysis_id, market_id, venue, market_title, resolution_criteria,
        llm_run_id, ambiguity_run_id, model_probability, ambiguity_score,
        confidence, cited_passages, reasoning, flagged_for_review, analyzed_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      analysisId,
      body.marketId,
      body.venue ?? 'kalshi',
      body.title,
      body.resolutionCriteria,
      resolutionRun.id,
      ambiguityRun.id,
      resolutionRun.outputJson.score, // P(YES)
      ambiguityRun.outputJson.score,
      resolutionRun.confidence,
      JSON.stringify(resolutionRun.citedRulePassages),
      resolutionRun.outputJson.reasoning,
      flaggedForReview ? 1 : 0,
      now.toISOString(),
      expiresAt.toISOString()
    );

    await this.logAudit('RESOLUTION_ANALYSIS_COMPLETE', {
      analysisId,
      marketId: body.marketId,
      modelProbability: resolutionRun.outputJson.score,
      ambiguityScore: ambiguityRun.outputJson.score,
      confidence: resolutionRun.confidence,
      flaggedForReview,
      llmRunId: resolutionRun.id,
      ambiguityRunId: ambiguityRun.id,
    });

    return Response.json({
      analysisId,
      marketId: body.marketId,
      modelProbability: resolutionRun.outputJson.score,
      ambiguityScore: ambiguityRun.outputJson.score,
      confidence: resolutionRun.confidence,
      reasoning: resolutionRun.outputJson.reasoning,
      citedPassages: resolutionRun.citedRulePassages,
      warnings: [
        ...(resolutionRun.outputJson.warnings ?? []),
        ...(ambiguityRun.outputJson.warnings ?? []),
      ],
      flaggedForReview,
      expiresAt: expiresAt.toISOString(),
      llmRunId: resolutionRun.id,
      ambiguityRunId: ambiguityRun.id,
    });
  }

  /**
   * Detect mispricing opportunities from recent analyses
   */
  private async detectMispricing(request: Request): Promise<Response> {
    const body = await request.json<{
      marketPrices?: Record<string, number>; // marketId -> current price
      maxAge?: number; // Max analysis age in hours
    }>();

    const maxAgeHours = body.maxAge ?? 24;
    const cutoffTime = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();

    // Get recent valid analyses
    const analyses = this.sql.exec<ResolutionAnalysisRow>(
      `SELECT * FROM resolution_analyses
       WHERE expires_at > datetime('now')
         AND analyzed_at > ?
       ORDER BY analyzed_at DESC`,
      cutoffTime
    ).toArray();

    const mispricings: Array<{
      analysisId: string;
      marketId: string;
      venue: string;
      modelProbability: number;
      marketPrice: number;
      edge: number;
      side: 'YES' | 'NO';
      ambiguityScore: number;
      confidence: number;
      flaggedForReview: boolean;
      passesFilters: boolean;
      filterReasons: string[];
    }> = [];

    for (const analysis of analyses) {
      // Get current market price (from request or fetch from D1)
      let marketPrice: number;

      const priceFromRequest = body.marketPrices?.[analysis.market_id];
      if (priceFromRequest !== undefined) {
        marketPrice = priceFromRequest;
      } else {
        // Try to fetch from D1
        const market = await this.env.DB.prepare(
          `SELECT last_yes_price FROM markets WHERE condition_id = ?`
        ).bind(analysis.market_id).first<{ last_yes_price: number }>();

        if (!market) {
          continue; // Skip if we can't get price
        }
        marketPrice = market.last_yes_price;
      }

      // Use human override if available, otherwise model probability
      const effectiveProbability = analysis.human_override_probability ?? analysis.model_probability;

      // Calculate edge
      const rawEdge = effectiveProbability - marketPrice;
      const absoluteEdge = Math.abs(rawEdge);
      const side: 'YES' | 'NO' = rawEdge > 0 ? 'YES' : 'NO';

      // Apply filters
      const filterReasons: string[] = [];
      let passesFilters = true;

      if (absoluteEdge < this.config.minEdgeThreshold) {
        passesFilters = false;
        filterReasons.push(`Edge ${(absoluteEdge * 100).toFixed(1)}% < min ${(this.config.minEdgeThreshold * 100).toFixed(1)}%`);
      }

      if (analysis.ambiguity_score > this.config.maxAmbiguityScore) {
        passesFilters = false;
        filterReasons.push(`Ambiguity ${(analysis.ambiguity_score * 100).toFixed(1)}% > max ${(this.config.maxAmbiguityScore * 100).toFixed(1)}%`);
      }

      if (analysis.confidence < this.config.minConfidence) {
        passesFilters = false;
        filterReasons.push(`Confidence ${(analysis.confidence * 100).toFixed(1)}% < min ${(this.config.minConfidence * 100).toFixed(1)}%`);
      }

      // Check execution gate (requires human review clearance if flagged)
      if (analysis.flagged_for_review && analysis.human_override_probability === null) {
        passesFilters = false;
        filterReasons.push('Awaiting human review');
      }

      mispricings.push({
        analysisId: analysis.analysis_id,
        marketId: analysis.market_id,
        venue: analysis.venue,
        modelProbability: effectiveProbability,
        marketPrice,
        edge: absoluteEdge,
        side,
        ambiguityScore: analysis.ambiguity_score,
        confidence: analysis.confidence,
        flaggedForReview: analysis.flagged_for_review === 1,
        passesFilters,
        filterReasons,
      });
    }

    // Sort by edge descending
    mispricings.sort((a, b) => b.edge - a.edge);

    const passing = mispricings.filter(m => m.passesFilters);
    const filtered = mispricings.filter(m => !m.passesFilters);

    return Response.json({
      total: mispricings.length,
      passing: passing.length,
      filtered: filtered.length,
      opportunities: passing,
      filteredOut: filtered,
      config: {
        minEdgeThreshold: this.config.minEdgeThreshold,
        maxAmbiguityScore: this.config.maxAmbiguityScore,
        minConfidence: this.config.minConfidence,
      },
    });
  }

  /**
   * Generate trading signals from detected mispricings
   */
  private async generateSignals(request: Request): Promise<Response> {
    const body = await request.json<{
      capital: number;
      marketPrices?: Record<string, number>;
      maxSignals?: number;
    }>();

    if (!body.capital || body.capital <= 0) {
      return Response.json({ error: 'Capital required' }, { status: 400 });
    }

    const maxSignals = body.maxSignals ?? 10;

    // First detect mispricings
    const detectRequest = new Request('http://internal/detect-mispricing', {
      method: 'POST',
      body: JSON.stringify({ marketPrices: body.marketPrices }),
    });
    const detectResponse = await this.detectMispricing(detectRequest);
    const detectResult = await detectResponse.json<{
      opportunities: Array<{
        analysisId: string;
        marketId: string;
        venue: string;
        modelProbability: number;
        marketPrice: number;
        edge: number;
        side: 'YES' | 'NO';
        ambiguityScore: number;
        confidence: number;
        flaggedForReview: boolean;
      }>;
    }>();

    // Get historical returns for CV adjustment
    const historicalReturns = this.getHistoricalReturns();
    if (historicalReturns.length >= 5) {
      this.monteCarloConfig.historicalReturns = historicalReturns;
    }

    const signals: ResolutionSignal[] = [];
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    for (const opp of detectResult.opportunities.slice(0, maxSignals)) {
      // Get full analysis for metadata
      const analysis = this.sql.exec<ResolutionAnalysisRow>(
        `SELECT * FROM resolution_analyses WHERE analysis_id = ?`,
        opp.analysisId
      ).one();

      if (!analysis) continue;

      // Compute Kelly sizing
      // For YES side: fairProb = modelProbability, price = marketPrice
      // For NO side: fairProb = 1 - modelProbability, price = 1 - marketPrice
      const fairProb = opp.side === 'YES' ? opp.modelProbability : 1 - opp.modelProbability;
      const price = opp.side === 'YES' ? opp.marketPrice : 1 - opp.marketPrice;

      const kellyResult = computeKellySize(
        {
          fairProbability: fairProb,
          marketPrice: price,
          side: opp.side,
          bankroll: body.capital,
          maxPositionPct: this.config.maxPositionPct,
        },
        this.monteCarloConfig
      );

      if (!kellyResult.hasEdge) continue;

      const signalId = `sig_res_${opp.marketId}_${now.getTime()}`;

      const signal: ResolutionSignal = {
        signalId,
        strategy: 'resolution_mispricing',
        marketId: opp.marketId,
        venue: opp.venue as 'kalshi' | 'polymarket',
        side: opp.side,
        targetSize: kellyResult.positionSize,
        kellyFraction: kellyResult.adjustedFraction,
        expectedEdge: kellyResult.expectedEdge,
        marketPrice: opp.marketPrice,
        modelProbability: opp.modelProbability,
        ambiguityScore: opp.ambiguityScore,
        confidence: opp.confidence,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        metadata: {
          llmRunId: analysis.llm_run_id,
          ambiguityRunId: analysis.ambiguity_run_id,
          citedPassages: JSON.parse(analysis.cited_passages),
          reasoning: analysis.reasoning,
          flaggedForHumanReview: opp.flaggedForReview,
        },
      };

      signals.push(signal);

      // Store signal in local database
      this.sql.exec(
        `INSERT INTO mispricing_signals (
          signal_id, analysis_id, market_id, venue, side, edge,
          kelly_fraction, target_size, market_price, model_probability,
          status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        signalId,
        opp.analysisId,
        opp.marketId,
        opp.venue,
        opp.side,
        opp.edge,
        kellyResult.adjustedFraction,
        kellyResult.positionSize,
        opp.marketPrice,
        opp.modelProbability,
        now.toISOString()
      );
    }

    // Send signals to queue
    if (signals.length > 0) {
      await this.env.QUEUE_SIGNALS.send({
        type: 'RESOLUTION_SIGNALS',
        signals,
        timestamp: now.toISOString(),
      });
    }

    await this.logAudit('RESOLUTION_SIGNALS_GENERATED', {
      signalCount: signals.length,
      capital: body.capital,
      yesSignals: signals.filter(s => s.side === 'YES').length,
      noSignals: signals.filter(s => s.side === 'NO').length,
      avgEdge: signals.length > 0
        ? signals.reduce((sum, s) => sum + s.expectedEdge, 0) / signals.length
        : 0,
    });

    return Response.json({
      signals,
      summary: {
        total: signals.length,
        byVenue: {
          kalshi: signals.filter(s => s.venue === 'kalshi').length,
          polymarket: signals.filter(s => s.venue === 'polymarket').length,
        },
        bySide: {
          YES: signals.filter(s => s.side === 'YES').length,
          NO: signals.filter(s => s.side === 'NO').length,
        },
        avgEdge: signals.length > 0
          ? signals.reduce((sum, s) => sum + s.expectedEdge, 0) / signals.length
          : 0,
        totalTargetSize: signals.reduce((sum, s) => sum + s.targetSize, 0),
      },
    });
  }

  /**
   * Get a specific analysis by ID
   */
  private async getAnalysis(request: Request): Promise<Response> {
    const body = await request.json<{ analysisId: string }>();

    if (!body.analysisId) {
      return Response.json({ error: 'analysisId required' }, { status: 400 });
    }

    const analysis = this.sql.exec<ResolutionAnalysisRow>(
      `SELECT * FROM resolution_analyses WHERE analysis_id = ?`,
      body.analysisId
    ).one();

    if (!analysis) {
      return Response.json({ error: 'Analysis not found' }, { status: 404 });
    }

    return Response.json({
      analysisId: analysis.analysis_id,
      marketId: analysis.market_id,
      venue: analysis.venue,
      marketTitle: analysis.market_title,
      resolutionCriteria: analysis.resolution_criteria,
      modelProbability: analysis.model_probability,
      ambiguityScore: analysis.ambiguity_score,
      confidence: analysis.confidence,
      citedPassages: JSON.parse(analysis.cited_passages),
      reasoning: analysis.reasoning,
      flaggedForReview: analysis.flagged_for_review === 1,
      humanOverrideProbability: analysis.human_override_probability,
      analyzedAt: analysis.analyzed_at,
      expiresAt: analysis.expires_at,
      llmRunId: analysis.llm_run_id,
      ambiguityRunId: analysis.ambiguity_run_id,
    });
  }

  /**
   * List recent analyses
   */
  private async listAnalyses(request: Request): Promise<Response> {
    const body = await request.json<{
      limit?: number;
      includeExpired?: boolean;
      onlyFlagged?: boolean;
    }>();

    const limit = body.limit ?? 50;
    let query = `SELECT * FROM resolution_analyses`;
    const conditions: string[] = [];

    if (!body.includeExpired) {
      conditions.push(`expires_at > datetime('now')`);
    }
    if (body.onlyFlagged) {
      conditions.push(`flagged_for_review = 1 AND human_override_probability IS NULL`);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ` ORDER BY analyzed_at DESC LIMIT ${limit}`;

    const analyses = this.sql.exec<ResolutionAnalysisRow>(query).toArray();

    return Response.json({
      count: analyses.length,
      analyses: analyses.map(a => ({
        analysisId: a.analysis_id,
        marketId: a.market_id,
        venue: a.venue,
        marketTitle: a.market_title,
        modelProbability: a.model_probability,
        ambiguityScore: a.ambiguity_score,
        confidence: a.confidence,
        flaggedForReview: a.flagged_for_review === 1,
        humanOverrideProbability: a.human_override_probability,
        analyzedAt: a.analyzed_at,
        expiresAt: a.expires_at,
      })),
    });
  }

  /**
   * Apply human override to an analysis
   */
  private async applyHumanOverride(request: Request): Promise<Response> {
    const body = await request.json<{
      analysisId: string;
      overrideProbability: number;
      reason: string;
    }>();

    if (!body.analysisId || body.overrideProbability === undefined) {
      return Response.json({ error: 'analysisId and overrideProbability required' }, { status: 400 });
    }

    if (body.overrideProbability < 0 || body.overrideProbability > 1) {
      return Response.json({ error: 'overrideProbability must be between 0 and 1' }, { status: 400 });
    }

    // Check analysis exists
    const analysis = this.sql.exec<ResolutionAnalysisRow>(
      `SELECT * FROM resolution_analyses WHERE analysis_id = ?`,
      body.analysisId
    ).one();

    if (!analysis) {
      return Response.json({ error: 'Analysis not found' }, { status: 404 });
    }

    // Update with override
    this.sql.exec(
      `UPDATE resolution_analyses
       SET human_override_probability = ?, flagged_for_review = 0
       WHERE analysis_id = ?`,
      body.overrideProbability,
      body.analysisId
    );

    await this.logAudit('RESOLUTION_HUMAN_OVERRIDE', {
      analysisId: body.analysisId,
      marketId: analysis.market_id,
      originalProbability: analysis.model_probability,
      overrideProbability: body.overrideProbability,
      reason: body.reason,
    });

    return Response.json({
      success: true,
      analysisId: body.analysisId,
      originalProbability: analysis.model_probability,
      overrideProbability: body.overrideProbability,
    });
  }

  /**
   * Get current positions
   */
  private async getPositions(): Promise<Response> {
    const positions = this.sql.exec<ResolutionPositionRow>(
      `SELECT * FROM resolution_positions WHERE status != 'closed' ORDER BY created_at DESC`
    ).toArray();

    const summary = {
      total: positions.length,
      yesPositions: positions.filter(p => p.side === 'YES').length,
      noPositions: positions.filter(p => p.side === 'NO').length,
      totalSize: positions.reduce((sum, p) => sum + p.size, 0),
      unrealizedPnl: positions.reduce((sum, p) => sum + p.unrealized_pnl, 0),
    };

    return Response.json({ positions, summary });
  }

  /**
   * Update position (called by execution agents)
   */
  private async updatePosition(request: Request): Promise<Response> {
    const body = await request.json<Partial<ResolutionPositionRow> & { positionId: string }>();

    if (!body.positionId) {
      return Response.json({ error: 'positionId required' }, { status: 400 });
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.unrealized_pnl !== undefined) {
      updates.push('unrealized_pnl = ?');
      values.push(body.unrealized_pnl);
    }
    if (body.realized_pnl !== undefined) {
      updates.push('realized_pnl = ?');
      values.push(body.realized_pnl);

      // Record return for CV calculation
      const position = this.sql.exec<ResolutionPositionRow>(
        `SELECT size FROM resolution_positions WHERE position_id = ?`,
        body.positionId
      ).one();

      if (position && position.size > 0) {
        this.sql.exec(
          `INSERT INTO resolution_returns (return_value, recorded_at) VALUES (?, ?)`,
          body.realized_pnl / position.size,
          new Date().toISOString()
        );
      }
    }
    if (body.status !== undefined) {
      updates.push('status = ?');
      values.push(body.status);
      if (body.status === 'closed') {
        updates.push('closed_at = ?');
        values.push(new Date().toISOString());
      }
    }

    if (updates.length === 0) {
      return Response.json({ error: 'No updates provided' }, { status: 400 });
    }

    values.push(body.positionId);

    this.sql.exec(
      `UPDATE resolution_positions SET ${updates.join(', ')} WHERE position_id = ?`,
      ...values
    );

    return Response.json({ success: true, positionId: body.positionId });
  }

  /**
   * Get current configuration
   */
  private async getConfig(): Promise<Response> {
    return Response.json({
      resolution: this.config,
      monteCarlo: this.monteCarloConfig,
    });
  }

  /**
   * Update configuration
   */
  private async updateConfig(request: Request): Promise<Response> {
    const body = await request.json<{
      resolution?: Partial<ResolutionConfig>;
      monteCarlo?: Partial<MonteCarloConfig>;
    }>();

    if (body.resolution) {
      this.config = { ...this.config, ...body.resolution };
    }
    if (body.monteCarlo) {
      this.monteCarloConfig = { ...this.monteCarloConfig, ...body.monteCarlo };
    }

    await this.logAudit('RESOLUTION_CONFIG_UPDATED', {
      resolution: this.config,
      monteCarlo: this.monteCarloConfig,
    });

    return Response.json({
      resolution: this.config,
      monteCarlo: this.monteCarloConfig,
    });
  }

  /**
   * Get agent status
   */
  private async getStatus(): Promise<Response> {
    const openPositions = this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM resolution_positions WHERE status = 'open'`
    ).one();

    const pendingReview = this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM resolution_analyses
       WHERE flagged_for_review = 1 AND human_override_probability IS NULL
       AND expires_at > datetime('now')`
    ).one();

    const recentAnalyses = this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM resolution_analyses
       WHERE analyzed_at > datetime('now', '-1 day')`
    ).one();

    const recentSignals = this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM mispricing_signals
       WHERE created_at > datetime('now', '-1 day')`
    ).one();

    return Response.json({
      agent: this.agentName,
      strategyType: 'resolution_mispricing',
      status: 'paper',
      config: this.config,
      openPositions: openPositions?.count ?? 0,
      pendingHumanReview: pendingReview?.count ?? 0,
      recentAnalyses: recentAnalyses?.count ?? 0,
      recentSignals: recentSignals?.count ?? 0,
      lastActivity: new Date().toISOString(),
    });
  }

  /**
   * Get strategy metrics
   */
  private async getMetrics(): Promise<Response> {
    const positions = this.sql.exec<ResolutionPositionRow>(
      `SELECT * FROM resolution_positions`
    ).toArray();

    const analyses = this.sql.exec<ResolutionAnalysisRow>(
      `SELECT * FROM resolution_analyses`
    ).toArray();

    const signals = this.sql.exec<MispricingSignalRow>(
      `SELECT * FROM mispricing_signals`
    ).toArray();

    const returns = this.getHistoricalReturns();
    const totalPnl = positions.reduce((sum, p) => sum + p.realized_pnl + p.unrealized_pnl, 0);

    // Calculate win rate
    const closedPositions = positions.filter(p => p.status === 'closed' && p.realized_pnl !== 0);
    const wins = closedPositions.filter(p => p.realized_pnl > 0).length;
    const winRate = closedPositions.length > 0 ? wins / closedPositions.length : 0;

    // Calculate average edge
    const avgEdge = signals.length > 0
      ? signals.reduce((sum, s) => sum + s.edge, 0) / signals.length
      : 0;

    // Calculate Sharpe-like ratio
    const mean = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const variance = returns.length > 0
      ? returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length
      : 0;
    const sharpe = variance > 0 ? mean / Math.sqrt(variance) : 0;

    // Ambiguity analysis stats
    const avgAmbiguity = analyses.length > 0
      ? analyses.reduce((sum, a) => sum + a.ambiguity_score, 0) / analyses.length
      : 0;
    const avgConfidence = analyses.length > 0
      ? analyses.reduce((sum, a) => sum + a.confidence, 0) / analyses.length
      : 0;
    const flaggedRate = analyses.length > 0
      ? analyses.filter(a => a.flagged_for_review === 1).length / analyses.length
      : 0;

    return Response.json({
      positions: {
        total: positions.length,
        open: positions.filter(p => p.status === 'open').length,
        closed: closedPositions.length,
        winRate,
      },
      analyses: {
        total: analyses.length,
        avgAmbiguity,
        avgConfidence,
        flaggedRate,
        withOverrides: analyses.filter(a => a.human_override_probability !== null).length,
      },
      signals: {
        total: signals.length,
        avgEdge,
        executed: signals.filter(s => s.executed_at !== null).length,
      },
      performance: {
        totalPnl,
        sharpeRatio: sharpe,
        returnCount: returns.length,
      },
    });
  }

  /**
   * Get historical returns for CV calculation
   */
  private getHistoricalReturns(): number[] {
    const rows = this.sql.exec<{ return_value: number }>(
      `SELECT return_value FROM resolution_returns ORDER BY recorded_at DESC LIMIT 100`
    ).toArray();

    return rows.map(r => r.return_value);
  }
}
