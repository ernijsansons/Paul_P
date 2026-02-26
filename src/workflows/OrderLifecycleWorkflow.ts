/**
 * Paul P - Order Lifecycle Workflow
 *
 * Provides typed access to orchestrator order lifecycle endpoints.
 */

import type { Env } from '../types/env';
import type { OrderLifecycle } from '../lib/execution/workflow';

export interface OrderWorkflowFilters {
  state?: string;
  strategy?: string;
  limit?: number;
}

export interface OrderWorkflowListResponse {
  orders: OrderLifecycle[];
  count: number;
}

export interface OrderWorkflowMetricsResponse {
  metrics: unknown;
}

export class OrderLifecycleWorkflow {
  constructor(private readonly env: Env) {}

  private getOrchestrator() {
    const id = this.env.PAUL_P_ORCHESTRATOR.idFromName('singleton');
    return this.env.PAUL_P_ORCHESTRATOR.get(id);
  }

  async listOrders(filters: OrderWorkflowFilters = {}): Promise<OrderWorkflowListResponse> {
    const orchestrator = this.getOrchestrator();
    const url = new URL('http://internal/workflow/orders');

    if (filters.state) url.searchParams.set('state', filters.state);
    if (filters.strategy) url.searchParams.set('strategy', filters.strategy);
    if (filters.limit !== undefined) url.searchParams.set('limit', String(filters.limit));

    const response = await orchestrator.fetch(url.toString());
    return response.json();
  }

  async getOrder(orderId: string): Promise<{ order: OrderLifecycle }> {
    const orchestrator = this.getOrchestrator();
    const url = new URL('http://internal/workflow/order');
    url.searchParams.set('orderId', orderId);

    const response = await orchestrator.fetch(url.toString());
    return response.json();
  }

  async getMetrics(): Promise<OrderWorkflowMetricsResponse> {
    const orchestrator = this.getOrchestrator();
    const response = await orchestrator.fetch('http://internal/workflow/metrics');
    return response.json();
  }

  async cancelOrder(orderId: string): Promise<{ success: boolean; order: OrderLifecycle }> {
    const orchestrator = this.getOrchestrator();
    const response = await orchestrator.fetch('http://internal/workflow/cancel', {
      method: 'POST',
      body: JSON.stringify({ orderId }),
    });
    return response.json();
  }
}

