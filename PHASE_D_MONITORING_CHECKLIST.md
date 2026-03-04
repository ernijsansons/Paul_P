# Phase D: Daily Monitoring Checklist & Quick Reference

**Purpose**: Track all metrics during the 10-day live validation window
**Updated**: 2026-03-03
**Capital**: $250.00
**Deployment Date**: [START DATE]
**Validation Period**: Days 1-10

---

## ⏰ DAILY TIMELINE & CHECKLIST

### 🌅 MORNING (Before Markets Open)

**Time**: 8:00 AM UTC (or market open time)

- [ ] **System Health Check** (5 min)
  - [ ] Kalshi API connection: ONLINE ✅
  - [ ] D1 database: RESPONDING ✅
  - [ ] R2 evidence buckets: ACCESSIBLE ✅
  - [ ] Circuit breaker state: NORMAL ✅
  - [ ] Kill switch: ARMED ✅

- [ ] **Capital Verification** (2 min)
  - [ ] Available balance: $_______
  - [ ] Max position size: $12.50 (5% of $250) ✅
  - [ ] Daily loss limit: $7.50 (3% of $250) ✅
  - [ ] Max drawdown limit: $37.50 (15% of $250) ✅

- [ ] **Markets Ready** (3 min)
  - [ ] BONDING markets: 3+ available with >$500 liquidity ✅
  - [ ] WEATHER markets: 3+ available with >$500 liquidity ✅
  - [ ] Spreads: All < 0.5% ✅
  - [ ] VPIN levels: < 0.6 on all targets ✅

- [ ] **Previous Day Summary** (if Day 2+)
  - [ ] Yesterday's P&L: $_________ (target: +$0.75 to +$4.20)
  - [ ] Win rate: ______% (target: 50-75%)
  - [ ] Largest position: $_________ (max $12.50)
  - [ ] Trades executed: _________ (target: 3-5)
  - [ ] Circuit breaker state: NORMAL / CAUTION / HALT
  - [ ] Alerts triggered: NONE / KILL_SWITCH / CAUTION / HALT

**Status**: ✅ READY TO TRADE or ⚠️ ISSUES DETECTED

---

### 📊 DURING TRADING HOURS (Every 2 Hours)

**Time**: Every 2-hour mark (10:00, 12:00, 14:00, 16:00, etc.)

**Quick Check** (5 min each):

- [ ] **Current Positions** (2 min)
  - Total open positions: _________
  - Largest position: $_________ (should be ≤ $12.50)
  - Total position value: $_________ (should be ≤ $50 = 20% of capital)

- [ ] **Intra-Day P&L** (1 min)
  - Unrealized P&L: $_________
  - Daily realized P&L so far: $_________ (target: -$7.50 to +$5.00)
  - Max daily loss remaining budget: $_________ (should be > $0)

- [ ] **Risk Status** (2 min)
  - Circuit breaker: NORMAL / CAUTION / HALT
  - Kill switch active: YES / NO (which markets blocked?)
  - Any stop-losses triggered this interval? YES / NO
  - Any take-profits triggered this interval? YES / NO

**Concern Threshold**:
- ⚠️ If daily loss > $5 → increase monitoring to every 30 min
- 🛑 If circuit breaker → CAUTION → monitor every 15 min
- 🛑 If circuit breaker → HALT → PAUSE trading, investigate

---

### 🌆 END OF DAY (After Markets Close)

**Time**: 5:00 PM UTC or end of session

**Comprehensive Review** (15 min):

#### 1. Trade Execution Summary (5 min)
```
Date: 2026-03-03 (example)

Trades Executed:
| # | Time | Market | Side | Size | Entry | Exit | Exit Reason | P&L | Grade |
|---|------|--------|------|------|-------|------|-------------|-----|-------|
| 1 | 09:15 | BONDING_YES | YES | 10 | 50.0 | 52.5 | TP | +$2.50 | EXC |
| 2 | 11:30 | WEATHER_TMP | YES | 8 | 45.0 | 44.1 | SL | -$0.72 | GOOD |
| 3 | 14:20 | BONDING_NO | NO | 10 | 48.0 | 49.8 | TP | +$1.80 | GOOD |
| 4 | 16:45 | WEATHER_RN | YES | 10 | 52.0 | 51.2 | SL | -$0.80 | GOOD |

Daily Summary:
- Total trades: 4
- Wins: 2 (50%)
- Losses: 2 (50%)
- Total P&L: +$2.78
- Avg trade: +$0.69
```

