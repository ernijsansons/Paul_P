# Phase D: Live Deployment & 10-Day Validation

## Phase D Overview

**Status**: Ready to deploy upon Phase C GO decision
**Duration**: 10 days (proof-of-concept validation)
**Capital**: $250 ($175 Bonding + $75 Weather)
**Execution Mode**: LIVE (real Kalshi orders)
**Success Gates**: Win rate >50%, P&L >$0, Drawdown <15%, no HALT

---

## Pre-Deployment Checklist

### Phase C Completion Verification

- [ ] Phase C execution completed (48 hours)
- [ ] All 8 test scenarios passed (8/8)
- [ ] Win rate ≥ 50% (paper trading)
- [ ] P&L ≥ $0 (paper trading)
- [ ] Execution quality ≥ 80% GOOD/EXCELLENT
- [ ] Circuit breaker working correctly
- [ ] PHASE_C_AUDIT.md populated with all results
- [ ] Phase D go/no-go decision recorded

### Code Deployment Readiness

- [ ] All Phase A-B-C code compiled (npm run build)
- [ ] All Phase A-B-C tests passing (npm run test)
- [ ] Risk Governor Agent deployed and running
- [ ] Position Monitor Agent scheduled (5-min intervals)
- [ ] Execution Policy Agent ready with live order logic
- [ ] Dashboard endpoints tested and responding

### Capital & Account Setup

- [ ] Starting capital transferred to account: $250
- [ ] Execution mode switched from PAPER to LIVE
- [ ] Position limits loaded: 5% max per position ($12.50)
- [ ] Daily loss limit set: 10% = $25 per day
- [ ] Drawdown budget set: 15% = $37.50
- [ ] Strategy capital allocation set: Bonding 70% ($175) + Weather 30% ($75)

### Monitoring & Alerts

- [ ] Slack webhook configured and tested
- [ ] Email alerts enabled for CAUTION/HALT events
- [ ] Daily P&L dashboard accessible
- [ ] Real-time position monitoring available
- [ ] Execution quality reporting enabled
- [ ] Audit trail logging enabled (DEBUG level)

### External Dependencies

- [ ] Kalshi API credentials verified (read/write access)
- [ ] Cloudflare Workers running (D1, R2, KV, Queues operational)
- [ ] Network connectivity confirmed (no VPN/firewall issues)
- [ ] Backup internet connectivity available (mobile hotspot tested)

---

## Deployment Steps (Day 1 - Hour 0)

### Step 1: Final Pre-Deployment Verification (T-0 to T+30min)

```bash
# Verify compilation
npm run build

# Run full test suite
npm run test

# Check database migrations
npm run db:status

# Verify Kalshi API connectivity
curl -H "Authorization: Bearer ${KALSHI_API_KEY}" \
  https://api.kalshi.com/trade-api/v2/markets?limit=1

# Verify capital is $250
sqlite3 paul-p.db "SELECT total_capital FROM accounts WHERE id=1"
```

**Expected Output**:
- ✅ Build succeeds with 0 errors
- ✅ All tests pass (806+)
- ✅ All 20 migrations applied
- ✅ Kalshi API returns market data
- ✅ Account total_capital = 250

**Decision Gate**: If any check fails, DO NOT PROCEED. Remediate and retry.

### Step 2: Switch Execution Mode to LIVE (T+30 to T+45min)

```bash
# Update config to LIVE mode
npm run config:set execution_mode LIVE

# Verify mode switched
npm run config:get execution_mode
# Expected output: LIVE
```

**Important**: This is the point of no return. After this, real orders will be placed.

### Step 3: Deploy Risk Governor Agent (T+45 to T+60min)

```bash
# Deploy with wrangler
npx wrangler deploy

# Verify deployment
npx wrangler tail --format pretty

# Check agent is running
curl http://localhost:8787/agents/risk-governor/status
# Expected: { "status": "running", "state": "NORMAL", "circuit_breaker": "NORMAL" }
```

**Verification**:
- ✅ Deployment succeeds
- ✅ Agent log output shows initialization
- ✅ Status endpoint returns NORMAL state

### Step 4: Start Position Monitor Agent (T+60 to T+75min)

The Position Monitor Agent runs on 5-minute intervals via Cloudflare scheduler (configured in wrangler.toml).

