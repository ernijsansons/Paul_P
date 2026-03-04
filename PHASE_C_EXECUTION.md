# Phase C: Execution Timeline (48 Hours)

## Executive Summary

This document provides a **minute-by-minute execution timeline** for Phase C paper trading validation. The test harness executes 30 paper trades (20 Bonding + 10 Weather) and validates all 8 risk control scenarios over a **48-hour continuous window**.

**Start Date/Time**: [User to fill in]
**Expected End Date/Time**: [+48 hours from start]
**Critical Checkpoint**: Hour 24 (midpoint - verify system stability)
**Final Checkpoint**: Hour 48 (complete audit before Phase D decision)

---

## Pre-Execution Checklist (T-60 minutes)

### System Verification (15 min)
- [ ] Database migrations applied: `npm run db:migrate`
- [ ] Phase A compilation verified: `npm run lint` (0 errors expected)
- [ ] Phase B tests passing: `npm test -- test/lib/execution/` (70/70 tests)
- [ ] Test infrastructure loaded: paper-harness.ts, run-phase-c-tests.ts
- [ ] Validation queries ready: phase-c-validation.sql (8 groups, 30+ queries)

### Configuration Verification (15 min)
- [ ] Capital set to $250 (verify in .env or config)
- [ ] Risk limits loaded: max daily loss $7.50 (3%), max DD 15%
- [ ] Position limits: max $12.50 per trade (5% of capital)
- [ ] Execution mode: PAPER (verify in code)
- [ ] Test scenarios: All 8 defined in paper-harness.ts

### Infrastructure Verification (15 min)
- [ ] Database accessible: test D1 connection
- [ ] Kalshi API credentials loaded and tested
- [ ] Logging enabled: console logs visible
- [ ] Monitoring dashboard accessible (if applicable)
- [ ] No active network errors or connectivity issues

### Final Sanity Checks (15 min)
- [ ] Test harness dry-run: `node scripts/run-phase-c-tests.ts --dry-run`
- [ ] Validation SQL test: Execute 1 query from phase-c-validation.sql
- [ ] Alert system ready: Slack/email notifications configured
- [ ] Audit trail initialized: audit_log table accessible

**Gate**: All 60 checks PASS → Proceed to Hour 0

---

## Hour-by-Hour Execution Timeline

### **HOURS 0-1: System Startup & Initial Validation**

**Hour 0:00 - 0:15: System Boot**
- [ ] Timestamp: Start Phase C execution
- [ ] Initialize paper trading session
- [ ] Load all test scenarios into memory
- [ ] Verify portfolio starting value: $250
- [ ] Check circuit breaker state: NORMAL
- [ ] Log: "Phase C execution started, session ID: [session-id]"

**Action**: None - System initialization

**Hour 0:15 - 0:30: Market Data Snapshot**
- [ ] Fetch current prices for test markets (Bonding, Weather)
- [ ] Record market conditions: spreads, VPIN, depth
- [ ] Store baseline snapshot in database
- [ ] Verify price feed connectivity
- [ ] Log: "Market snapshot captured at [timestamp]"

**Action**: None - Observation only

**Hour 0:30 - 0:45: Risk Limits Verification**
- [ ] Confirm all 17 risk invariants active
- [ ] Verify Phase A limits loaded (stop-loss -3%, TP +50%)
- [ ] Verify circuit breaker timeouts configured (60 min)
- [ ] Verify tail concentration limit (Herfindahl < 0.3)
- [ ] Run one test invariant check: should PASS

**Action**: None - Configuration verification

**Hour 0:45 - 1:00: First Paper Trade Execution**
- [ ] **Trade 1 (Bonding)**: Signal generated, order submitted
- [ ] Verify order: Correct size ($12.50), correct limit price
- [ ] Record: Entry price, limit price, market conditions at submit time
- [ ] Expected outcome: ACCEPTED (paper trade only, no real capital)
- [ ] Log: "Trade 1 submitted: Bonding, size 25 contracts, limit 50.5"

**Gate at Hour 1**: System operational, market feed live, first trade submitted successfully

---

### **HOURS 1-12: Initial Trading Phase (Bonding Focus)**

**Pattern for Bonding Trades 2-10** (9 trades over 11 hours, ~1 per 1.2 hours):

**Each Trade Execution (15 min cycle per trade):**
- [ ] T+0 min: Signal generated, check risk invariants
- [ ] T+5 min: Order submitted to paper execution engine
- [ ] T+10 min: Fill recorded, entry price logged
- [ ] T+15 min: Position monitor starts tracking for stops/TP