- [ ] All trades logged in R2 CSV ✅
- [ ] P&L calculated correctly ✅
- [ ] Exit reasons recorded ✅
- [ ] Execution grades computed ✅

#### 2. Daily Metrics (5 min)

- [ ] **P&L Metrics**
  - Daily P&L: $_________ (add to running total)
  - Running 10-day P&L: $_________ (expected: $0 to $42)
  - Daily Sharpe ratio: _________ (collect for Day 5+ analysis)

- [ ] **Win Rate Metrics**
  - Today's wins: _________
  - Today's losses: _________
  - Today's win rate: _________%
  - Running 10-day win rate: ________% (target: 50-75%)

- [ ] **Risk Metrics**
  - Daily loss: $_________ (max allowed: $7.50)
  - Max drawdown (YTD): ________% (max allowed: 15%)
  - Largest position executed today: $_________ (max: $12.50)
  - Circuit breaker state: NORMAL / CAUTION / HALT

- [ ] **Execution Metrics**
  - Avg execution grade: EXCELLENT / GOOD / ACCEPTABLE / POOR
  - % of fills GOOD or EXCELLENT: ________% (target: ≥80%)
  - Avg slippage: _________¢ (benchmark: 0.5¢)
  - Max slippage on any fill: _________¢ (budget: 1% of edge)

#### 3. Risk Control Validation (3 min)

- [ ] **Stop-Loss Checks**
  - Positions with active stop-loss: _________
  - Stop-losses triggered today: _________
  - All at -3% threshold: ✅ / ⚠️

- [ ] **Take-Profit Checks**
  - Take-profits triggered today: _________
  - All at +50% threshold: ✅ / ⚠️

- [ ] **Time-Based Exit Checks**
  - Positions held 6+ days: _________
  - Time-based exits today: _________

- [ ] **Kill Switch & Circuit Breaker**
  - Kill switch triggered: YES / NO (which markets?)
  - Circuit breaker transitions: NONE / NORMAL→CAUTION / CAUTION→HALT
  - Any false positives: YES / NO

#### 4. Decision Gates (2 min)

**Continuing Trade Checklist**:
- [ ] Win rate ≥ 40% (if < 40%, escalate)
- [ ] Daily loss < $7.50 (within limit)
- [ ] Max drawdown < 15% (within limit)
- [ ] Circuit breaker not in HALT (if HALT, investigate)
- [ ] No kill switches on 50%+ of portfolio (if yes, reduce position size)

**Status**:
- ✅ **CONTINUE** - All metrics normal
- ⚠️ **CAUTION** - One metric approaching limit
- 🛑 **HALT** - One or more limits exceeded

---

## 📈 ROLLING METRICS TRACKING (5-Day Windows)

### Days 1-5 Checkpoint

**Track These**:
```
Day 1: Trades___, P&L___, WR_%, DD_%
Day 2: Trades___, P&L___, WR_%, DD_%
Day 3: Trades___, P&L___, WR_%, DD_%
Day 4: Trades___, P&L___, WR_%, DD_%
Day 5: Trades___, P&L___, WR_%, DD_%

5-Day Totals:
- Total trades: _____ (expect: 15-25)
- Win rate: ____% (expect: 50-75%)
- P&L: $_____ (expect: $5-20)
- Max drawdown: ____% (expect: 2-8%)
- Sharpe: N/A (need 10 days for annualization)

Decision:
- CONTINUE ✅ (all metrics on track)
- REVIEW ⚠️ (one metric off, but recoverable)
- ESCALATE 🛑 (something wrong, investigate)
```

### Days 6-10 Checkpoint

