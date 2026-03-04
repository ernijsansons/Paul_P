# Phase D: Live Deployment Plan

**Status**: APPROVED FOR DEPLOYMENT 🚀
**Date**: 2026-03-03
**Capital**: $250.00 (Kalshi)
**Duration**: 10-day validation window
**Authorization**: Phase C GATE PASS (all 6 gates met, confidence 95%+)

---

## Executive Summary

Phase C paper trading validated all 18 risk invariants, 8 test scenarios, and edge assumptions:
- **70% win rate** (vs. 50% target)
- **+$34.40 P&L** (vs. $0 target) from 30 simulated trades
- **85% execution quality** (vs. 80% target)
- **0 circuit breaker false positives** (expected behavior confirmed)
- **Kill switch working correctly** (I18 triggered on volatility)

**Decision**: DEPLOY TO KALSHI with $250 capital using Strategy Allocation:
- Bonding (70% = $175) — High edge confidence from paper results
- Weather (30% = $75) — Signal diversification

---

## Pre-Deployment Checklist (Phase D-0: Go-Live Prep)

### ⏱️ Timeline: 4 Hours Before First Trade

#### Hour -4: Environment Setup
- [ ] Kalshi API credentials loaded and verified
- [ ] Authentication tokens refreshed (valid 24h+)
- [ ] D1 database connection confirmed
- [ ] R2 evidence buckets accessible
- [ ] KV cache keys configured
- [ ] Slack webhook for alerts configured (if monitoring)

**Verification Command**:
```bash
npm run verify:kalshi-connection
# Expected: "✅ API connection healthy"
```

#### Hour -3: Code Verification
- [ ] Latest build compiled without errors (`npm run build`)
- [ ] All 786/788 tests passing (`npm run test`)
- [ ] Type checking clean (`npm run type-check`)
- [ ] Risk invariants compiled with 18/18 controls
- [ ] Execution policy active (not PAPER mode)

**Verification Command**:
```bash
npm run build && npm run test -- --reporter=verbose
# Expected: "Success: 786 tests passed, 2 skipped, 0 failures"
```

#### Hour -2: Configuration & Capital Setup
- [ ] Trading mode set to LIVE (not PAPER)
- [ ] Capital initialized: $250.00 in account
- [ ] Risk limits loaded:
  - Max Position: 5% ($12.50)
  - Daily Loss Limit: 3% ($7.50)
  - Max Drawdown: 15% ($37.50)
  - Spread Limit: 0.5%
  - VPIN Limit: 0.5
  - Min Liquidity: $500
  - Tail Concentration: 0.3 (Herfindahl)
- [ ] Stop-loss set to -3% (hard limit per position)
- [ ] Take-profit set to +50% (lock-in gains)
- [ ] Time-based exit set to 7 days (stale position prevention)
- [ ] Circuit breaker initialized to NORMAL state
- [ ] Kill switch (I18) armed for slippage > 50% of edge

**Verification Command**:
```sql
-- Verify risk limits in database
SELECT * FROM risk_limits WHERE status = 'ACTIVE' ORDER BY parameter_name;
-- Expected: 18 rows, all values matching above
```

#### Hour -1: Market Verification
- [ ] BONDING markets available (list 3+):
  - [ ] BONDING_YES_MARCH (>$500 liquidity)
  - [ ] BONDING_NO_MARCH (>$500 liquidity)
  - [ ] BONDING_YES_APRIL (>$500 liquidity)
- [ ] WEATHER markets available (list 3+):
  - [ ] WEATHER_TEMP_72F (>$500 liquidity)
  - [ ] WEATHER_RAIN_TOMORROW (>$500 liquidity)
  - [ ] WEATHER_SNOW_WEEK (>$500 liquidity)
- [ ] No market data stale (all prices < 5 min old)
- [ ] Spread < 0.5% on all target markets
- [ ] No pending circuit breaker from previous session

**Verification Command**:
```bash
npm run verify:market-health
# Expected: "✅ All 6+ target markets ready, spreads within limits"
```

#### Minute -5: Final Safety Check
- [ ] Capital: $250.00 confirmed
- [ ] Execution mode: LIVE confirmed
- [ ] Circuit breaker: NORMAL state
- [ ] Kill switch: Armed
- [ ] Stop-losses: -3% set per position
- [ ] Take-profits: +50% set per position
- [ ] Audit trail system active
- [ ] Dashboard endpoints responding (4/4 endpoints)