```bash
# Verify schedule is active
grep -A 5 "position-monitor" wrangler.toml

# Check first run in logs
curl http://localhost:8787/agents/position-monitor/status
# Expected: { "open_positions": 0, "checked_at": "..." }
```

### Step 5: Test Dashboard Endpoints (T+75 to T+90min)

```bash
# Test all 4 dashboard endpoints
curl http://localhost:8787/api/dashboard/summary
curl http://localhost:8787/api/dashboard/positions
curl http://localhost:8787/api/dashboard/daily-pnl
curl http://localhost:8787/api/dashboard/execution-quality

# Verify responses are JSON with expected fields
# Expected status: 200 OK for all 4 endpoints
```

### Step 6: Enable Real-Time Alerts (T+90 to T+105min)

```bash
# Test Slack alert
curl -X POST http://localhost:8787/api/alerts/test \
  -H "Content-Type: application/json" \
  -d '{"channel":"slack","message":"Phase D deployment test"}'

# Expected: Alert appears in Slack channel
```

**Verification**:
- ✅ Slack alert received
- ✅ Email alert received
- ✅ Logging active at DEBUG level

### Step 7: Final System Check (T+105 to T+120min)

```bash
# Run comprehensive health check
npm run health-check

# Verify all subsystems operational:
# ✅ Database: Connected
# ✅ Kalshi API: Connected
# ✅ Risk Governor: Running, state=NORMAL
# ✅ Position Monitor: Running, checked 0 open positions
# ✅ Execution: Ready, capital=$250
# ✅ Dashboard: All 4 endpoints responding
# ✅ Alerts: Slack + Email enabled
# ✅ Logging: DEBUG enabled
```

**Decision Gate**: If any subsystem not operational, DO NOT PROCEED.

### Step 8: Deploy and Verify Capital (T+120 to T+135min)

```bash
# Final verification
sqlite3 paul-p.db "SELECT id, total_capital, execution_mode FROM accounts LIMIT 1"
# Expected: { id: 1, total_capital: 250, execution_mode: "LIVE" }

# Verify strategy allocations
sqlite3 paul-p.db "SELECT strategy, allocation FROM strategy_capital"
# Expected:
#   BONDING, 0.70
#   WEATHER, 0.30
```

**Final GO/NO-GO Decision**:
- [ ] GO - All checks passed, system ready for live trading
- [ ] NO-GO - Issue found, do not deploy

---

## 10-Day Validation Window (Day 1 - Day 10)

### Daily Monitoring Checklist

**Each morning (before market open)**:
- [ ] Check circuit breaker state: should be NORMAL
- [ ] Review previous day's P&L
- [ ] Verify position limits not exceeded
- [ ] Check for any alerts overnight
- [ ] Confirm Kalshi API connectivity

**Each afternoon (mid-day)**:
- [ ] Monitor real-time dashboard
- [ ] Check execution quality grade distribution
- [ ] Verify slippage within budget
- [ ] No unexpected position closures

**Each evening (after market close)**:
- [ ] Record daily metrics:
  - [ ] Trades executed: [N]
  - [ ] Win rate today: [X]%
  - [ ] Daily P&L: $[X]
  - [ ] Cumulative P&L: $[X]
  - [ ] Max drawdown so far: [X]%
  - [ ] Circuit breaker events: [N]
- [ ] Review any CAUTION/HALT events
- [ ] Document any anomalies

### Success Criteria Tracking

Track these metrics continuously across 10 days:

| Metric | Target | Day 1 | Day 2 | Day 3 | Day 4 | Day 5 | Day 6 | Day 7 | Day 8 | Day 9 | Day 10 |
|--------|--------|-------|-------|-------|-------|-------|-------|-------|-------|-------|---------|
| **Win Rate %** | >50% | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| **Cumulative P&L** | >$0 | $[ ] | $[ ] | $[ ] | $[ ] | $[ ] | $[ ] | $[ ] | $[ ] | $[ ] | $[ ] |
| **Max Drawdown %** | <15% | [ ]% | [ ]% | [ ]% | [ ]% | [ ]% | [ ]% | [ ]% | [ ]% | [ ]% | [ ]% |
| **Sharpe Ratio** | >1.0 | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| **Execution Grade** | 80%+ GOOD | [ ]% | [ ]% | [ ]% | [ ]% | [ ]% | [ ]% | [ ]% | [ ]% | [ ]% | [ ]% |
| **Avg Slippage** | <30% of edge | [ ]% | [ ]% | [ ]% | [ ]% | [ ]% | [ ]% | [ ]% | [ ]% | [ ]% | [ ]% |
| **CB Halt Count** | 0 | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| **CB False Pos** | 0 | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |

### Contingency Procedures

#### If Win Rate Falls Below 50%

**Timeline**: Continuous monitoring; if <50% after Day 5:

1. Review latest 5 trades for patterns
2. Check signal quality (is it generating profitable signals?)
3. Verify risk controls not triggering falsely
4. Analyze market conditions (regime change?)

**Decision**:
- [ ] Continue (market conditions unusual, edge still valid)
- [ ] Reduce position size to 50% (conservative approach)
- [ ] Halt and investigate (suspect strategy issue)

#### If P&L Turns Negative

**Timeline**: Continuous monitoring; if P&L <-$10:

1. Identify which strategy is underperforming
2. Check for execution slippage issues
3. Review recent position exits (were they correct?)
4. Verify capital allocation is correct

**Decision**:
- [ ] Continue (within normal variance)
- [ ] Reduce allocation to underperforming strategy
- [ ] Switch execution mode to PAPER (diagnostic mode)

#### If Drawdown Exceeds 10%

**Timeline**: Immediate alert; if drawdown >10% after Day 3:

1. This suggests realized variance higher than expected
2. Check if stop-losses are executing correctly
3. Verify position sizing is correct (5% max)

**Decision**:
- [ ] Continue (still within 15% budget, variance expected)
- [ ] Increase stop-loss monitoring
- [ ] Prepare Phase D NO-GO documentation

#### If Circuit Breaker Triggers

**Timeline**: Immediate notification:

1. **CAUTION triggered**: Position sizing reduced to 50%, trading continues
   - Root cause: 2+ losing trades in 1 day, or tail concentration breach
   - Action: Monitor next 24h for recovery; throttled position sizes
   - Expected: Auto-recovery to NORMAL after 24h without further violations

2. **HALT triggered**: All new orders blocked
   - Root cause: 2+ consecutive max-loss days, or continued CAUTION violation
   - Action: Manual review required; cannot resume without operator approval
   - Timeline: Auto-recovery after 60 minutes (configurable)
   - Decision: Allow auto-recovery or investigate manually

3. **False positive** (circuit breaker triggered when not warranted):
   - Document in audit trail
   - If >1 false positive: Switch to PAPER mode and investigate

#### If Slippage Consistently High (>40% of Edge)

**Timeline**: After Day 3 if pattern emerges:

1. Check market conditions:
   - Is Kalshi market less liquid than expected?
   - Are we trading at bad times (low volume hours)?
   - Are we hitting orders at unfavorable prices?

2. Review execution policy:
   - Which limit price method is being used?
   - Is market impact sizing reducing positions too much?
   - Should we use more aggressive pricing?

3. Decision:
   - [ ] Accept higher slippage (market is naturally tight)
   - [ ] Adjust limit price algorithm
   - [ ] Reduce position sizes further
   - [ ] Switch to PAPER if slippage > 50% of edge (kill switch)

### Emergency Stop Procedures

**Stop Loss Trigger** (if drawdown would hit $37.50 limit):

Circuit breaker automatically enters HALT state. No manual intervention needed - this is a fail-closed guardrail.

**Manual Emergency Stop**:

If critical issue detected (e.g., bug causing unlimited losses):

```bash
# Switch to PAPER mode immediately
npm run config:set execution_mode PAPER
npm run config:set circuit_breaker_state HALT

# Alert team
curl -X POST http://localhost:8787/api/alerts/critical \
  -d '{"message":"Emergency halt triggered - manual intervention required"}'
```

---

## Phase D Success Gates (Day 10 Evening)

At the end of Day 10, evaluate against these hard gates:

### Gate 1: Win Rate ≥ 50%
- [ ] PASS - Actual win rate: [X]% (≥50%)
- [ ] FAIL - Actual win rate: [X]% (<50%)

### Gate 2: Cumulative P&L ≥ $0
- [ ] PASS - Actual P&L: $[X] (≥$0)
- [ ] FAIL - Actual P&L: $[X] (<$0)