**Track These**:
```
Day 6: Trades___, P&L___, WR_%, DD_%
Day 7: Trades___, P&L___, WR_%, DD_%
Day 8: Trades___, P&L___, WR_%, DD_%
Day 9: Trades___, P&L___, WR_%, DD_%
Day 10: Trades___, P&L___, WR_%, DD_%

10-Day Totals:
- Total trades: _____ (expect: 30-40)
- Win rate: ____% (expect: 50-75%)
- P&L: $_____ (expect: $10-40)
- Max drawdown: ____% (expect: 2-10%)
- Sharpe ratio: _____ (annualized, target: ≥0.8)

SCALE DECISION:
- ✅ SCALE to $500: All gates passed
- ⚠️ CONTINUE at $250: Marginal performance, needs more time
- 🛑 SUSPEND: Performance below threshold, investigate before resuming
```

---

## 🚨 ALERT & ESCALATION MATRIX

### RED FLAGS (Immediate Action Required)

| Alert | Trigger | Action | Timeline |
|-------|---------|--------|----------|
| **Daily Loss Limit** | Daily loss > $7.50 | ⚠️ HALT trading, check stops | Immediate |
| **Max Drawdown** | Drawdown > 15% ($37.50) | ⚠️ HALT trading, reduce size | Immediate |
| **Circuit Breaker HALT** | 3+ consecutive losses | ⚠️ HALT, investigate root cause | Immediate |
| **Kill Switch (I18)** | Slippage > 50% of edge | ⚠️ Block that market, reduce size | Within 5 min |
| **Win Rate Collapse** | WR < 40% after 10 trades | ⚠️ Review signal quality | End of day |
| **Execution Failure** | % GOOD/EXCELLENT < 60% | ⚠️ Switch limit price method | Within 1 hour |

### YELLOW FLAGS (Monitor & Review)

| Alert | Trigger | Action | Timeline |
|-------|---------|--------|----------|
| Circuit Breaker CAUTION | Daily loss > $5 | 📊 Reduce positions 50% | Immediate |
| Win Rate Low | WR < 50% after 5 trades | 📊 Monitor next 5 trades | Next 2 hours |
| Slippage High | Avg slippage > 1% | 📊 Switch to aggressive_cross | Next 1 hour |
| Market Liquidity | Depth < $500 on market | 📊 Skip that market, use others | Before next trade |

### GREEN FLAGS (All Systems Normal)

| Status | Indicators |
|--------|-----------|
| ✅ **NORMAL** | WR 50-75%, P&L positive, DD < 10%, CB = NORMAL |
| ✅ **EXCELLENT** | WR > 70%, P&L > expected, DD < 5%, zero false triggers |

---

## 🔧 QUICK REFERENCE: CONTROL TRIGGERS

### Stop-Loss Trigger

```
Position Entry: 50.0¢
Stop-Loss Level: 50.0¢ - 1.5¢ = 48.5¢ (-3%)

Live Price Check: 48.3¢ ← BELOW STOP LEVEL
Action: EXIT IMMEDIATELY at market price
Expected Loss: ~$1.70 (from 50.0¢ to 48.3¢)
Execution: "Position closed due to stop-loss"
Log: Entry 50.0, Exit 48.3, Reason: STOP_LOSS, P&L: -$1.70
```

### Take-Profit Trigger

```
Position Entry: 50.0¢
Take-Profit Level: 50.0¢ + 25.0¢ = 75.0¢ (+50%)

Live Price Check: 75.2¢ ← ABOVE TP LEVEL
Action: EXIT IMMEDIATELY at market price
Expected Gain: ~$2.50 (from 50.0¢ to 75.2¢)
Execution: "Position closed due to take-profit"
Log: Entry 50.0, Exit 75.2, Reason: TAKE_PROFIT, P&L: +$2.50
```

### Time-Based Exit Trigger

```
Position Entry: Day 1, Hour 0
Max Hold Time: 7 days (168 hours)
Exit Trigger: Day 7, Hour 23:55 (7-day boundary)

Live Check: Day 7, Hour 23:59 ← TIME LIMIT REACHED
Action: EXIT at market price regardless of P&L
Execution: "Position closed due to 7-day holding limit"
Log: Entry Day1:00, Exit Day7:23:59, Reason: TIME_EXIT, P&L: [actual]
```

### Kill Switch Trigger (I18)