---

## Phase D Execution Timeline (10-Day Validation Window)

### Day 1-2: Initial Signal Generation & Conservative Positioning

**Objective**: Verify signal generation pipeline is working, execute first 3-5 trades

**Activities**:
1. **Signal Generation** (Hours 0-4):
   - Bonding strategy processes market data
   - Weather model analyzes forecasts
   - LLM resolution scoring active
   - First signals generated

2. **First Trade Execution** (Hours 4-8):
   - Target: 1-3 BONDING trades
   - Position size: $10-12 per trade (1-2 contracts)
   - Expected P&L: +$0.50 to +$1.50 (if edges match paper)
   - Monitor fill quality closely

3. **Monitoring Cadence** (Continuous):
   - Check every 15 minutes: fill quality, slippage, circuit breaker state
   - Check every hour: cumulative P&L, daily loss accumulation
   - Alert thresholds:
     - If any fill has slippage > 1% of edge → log to audit trail + review
     - If daily loss > $5 → check circuit breaker state (should still be NORMAL at -$5)
     - If circuit breaker enters CAUTION → reduce position sizes by 50% immediately

**Success Criteria (Days 1-2)**:
- ✅ At least 1 trade executed successfully
- ✅ Fill quality matches paper trading expectations (0-0.5% slippage typical)
- ✅ Circuit breaker remains in NORMAL state (no false triggers)
- ✅ Cumulative P&L > -$5 (within daily loss budget)

**If Failure**:
- ❌ Win rate < 30% on first 3 trades → review signal generation quality, check for market regime shift
- ❌ Slippage > 1% on any fill → market conditions changed, verify depth/VPIN
- ❌ Circuit breaker triggers CAUTION unexpectedly → check daily loss calculation, review invariant thresholds

---

### Day 3-5: Execution Normalization & Pattern Validation

**Objective**: Accumulate 8-15 total trades, validate win rate is in 50-70% range

**Activities**:
1. **Trading Cadence** (3-5 signals/day expected):
   - Continue with position sizing from Days 1-2 ($10-12 per trade)
   - Expect 1-2 take-profits per day
   - Expect 0-1 stop-losses per day
   - Expect 1 time-exit every 7 days (starting Day 8)

2. **Daily Monitoring** (end of each day):
   ```
   End-of-Day Checklist:
   [ ] Daily P&L calculated and logged
   [ ] Win rate computed (e.g., 3 wins / 5 trades = 60%)
   [ ] Daily loss total vs. $7.50 limit
   [ ] Max drawdown vs. $37.50 limit
   [ ] Circuit breaker state (expected: NORMAL)
   [ ] Largest position size check (max $12.50)
   [ ] Tail concentration audit (Herfindahl < 0.3)
   ```

3. **Rolling Metrics** (Days 3-5 checkpoint):
   - Win rate should be 50-75% (target 70%)
   - Avg P&L per trade ~$1.15 (from paper trading)
   - Expected 5-day P&L: $6-8 (5-7 trades at ~$1.15 avg)
   - Max single-day loss: -$3 to -$5 (not exceeding $7.50)

**Success Criteria (Days 3-5)**:
- ✅ 8-15 total trades executed
- ✅ Win rate between 50-75%
- ✅ Cumulative P&L > $0 (proof of profitability)
- ✅ No circuit breaker state changes (NORMAL throughout)
- ✅ Execution quality 80%+ GOOD/EXCELLENT

**If Failure**:
- ❌ Win rate < 40% → signal quality degraded, possible regime shift (market election/macro event?), escalate to CAUTION manually
- ❌ P&L < -$10 → edge hypothesis invalid, suspend trading pending investigation
- ❌ Circuit breaker enters CAUTION → position size halving triggered, monitor closely through recovery

---

### Day 6-10: Extended Validation & Scale Gate Assessment

**Objective**: Complete 10-day proof-of-concept, collect 20+ trades, confirm edge stability

**Activities**:
1. **Continued Trading**:
   - Maintain position sizing strategy
   - Allow natural circuit breaker state transitions (expected: mostly NORMAL)
   - Continue monitoring daily losses, max drawdown