### Gate 3: Max Drawdown ≤ 15%
- [ ] PASS - Actual drawdown: [X]% (≤15%)
- [ ] FAIL - Actual drawdown: [X]% (>15%)

### Gate 4: Execution Quality ≥ 80% GOOD/EXCELLENT
- [ ] PASS - Actual quality: [X]% (≥80%)
- [ ] FAIL - Actual quality: [X]% (<80%)

### Gate 5: Circuit Breaker No False Positives
- [ ] PASS - All triggers legitimate
- [ ] FAIL - [N] false positives detected

### Gate 6: No Critical Errors
- [ ] PASS - Zero unhandled exceptions
- [ ] FAIL - [N] critical errors in logs

---

## Phase D Completion Decision

### GO Decision (Proceed to Phase E - Scaling)

If ALL 6 gates PASS:

**Decision**: ✅ GO TO PHASE E

**Next Steps**:
1. Day 11: Scale capital to $500 (2x multiplier)
   - Bonding: $350 (up from $175)
   - Weather: $150 (up from $75)
   - Maintain same position sizing (5% max = $25)

2. Days 11-20: Continue live trading at $500 capital with daily monitoring

3. Day 21: If continued success, scale to $1K:
   - Bonding: $700 (70%)
   - Weather: $300 (30%)

4. Day 25+: Open-ended scaling based on performance

### NO-GO Decision (Remediate and Retry)

If ANY gate FAILS:

**Decision**: ❌ NO-GO - Remediation Required

**Required Analysis**:
1. Root cause analysis:
   - Which strategy failed? (Bonding, Weather, or both?)
   - Was edge assumption wrong?
   - Was execution quality too poor?
   - Were controls insufficient?

2. Remediation options:
   - [ ] Increase position limits after improving controls
   - [ ] Switch strategies (deploy different set)
   - [ ] Reduce edge assumptions and recalibrate
   - [ ] Improve execution algorithm
   - [ ] Return to Phase C paper trading and iterate

3. Timeline:
   - Minimal: 1 week for code fixes + 2 weeks for retesting
   - Expected: 2-3 weeks total before retry

---

## Deployment Log Template

```
PHASE D DEPLOYMENT LOG
═══════════════════════════════════════════════════════════

Date: [YYYY-MM-DD]
Operator: [Name]
Phase C Results: [GO/NO-GO/CONDITIONAL]

PRE-DEPLOYMENT CHECKLIST
───────────────────────────────────────────────────────────
Phase C verification: ✓ (all 8 scenarios, >50% WR, >$0 P&L)
Code compilation: ✓ (npm run build)
Test suite: ✓ (npm run test: [N] passed, 0 failed)
Capital verified: ✓ ($250)
Execution mode: ✓ (PAPER→LIVE)
Alerts configured: ✓ (Slack + Email)

DEPLOYMENT TIMELINE
───────────────────────────────────────────────────────────
T+00:00 - Pre-deployment verification started
T+00:30 - Compilation verified ✓
T+00:45 - Execution mode switched to LIVE ✓
T+01:00 - Risk Governor deployed ✓
T+01:15 - Position Monitor running ✓
T+01:30 - Dashboard verified ✓
T+01:45 - Alerts tested ✓
T+02:00 - Final health check passed ✓
T+02:00 - SYSTEM GO FOR LIVE TRADING

LIVE TRADING INITIATED
═══════════════════════════════════════════════════════════
Capital: $250 (Bonding 70% + Weather 30%)
Execution Mode: LIVE
Circuit Breaker: NORMAL
First order expected: [HH:MM UTC]

───────────────────────────────────────────────────────────
Operator Sign-off: _________________ Date: _______________
```

---

## Key Contacts & Resources

**Kalshi Support**:
- Email: support@kalshi.com
- Status: https://status.kalshi.com

**Cloudflare Status**:
- Dashboard: https://dash.cloudflare.com
- Status: https://status.cloudflare.com

**Emergency Procedures**:
- Critical issue: Switch execution_mode to PAPER immediately
- Lost connectivity: Wait 30 min for auto-recovery, then manual restart
- Uncertain decision: Consult Phase D playbook or escalate

---

**Phase D Deployment Ready**: ✅

Upon Phase C GO decision, follow deployment steps above to go live with $250 capital.

Expected Phase D completion: Day 10 evening with scale/no-scale decision.
