# Paul P Architecture

**Version:** 1.0.0  
**Last Updated:** 2026-02-26

## System Overview

Paul P is a Cloudflare-native prediction market research and execution system built with:

- Worker entrypoint (`src/index.ts`) for HTTP routes, queue consumers, and cron routing
- Durable Object agents (`src/agents/*`) for long-lived stateful services
- D1 for relational state and audit metadata
- R2 for immutable evidence and audit payload storage
- KV for short-lived cache and lightweight coordination
- Queues for ingestion, signal, order, and pairing fan-out

## Core Agent Responsibilities

- `PaulPOrchestrator`: cron and lifecycle orchestration, order workflow state
- `MarketDataAgent`: venue ingestion and evidence-first persistence
- `ResearchAgent`: ambiguity scoring, equivalence assessment, pairing approval flow
- `Strategy*Agent`: signal generation by strategy family
- `RiskGovernorAgent`: invariant checks and risk veto/approval
- `KalshiExecAgent` and `IBKRExecAgent`: venue execution and position reads
- `ReconciliationAgent`: position drift detection and recovery workflows
- `AuditReporterAgent`: append-only audit logging and anchoring
- `ComplianceAgent`: source policy checks and compliance exports

## Data Flow

1. Cron triggers ingestion scan via `PaulPOrchestrator`.
2. Ingestion consumers fetch venue data and store raw evidence in R2 before parsing.
3. Strategy agents emit trading signals.
4. Orchestrator creates order lifecycle records and runs validation + risk checks.
5. Execution agents place orders or simulate paper fills.
6. Reconciliation compares internal lifecycle state with venue-reported positions.
7. Audit and compliance trails are written for all critical actions.

## Workflow Modules

Workflow modules in `src/workflows` provide typed orchestration shims over deployed agents:

- `DataIngestionWorkflow`
- `SignalGenerationWorkflow`
- `OrderLifecycleWorkflow`
- `ReconciliationWorkflow`
- `DailyReportWorkflow`
- `StrategyDeploymentWorkflow`
- `MarketPairingWorkflow`

## Storage Model

- D1 primary: strategy state, order lifecycle metadata, invariant checks, governance records
- D1 anchor: audit chain anchor material separated from primary trade state
- R2 evidence: compressed raw API responses, keyed by source/date/hash
- R2 audit: hash-chain payload artifacts and anchor support data

## Security Boundaries

- Research/LLM and trading credentials are separated via scoped environment helpers in `src/types/env.ts`.
- Strategy execution remains fail-closed: invariant or compliance errors block progression.
- Audit integrity is mandatory for go-live and incident closure.
