# Phase E: Scaling & Long-Term Operations

## Overview

Phase E begins after Phase D validation is complete and ALL 6 success gates are passed:
- ✅ Win rate ≥ 50%
- ✅ P&L ≥ $0
- ✅ Drawdown ≤ 15%
- ✅ Execution quality ≥ 80%
- ✅ Circuit breaker working correctly
- ✅ Zero critical errors

**Phase E Duration**: Open-ended (30+ days)
**Capital Path**: $250 → $500 (Day 15) → $1K (Day 25) → Conditional beyond

---

## Scaling Timeline & Gates

### Day 1-10: Phase D Validation
- **Capital**: $250
- **Entry**: Phase D deployment after Phase C GO
- **Exit Gate**: All 6 success gates must PASS
- **Decision**: Scale to $500 or NO-GO (no Phase E)

### Day 11-20: Phase E Tier 1 ($500)
- **Capital Increase**: $250 → $500 (2x multiplier)
- **Entry Gate**: Phase D all gates PASS
- **Allocation**: Bonding $350 (70%) + Weather $150 (30%)
- **Position Sizing**: Max 5% = $25 per position (unchanged)
- **Duration**: 10 days
- **Exit Gate**: Continued success (WR>50%, P&L>$0, DD<15%)

### Day 21-30: Phase E Tier 2 ($1K)
- **Capital Increase**: $500 → $1K (2x multiplier)
- **Entry Gate**: Days 11-20 all gates PASS
- **Allocation**: Bonding $700 (70%) + Weather $300 (30%)
- **Position Sizing**: Max 5% = $50 per position (2x leverage)
- **Duration**: 10 days
- **Exit Gate**: Continued success + Sharpe > 1.0

### Day 31+: Phase E Tier 3+ ($5K+)
- **Capital**: Conditional scaling based on performance
- **Entry Gate**: 20+ days consistent success (WR>50%, Sharpe>1.0, DD<10%)
- **Allocation**: Bonding 70% / Weather 30% (maintain barbell structure)
- **Position Sizing**: Dynamic based on portfolio Herfindahl

---

## Day 15: $250 → $500 Scaling Procedure

### Prerequisites (Day 10 Evening)

Must verify ALL of the following:

```
PHASE D GATE VERIFICATION (Day 10 Evening)
═════════════════════════════════════════════════════════════

✓ Gate 1: Win Rate ≥ 50%
  Actual: [X]% over [N] trades
  Status: [✓ PASS / ✗ FAIL]

✓ Gate 2: P&L ≥ $0
  Actual: $[X] cumulative
  Status: [✓ PASS / ✗ FAIL]

✓ Gate 3: Max Drawdown ≤ 15%
  Actual: [X]% of peak capital
  Status: [✓ PASS / ✗ FAIL]

✓ Gate 4: Execution Quality ≥ 80%
  Actual: [X]% GOOD/EXCELLENT trades
  Status: [✓ PASS / ✗ FAIL]

✓ Gate 5: Circuit Breaker No False Positives
  Halt events: [N] (all legitimate)
  Caution events: [N] (all legitimate)
  Status: [✓ PASS / ✗ FAIL]

✓ Gate 6: Zero Critical Errors
  Exception count: [N]
  Status: [✓ PASS / ✗ FAIL]

═════════════════════════════════════════════════════════════
OVERALL DECISION: [✓ GO TO $500 / ✗ NO-GO - HOLD AT $250]
═════════════════════════════════════════════════════════════
```

If ANY gate is NOT passed, DO NOT scale. Hold at $250 and continue trading.

### Scaling Procedure (Day 11 - 08:00 UTC)

#### Step 1: Deploy New Capital (08:00-08:15)

```bash
# Update total capital to $500
sqlite3 paul-p.db "UPDATE accounts SET total_capital=500, available_capital=500 WHERE id=1"

# Verify update
sqlite3 paul-p.db "SELECT total_capital, available_capital FROM accounts WHERE id=1"
# Expected: 500, 500

# Redeploy allocation
npm run config:set strategy_bonding_capital 350
npm run config:set strategy_weather_capital 150

# Verify allocations
sqlite3 paul-p.db "SELECT strategy, capital FROM strategy_capital"
# Expected:
#   BONDING, 350
#   WEATHER, 150
```

#### Step 2: Verify Risk Limits (08:15-08:30)

```bash
# Verify max position size recalculated
sqlite3 paul-p.db "SELECT max_position_size FROM risk_limits WHERE id=1"
# Expected: 25 (5% of $500)

# Verify drawdown budget updated
sqlite3 paul-p.db "SELECT max_drawdown FROM risk_limits WHERE id=1"
# Expected: 75 (15% of $500)

# Verify position limits not breached
sqlite3 paul-p.db "SELECT SUM(position_size) FROM positions WHERE status='open'"
# Expected: < 25 (new position size cap)
```

