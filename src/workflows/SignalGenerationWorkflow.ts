/**
 * Paul P - Signal Generation Workflow
 *
 * Wraps signal scan and execution phases exposed by the orchestrator.
 */

import type { Env } from '../types/env';

export interface SignalWorkflowRunResult {
  startedAt: string;
  completedAt: string;
  scanResult: unknown;
  executionResult: unknown;
}

export class SignalGenerationWorkflow {
  constructor(private readonly env: Env) {}

  private getOrchestrator() {
    const id = this.env.PAUL_P_ORCHESTRATOR.idFromName('singleton');
    return this.env.PAUL_P_ORCHESTRATOR.get(id);
  }

  async scanSignals(): Promise<unknown> {
    const orchestrator = this.getOrchestrator();
    const response = await orchestrator.fetch('http://internal/cron/scan-signals', {
      method: 'POST',
    });
    return response.json();
  }

  async executeSignals(): Promise<unknown> {
    const orchestrator = this.getOrchestrator();
    const response = await orchestrator.fetch('http://internal/cron/execute-signals', {
      method: 'POST',
    });
    return response.json();
  }

  async run(): Promise<SignalWorkflowRunResult> {
    const startedAt = new Date().toISOString();
    const scanResult = await this.scanSignals();
    const executionResult = await this.executeSignals();

    return {
      startedAt,
      completedAt: new Date().toISOString(),
      scanResult,
      executionResult,
    };
  }
}

