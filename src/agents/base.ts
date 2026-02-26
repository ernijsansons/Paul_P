/**
 * Paul P - Base Agent Class
 * All Durable Object agents extend this class
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env';

export abstract class PaulPAgent extends DurableObject<Env> {
  abstract readonly agentName: string;

  protected sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  /**
   * Log an audit event
   */
  protected async logAudit(
    eventType: string,
    payload: Record<string, unknown>,
    evidenceHash?: string
  ): Promise<void> {
    const auditReporterId = this.env.AUDIT_REPORTER.idFromName('singleton');
    const auditReporter = this.env.AUDIT_REPORTER.get(auditReporterId);

    await auditReporter.fetch('http://internal/log', {
      method: 'POST',
      body: JSON.stringify({
        agent: this.agentName,
        eventType,
        payload,
        evidenceHash,
        timestamp: new Date().toISOString(),
      }),
    });
  }

  /**
   * Store raw API response as evidence
   */
  protected async storeEvidence(
    source: string,
    endpoint: string,
    response: ArrayBuffer
  ): Promise<string> {
    const { storeEvidence } = await import('../lib/evidence/store');

    const result = await storeEvidence(this.env, {
      source,
      endpoint,
      rawBytes: response,
      fetchedAt: new Date().toISOString(),
    });

    if (!result.ok) {
      throw new Error(`Failed to store evidence: ${result.error.message}`);
    }

    return result.value.evidenceHash;
  }

  /**
   * Initialize agent-local SQLite tables
   */
  protected async initLocalTables(): Promise<void> {
    // Override in subclasses if needed
  }

  /**
   * Handle HTTP requests to this agent
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      return await this.handleRequest(request, path);
    } catch (error) {
      console.error(`${this.agentName} error:`, error);
      return Response.json(
        {
          error: error instanceof Error ? error.message : String(error),
          agent: this.agentName,
        },
        { status: 500 }
      );
    }
  }

  /**
   * Override this to handle requests
   */
  protected abstract handleRequest(request: Request, path: string): Promise<Response>;
}