#### Step 3: Test New Capital with Small Orders (08:30-09:00)

```bash
# Place test order to verify new sizing
# Expected: Single order size should be ~$5-10 (2% of $500, smaller than 5% max)

# Monitor for:
# - Order fills successfully
# - No risk invariants triggered
# - Execution quality normal
```

#### Step 4: Monitor First 4 Hours (09:00-13:00)

```bash
# Check every 30 minutes:
# - Positions opening correctly
# - No unexpected closures
# - Circuit breaker stays NORMAL
# - P&L tracking correctly

# Dashboard should show:
# - Total capital: $500
# - Available capital: $500 - (reserved for open positions)
# - Open positions: [N] (should be similar to Day 10 levels)
```

#### Step 5: End-of-Day Verification (16:00)

```bash
# Reconcile capital:
sqlite3 paul-p.db "
  SELECT
    total_capital,
    available_capital,
    SUM(position_size) as reserved,
    (total_capital - SUM(position_size)) as reconciled
  FROM accounts a
  JOIN positions p ON 1=1
  WHERE a.id=1
"
# All numbers should reconcile correctly
```

---

## Day 25: $500 → $1K Scaling Procedure

### Prerequisites (Day 20 Evening)

Verify similar gates as Day 10, but with $500 capital baseline:

```
PHASE E TIER 1 GATE VERIFICATION (Day 20 Evening)
═════════════════════════════════════════════════════════════

✓ Gate 1: Win Rate ≥ 50%
  10-day win rate (Days 11-20): [X]%

✓ Gate 2: P&L ≥ $0
  10-day realized P&L (Days 11-20): $[X]
  Cumulative (Days 1-20): $[X]

✓ Gate 3: Max Drawdown ≤ 15%
  10-day max DD (Days 11-20): [X]%
  Cumulative max DD (Days 1-20): [X]%

✓ Gate 4: Sharpe Ratio > 1.0
  10-day Sharpe (Days 11-20): [X]
  (Indicates consistent risk-adjusted returns)

✓ Gate 5: Execution Quality ≥ 80%
  10-day average: [X]%

✓ Gate 6: No New Issues
  Circuit breaker events (Days 11-20): [N] legitimate
  Exceptions: [N]

═════════════════════════════════════════════════════════════
OVERALL DECISION: [✓ GO TO $1K / ✗ HOLD AT $500]
═════════════════════════════════════════════════════════════
```

### Scaling Procedure (Day 21 - 08:00 UTC)

Similar to Day 15 procedure:

```bash
# Step 1: Update capital
sqlite3 paul-p.db "UPDATE accounts SET total_capital=1000 WHERE id=1"

# Step 2: Update allocations
npm run config:set strategy_bonding_capital 700
npm run config:set strategy_weather_capital 300

# Step 3: Verify new position cap ($50 max, 5% of $1K)
sqlite3 paul-p.db "SELECT max_position_size FROM risk_limits WHERE id=1"
# Expected: 50

# Step 4: Verify new drawdown budget ($150, 15% of $1K)
sqlite3 paul-p.db "SELECT max_drawdown FROM risk_limits WHERE id=1"
# Expected: 150

# Step 5: Test with small orders and monitor
```

---

## Day 31+: Conditional Scaling to $5K+

After Day 25, if continued success:

### Entry Gates for $5K

- **Duration of Success**: 20+ consecutive days with:
  - Win rate ≥ 50%
  - Cumulative P&L ≥ $25+ (profitable)
  - Max drawdown ≤ 10% (tighter than initial)
  - Sharpe ratio > 1.0 (consistent edge)
  - Zero circuit breaker false positives
  - Zero critical errors

- **Risk Assessment**: Increase capital only if:
  - Edge remains consistent across different market conditions
  - No regime changes detected
  - Volatility within expected ranges
  - Execution quality stable

### Scaling Decision Matrix

| Current Capital | Duration @ Success | Sharpe > 1.0? | Max DD < 10%? | Scale To | Logic |
|-----------------|---|---|---|---|---|
| $1K | 5 days | ✓ | ✓ | $2K | Conservative: more data needed |
| $1K | 10 days | ✓ | ✓ | $2.5K | Moderate: increasing confidence |
| $1K | 20+ days | ✓ | ✓ | $5K | Aggressive: high confidence |
| $1K | 20+ days | ✓ | ✗ | $1.5K | Cautious: drawdown slightly high |
| $1K | 20+ days | ✗ | ✓ | Hold | Edge inconsistent, don't scale |

### Scaling Procedure for $5K+

Process is identical to previous scaling steps:
1. Update total_capital in accounts
2. Recalculate strategy allocations (70/30)
3. Verify position size caps (5% of new total)
4. Verify drawdown budget (15% of new total)
5. Test with small orders
6. Monitor first 4 hours
7. End-of-day reconciliation

