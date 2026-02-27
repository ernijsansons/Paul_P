/**
 * Paul P - Environment Types
 * All Cloudflare bindings for the Paul P trading system
 */

import type { D1Database, R2Bucket, KVNamespace, Queue, DurableObjectNamespace } from '@cloudflare/workers-types';

export interface Env {
  // Environment variables
  ENVIRONMENT: string;
  SYSTEM_NAME: string;

  // Primary D1 Database
  DB: D1Database;

  // Anchor D1 Database (separate, write-only from AuditReporterAgent)
  DB_ANCHOR: D1Database;

  // R2 Buckets
  R2_AUDIT: R2Bucket;
  R2_EVIDENCE: R2Bucket;

  // KV Cache
  KV_CACHE: KVNamespace;

  // Queues
  QUEUE_INGESTION: Queue;
  QUEUE_SIGNALS: Queue;
  QUEUE_ORDERS: Queue;
  QUEUE_PAIRING: Queue;

  // Durable Objects
  PAUL_P_ORCHESTRATOR: DurableObjectNamespace;
  RESEARCH_AGENT: DurableObjectNamespace;
  MARKET_DATA_AGENT: DurableObjectNamespace;
  STRATEGY_BONDING: DurableObjectNamespace;
  STRATEGY_WEATHER: DurableObjectNamespace;
  STRATEGY_XVSIGNAL: DurableObjectNamespace;
  STRATEGY_SMARTMONEY: DurableObjectNamespace;
  STRATEGY_RESOLUTION: DurableObjectNamespace;
  RISK_GOVERNOR: DurableObjectNamespace;
  KALSHI_EXEC: DurableObjectNamespace;
  IBKR_EXEC: DurableObjectNamespace;
  RECONCILIATION: DurableObjectNamespace;
  AUDIT_REPORTER: DurableObjectNamespace;
  COMPLIANCE: DurableObjectNamespace;

  // Workers AI
  AI: Ai;

  // Secrets (set via wrangler secret put)
  KALSHI_API_KEY: string;
  KALSHI_PRIVATE_KEY: string;
  ANTHROPIC_API_KEY: string;
  MINIMAX_API_KEY?: string;    // Optional: MiniMax M2.5 for scanner fastpath
  MOONSHOT_API_KEY?: string;   // Optional: Kimi K2.5 for scanner fastpath
  GOOGLE_AI_API_KEY?: string;  // Optional: Gemini for scanner fastpath
  LLM_ROUTING_FORCE_MODEL?: string;
  LLM_ROUTING_FORCE_ROUTE_CLASS?: string;
  IBKR_USERNAME?: string;
  IBKR_PASSWORD?: string;
  IBKR_GATEWAY_URL?: string;
  IBKR_ACCOUNT_ID?: string;
  NOAA_CDO_TOKEN?: string;
  ADMIN_TOKEN?: string; // For admin routes authentication
}

// Result type for operations that can fail
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function Ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function Err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// Common error types
export interface PaulPError {
  code: string;
  message: string;
  context?: Record<string, unknown>;
  timestamp: string;
}

export function createError(code: string, message: string, context?: Record<string, unknown>): PaulPError {
  return {
    code,
    message,
    context,
    timestamp: new Date().toISOString(),
  };
}

// ============================================================
// SCOPED ENV INTERFACES (P-21 Key Scope Separation)
// Use these for compile-time enforcement of key scope separation
// ============================================================

/**
 * Environment bindings for research/LLM agents
 * NO trading credentials - only AI/LLM access
 */
export interface ResearchEnv {
  ENVIRONMENT: string;
  SYSTEM_NAME: string;
  DB: D1Database;
  R2_EVIDENCE: R2Bucket;
  KV_CACHE: KVNamespace;
  AI: Ai;
  // LLM Provider API Keys
  ANTHROPIC_API_KEY: string;
  MINIMAX_API_KEY?: string;    // Optional: MiniMax M2.5 for scanner fastpath
  MOONSHOT_API_KEY?: string;   // Optional: Kimi K2.5 for scanner fastpath
  GOOGLE_AI_API_KEY?: string;  // Optional: Gemini for scanner fastpath
  LLM_ROUTING_FORCE_MODEL?: string;
  LLM_ROUTING_FORCE_ROUTE_CLASS?: string;
  // Durable Objects needed for research
  RESEARCH_AGENT: DurableObjectNamespace;
  AUDIT_REPORTER: DurableObjectNamespace;
  COMPLIANCE: DurableObjectNamespace;
}

