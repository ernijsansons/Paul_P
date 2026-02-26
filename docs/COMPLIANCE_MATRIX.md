# Paul P Compliance Matrix

**Version:** 1.0.0
**Last Updated:** 2026-02-26
**Next Review:** 2026-05-26 (quarterly)

## Overview

This document defines the compliance status, allowed usage, rate limits, and retention rules for each data source. Per blueprint P-23, no data ingestion is permitted from sources with `status != 'approved'`.

## Hard Rules

1. **No scraping without explicit ToS permission** - If ToS does not explicitly permit automated access, source is blocked
2. **Evidence storage required** - All API responses stored as evidence blobs before parsing
3. **ToS snapshots required** - Current ToS stored as evidence blob, re-checked quarterly

---

## Source Compliance Status

### Polymarket Gamma API

| Field | Value |
|-------|-------|
| **Source ID** | `polymarket_gamma_api` |
| **Status** | `APPROVED` |
| **Base URL** | `https://gamma-api.polymarket.com` |
| **Authentication** | None required |
| **ToS Link** | https://polymarket.com/tos |
| **ToS Evidence Hash** | *Populate on first ingestion* |
| **Next ToS Review** | 2026-05-26 |

**Allowed Usage:**
- Market metadata retrieval
- Resolution criteria extraction
- Price and volume monitoring
- Event metadata retrieval

**Rate Limits:**

| Limit Type | Value | Enforcement |
|------------|-------|-------------|
| Requests per second | 10 | Client-side throttle |
| Daily cap | None documented | Monitor usage |

**Retention Rules:**

| Data Type | Max Cache Duration | Raw Storage |
|-----------|-------------------|-------------|
| Market metadata | 24 hours | Allowed |
| Price data | 5 minutes | Allowed |
| Resolution criteria | Indefinite | Required |

---

### Polymarket CLOB API

| Field | Value |
|-------|-------|
| **Source ID** | `polymarket_clob_api` |
| **Status** | `APPROVED` |
| **Base URL** | `https://clob.polymarket.com` |
| **Authentication** | None required |
| **ToS Link** | https://polymarket.com/tos |
| **ToS Evidence Hash** | *Populate on first ingestion* |
| **Next ToS Review** | 2026-05-26 |

**Allowed Usage:**
- Orderbook depth retrieval
- Midpoint/spread monitoring
- Trade history (public)

**Rate Limits:**

| Limit Type | Value | Enforcement |
|------------|-------|-------------|
| Requests per second | 10 | Client-side throttle |

**Retention Rules:**

| Data Type | Max Cache Duration | Raw Storage |
|-----------|-------------------|-------------|
| Orderbook snapshot | 1 minute | Allowed |
| Trade history | 24 hours | Allowed |

---

### Polymarket Data API

| Field | Value |
|-------|-------|
| **Source ID** | `polymarket_data_api` |
| **Status** | `APPROVED` |
| **Base URL** | `https://data-api.polymarket.com` |
| **Authentication** | None required |
| **ToS Link** | https://polymarket.com/tos |
| **ToS Evidence Hash** | *Populate on first ingestion* |
| **Next ToS Review** | 2026-05-26 |

**Allowed Usage:**
- Leaderboard retrieval
- Public profile positions
- Account activity (public)
- PnL data (public)

**Rate Limits:**

| Limit Type | Value | Enforcement |
|------------|-------|-------------|
| Requests per second | 5 | Client-side throttle |
| Batch size | 100 profiles | Per request |

**Retention Rules:**

| Data Type | Max Cache Duration | Raw Storage |
|-----------|-------------------|-------------|
| Account data | 4 hours | Allowed |
| Position data | 1 hour | Allowed |
| Leaderboard | 1 hour | Allowed |

---

### Kalshi Trade API

| Field | Value |
|-------|-------|
| **Source ID** | `kalshi_trade_api` |
| **Status** | `APPROVED` |
| **Base URL** | `https://api.elections.kalshi.com/trade-api/v2` |
| **Authentication** | RSA-PSS (trading endpoints only) |
| **ToS Link** | https://kalshi.com/terms |
| **ToS Evidence Hash** | *Populate on first ingestion* |
| **Next ToS Review** | 2026-05-26 |

**Allowed Usage:**
- Market data (public endpoints)
- Orderbook retrieval
- Trade execution (authenticated)
- Position management (authenticated)

**Rate Limits:**

| Limit Type | Value | Enforcement |
|------------|-------|-------------|
| Public endpoints | 100/min | API enforced |
| Trading endpoints | 60/min | API enforced |
| Cancels | 120/min | API enforced |

