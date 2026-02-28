/**
 * Paul P - Ingestion Queue Consumer
 *
 * Processes market data ingestion messages with compliance gate.
 * All ingestion requests are checked against compliance rules before processing.
 */

import type { Env } from '../types/env';

export interface IngestionMessage {
  type: 'fetch_markets' | 'fetch_orderbook' | 'fetch_account' | 'fetch_leaderboard';
  venue: 'polymarket' | 'kalshi';
  payload: Record<string, unknown>;
}

interface ComplianceCheckResult {
  allowed: boolean;
  reason?: string;
  blockedEntities?: string[];
}

function getComplianceSourceIds(message: IngestionMessage): string[] {
  if (message.venue === 'polymarket') {
    switch (message.type) {
      case 'fetch_markets':
        return ['polymarket_gamma_api'];
      case 'fetch_orderbook':
        return ['polymarket_clob_api'];
      case 'fetch_account':
      case 'fetch_leaderboard':
        return ['polymarket_data_api'];
      default:
        return [];
    }
  }

  if (message.venue === 'kalshi') {
    // Kalshi Trade API provides markets + orderbook in this ingestion flow.
    switch (message.type) {
      case 'fetch_markets':
      case 'fetch_orderbook':
      case 'fetch_account':
      case 'fetch_leaderboard':
        return ['kalshi_trade_api'];
      default:
        return [];
    }
  }

  return [];
}

/**
 * Check compliance before processing ingestion request
 */
async function checkCompliance(
  env: Env,
  message: IngestionMessage
): Promise<ComplianceCheckResult> {
  try {
    const complianceId = env.COMPLIANCE.idFromName('singleton');
    const compliance = env.COMPLIANCE.get(complianceId);

    const entities = getComplianceSourceIds(message);
    if (entities.length === 0) {
      return {
        allowed: false,
        reason: `No compliance source mapping for ${message.venue}:${message.type}`,
      };
    }

    const response = await compliance.fetch('http://internal/check-batch', {
      method: 'POST',
      body: JSON.stringify({
        entities,
        operation: message.type,
        venue: message.venue,
      }),
    });

    return response.json();
  } catch (error) {
    console.error('Compliance check failed, defaulting to DENY:', error);
    // Fail-closed: if compliance check fails, don't process
    return {
      allowed: false,
      reason: 'Compliance check service unavailable - fail closed',
    };
  }
}

export async function handleIngestionQueue(
  batch: MessageBatch,
  env: Env
): Promise<void> {
  const marketDataAgentId = env.MARKET_DATA_AGENT.idFromName('singleton');
  const marketDataAgent = env.MARKET_DATA_AGENT.get(marketDataAgentId);

  for (const message of batch.messages) {
    try {
      const body = message.body as IngestionMessage;

      // COMPLIANCE GATE: Check before any data ingestion
      const complianceResult = await checkCompliance(env, body);

      if (!complianceResult.allowed) {
        console.warn(
          `Ingestion blocked by compliance: ${complianceResult.reason}`,
          complianceResult.blockedEntities
        );

        // Log blocked attempt to audit trail
        const auditId = env.AUDIT_REPORTER.idFromName('singleton');
        const audit = env.AUDIT_REPORTER.get(auditId);
        await audit.fetch('http://internal/log', {
          method: 'POST',
          body: JSON.stringify({
            agent: 'ingestion-consumer',
            eventType: 'INGESTION_BLOCKED_BY_COMPLIANCE',
            payload: {
              messageType: body.type,
              venue: body.venue,
              reason: complianceResult.reason,
              blockedEntities: complianceResult.blockedEntities,
            },
          }),
        });

        // Acknowledge the message but don't process
        message.ack();
        continue;
      }

      // Process the ingestion request
      switch (body.type) {
        case 'fetch_markets':
          await marketDataAgent.fetch('http://internal/ingest/markets', {
            method: 'POST',
            body: JSON.stringify({ venue: body.venue, ...body.payload }),
          });
          break;

        case 'fetch_orderbook':
          await marketDataAgent.fetch('http://internal/ingest/orderbook', {
            method: 'POST',
            body: JSON.stringify({ venue: body.venue, ...body.payload }),
          });
          break;

        case 'fetch_account':
          await marketDataAgent.fetch('http://internal/ingest/account', {
            method: 'POST',
            body: JSON.stringify(body.payload),
          });
          break;

        case 'fetch_leaderboard':
          await marketDataAgent.fetch('http://internal/ingest/leaderboard', {
            method: 'POST',
            body: JSON.stringify(body.payload),
          });
          break;

        default:
          console.warn(`Unknown ingestion message type: ${(body as IngestionMessage).type}`);
      }

      message.ack();
    } catch (error) {
      console.error('Error processing ingestion message:', error);
      message.retry();
    }
  }
}