2. **Sharpe Ratio Calculation** (Daily):
   ```
   Daily Sharpe = (Avg Daily Return) / (Std Dev of Daily Returns)

   Example Calculation:
   Day 1: +$0.80
   Day 2: +$1.20
   Day 3: +$0.50
   Day 4: -$0.20
   Day 5: +$1.50
   Day 6: +$0.90
   Day 7: +$1.10
   Day 8: +$0.70
   Day 9: +$0.60
   Day 10: +$1.30

   Avg = $0.84/day = 0.336% daily return
   Std Dev ≈ 0.58/day
   Sharpe ≈ 0.336 / 0.58 ≈ 0.58 (annualized: ~9.2)

   Gate: Need Sharpe > 1.0 to scale
   ```

3. **End-of-Phase-D Review** (Day 10 evening):
   - Total trades: 20-30 expected
   - Win rate: Track against 70% paper baseline
   - 10-day P&L: Expected +$20-40 (based on $1.15 avg × 20-30 trades)
   - Max drawdown: Track against 15% limit ($37.50)
   - Sharpe ratio calculation
   - Circuit breaker state transitions: count and review each

**Success Criteria (Days 6-10)**:
- ✅ 20+ total trades by Day 10
- ✅ Win rate stable at 50-75% (proving edge is real, not luck)
- ✅ Cumulative 10-day P&L ≥ +$10 (proving profitability scales)
- ✅ Max drawdown < 15% (risk controls working)
- ✅ No false circuit breaker triggers (0-1 expected transitions, none false)
- ✅ Execution quality consistent at 80%+ GOOD/EXCELLENT

**If Success** (All criteria met):
- ✅ **SCALE AUTHORIZED**: Increase capital from $250 → $500
- ✅ Position sizing scales: $12.50 → $25 per position
- ✅ Daily loss limit scales: $7.50 → $15 (3% of $500)
- ✅ Max drawdown limit: $37.50 → $75 (15% of $500)

**If Failure** (Any criterion missed):
- ❌ **HOLD AT $250**: Do not scale
- ❌ Investigate root cause: edge degradation? regime change? system bug?
- ❌ Decision: Continue testing Days 11-20, or suspend for diagnosis?

---

## Daily Monitoring Dashboard (Template)

Create a daily log file: `PHASE_D_DAILY_LOG.md`

```markdown
## Phase D Daily Log

### Day 1 (2026-03-03)
**Time**: 22:50 UTC (Phase C complete, go-live day)

**Pre-Market**:
- [ ] Capital: $250.00 verified
- [ ] Markets open and healthy
- [ ] Circuit breaker: NORMAL
- [ ] First signal generated: (market, side, size, edge)

**Trades Executed** (throughout day):
| # | Time | Market | Side | Size | Entry | Exit | Exit Reason | P&L | Grade |
|---|------|--------|------|------|-------|------|-------------|-----|-------|
| 1 | 22:55 | BONDING_YES_MARCH | YES | 10 | 50.0¢ | 52.5¢ | TP | +$2.50 | EXCELLENT |

**End-of-Day Summary**:
- Trades: 1
- Wins: 1 (100%)
- Daily P&L: +$2.50
- Max Drawdown (YTD): +2.50%
- Circuit Breaker: NORMAL
- Sharpe (rolling 5d): N/A (need 5 days)
- Notes: First trade executed successfully, fill quality excellent

---
```

Each day, record:
- Time of first trade
- All executed trades (entry, exit, reason, P&L, grade)
- Cumulative daily P&L
- Win rate (rolling)
- Circuit breaker state
- Any alerts or anomalies
- Daily Sharpe if applicable

---

## Risk Management During Phase D

### Circuit Breaker State Management

**NORMAL State** (Default):
- Position sizing: $12.50 max per trade
- Action: Full signal execution
- Monitoring: Hourly P&L checks
- Recovery: N/A (already normal)

**CAUTION State** (Triggered by):
- 2+ consecutive losses in same day
- Daily loss > $5 (67% of daily limit)
- Kill switch triggered on market (blocks new orders in that market)
- High VPIN (> 0.5) on all positions

**CAUTION Actions**:
- Position sizing: Halved to $6.25 max per trade
- New orders: Allowed but at reduced size
- Existing positions: Held with normal stops (no change)
- Duration: 60 minutes or until loss reversal

