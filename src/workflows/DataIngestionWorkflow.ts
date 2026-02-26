/**
 * Paul P - Data Ingestion Workflow
 *
 * Orchestrates periodic market data ingestion using existing orchestrator
 * and queue bindings.
 */

import type { Env } from '../types/env';

export type IngestionTrigger = 'cron' | 'manual' | 'backfill';

export interface IngestionRunResult {
  trigger: IngestionTrigger;
  startedAt: string;
  completedAt: string;
  orchestratorResponse: unknown;
}

export class DataIngestionWorkflow {
  constructor(private readonly env: Env) {}

  private getOrchestrator() {
    const id = this.env.PAUL_P_ORCHESTRATOR.idFromName('singleton');
    return this.env.PAUL_P_ORCHESTRATOR.get(id);
  }

  async run(trigger: IngestionTrigger = 'manual'): Promise<IngestionRunResult> {
    const startedAt = new Date().toISOString();
    const orchestrator = this.getOrchestrator();

    const response = await orchestrator.fetch('http://internal/cron/ingest', {
      method: 'POST',
      body: JSON.stringify({ trigger, startedAt }),
    });
    const orchestratorResponse = await response.json();

    return {
      trigger,
      startedAt,
      completedAt: new Date().toISOString(),
      orchestratorResponse,
    };
  }

  async enqueueVenueIngestion(
    venue: 'polymarket' | 'kalshi',
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.env.QUEUE_INGESTION.send({
      type: 'fetch_markets',
      venue,
      payload,
    });
  }
}