```
Market: BONDING_YES_MARCH
Expected Edge: 2.5% (1.25¢ on $50 mid)
Kill Threshold: 50% of edge = 0.625¢

Slippage Monitor:
- Fill Price: 46.5¢
- Ask Price: 52.0¢
- Realized Slippage: 5.5¢ (52.0 - 46.5)
- Ratio to Edge: 5.5¢ / 1.25¢ = 440% of edge

Decision: 440% > 50%? YES → KILL SWITCH TRIGGERED
Action: Block new orders in BONDING_YES_MARCH
Alert: "Market BONDING_YES_MARCH blocked due to execution quality"
Duration: Until manual review
Existing Positions: Hold with normal stops
```

### Circuit Breaker: NORMAL → CAUTION

```
Daily Loss Accumulation:
- Trade 1: -$1.00 (Loss 1)
- Trade 2: -$0.80 (Loss 2)
- Cumulative: -$1.80

Trigger Condition:
- Consecutive losses: 2 ✓
- Daily loss > 60% of limit: $1.80 / $7.50 = 24% ✗
- Decision: Approaching threshold → TRANSITION TO CAUTION

New Rules (CAUTION State):
- Position size: $12.50 → $6.25 (50% reduction)
- Max positions: Halved
- Duration: 60 min or until recovery
- Alert: "Circuit Breaker: CAUTION mode activated"

To Recover:
- Option 1: Win next trade → recover to NORMAL
- Option 2: 60 minutes pass with no more losses → recover to NORMAL
- Option 3: Daily loss reverses (profit coming in) → recover to NORMAL
```

### Circuit Breaker: CAUTION → HALT

```
Daily Loss Accumulation (continuing):
- Trade 3: -$1.20 (Loss 3, while in CAUTION)
- Trade 4: -$0.50 (Loss 4)
- Cumulative: -$1.80 - $1.20 - $0.50 = -$3.50

Trigger Condition:
- Daily loss > $7.50 (limit)?
  - $3.50 so far, still room, but...
- Consecutive losses: 4 in CAUTION state
- Risk: Next loss could exceed $7.50 limit

Decision: HALT all trading
Action:
- Stop accepting new orders
- Keep existing positions with normal stops
- Allow positions to close via stops/TPs
- Alert: "Trading halted - daily loss approaching limit"
- Review required before resuming
```

---

## 📋 DAILY LOG TEMPLATE

### Copy this for each day (Days 1-10):

```markdown
## Phase D - Day X Daily Log

**Date**: 2026-03-XX
**Day**: X of 10
**Market Status**: [OPEN / CLOSED]

### Morning Checklist
- [ ] System health: ONLINE
- [ ] Capital verified: $250.00
- [ ] Markets ready: BONDING + WEATHER online
- [ ] Circuit breaker: NORMAL

### Trades Executed (Today)
[List all trades with entry, exit, P&L]

### Daily Metrics Summary
- Trades: ___
- Wins: ___ (___%)
- Losses: ___
- Daily P&L: $___
- Max DD: ___%

### Risk Controls Status
- Stop-losses triggered: ___
- Take-profits triggered: ___
- Kill switch: NO / YES (markets: ___)
- Circuit breaker: NORMAL / CAUTION / HALT

### Alerts & Notes
[Any unusual activity, market conditions, system issues]

### End-of-Day Decision
- [ ] CONTINUE (all normal)
- [ ] REVIEW (issue found)
- [ ] HALT (limit exceeded)

### 10-Day Running Totals
- Cumulative trades: ___
- Cumulative P&L: $___
- Win rate: ___%
- Max drawdown: ___%
- Sharpe ratio: ___ (Day 10+ only)
```

---

## 📊 SAMPLE DAILY LOG (Example - Day 3)

