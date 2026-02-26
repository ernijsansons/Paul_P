# Paul P Security Guide

This document outlines the security controls and best practices for the Paul P autonomous trading system.

## Authentication

### Admin Routes

All admin routes (`/admin/*`) require authentication via one of two methods:

1. **Bearer Token Authentication**
   ```bash
   # Set the admin token
   wrangler secret put ADMIN_TOKEN

   # Use in requests
   curl -H "Authorization: Bearer YOUR_ADMIN_TOKEN" https://paul-p.workers.dev/admin/status
   ```

2. **Cloudflare Access**
   - Configure Cloudflare Access for your Workers domain
   - Authenticated users will have `cf-access-authenticated-user-email` header set
   - Recommended for production deployments

### API Credentials

Store all API credentials as secrets:

```bash
# Required
wrangler secret put KALSHI_API_KEY
wrangler secret put KALSHI_PRIVATE_KEY
wrangler secret put ANTHROPIC_API_KEY

# Optional
wrangler secret put IBKR_USERNAME
wrangler secret put IBKR_PASSWORD
wrangler secret put ADMIN_TOKEN
```

**Never commit secrets to version control.**

## Access Control

### Key Scope Principle

Each API credential should have minimal required permissions:

| Credential | Required Scope | Notes |
|------------|----------------|-------|
| KALSHI_API_KEY | Trading, Read | Full trading access for execution |
| KALSHI_PRIVATE_KEY | Signing | Used for request authentication |
| ANTHROPIC_API_KEY | Chat completions | Used for LLM governance |
| IBKR_* | Trading | If using IBKR for hedging |

### Two-Person Approval

The following operations require two-person approval:

- Strategy go-live approval (`POST /admin/strategies/:id/go-live`)
- Capital allocation increases
- Execution policy changes to live mode

## Data Protection

### Audit Chain Integrity

The audit chain provides tamper-evident logging:

1. All events are hashed with SHA-256
2. Each hash includes the previous event's hash (chain)
3. Chain is anchored to D1_ANCHOR database hourly
4. Raw audit data is stored in R2_AUDIT bucket

**Never modify audit chain entries directly.**

### Evidence Storage

All API responses are stored as evidence before parsing:

1. Raw bytes stored in R2_EVIDENCE
2. SHA-256 hash computed and stored
3. Evidence hash linked to processed data

This enables later verification of data integrity.

### Sensitive Data

The system does NOT store:

- User passwords (external auth only)
- Payment card numbers
- Personal identification numbers

The system DOES store:

- Trading account identifiers
- Position sizes and prices
- API response evidence

## Network Security

### Outbound Connections

The system connects to:

| Destination | Purpose | Protocol |
|-------------|---------|----------|
| api.elections.kalshi.com | Trading API | HTTPS |
| gamma-api.polymarket.com | Market data | HTTPS |
| clob.polymarket.com | CLOB API | HTTPS |
| data-api.polymarket.com | Account data | HTTPS |
| api.anthropic.com | LLM API | HTTPS |

### Cloudflare Workers Security

- All Workers run in isolated V8 isolates
- No direct network access to internal services
- All external calls go through Cloudflare's edge

## Risk Controls

### Fail-Closed Design

All risk invariants are designed to fail-closed:

1. If invariant check fails → block order
2. If compliance check fails → block ingestion
3. If system unhealthy → circuit breaker activates

### Circuit Breaker

States: NORMAL → CAUTION → HALT → RECOVERY

- Consecutive failures trigger state transitions
- HALT state blocks all new positions
- Recovery requires manual approval

### Position Limits

Default limits (configurable via Risk Governor):

- Max position size: 5% of portfolio
- Max concentration: 10% per market
- Max market exposure: 15% (including correlated)
- Max category exposure: 30%
- Max daily loss: 3%
- Max drawdown: 10%

## Compliance

### Data Ingestion Compliance Gate

All data ingestion passes through ComplianceAgent:

1. Entity checks against compliance rules
2. Blocked entities logged to audit trail
3. Fail-closed: compliance check failure = deny

### Market Pair Approval

Cross-venue signals require:

1. LLM equivalence assessment
2. Human review approval
3. Valid equivalence grade (identical/near_equivalent)

## Incident Response

### Monitoring

Key metrics to monitor:

- Circuit breaker state changes
- Risk invariant violations
- Audit chain gaps
- Position drift alerts
- API error rates

### Emergency Procedures

1. **Trading Halt**
   ```bash
   curl -X POST \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -d '{"targetState": "HALT", "reason": "Emergency halt"}' \
     https://paul-p.workers.dev/admin/circuit-breaker/transition
   ```

2. **Position Reconciliation**
   ```bash
   curl -X POST \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     https://paul-p.workers.dev/admin/reconcile
   ```

3. **Audit Chain Verification**
   ```bash
   curl -H "Authorization: Bearer $ADMIN_TOKEN" \
     https://paul-p.workers.dev/admin/audit/status
   ```

## Security Checklist

Before going live:

- [ ] All secrets set via `wrangler secret put`
- [ ] ADMIN_TOKEN is strong (32+ characters)
- [ ] Cloudflare Access configured for admin routes
- [ ] No secrets in wrangler.toml or code
- [ ] Audit chain anchoring verified
- [ ] Position reconciliation working
- [ ] Circuit breaker tested
- [ ] Two-person approval process documented
- [ ] Incident response contacts defined

## Vulnerability Reporting

If you discover a security vulnerability, please report it to the system administrators immediately. Do not disclose publicly until patched.
