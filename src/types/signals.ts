/**
 * Paul P - Unified Signal Types
 *
 * Single source of truth for signal message shapes used across:
 * - Strategy agents (emitters)
 * - Signal queue consumer
 * - PaulP Orchestrator
 * - Risk Governor
 */

import { deterministicId } from '../lib/utils/deterministic-id';

// ============================================================
// CORE SIGNAL TYPES
// ============================================================

/**
 * Base signal from any strategy - the unified format
 */
export interface TradingSignal {
  signalId: string;
  strategyType: 'bonding' | 'weather' | 'xv_signal' | 'smart_money' | 'resolution';
  marketId: string;
  venue: 'kalshi' | 'polymarket';
  side: 'YES' | 'NO';
  action: 'BUY' | 'SELL';

  // Probability and edge
  modelProbability: number; // Our model's probability estimate
  marketPrice: number; // Current market price (0-1)
  edge: number; // modelProbability - marketPrice (positive = favorable)

  // Sizing
  suggestedSize: number; // Suggested position size in dollars
  kellyFraction?: number; // Kelly criterion fraction used
  capital: number; // Capital allocated to this strategy

  // Confidence
  confidence: number; // Model confidence (0-1)

  // Timing
  generatedAt: string; // ISO timestamp when signal was generated
  expiresAt: string; // ISO timestamp when signal becomes stale

  // Strategy-specific context
  context: Record<string, unknown>;
}

/**
 * Signal with risk assessment applied
 */
export interface ApprovedSignal extends TradingSignal {
  adjustedSize: number; // Size after risk adjustments
  riskApprovedAt: string;
  invariantsChecked: string[]; // List of invariant codes checked
}

/**
 * Queue message wrapper for QUEUE_SIGNALS
 */
export interface SignalQueueMessage {
  type: 'TRADING_SIGNAL' | 'BATCH_SIGNALS';
  signal?: TradingSignal;
  signals?: TradingSignal[];
  batchId?: string;
  timestamp: string;
}

// ============================================================
// STRATEGY-SPECIFIC SIGNAL EXTENSIONS
// ============================================================

/**
 * Bonding strategy signal context
 */
export interface BondingSignalContext {
  signalType: 'bond' | 'tail';
  tailType?: 'event_hedge' | 'regime_tail' | 'diversifier';
  bondProbability?: number;
  expectedReturn?: number;
}

/**
 * Weather strategy signal context
 */
export interface WeatherSignalContext {
  predictionType: 'temperature' | 'precipitation' | 'wind' | 'snow';
  forecastHorizon: number; // hours
  noaaForecast?: number;
  modelForecast?: number;
  resolutionThreshold?: number;
}

/**
 * XV Signal strategy context (cross-venue)
 */
export interface XVSignalContext {
  pairId: string;
  marketAId: string;
  marketBId: string;
  divergence: number;
  equivalenceGrade: string;
}

/**
 * Smart Money strategy context
 */
export interface SmartMoneyContext {
  convergenceCount: number; // Number of smart accounts converged
  totalConviction: number;
  topAccounts: string[];
}

/**
 * Resolution strategy context
 */
export interface ResolutionContext {
  llmProbYes: number;
  llmProbNo: number;
  llmProbVoid: number;
  llmConfidence: number;
  ambiguityScore: number;
  scoringRunId: string;
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Create a standard trading signal
 */
export function createTradingSignal(params: {
  strategyType: TradingSignal['strategyType'];
  marketId: string;
  venue: TradingSignal['venue'];
  side: TradingSignal['side'];
  action: TradingSignal['action'];
  modelProbability: number;
  marketPrice: number;
  suggestedSize: number;
  capital: number;
  confidence: number;
  expiresInMinutes?: number;
  kellyFraction?: number;
  context?: Record<string, unknown>;
}): TradingSignal {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (params.expiresInMinutes ?? 60) * 60 * 1000);
  const seed = [
    params.strategyType,
    params.marketId,
    params.venue,
    params.side,
    params.action,
    now.toISOString(),
  ].join('|');

  return {
    signalId: deterministicId('sig', seed),
    strategyType: params.strategyType,
    marketId: params.marketId,
    venue: params.venue,
    side: params.side,
    action: params.action,
    modelProbability: params.modelProbability,
    marketPrice: params.marketPrice,
    edge: params.modelProbability - params.marketPrice,
    suggestedSize: params.suggestedSize,
    kellyFraction: params.kellyFraction,
    capital: params.capital,
    confidence: params.confidence,
    generatedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    context: params.context ?? {},
  };
}

/**
 * Check if a signal has expired
 */
export function isSignalExpired(signal: TradingSignal): boolean {
  return new Date(signal.expiresAt) < new Date();
}

/**
 * Validate signal has required fields
 */
export function validateSignal(signal: unknown): signal is TradingSignal {
  if (!signal || typeof signal !== 'object') return false;

  const s = signal as Record<string, unknown>;
  return (
    typeof s.signalId === 'string' &&
    typeof s.strategyType === 'string' &&
    typeof s.marketId === 'string' &&
    typeof s.venue === 'string' &&
    typeof s.side === 'string' &&
    typeof s.action === 'string' &&
    typeof s.modelProbability === 'number' &&
    typeof s.marketPrice === 'number' &&
    typeof s.edge === 'number' &&
    typeof s.suggestedSize === 'number' &&
    typeof s.capital === 'number' &&
    typeof s.confidence === 'number' &&
    typeof s.generatedAt === 'string' &&
    typeof s.expiresAt === 'string'
  );
}
