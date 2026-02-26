# Paul P Service Level Objectives (SLOs)

**Version:** 1.0.0
**Last Updated:** 2026-02-26

## Overview

This document defines Service Level Objectives for each Paul P subsystem per blueprint P-24. These thresholds trigger alerts and potential circuit breaker activation when violated.

---

## SLO Summary Table

| Subsystem | Metric | Threshold | Measurement | Alert Severity |
|-----------|--------|-----------|-------------|----------------|
| Market Data | Freshness | < 5 min | Cron check | High |
| Reconciliation | Lag | < 15 min | Heartbeat | Critical |
| Order Execution | Latency | < 10 sec | Timestamp delta | High |
| API Availability | Error Rate | < 5% 5xx/hour | Exec agent counters | Medium |
| Audit Chain | Integrity | 100% | Hourly verification | Critical |
| Daily Report | Delivery | By 23:30 UTC | Cron + Slack | Low |
| LLM Scoring | Regression Pass Rate | >= 90% | Nightly sweep | High |

---

## Detailed SLO Specifications

### 1. Market Data Freshness

**Objective:** Market data for all active strategies must be no more than 5 minutes stale.

| Attribute | Value |
|-----------|-------|
| SLI | Age of most recent price update per active market |
| Threshold | 300 seconds |
| Measurement | `datetime('now') - last_synced_at` from `markets` table |
| Invariant | I14 (PRICE_STALENESS) |
| Alert Channel | Slack #paul-p-alerts |

**Breach Response:**
1. Circuit breaker enters CAUTION state
2. Pause signal generation for affected strategies
3. Retry data fetch with exponential backoff
4. If stale > 15 minutes, enter HALT state

---

### 2. Reconciliation Lag

**Objective:** Position reconciliation must complete successfully every 15 minutes.

| Attribute | Value |
|-----------|-------|
| SLI | Time since last successful reconciliation |
| Threshold | 900 seconds |
| Measurement | ReconciliationAgent heartbeat timestamp |
| Invariant | I6 (POSITION_DRIFT) |
| Alert Channel | Slack #paul-p-alerts |

**Breach Response:**
1. Immediate alert to operator
2. Circuit breaker enters CAUTION state
3. Block new position creation
4. If > 30 minutes, enter HALT state and cancel all open orders

---

### 3. Order Execution Latency

**Objective:** Time from signal generation to order submission must be under 10 seconds.

| Attribute | Value |
|-----------|-------|
| SLI | `order_submitted_at - signal_generated_at` |
| Threshold | 10,000 milliseconds |
| Measurement | Timestamp delta in order lifecycle |
| Alert Channel | Slack #paul-p-alerts |

**Breach Response:**
1. Log latency to audit trail
2. If p95 latency > 10s over 1 hour, alert operator
3. Review queue depths and consumer throughput

---

### 4. API Availability

**Objective:** External API error rate must stay below 5% per hour per venue.

| Attribute | Value |
|-----------|-------|
| SLI | Count of 5xx errors / total requests per venue |
| Threshold | 5% |
| Measurement | Exec agent request counters |
| Window | 1 hour rolling |
| Alert Channel | Slack #paul-p-alerts |

**Breach Response:**
1. Circuit breaker enters CAUTION for affected venue
2. If > 20% error rate, HALT trading on that venue
3. Check venue status page for known outages

---

### 5. Audit Chain Integrity

**Objective:** Audit chain must be 100% intact with no gaps or hash mismatches.

| Attribute | Value |
|-----------|-------|
| SLI | Chain verification result |
| Threshold | Zero tolerance - 100% integrity required |
| Measurement | Hourly chain walk + anchor verification |
| Invariant | I17 (AUDIT_CHAIN_INTEGRITY) |
| Alert Channel | Slack #paul-p-critical |

**Breach Response:**
1. Immediate HALT state
2. Page on-call operator
3. Preserve all evidence
4. Do not resume trading until root cause identified

---

### 6. Daily Report Delivery

**Objective:** Daily performance report must be delivered by 23:30 UTC.

| Attribute | Value |
|-----------|-------|
| SLI | Report delivery timestamp |
| Threshold | 23:30 UTC |
| Measurement | Slack message timestamp |
| Alert Channel | Slack #paul-p-alerts |

