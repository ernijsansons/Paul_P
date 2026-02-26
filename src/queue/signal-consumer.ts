/**
 * Paul P - Signal Queue Consumer
 * Processes trading signals from strategy agents
 *
 * Accepts SignalQueueMessage from QUEUE_SIGNALS and forwards approved
 * signals to QUEUE_ORDERS after risk checks.
 */

import type { Env } from '../types/env';
import { type TradingSignal, isSignalExpired, validateSignal } from '../types/signals';

/**
 * Legacy signal format for backwards compatibility
 * @deprecated Use TradingSignal instead
 */
export interface LegacySignalMessage {
  signalId: string;
  strategyId: string;
  strategyType: string;
  ticker: string;
  venue: 'kalshi' | 'ibkr';
  side: 'YES' | 'NO';
  action: 'BUY' | 'SELL';
  quantity: number;
  limitPrice?: number;
  confidence: number;
  edge: number;
  generatedAt: string;
  expiresAt: string;
  context: Record<string, unknown>;
}

/**
 * Convert legacy format to unified TradingSignal
 */
function fromLegacyFormat(legacy: LegacySignalMessage): TradingSignal {
  return {
    signalId: legacy.signalId,
    strategyType: legacy.strategyType as TradingSignal['strategyType'],
    marketId: legacy.ticker,
    venue: legacy.venue === 'ibkr' ? 'kalshi' : legacy.venue,
    side: legacy.side,
    action: legacy.action,
    modelProbability: 0.5 + legacy.edge, // Reconstruct from edge
    marketPrice: 0.5,
    edge: legacy.edge,
    suggestedSize: legacy.quantity,
    capital: legacy.quantity * 10, // Estimate capital
    confidence: legacy.confidence,
    generatedAt: legacy.generatedAt,
    expiresAt: legacy.expiresAt,
    context: legacy.context,
  };
}

/**
 * Bonding strategy signal format from StrategyBondingAgent
 */
interface BondingSignalFormat {
  signalId: string;
  strategy: 'bonding_barbell';
  marketId: string;
  venue: 'kalshi' | 'polymarket';
  side: 'YES' | 'NO';
  signalType: 'bond' | 'tail';
  tailType?: string;
  targetSize: number;
  kellyFraction: number;
  expectedEdge: number;
  marketPrice: number;
  fairProbability: number;
  confidence: number;
  createdAt: string;
  expiresAt: string;
  metadata: Record<string, unknown>;
}

/**
 * Convert bonding strategy signal to unified format
 */
function convertBondingSignal(raw: unknown): TradingSignal {
  const sig = raw as BondingSignalFormat;
  return {
    signalId: sig.signalId,
    strategyType: 'bonding',
    marketId: sig.marketId,
    venue: sig.venue,
    side: sig.side,
    action: 'BUY', // Bonding signals are always entry positions
    modelProbability: sig.fairProbability,
    marketPrice: sig.marketPrice,
    edge: sig.fairProbability - sig.marketPrice,
    suggestedSize: sig.targetSize,
    kellyFraction: sig.kellyFraction,
    capital: sig.targetSize * 20, // Estimate capital from size
    confidence: sig.confidence,
    generatedAt: sig.createdAt,
    expiresAt: sig.expiresAt,
    context: {
      signalType: sig.signalType,
      tailType: sig.tailType,
      expectedEdge: sig.expectedEdge,
      ...sig.metadata,
    },
  };
}

/**
 * Weather strategy signal format from StrategyWeatherAgent
 */
interface WeatherSignalFormat {
  signalId: string;
  strategy: 'weather';
  marketId: string;
  venue: 'kalshi';
  side: 'YES' | 'NO';
  targetSize: number;
  kellyFraction: number;
  modelProbability: number;
  marketPrice: number;
  edge: number;
  confidence: number;
  forecast: {
    mean: number;
    stdDev: number;
    sampleSize: number;
  };
  createdAt: string;
  expiresAt: string;
}

/**
 * Convert weather strategy signal to unified format
 */
function convertWeatherSignal(raw: unknown): TradingSignal {
  const sig = raw as WeatherSignalFormat;
  return {
    signalId: sig.signalId,
    strategyType: 'weather',
    marketId: sig.marketId,
    venue: sig.venue,
    side: sig.side,
    action: 'BUY',
    modelProbability: sig.modelProbability,
    marketPrice: sig.marketPrice,
    edge: sig.edge,
    suggestedSize: sig.targetSize,
    kellyFraction: sig.kellyFraction,
    capital: sig.targetSize * 20,
    confidence: sig.confidence,
    generatedAt: sig.createdAt,
    expiresAt: sig.expiresAt,
    context: {
      forecast: sig.forecast,
    },
  };
}

