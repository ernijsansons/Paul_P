/**
 * Paul P - Order Queue Consumer
 * Processes orders for execution
 * Single order at a time (max_batch_size = 1) for safety
 */

import type { Env } from '../types/env';
import { deterministicId } from '../lib/utils/deterministic-id';

/**
 * Order message from signal-consumer (unified format)
 */
export interface OrderMessage {
  signalId: string;
  strategyType: 'bonding' | 'weather' | 'xv_signal' | 'smart_money' | 'resolution';
  marketId: string;
  venue: 'kalshi' | 'polymarket';
  side: 'YES' | 'NO';
  action: 'BUY' | 'SELL';
  quantity: number;
  limitPrice?: number;
  confidence: number;
  edge: number;
  capital: number;
  generatedAt: string;
  context?: Record<string, unknown>;
}

/**
 * Legacy order format for backwards compatibility
 * @deprecated Use OrderMessage instead
 */
export interface LegacyOrderMessage {
  signalId: string;
  strategyId: string;
  ticker: string;
  venue: 'kalshi' | 'ibkr';
  side: 'YES' | 'NO';
  action: 'BUY' | 'SELL';
  quantity: number;
  limitPrice?: number;
  generatedAt: string;
}

/**
 * Normalize order message format
 */
function normalizeOrder(body: unknown): OrderMessage | null {
  if (!body || typeof body !== 'object') return null;

  const msg = body as Record<string, unknown>;

  // New format with strategyType
  if (typeof msg.strategyType === 'string' && typeof msg.marketId === 'string') {
    return msg as unknown as OrderMessage;
  }

  // Legacy format with strategyId and ticker
  if (typeof msg.strategyId === 'string' && typeof msg.ticker === 'string') {
    const legacy = msg as unknown as LegacyOrderMessage;
    return {
      signalId: legacy.signalId,
      strategyType: legacy.strategyId as OrderMessage['strategyType'],
      marketId: legacy.ticker,
      venue: legacy.venue === 'ibkr' ? 'kalshi' : legacy.venue as 'kalshi',
      side: legacy.side,
      action: legacy.action,
      quantity: legacy.quantity,
      limitPrice: legacy.limitPrice,
      confidence: 0.5,
      edge: 0,
      capital: legacy.quantity * 20,
      generatedAt: legacy.generatedAt,
    };
  }

  return null;
}

export async function handleOrderQueue(
  batch: MessageBatch,
  env: Env
): Promise<void> {
  // Process one order at a time for safety
  for (const message of batch.messages) {
    try {
      const order = normalizeOrder(message.body);

      if (!order) {
        console.error('Invalid order message format, skipping');
        message.ack();
        continue;
      }

      console.log(`Processing order for ${order.marketId} via ${order.venue} (${order.strategyType})`);

      // Route to appropriate execution agent
      if (order.venue === 'kalshi') {
        const execId = env.KALSHI_EXEC.idFromName('singleton');
        const exec = env.KALSHI_EXEC.get(execId);

        const response = await exec.fetch('http://internal/execute', {
          method: 'POST',
          body: JSON.stringify(order),
        });

        const result = await response.json<{ success: boolean; orderId?: string; error?: string }>();

        if (!result.success) {
          console.error(`Order execution failed: ${result.error}`);
          // Don't retry immediately - log to invariant violations
          await logExecutionFailure(env, order, result.error ?? 'Unknown error');
        }
      } else if (order.venue === 'polymarket') {
        // Polymarket orders not supported for direct execution
        // XV signal strategy routes Polymarket signals to Kalshi
        console.warn(`Polymarket order not executed - route to Kalshi instead: ${order.signalId}`);
        await logExecutionFailure(env, order, 'Polymarket direct execution not supported');
      } else {
        console.warn(`Unknown venue ${order.venue} for order ${order.signalId}`);
        await logExecutionFailure(env, order, `Unknown venue: ${order.venue}`);
      }

      message.ack();
    } catch (error) {
      console.error('Error processing order:', error);

      // For orders, we don't automatically retry
      // Log the failure and ack to prevent infinite retries
      await logExecutionFailure(
        env,
        message.body as OrderMessage,
        error instanceof Error ? error.message : String(error)
      );
      message.ack();
    }
  }
}

async function logExecutionFailure(
  env: Env,
  order: OrderMessage,
  errorMessage: string
): Promise<void> {
  const nowIso = new Date().toISOString();
  const id = deterministicId('viol', order.signalId, order.marketId, errorMessage, nowIso);

  await env.DB.prepare(`
    INSERT INTO invariant_violations (
      id, invariant_id, invariant_name, severity, triggered_by, triggered_at,
      description, context_json, action_taken
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    'EXEC-01',
    'Order Execution Failure',
    'WARNING',
    order.signalId,
    nowIso,
    errorMessage,
    JSON.stringify(order),
    'ALERT_ONLY'
  ).run();
}