**Key Checkpoints Every 2 Trades:**
- [ ] Win rate trending (target: >70% by Hour 6)
- [ ] Daily P&L trending (target: +$2-5 by Hour 6)
- [ ] No circuit breaker triggers yet (NORMAL state)
- [ ] All positions have correct stop-loss at entry * 0.97

**Typical Trade Details:**
- Bonding edge: 2-4 cents
- Expected win rate: 80%+
- Expected execution grade: GOOD/EXCELLENT
- Risk per trade: -$12.50 worst case (stop-loss hit)

**Hour 6 Checkpoint** ⚠️:
- [ ] Trades 1-5 complete (5 positions open or closed)
- [ ] Win rate: Should be 4/5 or 5/5 (target: >80%)
- [ ] P&L: Should be +$4-8 cumulative
- [ ] Daily loss: Should be near $0 (low variance so far)
- [ ] **Gate**: If win rate < 60% or P&L < -$5, escalate for review

**Hour 12 Checkpoint**:
- [ ] Trades 1-10 complete
- [ ] 9 Bonding trades executed (1 slot for potential retry/adjustment)
- [ ] Cumulative P&L: Target +$15-25
- [ ] Win rate: Target >75%
- [ ] Circuit breaker state: NORMAL (no violations yet)

---

### **HOURS 12-24: Full Day / Mid-Point Review**

**Hour 12-18: Continue Bonding + Introduce Weather**

**Bonding Trades 11-15** (5 trades):
- Spread across 6 hours
- Continue tracking stops and P&L
- Monitor for any tail concentration issues

**Weather Trades 1-3** (3 trades):
- Start introducing Weather signals (different signal source)
- Weather edge typically: 1-2 cents (lower confidence than Bonding)
- Expected win rate: 50-60% (vs 80%+ for Bonding)
- Each trade size: $12.50 (same position limit)

**Hour 18 Sub-Checkpoint:**
- [ ] Trades 1-18 complete
- [ ] Bonding: 15 trades, expected P&L +$20-30, WR ~80%
- [ ] Weather: 3 trades, expected P&L -$2 to +$2, WR ~50%
- [ ] Combined P&L: +$20-28
- [ ] Daily loss: ~0% (below $7.50 limit)

**Hour 18-24: Continue Mixed Trading**

**Bonding Trades 16-20** (5 trades):
- Final batch of Bonding trades
- Total: 20 Bonding trades by Hour 24

**Weather Trades 4-7** (4 trades):
- Continue Weather diversification
- Accumulate data on Weather signal quality

**Hour 24 - CRITICAL CHECKPOINT** ⚠️⚠️⚠️

Verify before proceeding to Hour 25:

| Metric | Target | Actual | Status |
|--------|--------|--------|--------|
| **Trades Completed** | 25 (20B + 5W) | _____ | [ ] PASS / [ ] FAIL |
| **Win Rate (Bonding)** | >75% | _____ | [ ] PASS / [ ] FAIL |
| **Win Rate (Weather)** | >50% | _____ | [ ] PASS / [ ] FAIL |
| **Cumulative P&L** | +$20-30 | _____ | [ ] PASS / [ ] FAIL |
| **Daily Loss (Hour 0-24)** | <$7.50 | _____ | [ ] PASS / [ ] FAIL |
| **Max Drawdown (24h)** | <5% | _____ | [ ] PASS / [ ] FAIL |
| **Circuit Breaker** | NORMAL | _____ | [ ] PASS / [ ] FAIL |
| **Tail Concentration** | Herfindahl < 0.3 | _____ | [ ] PASS / [ ] FAIL |
| **Execution Grade** | GOOD/EXCELLENT 80%+ | _____ | [ ] PASS / [ ] FAIL |
| **No Stop-Loss False Positives** | 0 spurious exits | _____ | [ ] PASS / [ ] FAIL |

**Hour 24 Gate Decision:**
- **GO if** 8/10 metrics pass and P&L > $10
- **REVIEW if** 6-7 metrics pass: Analyze gaps
- **STOP if** <6 metrics pass: Debug and restart at Hour 0

**Log**: "Hour 24 checkpoint: [PASS/REVIEW/STOP] - [Summary of key metrics]"

---

### **HOURS 24-36: Second Day / Test Scenario Execution**

**Hour 24-30: Continuous Trading**

**Bonding Trades** (complete, waiting for test scenarios)
**Weather Trades 8-10** (final 3 trades):
- Complete Weather diversification
- Total: 10 Weather trades by Hour 30

**Hour 30-36: Execute All 8 Test Scenarios**

Each scenario runs as a self-contained test sequence:

| Scenario | Focus | Duration | Expected | Gate |
|----------|-------|----------|----------|------|
| S1: Stop-Loss | -3% trigger | 20 min | Exit at stop | Must trigger |
| S2: Take-Profit | +50% trigger | 20 min | Exit at TP | Must trigger |
| S3: Time Exit | 7 day limit | 15 min | Time check | Must evaluate |
| S4: Tail Event | Market drop | 25 min | Circuit response | CAUTION/HALT |
| S5: Kill Switch | Slippage > 50% | 20 min | Market halt | Execution blocked |
| S6: Shallow Market | Size adjustment | 20 min | Reduced position | No execution |
| S7: Circuit Breaker | Double loss day | 30 min | HALT state | Auto-recovery after 1h |
| S8: Tail Concentration | Herfindahl check | 15 min | Rebalance | Position limits enforced |

**Scenario Execution Log**:
```
Hour 30:00 - Start S1: Stop-Loss Test
  Price: 50.50 (entry 50)
  Action: Lower price to 48.50 (50 * 0.97)
  Expected: Position exits at stop-loss
  Result: [PASS/FAIL]
  Time: 0:20

Hour 30:25 - Start S2: Take-Profit Test
  Entry: 50
  Action: Raise price to 75 (50 * 1.50)
  Expected: Position exits at take-profit
  Result: [PASS/FAIL]
  Time: 0:20

[Continue for S3-S8...]
```

**Hour 36 Checkpoint**:
- [ ] All 8 test scenarios executed
- [ ] 8/8 test results recorded
- [ ] Gate: All scenarios must show correct behavior (8/8 PASS required)

---

### **HOURS 36-42: SQL Validation & Data Integrity**

**Hour 36-38: Run Comprehensive SQL Validation Suite**

Execute phase-c-validation.sql with 8 validation groups:

**V1: Position Monitoring** (5 queries, 10 min)
- Verify all stop-loss, TP, time-exit columns populated
- Check position_monitor_events table for correct triggers
- Validate realized P&L calculations

**V2: Tail Concentration** (2 queries, 5 min)
- Check tail_concentration_snapshots table
- Verify Herfindahl index calculations
- Confirm compliance flags set correctly

**V3: Slippage & Kill Switch** (3 queries, 10 min)
- Review slippage_history table
- Verify kill switch thresholds exceeded when needed
- Confirm markets halted when slippage > 50% of edge

**V4: Circuit Breaker** (3 queries, 10 min)
- Check circuit_breaker_history transitions
- Verify HALT timeout logic (60 min auto-recovery)
- Confirm CAUTION throttling applied correctly

**V5: Execution Quality** (3 queries, 10 min)
- Review execution_reports table
- Verify execution grades (EXCELLENT/GOOD/ACCEPTABLE/POOR)
- Check average slippage vs expected

**V6: Position Accounting** (3 queries, 10 min)
- Validate cumulative P&L vs individual position P&L
- Verify win rate calculation (wins / total closed)
- Check max drawdown from peak

**V7: Dashboard Accuracy** (4 queries, 10 min)
- Verify dashboard /summary endpoint metrics
- Check open positions data
- Validate daily P&L aggregates

**V8: Audit Trail** (1 query, 5 min)
- Confirm audit_log entries for all critical events
- Verify signal-to-execution completeness
- Check timestamp ordering

**Hour 38 Checkpoint**:
- [ ] 30+ SQL validation queries executed
- [ ] All 8 validation groups PASS
- [ ] Data integrity verified (no orphaned records)
- [ ] Audit trail complete and correct

---

### **HOURS 42-46: Dashboard Verification**

**Hour 42-43: Dashboard Endpoint Testing**

**Endpoint 1: /dashboard/summary** (15 min)
- [ ] Verify circuit_breaker_state field
- [ ] Check open_position_count
- [ ] Validate cumulative_pnl matches database
- [ ] Check execution_mode (should be PAPER)
- [ ] Verify all_time_win_rate calculation

**Endpoint 2: /dashboard/positions/open** (10 min)
- [ ] List all open positions (should be 0-5 by hour 42)
- [ ] Verify entry_price for each
- [ ] Check current_price is recent
- [ ] Validate unrealized_pnl = (current - entry) * size
- [ ] Confirm time_held_minutes accurate

**Endpoint 3: /dashboard/daily-pnl** (10 min)
- [ ] Verify today's win_rate calculation
- [ ] Check total_wins (should be 15-20 from 30 trades)
- [ ] Validate today_pnl (cumulative P&L)
- [ ] Check position breakdown (Bonding vs Weather)

