/**
 * Paul P - Daily Report Workflow
 *
 * Triggers report generation and renders a deterministic text report body.
 */

import type { Env } from '../types/env';

export interface DailyReportMetrics {
  date: string;
  ordersCreated: number;
  ordersFilled: number;
  avgCLV: number;
}

export interface DailyReportRunResult {
  generatedAt: string;
  rawResponse: unknown;
  renderedReport: string;
}

export class DailyReportWorkflow {
  constructor(private readonly env: Env) {}

  private getOrchestrator() {
    const id = this.env.PAUL_P_ORCHESTRATOR.idFromName('singleton');
    return this.env.PAUL_P_ORCHESTRATOR.get(id);
  }

  async run(): Promise<DailyReportRunResult> {
    const orchestrator = this.getOrchestrator();
    const response = await orchestrator.fetch('http://internal/cron/daily-report', {
      method: 'POST',
    });
    const rawResponse = await response.json();

    const metrics = this.extractMetrics(rawResponse);
    return {
      generatedAt: new Date().toISOString(),
      rawResponse,
      renderedReport: this.formatReport(metrics),
    };
  }

  formatReport(metrics: DailyReportMetrics): string {
    const fillRate = metrics.ordersCreated > 0
      ? (metrics.ordersFilled / metrics.ordersCreated) * 100
      : 0;

    return [
      '=== PAUL P DAILY REPORT ===',
      `Date: ${metrics.date}`,
      `Orders Created: ${metrics.ordersCreated}`,
      `Orders Filled: ${metrics.ordersFilled}`,
      `Fill Rate: ${fillRate.toFixed(2)}%`,
      `Average CLV: ${metrics.avgCLV.toFixed(4)}`,
    ].join('\n');
  }

  private extractMetrics(rawResponse: unknown): DailyReportMetrics {
    const fallbackDate = new Date().toISOString().slice(0, 10);

    if (
      rawResponse &&
      typeof rawResponse === 'object' &&
      'metrics' in rawResponse &&
      rawResponse.metrics &&
      typeof rawResponse.metrics === 'object'
    ) {
      const metrics = rawResponse.metrics as Partial<DailyReportMetrics>;
      return {
        date: typeof metrics.date === 'string' ? metrics.date : fallbackDate,
        ordersCreated: typeof metrics.ordersCreated === 'number' ? metrics.ordersCreated : 0,
        ordersFilled: typeof metrics.ordersFilled === 'number' ? metrics.ordersFilled : 0,
        avgCLV: typeof metrics.avgCLV === 'number' ? metrics.avgCLV : 0,
      };
    }

    return {
      date: fallbackDate,
      ordersCreated: 0,
      ordersFilled: 0,
      avgCLV: 0,
    };
  }
}