**Breach Response:**
1. Check DailyReportWorkflow status
2. Manual trigger if stuck
3. Not a trading blocker, but document cause

---

### 7. LLM Regression Pass Rate

**Objective:** LLM prompt regression tests must pass at >= 90% rate.

| Attribute | Value |
|-----------|-------|
| SLI | Passed tests / total tests |
| Threshold | 90% |
| Measurement | Nightly drift sweep results |
| Table | `llm_drift_sweeps` |
| Alert Channel | Slack #paul-p-alerts |

**Breach Response:**
1. Block deployment of new prompt version
2. Review failing test cases
3. If live prompt affected, disable Resolution Mispricing strategy

---

## Invariant to SLO Mapping

| Invariant | SLO | Description |
|-----------|-----|-------------|
| I1 | Max Position Size | Position size ≤ 3% of portfolio |
| I2 | Max Concentration | Single market ≤ 10% exposure |
| I3 | Max Market Exposure | Direct + correlated ≤ 15% |
| I4 | Max Category Exposure | Single category ≤ 25% |
| I5 | Max Daily Loss | Daily PnL ≤ -3% |
| I6 | Max Drawdown | Drawdown ≤ 10% |
| I7 | Max Weekly Loss | Weekly PnL ≤ -5% |
| I8 | Min Liquidity | 24h volume ≥ $5,000 |
| I9 | Max VPIN | VPIN ≤ 0.6 |
| I10 | Max Spread | Spread ≤ 10% |
| I11 | Min Time to Settlement | Hours ≥ 24 |
| I12 | Equivalence Grade | Approved grades only |
| I13 | Max Ambiguity | Score ≤ 0.4 |
| I14 | Price Staleness | Data age ≤ 60s |
| I15 | Order Size Limits | $10 ≤ size ≤ $10,000 |
| I16 | Circuit Breaker | Not in HALT |
| I17 | System Health | All critical systems healthy |

---

## Disaster Recovery SLOs

Per blueprint P-24, Recovery Point Objectives (RPO) and Recovery Time Objectives (RTO):

| Component | RPO | RTO | Backup Method |
|-----------|-----|-----|---------------|
| D1 Primary | 24 hours | 1 hour | CF automatic + daily R2 export |
| D1 Anchor | 1 hour | 30 min | Separate account |
| R2 Audit | 0 (immutable) | 1 hour | Write-once |
| R2 Evidence | 0 (immutable) | 1 hour | Compressed, deduplicated |
| KV Cache | N/A (ephemeral) | < 5 min | Auto-rebuild from API |
| DO SQLite | 5 min | 15 min | DO persistence + reconciliation |

---

## SLO Dashboard Queries

### Market Data Freshness
```sql
SELECT
  market_slug,
  strftime('%s', 'now') - strftime('%s', last_synced_at) AS staleness_sec
FROM markets
WHERE status = 'active'
ORDER BY staleness_sec DESC
LIMIT 10;
```

### Reconciliation Health
```sql
SELECT
  strftime('%s', 'now') - strftime('%s', last_run_at) AS lag_sec,
  status,
  drift_count
FROM reconciliation_runs
ORDER BY last_run_at DESC
LIMIT 1;
```

### Order Execution Latency (p95)
```sql
SELECT
  strategy_id,
  AVG(strftime('%s', submitted_at) - strftime('%s', signal_generated_at)) AS avg_latency_sec
FROM orders
WHERE created_at > datetime('now', '-1 hour')
GROUP BY strategy_id;
```

### API Error Rate
```sql
SELECT
  venue,
  SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) AS error_rate_pct
FROM api_requests
WHERE created_at > datetime('now', '-1 hour')
GROUP BY venue;
```

---

## SLO Review Schedule

| Review Type | Frequency | Participants |
|-------------|-----------|--------------|
| SLO threshold review | Monthly | Engineering |
| SLO performance review | Weekly | Engineering |
| DR drill | Quarterly | Engineering + Ops |

---

## Revision History

| Date | Version | Change | Author |
|------|---------|--------|--------|
| 2026-02-26 | 1.0.0 | Initial creation | Paul P System |