**Endpoint 4: /dashboard/execution-quality** (10 min)
- [ ] Verify grade distribution (EXCELLENT/GOOD/ACCEPTABLE/POOR)
- [ ] Check average_slippage metric
- [ ] Validate average_grade_score (target 3.0+ = GOOD avg)
- [ ] Confirm kill_switch_triggered flag (should be 0 or documented)

**Hour 44-46: Manual Visual Verification**

- [ ] Review position history in database (sanity check)
- [ ] Spot-check 5 random trades:
  - [ ] Entry price correct
  - [ ] Exit price (if closed) correct
  - [ ] Stop-loss position correct
  - [ ] P&L calculated correctly
- [ ] Check for any SQL errors in logs
- [ ] Verify no data corruption

---

### **HOURS 46-48: Final Report & Phase D Gate Decision**

**Hour 46-47: Generate Phase C Audit Report**

Use PHASE_C_AUDIT.md template to document:

1. **Execution Log**
   - [ ] Timestamp of every trade (30 trades)
   - [ ] Signal source (Bonding or Weather)
   - [ ] Entry price, exit price, realized P&L
   - [ ] Any stop-loss / take-profit / time-exit triggers

2. **Test Scenario Results** (8 scenarios)
   - [ ] S1: Stop-Loss Hit - [PASS/FAIL]
   - [ ] S2: Take-Profit Hit - [PASS/FAIL]
   - [ ] S3: Time-Based Exit - [PASS/FAIL]
   - [ ] S4: Tail Event - [PASS/FAIL]
   - [ ] S5: Kill Switch - [PASS/FAIL]
   - [ ] S6: Shallow Market - [PASS/FAIL]
   - [ ] S7: Circuit Breaker - [PASS/FAIL]
   - [ ] S8: Tail Concentration - [PASS/FAIL]

3. **Risk Control Validation**
   - [ ] Per-position stops enforced: _____ / 30 trades
   - [ ] Take-profit locks engaged: _____ / (position hits)
   - [ ] Time-based exits correct: _____ / (7+ day positions)
   - [ ] Circuit breaker false positives: _____
   - [ ] Tail concentration violations: _____
   - [ ] Kill switch false positives: _____

4. **Success Metrics Summary**
   - [ ] Total Trades: 30 executed
   - [ ] Win Rate: ____% (target >50%)
   - [ ] Cumulative P&L: $_____ (target >$0)
   - [ ] Max Drawdown: ____% (target <15%)
   - [ ] Execution Grade Avg: _____ (target GOOD+)

**Hour 47-48: Phase D Go/No-Go Decision**

**PASS Criteria** (All must be met):
1. ✅ 30/30 trades executed without system crash
2. ✅ 8/8 test scenarios passed
3. ✅ Win rate > 50% (actual: ____%)
4. ✅ Cumulative P&L > $0 (actual: $____)
5. ✅ Max drawdown < 15% (actual: ___%)
6. ✅ No circuit breaker false positives
7. ✅ All 17 risk invariants enforced correctly
8. ✅ SQL validation 100% pass (30+ queries)
9. ✅ Dashboard endpoints accurate
10. ✅ Audit trail complete and verifiable

**Decision Tree:**

```
IF (all 10 criteria PASS) THEN
  DECISION = "GO TO PHASE D"
  Action: Deploy to LIVE mode with $250
  Deploy: Bonding (70%) + Weather (30%)
  Start: 10-day validation window

ELSE IF (7-9 criteria pass AND P&L > -$10) THEN
  DECISION = "REVIEW - Address Gaps"
  Action: Identify failing criteria
  Action: Run 1-2 additional scenario tests
  Decision window: 24 hours
  Retry: Re-execute failing scenarios

ELSE IF (P&L < -$10 OR win rate < 40%) THEN
  DECISION = "STOP - Strategy Needs Tuning"
  Action: Analyze root cause of poor performance
  Action: Review signal quality (Bonding/Weather)
  Action: Check for circuit breaker triggers
  Decision: Proceed to Phase D only after tuning

ELSE
  DECISION = "CRITICAL FAILURE"
  Action: Do not proceed to Phase D
  Action: Debug and fix system issues first
  Decision: Return to Phase B / Phase A verification
```

**Hour 48: Final Sign-Off**

- [ ] Generate PHASE_C_AUDIT.md with full results
- [ ] Compute final decision: [GO / REVIEW / STOP]
- [ ] Document any anomalies found
- [ ] Create evidence package (audit logs, SQL results, dashboard screenshots)
- [ ] Notify: "[DECISION] Phase C complete at [timestamp]. Proceeding to Phase [D or retry]"

---

## Contingency Procedures

### If Circuit Breaker Triggers During Trading