/**
 * Environment bindings for trading/execution agents
 * NO LLM credentials - only trading access
 */
export interface TradingEnv {
  ENVIRONMENT: string;
  SYSTEM_NAME: string;
  DB: D1Database;
  R2_AUDIT: R2Bucket;
  KV_CACHE: KVNamespace;
  KALSHI_API_KEY: string;
  KALSHI_PRIVATE_KEY: string;
  IBKR_USERNAME?: string;
  IBKR_PASSWORD?: string;
  // Durable Objects needed for trading
  RISK_GOVERNOR: DurableObjectNamespace;
  KALSHI_EXEC: DurableObjectNamespace;
  IBKR_EXEC: DurableObjectNamespace;
  RECONCILIATION: DurableObjectNamespace;
  AUDIT_REPORTER: DurableObjectNamespace;
}

/**
 * Environment bindings for data ingestion agents
 * Read-only data access, no trading or LLM credentials
 */
export interface IngestionEnv {
  ENVIRONMENT: string;
  SYSTEM_NAME: string;
  DB: D1Database;
  R2_EVIDENCE: R2Bucket;
  KV_CACHE: KVNamespace;
  QUEUE_INGESTION: Queue;
  // Durable Objects needed for ingestion
  MARKET_DATA_AGENT: DurableObjectNamespace;
  COMPLIANCE: DurableObjectNamespace;
  AUDIT_REPORTER: DurableObjectNamespace;
}

/**
 * Environment bindings for audit/compliance agents
 * Read-only access to audit infrastructure
 */
export interface AuditEnv {
  ENVIRONMENT: string;
  SYSTEM_NAME: string;
  DB: D1Database;
  DB_ANCHOR: D1Database;
  R2_AUDIT: R2Bucket;
  R2_EVIDENCE: R2Bucket;
  KV_CACHE: KVNamespace;
  AUDIT_REPORTER: DurableObjectNamespace;
  COMPLIANCE: DurableObjectNamespace;
}

/**
 * Type guard to extract ResearchEnv from full Env
 * Use this when passing env to research-only code
 */
export function asResearchEnv(env: Env): ResearchEnv {
  return {
    ENVIRONMENT: env.ENVIRONMENT,
    SYSTEM_NAME: env.SYSTEM_NAME,
    DB: env.DB,
    R2_EVIDENCE: env.R2_EVIDENCE,
    KV_CACHE: env.KV_CACHE,
    AI: env.AI,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    MINIMAX_API_KEY: env.MINIMAX_API_KEY,
    MOONSHOT_API_KEY: env.MOONSHOT_API_KEY,
    GOOGLE_AI_API_KEY: env.GOOGLE_AI_API_KEY,
    LLM_ROUTING_FORCE_MODEL: env.LLM_ROUTING_FORCE_MODEL,
    LLM_ROUTING_FORCE_ROUTE_CLASS: env.LLM_ROUTING_FORCE_ROUTE_CLASS,
    RESEARCH_AGENT: env.RESEARCH_AGENT,
    AUDIT_REPORTER: env.AUDIT_REPORTER,
    COMPLIANCE: env.COMPLIANCE,
  };
}

/**
 * Type guard to extract TradingEnv from full Env
 * Use this when passing env to trading-only code
 */
export function asTradingEnv(env: Env): TradingEnv {
  return {
    ENVIRONMENT: env.ENVIRONMENT,
    SYSTEM_NAME: env.SYSTEM_NAME,
    DB: env.DB,
    R2_AUDIT: env.R2_AUDIT,
    KV_CACHE: env.KV_CACHE,
    KALSHI_API_KEY: env.KALSHI_API_KEY,
    KALSHI_PRIVATE_KEY: env.KALSHI_PRIVATE_KEY,
    IBKR_USERNAME: env.IBKR_USERNAME,
    IBKR_PASSWORD: env.IBKR_PASSWORD,
    RISK_GOVERNOR: env.RISK_GOVERNOR,
    KALSHI_EXEC: env.KALSHI_EXEC,
    IBKR_EXEC: env.IBKR_EXEC,
    RECONCILIATION: env.RECONCILIATION,
    AUDIT_REPORTER: env.AUDIT_REPORTER,
  };
}