```markdown
## Phase D - Day 3 Daily Log

**Date**: 2026-03-05
**Day**: 3 of 10
**Market Status**: TRADING COMPLETE

### Morning Checklist
- [x] System health: ONLINE
- [x] Capital verified: $250.00
- [x] Markets ready: BONDING + WEATHER online
- [x] Circuit breaker: NORMAL

### Trades Executed (Today - Mar 5)
| Time | Market | Side | Size | Entry | Exit | Reason | P&L | Grade |
|------|--------|------|------|-------|------|--------|-----|-------|
| 09:20 | BONDING_YES | YES | 10 | 50.0 | 48.8 | SL | -$1.20 | GOOD |
| 11:45 | WEATHER_TMP | YES | 8 | 45.0 | 47.5 | TP | +$2.00 | EXC |
| 14:10 | BONDING_NO | NO | 10 | 48.0 | 49.8 | SL | -$1.80 | GOOD |
| 16:30 | WEATHER_RN | YES | 10 | 52.0 | 60.0 | TP | +$8.00 | EXC |

### Daily Metrics Summary
- Trades: 4
- Wins: 2 (50%)
- Losses: 2 (50%)
- Daily P&L: **+$7.00** ✅
- Max DD (today): -2.1%

### Risk Controls Status
- Stop-losses triggered: 2 ✅
- Take-profits triggered: 2 ✅
- Kill switch: NO ✅
- Circuit breaker: NORMAL ✅

### Alerts & Notes
- Excellent performance on WEATHER strategy (2 big wins)
- Market liquidity: Good, all spreads < 0.4%
- VPIN levels: Normal (0.35-0.45 range)
- Execution quality: Perfect (2 EXCELLENT + 2 GOOD)

### End-of-Day Decision
- [x] **CONTINUE** - All metrics excellent

### 10-Day Running Totals
- Cumulative trades: 12 (Days 1-3)
- Cumulative P&L: **+$12.50** ✅✅✅
- Win rate: **58%** (7 wins, 5 losses)
- Max drawdown: **2.5%** (well within 15% limit)
- Sharpe ratio: PENDING (need 10 days)

**Assessment**: On track for Day 10 gate. Win rate trending toward 70% target. Execution quality excellent.
```

---

## 🎯 DAY 10 GATE CALCULATION TEMPLATE

At end of Day 10, fill this out:

```markdown
## PHASE D - DAY 10 FINAL ASSESSMENT

### Totals (Days 1-10)
- Total trades: _______
- Winning trades: _______
- Losing trades: _______
- Win rate: ______%

### P&L Summary
- Total realized P&L: $_______
- Average per trade: $_______
- Best day: $_______ (Day ___)
- Worst day: $_______ (Day ___)
- Max daily loss: $_______ (Day ___)
- Remaining daily loss budget: $_______ (should be > $0)

### Risk Metrics
- Max drawdown (peak-to-trough): _____%
- Max drawdown buffer: $_______ (should be > $0)
- Largest position executed: $_______
- Highest daily loss: $_______ (max $7.50)
- Circuit breaker transitions: _______

### Execution Quality
- EXCELLENT: _____ trades (____%)
- GOOD: _____ trades (____%)
- ACCEPTABLE: _____ trades (____%)
- POOR: _____ trades (____%)
- GOOD+ percentage: ____% (target ≥80%)

### Kill Switch & Controls
- Kill switch triggers: _______
- False positives: YES / NO
- Stop-loss enforcement: 100% working
- Take-profit enforcement: 100% working
- Time-exit enforcement: 100% working

### Scale Gate Assessment

Gate 1 - Win Rate ≥ 50%: ______% → [ ] PASS / [ ] FAIL
Gate 2 - P&L ≥ $10: $_______ → [ ] PASS / [ ] FAIL
Gate 3 - Sharpe ≥ 0.8: _______ → [ ] PASS / [ ] FAIL
Gate 4 - Max DD ≤ 15%: _____% → [ ] PASS / [ ] FAIL
Gate 5 - Circuit Breaker ≤ 1 change: _____ → [ ] PASS / [ ] FAIL
Gate 6 - Kill switches < 50% of markets: _____ → [ ] PASS / [ ] FAIL

### Final Decision
[ ] **SCALE TO $500** - All gates passed ✅
[ ] **HOLD AT $250** - Need more time (specify which gate failed)
[ ] **SUSPEND** - Performance below threshold (specify issue)

### Notes
[Final assessment, any anomalies, recommendations]
```

---

## Version Control

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-03-03 | Initial deployment checklist |
| 1.1 | [DATE] | [Update if needed] |

**Status**: Ready for Phase D deployment
**Next Review**: Day 5 (mid-checkpoint)
**Final Review**: Day 10 (scale decision)