---

## Continuous Monitoring (All Phases)

### Daily Metrics Dashboard

**Every morning** (before market open):

```
PHASE E DAILY MONITORING
═════════════════════════════════════════════════════════════

Date: [YYYY-MM-DD]
Capital: $[X]
Circuit Breaker: [NORMAL/CAUTION/HALT]

Previous Day Results:
  - Trades: [N] executed, [N] won, [N] lost
  - Win rate: [X]%
  - Daily P&L: $[X]
  - Slippage avg: [X]¢ ([X]% of edge)
  - Execution grade: [DISTRIBUTION: E/G/A/P]

Cumulative Results (Days 1-[N]):
  - Total trades: [N]
  - Overall win rate: [X]%
  - Cumulative P&L: $[X]
  - Max drawdown so far: [X]%
  - Sharpe ratio: [X]

Market Conditions:
  - Kalshi markets checked: [N]
  - Signals generated: [N]
  - Orders submitted: [N]

Risk Controls Status:
  - Position limits: [✓ OK / ✗ BREACHED]
  - Tail concentration: [Herfindahl X.XX] [✓ <0.3 / ✗ >0.3]
  - Drawdown budget: $[X] used / $[X] available
  - Circuit breaker events: [N]

Issues/Alerts:
  - [None / List any alerts or anomalies]

═════════════════════════════════════════════════════════════
```

### Weekly Review (Every Sunday)

```
PHASE E WEEKLY REVIEW
═════════════════════════════════════════════════════════════

Week: [W] (Days [start]-[end])
Capital: $[X]

Performance Metrics:
  - Trades this week: [N]
  - Win rate: [X]%
  - Weekly P&L: $[X]
  - Cumulative P&L: $[X]
  - Sharpe ratio: [X]
  - Max DD: [X]%

Risk Assessment:
  - Circuit breaker HALT events: [N]
  - Circuit breaker CAUTION events: [N]
  - Position limits breaches: [N]
  - Slippage incidents: [N]
  - Execution quality degradation: [Y/N]

Strategy Performance:
  - Bonding allocation ($[X]): [X]% win rate, $[X] P&L
  - Weather allocation ($[X]): [X]% win rate, $[X] P&L

Market Conditions Observed:
  - [Observation 1]
  - [Observation 2]
  - [Notable market moves or conditions]

Decisions Made:
  - [ ] Continue normal operations
  - [ ] Adjust position sizing
  - [ ] Review signal quality
  - [ ] Check for regime changes

═════════════════════════════════════════════════════════════
```

### Monthly Deep Dive (Every 30 Days)

```
PHASE E MONTHLY ANALYSIS
═════════════════════════════════════════════════════════════

Month: [YYYY-MM]
Capital Range: $[start] → $[end]

Performance Summary:
  - Total trades: [N]
  - Win rate: [X]%
  - Monthly P&L: $[X]
  - Cumulative P&L (all time): $[X]
  - Sharpe ratio: [X]
  - Max drawdown: [X]%
  - Return on capital: [X]% (P&L / starting capital)

Risk Summary:
  - Average position size: $[X]
  - Max position size: $[X]
  - Tail concentration (avg): [X]%
  - Slippage (avg): [X]¢
  - Circuit breaker events: [N] (all legitimate)

Scaling Decisions:
  - [ ] Scale capital upward (gate: [gate name] passed)
  - [ ] Hold at current capital (gate: [gate name] borderline)
  - [ ] Scale downward (gate: [gate name] failed)

Strategic Insights:
  - [Insight about signal quality]
  - [Insight about execution]
  - [Insight about market conditions]

Next Month Targets:
  - Win rate: ≥ [X]% (vs this month [X]%)
  - P&L: ≥ $[X] (vs this month $[X])
  - Sharpe: ≥ [X] (vs this month [X])
  - Drawdown: ≤ [X]% (vs this month [X]%)

═════════════════════════════════════════════════════════════
```

---

## Long-Term Operations (30+ Days)

### Risk Management Evolution

As capital scales, risk management becomes more critical:

**$250-$1K (Days 1-30)**:
- Hard position size cap: 5% max
- Tail concentration limit: Herfindahl < 0.3
- Daily loss limit: 10% of capital
- Drawdown budget: 15% of capital
- Circuit breaker: Standard thresholds

**$1K-$5K (Days 31-60)**:
- Position size cap: 3-5% (tighten as capital grows)
- Tail concentration: Herfindahl < 0.25 (stricter)
- Daily loss limit: 5-10% (scale-dependent)
- Drawdown budget: 10% (tighter than early phase)
- Circuit breaker: More sensitive detection