/**
 * XV Signal format from StrategyXVSignalAgent
 */
interface XVSignalFormat {
  signalId: string;
  pairId: string;
  kalshiMarketId: string;
  polymarketMarketId: string;
  direction: 'YES' | 'NO';
  targetSize: number;
  kellyFraction: number;
  kalshiPrice: number;
  polymarketPrice: number;
  divergence: number;
  confidence: number;
  createdAt: string;
  expiresAt: string;
  capital?: number;
}

/**
 * Convert XV signal strategy signal to unified format
 */
function convertXVSignal(raw: unknown): TradingSignal {
  const sig = raw as XVSignalFormat;
  // XV signals target Kalshi based on Polymarket price signal
  const edge = Math.abs(sig.kalshiPrice - sig.polymarketPrice);
  return {
    signalId: sig.signalId,
    strategyType: 'xv_signal',
    marketId: sig.kalshiMarketId,
    venue: 'kalshi',
    side: sig.direction,
    action: 'BUY',
    modelProbability: sig.polymarketPrice, // Use Polymarket as model
    marketPrice: sig.kalshiPrice,
    edge: edge,
    suggestedSize: sig.targetSize,
    kellyFraction: sig.kellyFraction,
    capital: sig.capital ?? sig.targetSize * 20,
    confidence: sig.confidence,
    generatedAt: sig.createdAt,
    expiresAt: sig.expiresAt,
    context: {
      pairId: sig.pairId,
      polymarketMarketId: sig.polymarketMarketId,
      divergence: sig.divergence,
    },
  };
}

/**
 * Smart Money signal format from StrategySmartMoneyAgent
 */
interface SmartMoneySignalFormat {
  signalId: string;
  kalshiMarketId: string;
  direction: 'YES' | 'NO';
  targetSize: number;
  kellyFraction: number;
  marketPrice: number;
  convergenceScore: number;
  confidence: number;
  accountIds: string[];
  createdAt: string;
  expiresAt: string;
  capital?: number;
}

/**
 * Convert smart money strategy signal to unified format
 */
function convertSmartMoneySignal(raw: unknown): TradingSignal {
  const sig = raw as SmartMoneySignalFormat;
  // Smart money signals assume edge from convergence
  const assumedEdge = sig.convergenceScore * 0.1; // Scale convergence to edge
  return {
    signalId: sig.signalId,
    strategyType: 'smart_money',
    marketId: sig.kalshiMarketId,
    venue: 'kalshi',
    side: sig.direction,
    action: 'BUY',
    modelProbability: sig.direction === 'YES'
      ? sig.marketPrice + assumedEdge
      : sig.marketPrice - assumedEdge,
    marketPrice: sig.marketPrice,
    edge: assumedEdge,
    suggestedSize: sig.targetSize,
    kellyFraction: sig.kellyFraction,
    capital: sig.capital ?? sig.targetSize * 20,
    confidence: sig.confidence,
    generatedAt: sig.createdAt,
    expiresAt: sig.expiresAt,
    context: {
      convergenceScore: sig.convergenceScore,
      accountIds: sig.accountIds,
    },
  };
}

/**
 * Resolution signal format from StrategyResolutionAgent
 */
interface ResolutionSignalFormat {
  signalId: string;
  marketId: string;
  direction: 'YES' | 'NO';
  targetSize: number;
  kellyFraction: number;
  marketPrice: number;
  llmProbYes: number;
  llmProbNo: number;
  llmConfidence: number;
  ambiguityScore: number;
  scoringRunId: string;
  createdAt: string;
  expiresAt: string;
  capital?: number;
}

/**
 * Convert resolution strategy signal to unified format
 */
function convertResolutionSignal(raw: unknown): TradingSignal {
  const sig = raw as ResolutionSignalFormat;
  const modelProb = sig.direction === 'YES' ? sig.llmProbYes : sig.llmProbNo;
  const edge = Math.abs(modelProb - sig.marketPrice);
  return {
    signalId: sig.signalId,
    strategyType: 'resolution',
    marketId: sig.marketId,
    venue: 'kalshi',
    side: sig.direction,
    action: 'BUY',
    modelProbability: modelProb,
    marketPrice: sig.marketPrice,
    edge: edge,
    suggestedSize: sig.targetSize,
    kellyFraction: sig.kellyFraction,
    capital: sig.capital ?? sig.targetSize * 20,
    confidence: sig.llmConfidence,
    generatedAt: sig.createdAt,
    expiresAt: sig.expiresAt,
    context: {
      llmProbYes: sig.llmProbYes,
      llmProbNo: sig.llmProbNo,
      ambiguityScore: sig.ambiguityScore,
      scoringRunId: sig.scoringRunId,
    },
  };
}

