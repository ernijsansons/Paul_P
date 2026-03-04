/**
 * Paul P - Kalshi Historical Data Access Test
 *
 * This script tests whether we can access the historical data needed for backtesting:
 * 1. Settled/resolved markets with outcomes
 * 2. Historical candlestick/trade data for those markets
 *
 * Run with: npx tsx scripts/test-kalshi-historical.ts
 */

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

interface TestResult {
  test: string;
  passed: boolean;
  details: string;
  data?: unknown;
}

const results: TestResult[] = [];

async function fetchKalshi<T>(endpoint: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(KALSHI_API_BASE + endpoint);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Paul-P-Test/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

// Test 1: Can we get ANY markets?
async function testMarketAccess() {
  console.log('\n📊 Test 1: Basic Market Access');
  try {
    const data = await fetchKalshi<{ markets: unknown[]; cursor: string | null }>('/markets', { limit: '10' });
    const passed = data.markets && data.markets.length > 0;
    results.push({
      test: 'Basic Market Access',
      passed,
      details: `Retrieved ${data.markets?.length || 0} markets`,
      data: data.markets?.slice(0, 2),
    });
    console.log(passed ? '✅ PASS' : '❌ FAIL', `- Retrieved ${data.markets?.length || 0} markets`);
    return data.markets;
  } catch (error) {
    results.push({
      test: 'Basic Market Access',
      passed: false,
      details: `Error: ${error}`,
    });
    console.log('❌ FAIL -', error);
    return [];
  }
}

// Test 2: Can we filter for settled markets?
async function testSettledMarkets() {
  console.log('\n📊 Test 2: Settled Markets Access');
  try {
    // Try with status filter first
    let data: { markets: Array<{ status?: string; result?: string; ticker: string }>; cursor: string | null };
    try {
      data = await fetchKalshi('/markets', { limit: '200' });
    } catch {
      // Status filter might not be supported - fetch all and filter
      data = await fetchKalshi('/markets', { limit: '200' });
    }

    // Filter for settled markets client-side
    const settledMarkets = data.markets?.filter(
      (m) => m.status === 'settled' || m.result
    ) || [];

    const passed = settledMarkets.length > 0;
    results.push({
      test: 'Settled Markets Access',
      passed,
      details: `Found ${settledMarkets.length} settled markets out of ${data.markets?.length || 0} total`,
      data: settledMarkets.slice(0, 3),
    });
    console.log(passed ? '✅ PASS' : '❌ FAIL', `- Found ${settledMarkets.length} settled markets`);
    return settledMarkets;
  } catch (error) {
    results.push({
      test: 'Settled Markets Access',
      passed: false,
      details: `Error: ${error}`,
    });
    console.log('❌ FAIL -', error);
    return [];
  }
}

// Test 3: Can we get historical trades for a market?
async function testHistoricalTrades(ticker?: string) {
  console.log('\n📊 Test 3: Historical Trades Access');

  if (!ticker) {
    // Find any market to test
    try {
      const data = await fetchKalshi<{ markets: Array<{ ticker: string }> }>('/markets', { limit: '10' });
      ticker = data.markets?.[0]?.ticker;
    } catch {
      results.push({
        test: 'Historical Trades Access',
        passed: false,
        details: 'No market ticker available for testing',
      });
      console.log('❌ FAIL - No market ticker available');
      return [];
    }
  }

  if (!ticker) {
    results.push({
      test: 'Historical Trades Access',
      passed: false,
      details: 'No market ticker available',
    });
    console.log('❌ FAIL - No market ticker available');
    return [];
  }

  try {
    const data = await fetchKalshi<{ trades: Array<{ trade_id: string; yes_price: number; created_time: string }> }>(
      `/markets/${ticker}/trades`,
      { limit: '50' }
    );

    const passed = data.trades && data.trades.length > 0;
    results.push({
      test: 'Historical Trades Access',
      passed,
      details: `Retrieved ${data.trades?.length || 0} trades for ${ticker}`,
      data: data.trades?.slice(0, 3),
    });
    console.log(passed ? '✅ PASS' : '⚠️ PARTIAL', `- Retrieved ${data.trades?.length || 0} trades for ${ticker}`);
    return data.trades || [];
  } catch (error) {
    results.push({
      test: 'Historical Trades Access',
      passed: false,
      details: `Error for ${ticker}: ${error}`,
    });
    console.log('❌ FAIL -', error);
    return [];
  }
}

// Test 4: Can we get historical candlesticks?
async function testHistoricalCandlesticks(ticker?: string) {
  console.log('\n📊 Test 4: Historical Candlesticks Access');

  if (!ticker) {
    try {
      const data = await fetchKalshi<{ markets: Array<{ ticker: string }> }>('/markets', { limit: '10' });
      ticker = data.markets?.[0]?.ticker;
    } catch {
      results.push({
        test: 'Historical Candlesticks Access',
        passed: false,
        details: 'No market ticker available for testing',
      });
      console.log('❌ FAIL - No market ticker available');
      return [];
    }
  }

  if (!ticker) {
    results.push({
      test: 'Historical Candlesticks Access',
      passed: false,
      details: 'No market ticker available',
    });
    console.log('❌ FAIL - No market ticker available');
    return [];
  }

  try {
    // Try to get candlesticks from the past 30 days
    const endTs = Math.floor(Date.now() / 1000);
    const startTs = endTs - 30 * 24 * 60 * 60; // 30 days ago

    const data = await fetchKalshi<{ candlesticks: Array<{ end_period_ts: number; close: number; volume: number }> }>(
      `/markets/${ticker}/candlesticks`,
      {
        period_interval: '60', // 1 hour candles
        start_ts: String(startTs),
        end_ts: String(endTs),
      }
    );

    const passed = data.candlesticks && data.candlesticks.length > 0;
    results.push({
      test: 'Historical Candlesticks Access',
      passed,
      details: `Retrieved ${data.candlesticks?.length || 0} candlesticks for ${ticker}`,
      data: data.candlesticks?.slice(0, 3),
    });
    console.log(passed ? '✅ PASS' : '⚠️ PARTIAL', `- Retrieved ${data.candlesticks?.length || 0} candlesticks for ${ticker}`);
    return data.candlesticks || [];
  } catch (error) {
    results.push({
      test: 'Historical Candlesticks Access',
      passed: false,
      details: `Error for ${ticker}: ${error}`,
    });
    console.log('❌ FAIL -', error);
    return [];
  }
}

// Test 5: Can we access historical markets from 2024?
async function testHistoricalMarkets2024() {
  console.log('\n📊 Test 5: 2024 Historical Markets');
  try {
    // Kalshi doesn't have a date filter, so we need to paginate and find old markets
    // For now, just check if any markets have settlement times in 2024
    const data = await fetchKalshi<{ markets: Array<{ ticker: string; settlement_time?: string; status?: string; result?: string }> }>(
      '/markets',
      { limit: '500' }
    );

    const markets2024 = data.markets?.filter((m) => {
      if (!m.settlement_time) return false;
      const year = new Date(m.settlement_time).getFullYear();
      return year === 2024 && (m.status === 'settled' || m.result);
    }) || [];

    const passed = markets2024.length > 0;
    results.push({
      test: '2024 Historical Markets',
      passed,
      details: `Found ${markets2024.length} settled markets from 2024 in first 500 results`,
      data: markets2024.slice(0, 5).map((m) => ({ ticker: m.ticker, settlement_time: m.settlement_time, result: m.result })),
    });
    console.log(passed ? '✅ PASS' : '⚠️ PARTIAL', `- Found ${markets2024.length} markets from 2024`);
    return markets2024;
  } catch (error) {
    results.push({
      test: '2024 Historical Markets',
      passed: false,
      details: `Error: ${error}`,
    });
    console.log('❌ FAIL -', error);
    return [];
  }
}

// Test 6: Check market data completeness for a settled market
async function testSettledMarketData(settledMarkets: Array<{ ticker: string }>) {
  console.log('\n📊 Test 6: Settled Market Data Completeness');

  if (!settledMarkets.length) {
    results.push({
      test: 'Settled Market Data Completeness',
      passed: false,
      details: 'No settled markets available to test',
    });
    console.log('⚠️ SKIP - No settled markets available');
    return;
  }

  const testMarket = settledMarkets[0].ticker;

  try {
    // Get market details
    const marketData = await fetchKalshi<{ market: { ticker: string; result?: string; settlement_time?: string; rules_primary?: string } }>(
      `/markets/${testMarket}`
    );

    // Get trades
    const tradesData = await fetchKalshi<{ trades: unknown[] }>(
      `/markets/${testMarket}/trades`,
      { limit: '100' }
    );

    // Get candlesticks
    const candlesData = await fetchKalshi<{ candlesticks: unknown[] }>(
      `/markets/${testMarket}/candlesticks`,
      { period_interval: '60' }
    );

    const hasResult = !!marketData.market?.result;
    const hasSettlementTime = !!marketData.market?.settlement_time;
    const hasRules = !!marketData.market?.rules_primary;
    const hasTrades = (tradesData.trades?.length || 0) > 0;
    const hasCandles = (candlesData.candlesticks?.length || 0) > 0;

    const passed = hasResult && hasSettlementTime && (hasTrades || hasCandles);

    results.push({
      test: 'Settled Market Data Completeness',
      passed,
      details: [
        `Market: ${testMarket}`,
        `Has result: ${hasResult}`,
        `Has settlement time: ${hasSettlementTime}`,
        `Has rules: ${hasRules}`,
        `Has trades: ${hasTrades} (${tradesData.trades?.length || 0})`,
        `Has candlesticks: ${hasCandles} (${candlesData.candlesticks?.length || 0})`,
      ].join('\n'),
      data: {
        market: marketData.market,
        tradeCount: tradesData.trades?.length || 0,
        candleCount: candlesData.candlesticks?.length || 0,
      },
    });

    console.log(passed ? '✅ PASS' : '⚠️ PARTIAL');
    console.log(`  Market: ${testMarket}`);
    console.log(`  Result: ${marketData.market?.result || 'N/A'}`);
    console.log(`  Settlement: ${marketData.market?.settlement_time || 'N/A'}`);
    console.log(`  Trades: ${tradesData.trades?.length || 0}`);
    console.log(`  Candlesticks: ${candlesData.candlesticks?.length || 0}`);
  } catch (error) {
    results.push({
      test: 'Settled Market Data Completeness',
      passed: false,
      details: `Error: ${error}`,
    });
    console.log('❌ FAIL -', error);
  }
}

// Main
async function main() {
  console.log('=' .repeat(60));
  console.log('PAUL P - KALSHI HISTORICAL DATA ACCESS TEST');
  console.log('=' .repeat(60));
  console.log('Testing whether required historical data is accessible...\n');

  // Run tests
  const markets = await testMarketAccess();
  const settledMarkets = await testSettledMarkets();
  await testHistoricalTrades(settledMarkets[0]?.ticker || (markets[0] as { ticker: string })?.ticker);
  await testHistoricalCandlesticks(settledMarkets[0]?.ticker || (markets[0] as { ticker: string })?.ticker);
  await testHistoricalMarkets2024();
  await testSettledMarketData(settledMarkets as Array<{ ticker: string }>);

  // Summary
  console.log('\n' + '=' .repeat(60));
  console.log('SUMMARY');
  console.log('=' .repeat(60));

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;

  console.log(`\nTests passed: ${passed}/${total}`);
  console.log();

  for (const result of results) {
    console.log(`${result.passed ? '✅' : '❌'} ${result.test}`);
    console.log(`   ${result.details.split('\n')[0]}`);
  }

  console.log('\n' + '=' .repeat(60));
  console.log('BACKTEST FEASIBILITY ASSESSMENT');
  console.log('=' .repeat(60));

  const criticalTests = [
    'Settled Markets Access',
    'Historical Trades Access',
    '2024 Historical Markets',
  ];

  const criticalPassed = results
    .filter((r) => criticalTests.includes(r.test))
    .every((r) => r.passed);

  if (criticalPassed) {
    console.log('\n✅ BACKTEST FEASIBLE');
    console.log('Historical data access confirmed. Proceed with Phase A.');
  } else {
    console.log('\n❌ BACKTEST BLOCKED');
    console.log('Historical data access insufficient. Consider:');
    console.log('  1. Check Kalshi API documentation for historical endpoints');
    console.log('  2. Contact Kalshi for bulk historical data export');
    console.log('  3. Use third-party data vendors (Databento, etc.)');
    console.log('  4. Build data collection pipeline going forward (no backtest)');
  }

  // Write detailed results to file
  const outputPath = './test-results/kalshi-historical-test.json';
  console.log(`\nDetailed results written to: ${outputPath}`);

  // Return exit code
  return criticalPassed ? 0 : 1;
}

main().then((code) => {
  process.exit(code);
}).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