**HALT State** (Triggered by):
- Daily loss > $7.50 (max limit hit)
- Max drawdown > 15% ($37.50)
- 3+ consecutive losses
- Kill switch on 50%+ of portfolio markets

**HALT Actions**:
- New orders: Blocked immediately
- Existing positions: Held with normal stops
- P&L preservation: Focus on closing positions
- Recovery: Manual review required before resuming

### Kill Switch Enforcement (I18)

**Trigger**: Realized slippage > 50% of expected edge

**Example**:
```
Market: BONDING_YES_MARCH
Expected Edge: 2.5% (1.25¢ on $50 midpoint)
Expected Slippage: 0.5¢
Kill Threshold: 0.5 × 1.25¢ = 0.625¢

Scenario 1: Slippage = 0.4¢ → OK (within budget)
Scenario 2: Slippage = 0.8¢ → KILL SWITCH (80% of edge)
  Action: Market blocked for new orders
  Alert: "Execution quality degraded: BONDING_YES_MARCH blocked"
  Existing positions: Held, no new orders in this market
```

### Stop-Loss Enforcement (I1 - Hard Limit)

Every position has a -3% stop-loss from entry:
```
Entry Price: 50.0¢
Stop-Loss Price: 48.5¢ (-3%)

Price Action:
Hour 1: 50.5¢ ✅ (above stop)
Hour 2: 49.0¢ ✅ (above stop)
Hour 3: 48.4¢ ❌ (below stop - EXIT IMMEDIATELY)
  Exit Price: 48.4¢ (or better)
  Loss: -$1.60 (from $50 entry to $48.40 exit)
  Control: Working correctly
```

### Take-Profit Enforcement (I1 - Gain Lock)

Every position has a +50% take-profit target:
```
Entry Price: 50.0¢
Take-Profit Price: 75.0¢ (+50%)

Price Action:
Hour 1: 52.0¢ ✅ (below target)
Hour 4: 60.0¢ ✅ (below target)
Hour 8: 75.0¢ ❌ (at target - EXIT)
  Exit Price: 75.0¢
  Gain: +$2.50 (from $50 entry to $75 exit)
  Control: Lock-in working
```

---

## Kalshi Order Execution Reference

### Order Placement (from KalshiExecAgent)

**Function**: `transformToKalshiOrder(request, market, policy)`

**Inputs**:
```typescript
request: {
  position_id: string,
  market_id: string,
  side: 'YES' | 'NO',
  size: number,  // contracts
  signal_strength: number, // 0-1 (used for limit price calculation)
  expected_edge: number, // e.g., 0.025 (2.5%)
}

market: {
  yes_ask: number,  // current ask price in cents
  no_ask: number,
  yes_bid: number,
  no_bid: number,
  // ... other fields
}

policy: {
  // Limit price selection method
  limitPriceMethod: 'mid_minus_edge' | 'best_bid_improve' | 'model_fair_value' | 'aggressive_cross',
  paperTradeSlippage: 0.005, // 0.5¢ expected in paper mode
  // ... other fields
}
```

**Output**:
```typescript
order: {
  ticker: string,  // market_id from Kalshi
  buy: boolean,   // true for YES, false for NO
  limitPrice: number, // in cents
  size: number, // contracts
  // ... submission details
}
```

**Limit Price Methods** (in order of aggressiveness):
1. **mid_minus_edge**: `limit = mid - (edge / 2)` — Conservative, likely to fill
2. **best_bid_improve**: `limit = best_bid + 0.01¢` — Improve existing bid
3. **model_fair_value**: `limit = model_price - edge` — Based on signal
4. **aggressive_cross**: `limit = ask + 0.01¢` — Cross spread, immediate fill

Selection logic during Phase D:
- Use `mid_minus_edge` for 70% of orders (high fill probability)
- Use `aggressive_cross` for 30% of orders (signal urgency)
- If fill rate < 70%, shift more to `aggressive_cross`
- If slippage > budget, shift back to `mid_minus_edge`

---

## Expected Daily Performance Range

Based on Phase C paper trading results ($1.15 avg per trade, 70% win rate):

**Conservative Case** (50% win rate):
- 3 trades/day × 10 days = 30 trades total
- 50% win rate = 15 wins, 15 losses
- Avg win: +$1.50, Avg loss: -$1.00
- Expected 10-day P&L: (15 × $1.50) - (15 × $1.00) = +$7.50
- Daily average: +$0.75/day

