/**
 * Paul P - Reconciliation Workflow
 *
 * Wraps the reconciliation agent endpoints used for drift checks and recovery.
 */

import type { Env } from '../types/env';

export class ReconciliationWorkflow {
  constructor(private readonly env: Env) {}

  private getReconciliationAgent() {
    const id = this.env.RECONCILIATION.idFromName('singleton');
    return this.env.RECONCILIATION.get(id);
  }

  async run(): Promise<unknown> {
    const agent = this.getReconciliationAgent();
    const response = await agent.fetch('http://internal/reconcile', { method: 'POST' });
    return response.json();
  }

  async getStatus(): Promise<unknown> {
    const agent = this.getReconciliationAgent();
    const response = await agent.fetch('http://internal/status');
    return response.json();
  }

  async getHistory(limit = 20): Promise<unknown> {
    const agent = this.getReconciliationAgent();
    const url = new URL('http://internal/history');
    url.searchParams.set('limit', String(limit));

    const response = await agent.fetch(url.toString());
    return response.json();
  }

  async rebuildFromVenue(): Promise<unknown> {
    const agent = this.getReconciliationAgent();
    const response = await agent.fetch('http://internal/rebuild-positions', { method: 'POST' });
    return response.json();
  }
}

