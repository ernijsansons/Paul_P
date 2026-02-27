# Paul P Service Level Objectives (SLO)

**Version:** 1.1.0  
**Last Updated:** 2026-02-27

## Summary

| Subsystem | Metric | Target | Measurement |
|-----------|--------|--------|-------------|
| Market Data | Freshness | < 5 min | Market sync timestamps |
| Reconciliation | Lag | < 15 min | Reconciliation heartbeat |
| Order Execution | Latency | < 10 sec | Signal-to-submit latency |
| Audit Chain | Integrity | 100% | Chain verification |
| LLM Regression | Pass Rate | >= 90% | Regression sweep results |
| LLM Routing | Success Rate | >= 99% | `llm_routing_decisions` |
| LLM Routing | Budget Utilization | below alert threshold | `llm_budget_usage` |
| LLM Routing | P99 Latency | by route class | `llm_routing_decisions` |

## LLM Routing SLOs

### Success Rate

- SLI: successful routed calls / total routed calls
- Target: >= 99% over 1 hour
- Source: `llm_routing_decisions.success`

Response when breached:

1. Check provider/API status.
2. Review fallback activity.
3. Verify override misconfiguration is not active.

### Budget Utilization

- SLI: consumed / limit by budget category
- Thresholds are category-specific (alert before 100% hard cap)
- Source: `llm_budget_usage`

Response when breached:

1. Review route mix and call volume changes.
2. Recompute derived envelope assumptions in `routing.budget.ts`.
3. Deploy updated assumptions when justified.

### Latency by Route Class

| Route Class | P99 Target |
|-------------|------------|
| `premium_cognition` | < 60s |
| `scanner_fastpath` | < 10s |
| `synthesis_long_context` | < 120s |
| `cheap_enrichment` | < 30s |

`deterministic_hard_control` is no-LLM and therefore excluded from LLM latency SLO.

## Control Notes

- Hard-risk veto logic remains deterministic and is not governed by LLM routing latency/SLA.
- LLM routing applies to analysis/enrichment/explanation paths only.

## Review Cadence

- Weekly: SLO performance review
- Monthly: threshold review
- Quarterly: DR drill + SLO calibration