1. **CAUTION State** (triggered after 1 failed check):
   - [ ] Position sizes halved (max 50% of normal)
   - [ ] New orders still allowed at CAUTION limits
   - [ ] Expected: Recover within 1-2 trades

2. **HALT State** (triggered after 2 consecutive failures):
   - [ ] No new orders allowed
   - [ ] Existing positions tracked for stops/TP
   - [ ] Auto-recovery timer: 60 minutes
   - [ ] Test this with S7 scenario at Hour 36

3. **Recovery Protocol**:
   - [ ] At 60-minute timeout: Transition HALT → RECOVERY
   - [ ] In RECOVERY: Position limits 75% of normal
   - [ ] Can return to NORMAL after stable trading (1 hour)

### If Test Scenario Fails

**Failure at Hour 30-36**:
1. [ ] Stop current scenario execution
2. [ ] Log the failure with exact conditions (price, order state, etc.)
3. [ ] Attempt scenario again (up to 2 retries)
4. [ ] If still fails: Document as "FAIL" in audit report
5. [ ] Continue with next scenario

**If Multiple Scenarios Fail** (>2/8):
- Scenario failure itself may be valid test result (detecting issues)
- Document failures clearly
- Proceed to audit report; failures don't auto-block Phase D
- Phase D gate decision considers scenario results + P&L + win rate

### If System Crashes

**Recovery Procedure**:
1. [ ] Restart Phase C at last successful hour checkpoint
2. [ ] Roll back to last database snapshot (before crash)
3. [ ] Re-execute trades from checkpoint forward
4. [ ] Note in audit trail: "System crash at [time], recovered at [time]"
5. [ ] Maximum 1 crash recovery allowed; 2nd crash = STOP

### If Win Rate Falls Below 40% at Hour 24

1. [ ] Pause trading (don't execute more trades)
2. [ ] Analyze first 20 trades: signal quality, market conditions
3. [ ] Decision:
   - Continue with strategy if market conditions explain poor performance
   - Abort Phase C if strategy fundamentally broken (STOP decision)
4. [ ] Document conclusion in audit trail

---

## Rollback Procedure

If at any point Phase C must be abandoned:

1. **Immediate Actions**:
   - [ ] Stop all paper trade execution
   - [ ] Log final state: open positions, P&L, time
   - [ ] Preserve audit trail (do NOT delete logs)

2. **Data Preservation**:
   - [ ] Export all trades and positions
   - [ ] Screenshot all dashboard metrics
   - [ ] Run final validation SQL queries
   - [ ] Store in `/data/phase-c-rollback/` directory

3. **Post-Mortem Analysis**:
   - [ ] Determine root cause (strategy, risk controls, system)
   - [ ] Create post-mortem report (1-2 pages)
   - [ ] Recommend fixes for Phase A, B, or C

4. **Next Steps**:
   - [ ] If Phase A issue: Return to Phase A fixes
   - [ ] If Phase B issue: Return to Phase B unit tests
   - [ ] If strategy issue: Revisit signal generation
   - [ ] Schedule retry after fixes: [date/time]

---

## Success Definition

**Phase C is SUCCESSFUL if:**

1. ✅ 30 paper trades executed from start to finish
2. ✅ Win rate >50% (proof of edge)
3. ✅ Cumulative P&L >$0 (positive returns)
4. ✅ Max drawdown <15% (risk managed)
5. ✅ All 8 test scenarios execute and validate correctly
6. ✅ No critical system failures or crashes
7. ✅ Audit trail complete and verifiable
8. ✅ Ready for Phase D: Live deployment with $250

---

## Phase D Next Steps

Upon PASS decision, immediately proceed to:

1. **Day 1 (Live Trading)**:
   - [ ] Switch execution mode from PAPER to LIVE
   - [ ] Deploy capital: Bonding (70% = $175) + Weather (30% = $75)
   - [ ] Start 10-day validation window
   - [ ] Monitor daily P&L, win rate, drawdown

2. **Days 1-10 (Validation Window)**:
   - [ ] Daily checkpoints: P&L, win rate, max drawdown
   - [ ] Success criteria: Win rate >50%, P&L >$0, DD <15%
   - [ ] Failure criteria: Win rate <40%, P&L <-$10, DD >15%

3. **Day 15+ (Conditional Scale)**:
   - [ ] If validation passes: Scale to $500
   - [ ] Monitor for 20+ days at $500
   - [ ] Scale to $1K on Day 25 if still profitable

---

**Document Owner**: Phase C Auditor
**Last Updated**: [Date]
**Status**: Ready for execution

⏱️ **COUNTDOWN TO PHASE C START: [T-60 min]**