**$5K+ (Day 61+)**:
- Position size cap: 2-3% (much tighter)
- Tail concentration: Herfindahl < 0.2 (very strict)
- Daily loss limit: 5% (prevent large swings)
- Drawdown budget: 10% hard stop
- Circuit breaker: Ultra-sensitive for large capital
- Volatility-based position sizing (reduce in high-vol regimes)

### Stress Testing (Monthly)

Every 30 days, simulate adverse scenarios:

1. **Black Swan Event** (10% market move):
   - Verify stop-losses trigger correctly
   - Confirm circuit breaker catches excess losses
   - Validate drawdown stays < limit

2. **Execution Stress** (3x normal slippage):
   - Verify order sizing adjusts down
   - Confirm kill switch prevents over-slippage
   - Validate execution quality remains acceptable

3. **Volatility Spike** (2x normal VPIN):
   - Verify position sizes reduce automatically
   - Confirm circuit breaker throttles positions
   - Validate trading continues safely

---

## Decision Rules for Scaling Beyond $5K

Once capital exceeds $5K, scaling follows these rules:

### Conservative Rule (Recommended)
- Scale by 20% if: Sharpe > 1.5 for 20+ consecutive days
- Example: $5K → $6K, $6K → $7.2K, etc.
- Benefit: Steady growth with safety margin
- Drawback: Slow capital accumulation

### Moderate Rule
- Scale by 50% if: Sharpe > 1.2 for 20+ days AND no DD > 8%
- Example: $5K → $7.5K, $7.5K → $11.25K, etc.
- Benefit: Faster capital growth
- Drawback: More risk of volatility killing scaling momentum

### Aggressive Rule (Not Recommended for $250 → $5K)
- Scale by 100% if: Sharpe > 1.0 for 30+ days AND DD < 5%
- Example: $5K → $10K immediately
- Benefit: Exponential growth potential
- Drawback: High risk if edge erodes

**Recommendation for Paul P**: Use **Conservative Rule** through $10K, then evaluate for acceleration.

---

## Maintenance & Support

### Monthly Checklist

- [ ] Review all 17 risk invariants still triggering correctly
- [ ] Audit compliance with position limits
- [ ] Validate capital allocation (70/30 Bonding/Weather)
- [ ] Check dashboard accuracy against trade log
- [ ] Verify execution policy still optimal
- [ ] Review cost metrics (fees, slippage)
- [ ] Test disaster recovery procedures
- [ ] Update documentation with recent performance

### Quarterly Deep Dive

- [ ] Backtest current allocation against historical data
- [ ] Analyze strategy correlation (are they still uncorrelated?)
- [ ] Stress test with worst historical scenarios
- [ ] Review signal quality and evolution
- [ ] Assess market regime changes
- [ ] Plan next scaling tier
- [ ] Update risk limits based on realized volatility

---

## Success Scenarios

### Best Case (Strong Signal, Consistent Edge)
- Win rate holds at 60%+ (well above 50% gate)
- Sharpe grows to 2.0+ (very strong risk-adjusted returns)
- Scaling schedule: $250 (Day 1) → $500 (Day 15) → $1K (Day 25) → $5K (Day 60) → $10K (Day 90)
- 90-day capital: $10K
- 90-day P&L: $1K+ profit (100%+ return on initial $250)

### Base Case (Normal Signal Quality)
- Win rate holds at 55% (steady above gate)
- Sharpe stabilizes at 1.2-1.5 (good risk-adjusted returns)
- Scaling schedule: $250 → $500 → $1K → $2.5K (hold longer) → $5K (Day 70)
- 90-day capital: $5K
- 90-day P&L: $500+ profit (200% return on initial $250)

### Worst Case (Edge Erodes)
- Win rate drops to 52% (barely above gate)
- Sharpe remains ~1.0 (marginal risk-adjusted returns)
- Scaling schedule: $250 → $500 → HOLD (extended validation) → $750 (Day 60)
- 90-day capital: $750
- 90-day P&L: $100+ profit (40% return on initial $250)

---

## End State (Day 90+)

After 90 days of successful operation at $5K+ capital with consistent edge:

- System is proven to be genuinely profitable
- Capital has grown 10-20x (depending on strategy)
- Risk controls have validated themselves thoroughly
- Team has deep operational experience
- Ready to either:
  1. **Exit & Harvest**: Close positions, take profits, move to next project
  2. **Perpetual Operation**: Continue indefinitely with monthly scaling
  3. **Institutionalize**: Turn into fund or managed account

---

**Phase E Success Definition**:
Consistent daily profits with capital growing 10-100x while maintaining <15% drawdown and >50% win rate over 90+ days. This validates that edge is real, not lucky.

---

**Next Step After Phase E Day 90**:
Determine end-state strategy (harvest, perpetual, or institutionalize).
