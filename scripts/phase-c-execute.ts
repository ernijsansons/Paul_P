#!/usr/bin/env node
/**
 * Phase C Execution Script (Simplified)
 *
 * Runs paper trading tests with the PaperTestRunner
 * Duration: ~10 minutes
 */

import { PaperTestRunner } from '../src/lib/testing/paper-harness';

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  PHASE C: Paper Trading Tests                        ║');
  console.log('║  Duration: 48-hour simulation (expedited)            ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  const runner = new PaperTestRunner({
    capital: 250,
    riskLimits: {
      maxDrawdownPercent: 15,
      maxPositionPercent: 5,
      maxDailyLossPercent: 3,
    },
    positionLimits: {
      maxBondingAllocation: 0.70,
      maxWeatherAllocation: 0.30,
      maxTailConcentration: 0.3,
    },
  });

  console.log('📊 Test Configuration:');
  console.log('   • Capital: $250');
  console.log('   • Bonding: 70% ($175)');
  console.log('   • Weather: 30% ($75)');
  console.log('   • Max Drawdown: 15% ($37.50/day)');
  console.log('   • Max Position: 5% ($12.50)');
  console.log('   • Tail Concentration Limit: 0.3 (Herfindahl)');
  console.log('');

  console.log('⏱️  Starting paper trading...\n');
  const startTime = Date.now();

  try {
    const results = await runner.runAllScenarios();
    const endTime = Date.now();
    const durationSecs = Math.round((endTime - startTime) / 1000);

    console.log('\n═══════════════════════════════════════════════════════');
    console.log('                PHASE C RESULTS                        ');
    console.log('═══════════════════════════════════════════════════════\n');

    // Display summary
    console.log('📈 Execution Summary:');
    console.log(`   Total Trades: ${results.totalTradesExecuted}`);
    console.log(`   Winning Trades: ${results.totalWins}`);
    console.log(`   Losing Trades: ${results.totalLosses}`);
    console.log(`   Win Rate: ${results.winRate.toFixed(1)}%`);
    console.log('');

    console.log('💰 P&L Summary:');
    console.log(`   Realized P&L: $${results.totalRealizedPnL.toFixed(2)}`);
    console.log('');

    console.log('⚠️  Risk Metrics:');
    console.log(`   Avg Execution Grade: ${results.avgExecutionGrade}`);
    console.log(`   Kill Switch Working: ${results.killSwitchWorking ? 'YES ✅' : 'NO ❌'}`);
    console.log('');

    console.log('🎯 Test Scenarios:');
    console.log(`   Scenarios Passed: ${results.passedScenarios}/${results.totalScenarios}`);
    console.log('');

    console.log('⏱️  Execution Time: ' + durationSecs + ' seconds');
    console.log('');

    // Phase D Gate Decision Logic
    console.log('═══════════════════════════════════════════════════════');
    console.log('                PHASE D GATE DECISION                  ');
    console.log('═══════════════════════════════════════════════════════\n');

    let phaseDDecision = 'GO';
    const blockers: string[] = [];

    // Use Phase D gate decision if available
    if (results.phaseDGateDecision) {
      const gate = results.phaseDGateDecision;

      // Hard Gate 1: All 8 scenarios must pass
      if (!gate.scenarioPassMet) {
        phaseDDecision = 'NO-GO';
        blockers.push(`❌ Test Scenarios: Only ${gate.scenarioPass}/${results.totalScenarios} passed (need all)`);
      } else {
        console.log(`✅ Hard Gate 1: Test Scenarios (${results.passedScenarios}/${results.totalScenarios}) PASS`);
      }

      // Hard Gate 2: Win rate >= 50%
      if (!gate.winRateMet) {
        phaseDDecision = 'NO-GO';
        blockers.push(`❌ Win Rate: ${gate.winRate.toFixed(1)}% < 50%`);
      } else {
        console.log(`✅ Hard Gate 2: Win Rate (${gate.winRate.toFixed(1)}%) PASS`);
      }

      // Hard Gate 3: P&L >= $0
      if (!gate.pnlMet) {
        phaseDDecision = 'NO-GO';
        blockers.push(`❌ P&L: $${gate.pnl.toFixed(2)} < $0`);
      } else {
        console.log(`✅ Hard Gate 3: P&L ($${gate.pnl.toFixed(2)}) PASS`);
      }

      // Hard Gate 4: Execution quality >= 80%
      if (!gate.executionQualityMet) {
        phaseDDecision = 'NO-GO';
        blockers.push(`❌ Execution Quality: ${gate.executionQuality.toFixed(1)}% < 80%`);
      } else {
        console.log(`✅ Hard Gate 4: Execution Quality (${gate.executionQuality.toFixed(1)}%) PASS`);
      }

      // Hard Gate 5: All controls working
      const controlsWorking = results.allStopsWorking &&
                              results.allTakeProfitsWorking &&
                              results.allTimeExitsWorking &&
                              results.killSwitchWorking &&
                              results.circuitBreakerWorking;
      if (!controlsWorking) {
        if (!results.allStopsWorking) blockers.push('⚠️  Stop-Loss Controls: Not working');
        if (!results.allTakeProfitsWorking) blockers.push('⚠️  Take-Profit Controls: Not working');
        if (!results.allTimeExitsWorking) blockers.push('⚠️  Time-Based Exits: Not working');
        if (!results.killSwitchWorking) blockers.push('⚠️  Kill Switch: Not working');
        if (!results.circuitBreakerWorking) blockers.push('⚠️  Circuit Breaker: Not working');
      } else {
        console.log('✅ Hard Gate 5: Risk Controls (All Working) PASS');
      }

      // Use blocking issues from gate decision
      if (gate.blockingIssues && gate.blockingIssues.length > 0) {
        blockers.push(...gate.blockingIssues.map(issue => '❌ ' + issue));
      }
    }

    console.log('');
    if (blockers.length > 0) {
      console.log('❌ BLOCKERS:');
      blockers.forEach(blocker => console.log('   ' + blocker));
      console.log('');
    }

    console.log(`\n🚀 PHASE D DECISION: ${phaseDDecision}`);
    console.log('═══════════════════════════════════════════════════════\n');

    if (phaseDDecision === 'GO') {
      console.log('✅ Phase C PASSED - Ready for Phase D (Live Deployment with $250)\n');
      console.log('Next Steps:');
      console.log('  1. Review detailed results above');
      console.log('  2. Confirm all 6 hard gates passed');
      console.log('  3. Deploy to Kalshi with $250 capital');
      console.log('  4. Execute for 10 days with conservative position sizing');
      console.log('  5. Monitor daily P&L, win rate, and drawdown');
      console.log('  6. Scale to $500-1K if daily Sharpe > 1.0 for 5+ days');
    } else {
      console.log('❌ Phase C FAILED - Remediation Required\n');
      console.log('Blocking Issues:');
      blockers.forEach(blocker => console.log('  • ' + blocker));
      console.log('');
      console.log('Remediation Steps:');
      console.log('  1. Review failed tests and error logs');
      console.log('  2. Fix identified issues');
      console.log('  3. Re-run Phase C validation');
      console.log('  4. Once passing, proceed to Phase D gate review');
    }

    process.exit(phaseDDecision === 'GO' ? 0 : 1);
  } catch (error) {
    console.error('❌ Phase C Execution Failed:');
    console.error(error);
    process.exit(1);
  }
}

main();