**Base Case** (70% win rate from paper):
- 3-4 trades/day × 10 days = 30-40 trades total
- 70% win rate = 21-28 wins, 9-12 losses
- Avg win: +$1.50, Avg loss: -$1.00
- Expected 10-day P&L: (25 × $1.50) - (10 × $1.00) = +$29.50
- Daily average: +$2.95/day

**Optimistic Case** (80% win rate, tighter stops):
- 4 trades/day × 10 days = 40 trades total
- 80% win rate = 32 wins, 8 losses
- Avg win: +$1.50, Avg loss: -$0.75
- Expected 10-day P&L: (32 × $1.50) - (8 × $0.75) = +$42.00
- Daily average: +$4.20/day

**Red Flag Cases** (need investigation):
- ❌ Win rate < 40%: Edge hypothesis invalid
- ❌ Avg loss > $2.00: Stop-losses not working
- ❌ Slippage > 1%: Market conditions degraded
- ❌ Sharpe < 0.5: Not sufficient edge for scaling

---

## Escalation Procedures

### Scenario 1: Win Rate Drops Below 50%

**Symptoms**:
- After 10 trades, win rate = 35%
- P&L = -$2.00 (2 wins, 8 losses)

**Diagnosis**:
1. Check market conditions: Did macro event occur? (election, FOMC, data)
2. Check signal generation: Are signal parameters still valid?
3. Check LLM governance: Did resolution scoring degrade?
4. Check execution quality: Are we getting filled at worse prices?

**Actions**:
1. Analyze last 10 trades: Which markets failed? Which strategies?
2. If BONDING failed (strategy 1): Suspend bonding, continue weather
3. If WEATHER failed (strategy 2): Suspend weather, continue bonding
4. If both failed: Suspend all trading, escalate to review

**Decision Gate**:
- If 1 strategy recovers to 50%+ by Day 5, continue
- If both < 50% through Day 5, suspend pending debug

---

### Scenario 2: Kill Switch Triggers on Multiple Markets

**Symptoms**:
- Day 3: Kill switch triggered on BONDING_YES_MARCH
- Day 4: Kill switch triggered on BONDING_NO_MARCH
- Day 5: Kill switch triggered on WEATHER_TEMP_72F

**Diagnosis**:
- Slippage consistently > 50% of edge
- Possible causes:
  1. Market depth degraded (markets thinning)
  2. VPIN spiked (order flow toxic)
  3. Spreads widened (market making dried up)
  4. Our order size too large for market

**Actions**:
1. Reduce position size from $12.50 → $6.25 (50% reduction)
2. Switch limit price method to `aggressive_cross` (accept spread, focus on execution speed)
3. Check VPIN levels: if > 0.7, reduce size further
4. Check market depths: if < $1000, skip that market

**Decision Gate**:
- If kill switch triggers resolve with smaller positions, continue
- If kill switches persist (3+ per day), suspend market, investigate

---

### Scenario 3: Circuit Breaker Enters HALT State

**Symptoms**:
- Daily loss exceeds $7.50 (max daily limit)
- Or max drawdown exceeds $37.50 (max drawdown limit)
- Or 3+ consecutive losing trades with no wins

**Actions (Automatic)**:
1. Stop accepting new orders immediately
2. Keep existing positions open with normal stops
3. Focus on closing positions (especially losers)
4. Log detailed audit trail

**Manual Review Required**:
1. Analyze the sequence of losses: were they predictable?
2. Check if stop-losses worked correctly
3. Check if market conditions changed dramatically
4. Assess: Is this a temporary regime shift or strategy failure?

**Recovery Decision**:
- **If temporary** (market volatility, macro event): Resume after 1-2 day break
- **If strategy failure**: Suspend that strategy indefinitely
- **If system failure** (stop-loss not working): Debug immediately before resuming

---

## Success Metrics & Gates for Scaling

### After Day 10: Scale to $500 IF:

- [ ] Win rate ≥ 50% (proof edge is real)
- [ ] 10-day P&L ≥ +$10 (absolute profit)
- [ ] Sharpe ratio ≥ 0.8 (risk-adjusted returns)
- [ ] Max drawdown ≤ 10% (risk well-managed)
- [ ] Circuit breaker ≤ 1 state change (no false triggers)
- [ ] No kill switches on 50%+ of markets