/**
 * Normalize any message format to TradingSignal[]
 */
function normalizeSignals(body: unknown): TradingSignal[] {
  if (!body || typeof body !== 'object') return [];

  const msg = body as Record<string, unknown>;

  // Handle new unified format
  if (msg.type === 'TRADING_SIGNAL' && msg.signal) {
    const signal = msg.signal as TradingSignal;
    return validateSignal(signal) ? [signal] : [];
  }

  if (msg.type === 'BATCH_SIGNALS' && Array.isArray(msg.signals)) {
    return (msg.signals as TradingSignal[]).filter(validateSignal);
  }

  // Handle bonding strategy signal format
  if (msg.type === 'BONDING_SIGNALS' && Array.isArray(msg.signals)) {
    return (msg.signals as unknown[]).map(convertBondingSignal).filter(validateSignal);
  }

  // Handle weather strategy signal format
  if (msg.type === 'WEATHER_SIGNALS' && Array.isArray(msg.signals)) {
    return (msg.signals as unknown[]).map(convertWeatherSignal).filter(validateSignal);
  }

  // Handle XV signal strategy format
  if (msg.type === 'XV_SIGNALS' && Array.isArray(msg.signals)) {
    return (msg.signals as unknown[]).map(convertXVSignal).filter(validateSignal);
  }

  // Handle smart money strategy format
  if (msg.type === 'SMART_MONEY_SIGNALS' && Array.isArray(msg.signals)) {
    return (msg.signals as unknown[]).map(convertSmartMoneySignal).filter(validateSignal);
  }

  // Handle resolution strategy format
  if (msg.type === 'RESOLUTION_SIGNALS' && Array.isArray(msg.signals)) {
    return (msg.signals as unknown[]).map(convertResolutionSignal).filter(validateSignal);
  }

  // Handle legacy flat signal format
  if (typeof msg.signalId === 'string' && typeof msg.ticker === 'string') {
    const legacy = msg as unknown as LegacySignalMessage;
    return [fromLegacyFormat(legacy)];
  }

  // Handle direct TradingSignal
  if (validateSignal(body)) {
    return [body];
  }

  return [];
}

export async function handleSignalQueue(
  batch: MessageBatch,
  env: Env
): Promise<void> {
  const riskGovernorId = env.RISK_GOVERNOR.idFromName('singleton');
  const riskGovernor = env.RISK_GOVERNOR.get(riskGovernorId);

  for (const message of batch.messages) {
    try {
      const signals = normalizeSignals(message.body);

      if (signals.length === 0) {
        console.log('No valid signals found in message, skipping');
        message.ack();
        continue;
      }

      for (const signal of signals) {
        console.log(`Processing signal ${signal.signalId} from ${signal.strategyType}`);

        // Check if signal has expired
        if (isSignalExpired(signal)) {
          console.log(`Signal ${signal.signalId} expired, skipping`);
          continue;
        }

        // Forward to Risk Governor for invariant checks
        const response = await riskGovernor.fetch('http://internal/check-signal', {
          method: 'POST',
          body: JSON.stringify({
            signal: {
              marketId: signal.marketId,
              side: signal.side,
              modelProbability: signal.modelProbability,
              marketPrice: signal.marketPrice,
              edge: signal.edge,
              confidence: signal.confidence,
              requestedSize: signal.suggestedSize,
            },
            strategyType: signal.strategyType,
            capital: signal.capital,
          }),
        });

        const result = await response.json<{
          approved: boolean;
          adjustedSize?: number;
          reason?: string;
          violations?: Array<{ code: string; message: string }>;
        }>();

        if (result.approved) {
          // Forward to order queue
          await env.QUEUE_ORDERS.send({
            signalId: signal.signalId,
            strategyType: signal.strategyType,
            marketId: signal.marketId,
            venue: signal.venue,
            side: signal.side,
            action: signal.action,
            quantity: result.adjustedSize ?? signal.suggestedSize,
            limitPrice: Math.round(signal.marketPrice * 100), // Convert to cents
            confidence: signal.confidence,
            edge: signal.edge,
            capital: signal.capital,
            generatedAt: signal.generatedAt,
            context: signal.context,
          });

          console.log(`Signal ${signal.signalId} approved and forwarded to orders queue`);
        } else {
          console.log(`Signal ${signal.signalId} vetoed: ${result.reason}`);
          if (result.violations) {
            console.log('Violations:', result.violations.map(v => v.code).join(', '));
          }
        }
      }

      message.ack();
    } catch (error) {
      console.error('Error processing signal:', error);
      message.retry();
    }
  }
}