**Retention Rules:**

| Data Type | Max Cache Duration | Raw Storage |
|-----------|-------------------|-------------|
| Market data | 5 minutes | Allowed |
| Trade confirmations | Indefinite | Required |
| Position data | 1 hour | Allowed |

---

### NOAA Climate Data Online

| Field | Value |
|-------|-------|
| **Source ID** | `noaa_cdo` |
| **Status** | `APPROVED` |
| **Base URL** | `https://www.ncdc.noaa.gov/cdo-web/api/v2` |
| **Authentication** | API Token required |
| **ToS Link** | https://www.weather.gov/disclaimer |
| **ToS Evidence Hash** | *Populate on first ingestion* |
| **Next ToS Review** | 2026-05-26 |

**Allowed Usage:**
- Historical weather data
- Station observations
- Climate normals

**Rate Limits:**

| Limit Type | Value | Enforcement |
|------------|-------|-------------|
| Requests per second | 5 | Documented limit |
| Daily requests | 1000 | Token-based |

**Retention Rules:**

| Data Type | Max Cache Duration | Raw Storage |
|-----------|-------------------|-------------|
| Historical data | Indefinite | Allowed |
| Observations | 24 hours | Allowed |

---

### NOAA Weather API

| Field | Value |
|-------|-------|
| **Source ID** | `noaa_weather_api` |
| **Status** | `APPROVED` |
| **Base URL** | `https://api.weather.gov` |
| **Authentication** | None required |
| **ToS Link** | https://www.weather.gov/disclaimer |
| **ToS Evidence Hash** | *Populate on first ingestion* |
| **Next ToS Review** | 2026-05-26 |

**Allowed Usage:**
- Forecast data
- Current observations
- Alert data

**Rate Limits:**

| Limit Type | Value | Enforcement |
|------------|-------|-------------|
| Requests per second | 10 | Documented limit |

---

### FRED Economic Data

| Field | Value |
|-------|-------|
| **Source ID** | `fred_api` |
| **Status** | `APPROVED` |
| **Base URL** | `https://api.stlouisfed.org/fred` |
| **Authentication** | API key required |
| **ToS Link** | https://fred.stlouisfed.org/docs/api/terms_of_use.html |
| **ToS Evidence Hash** | *Populate on first ingestion* |
| **Next ToS Review** | 2026-05-26 |

**Allowed Usage:**
- Economic series data
- Release schedules
- Historical data

**Rate Limits:**

| Limit Type | Value | Enforcement |
|------------|-------|-------------|
| Requests per minute | 120 | API enforced |

---

### Polymarket Analytics (Third Party)

| Field | Value |
|-------|-------|
| **Source ID** | `polymarket_analytics` |
| **Status** | `BLOCKED` |
| **Base URL** | `https://polymarketanalytics.com` |
| **Authentication** | N/A |
| **Blocking Reason** | ToS does not explicitly permit automated access |

**Notes:**
- Site uses Goldsky indexing + Gamma API data
- Manual research use only
- Do not automate without written permission

---

## Compliance Enforcement

### Ingestion Pipeline Gate

All data ingestion must check compliance status before proceeding:

```typescript
// Enforced in MarketDataAgent and all ingestion code
async function checkCompliance(sourceId: string): Promise<boolean> {
  const status = await db.query(
    'SELECT status FROM compliance_matrix WHERE source_name = ?',
    [sourceId]
  );
  if (status !== 'approved') {
    await auditLog('COMPLIANCE_BLOCKED', { sourceId, status });
    return false;
  }
  return true;
}
```

### Quarterly Review Process

1. Re-check ToS for all sources
2. Store new ToS snapshot as evidence blob
3. Update `tos_last_verified_at` in `compliance_matrix` table
4. Review any ToS changes for impact on allowed usage
5. Update this document with any changes

---

## Database Schema Reference

```sql
-- From migration 0011_compliance_matrix.sql
CREATE TABLE compliance_matrix (
  id TEXT PRIMARY KEY,
  source_name TEXT UNIQUE NOT NULL,
  source_type TEXT NOT NULL,
  base_url TEXT NOT NULL,
  status TEXT DEFAULT 'pending_review',
  tos_url TEXT,
  tos_hash TEXT,
  tos_last_verified_at TEXT,
  rate_limit_requests_per_sec INTEGER,
  rate_limit_daily_cap INTEGER,
  allowed_usage TEXT,
  retention_rules TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

---

## Revision History

| Date | Version | Change | Author |
|------|---------|--------|--------|
| 2026-02-26 | 1.0.0 | Initial creation | Paul P System |