**Scale Action** (if all gates pass):
- Increase capital: $250 → $500
- Increase position size: $12.50 → $25 per trade
- Increase daily loss limit: $7.50 → $15
- Increase max drawdown: $37.50 → $75

### After Day 20: Scale to $1K+ IF:

- [ ] Win rate ≥ 55% sustained
- [ ] 20-day P&L ≥ +$30 (trend continuing)
- [ ] Sharpe ratio ≥ 1.0 sustained
- [ ] Max drawdown ≤ 12%
- [ ] Zero false circuit breaker triggers
- [ ] Kill switch never triggered (execution quality perfect)

**Scale Action** (if all gates pass):
- Increase capital: $500 → $1,000
- Increase position size: $25 → $50 per trade
- Increase daily loss limit: $15 → $30
- Increase max drawdown: $75 → $150

---

## Documentation & Audit Trail

### Daily Records to Maintain

1. **Trade Log** (CSV format in R2):
   ```
   Date,Time,Strategy,Market,Side,Size,Entry,Exit,ExitReason,P&L,ExecGrade
   2026-03-03,22:55,BONDING,BONDING_YES_MARCH,YES,10,50.0,52.5,TP,2.50,EXCELLENT
   ```

2. **Daily Summary** (in PHASE_D_DAILY_LOG.md):
   - Total trades, win rate, P&L, max drawdown, circuit breaker state

3. **Risk Check Logs** (from RiskGovernorAgent):
   - All invariant checks logged to audit_trail table
   - All circuit breaker transitions logged
   - All kill switch triggers logged

4. **Execution Reports** (from KalshiExecAgent):
   - Expected slippage, realized slippage, execution grade per order
   - Stored in execution_reports table

5. **Position Monitoring** (from PositionMonitorAgent):
   - Stop-loss hits, take-profit hits, time exits
   - Stored in position_monitor_events table

---

## Phase D Completion Criteria

**Phase D is COMPLETE when**:
1. ✅ 10-day validation window passed
2. ✅ Win rate ≥ 50% (edge hypothesis confirmed)
3. ✅ P&L ≥ +$10 (profitable in live conditions)
4. ✅ Max drawdown < 15% (risk controls working)
5. ✅ Zero false circuit breaker triggers
6. ✅ Scaling decision made (to $500 or hold at $250)

**Success Definition**:
- Trading system is operational and profitable on Kalshi
- All 18 risk invariants enforced correctly in live conditions
- Edge assumptions validated (70% win rate ≈ paper trading)
- Ready to scale capital based on performance gates

---

## Next Phase (Conditional: Phase E - Scaling & Operations)

### If Phase D Succeeds (Day 11+):

**Phase E Objectives**:
1. Scale to $500-$1K capital based on Day 10 metrics
2. Deploy strategies #3-5 (cross-venue signal, smart money, resolution)
3. Optimize execution (additional limit price methods)
4. Automate monitoring (Slack alerts, daily reports)
5. Build feature completeness (rebalancing, regime detection)

**Phase E Timeline**: Weeks 2-4 of live trading (if scaling happens)

### If Phase D Fails:

**Diagnosis & Fix Phase** (Week 2):
1. Identify failure root cause
2. Adjust strategy parameters, execution policy, or risk limits
3. Return to Phase C (paper validation) with fixes
4. Re-validate for 3-5 days before re-launching Phase D

**Success Criteria to Retry**:
- Paper trading shows win rate > 60%
- Edge assumptions re-validated
- Confidence restored before re-deploying

---

## Contact & Escalation

**Trading System Status**: Active on Kalshi
**Capital Deployed**: $250.00
**Phase**: D (Live Validation - Days 1-10)
**Monitoring**: Daily P&L, win rate, max drawdown

**Alerts Configured**:
- Daily report: End-of-day P&L summary
- CAUTION trigger: Slack notification (position size halving)
- HALT trigger: Immediate alert (trading suspended)
- Kill switch: Market-specific block logged

---

**Document Version**: 1.0
**Created**: 2026-03-03 22:50 UTC
**Status**: APPROVED FOR DEPLOYMENT
**Next Review**: Day 5 of Phase D (mid-week checkpoint)

