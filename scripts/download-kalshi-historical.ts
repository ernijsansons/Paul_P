/**
 * Paul P - Kalshi Historical Data Download
 *
 * Downloads settled markets and their candlestick data from Kalshi's historical API.
 * Note: Official API only contains ~1 week of historical data.
 *
 * For full 2024 historical data, consider:
 * 1. PredictionData.dev (paid service, $1000+/month for Kalshi)
 * 2. Build custom scraper using mickbransfield/kalshi as reference
 *
 * Run with: npx tsx scripts/download-kalshi-historical.ts
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const OUTPUT_DIR = './data/kalshi-historical';

interface Market {
  ticker: string;
  event_ticker?: string;
  title?: string;
  status?: string;
  result?: string;
  settlement_ts?: string;
  close_time?: string;
  last_price?: number;
  volume?: number;
  rules_primary?: string;
  category?: string;
  series_ticker?: string;
}

interface Candlestick {
  end_period_ts: number;
  price: {
    open: string | null;
    high: string | null;
    low: string | null;
    close: string | null;
    mean: string | null;
  };
  volume: string;
  open_interest: string;
  yes_bid: {
    open: string;
    close: string;
  };
  yes_ask: {
    open: string;
    close: string;
  };
}

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
      'User-Agent': 'Paul-P/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

async function downloadMarkets(maxPages = 10): Promise<Market[]> {
  console.log('📥 Downloading historical markets...');

  const allMarkets: Market[] = [];
  let cursor: string | undefined;
  let page = 0;

  while (page < maxPages) {
    const params: Record<string, string> = { limit: '1000' };
    if (cursor) params['cursor'] = cursor;

    const data = await fetchKalshi<{ markets: Market[]; cursor: string | null }>(
      '/historical/markets',
      params
    );

    allMarkets.push(...data.markets);
    console.log(`  Page ${page + 1}: ${data.markets.length} markets (total: ${allMarkets.length})`);

    cursor = data.cursor ?? undefined;
    if (!cursor) break;
    page++;

    // Rate limiting
    await new Promise((r) => setTimeout(r, 200));
  }

  return allMarkets;
}

async function downloadCandlesticks(markets: Market[]): Promise<Map<string, Candlestick[]>> {
  console.log('\n📥 Downloading candlesticks for markets...');

  const candlesticksMap = new Map<string, Candlestick[]>();
  let success = 0;
  let failed = 0;

  for (const market of markets) {
    try {
      // Calculate time range based on market settlement
      const settlementTs = market.settlement_ts
        ? Math.floor(new Date(market.settlement_ts).getTime() / 1000)
        : Math.floor(Date.now() / 1000);

      // Get data from 7 days before settlement
      const startTs = settlementTs - 7 * 24 * 60 * 60;

      const data = await fetchKalshi<{ candlesticks: Candlestick[] }>(
        `/historical/markets/${market.ticker}/candlesticks`,
        {
          period_interval: '60', // 1 hour
          start_ts: String(startTs),
          end_ts: String(settlementTs),
        }
      );

      if (data.candlesticks && data.candlesticks.length > 0) {
        candlesticksMap.set(market.ticker, data.candlesticks);
        success++;
      }
    } catch {
      failed++;
    }

    // Progress indicator
    if ((success + failed) % 50 === 0) {
      console.log(`  Progress: ${success + failed}/${markets.length} (${success} success, ${failed} failed)`);
    }

    // Rate limiting
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(`  Complete: ${success} markets with candlesticks, ${failed} failed`);
  return candlesticksMap;
}

function saveData(markets: Market[], candlesticks: Map<string, Candlestick[]>) {
  // Create output directory
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  // Save markets
  const marketsFile = `${OUTPUT_DIR}/markets-${timestamp}.json`;
  writeFileSync(marketsFile, JSON.stringify(markets, null, 2));
  console.log(`\n💾 Saved ${markets.length} markets to ${marketsFile}`);

  // Save candlesticks
  const candlesticksData: Record<string, Candlestick[]> = {};
  for (const [ticker, candles] of candlesticks) {
    candlesticksData[ticker] = candles;
  }
  const candlesFile = `${OUTPUT_DIR}/candlesticks-${timestamp}.json`;
  writeFileSync(candlesFile, JSON.stringify(candlesticksData, null, 2));
  console.log(`💾 Saved candlesticks for ${candlesticks.size} markets to ${candlesFile}`);

  // Save summary
  const summary = {
    downloadedAt: new Date().toISOString(),
    totalMarkets: markets.length,
    marketsWithCandlesticks: candlesticks.size,
    dateRange: {
      earliest: markets.map((m) => m.settlement_ts).filter(Boolean).sort()[0],
      latest: markets.map((m) => m.settlement_ts).filter(Boolean).sort().pop(),
    },
    byResult: {
      yes: markets.filter((m) => m.result === 'yes').length,
      no: markets.filter((m) => m.result === 'no').length,
      other: markets.filter((m) => m.result && m.result !== 'yes' && m.result !== 'no').length,
    },
    byCategory: markets.reduce(
      (acc, m) => {
        const cat = m.category || 'unknown';
        acc[cat] = (acc[cat] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    ),
  };
  const summaryFile = `${OUTPUT_DIR}/summary-${timestamp}.json`;
  writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
  console.log(`💾 Saved summary to ${summaryFile}`);

  return summary;
}

async function main() {
  console.log('=' .repeat(60));
  console.log('PAUL P - KALSHI HISTORICAL DATA DOWNLOAD');
  console.log('=' .repeat(60));
  console.log();

  // Check cutoff
  console.log('📊 Checking historical data cutoff...');
  const cutoff = await fetchKalshi<{
    market_settled_ts: string;
    orders_updated_ts: string;
    trades_created_ts: string;
  }>('/historical/cutoff');
  console.log(`  Markets settled before: ${cutoff.market_settled_ts}`);
  console.log();

  // Download markets
  const markets = await downloadMarkets(10);

  // Filter for settled markets with results
  const settledMarkets = markets.filter(
    (m) => (m.status === 'finalized' || m.status === 'settled') && m.result
  );
  console.log(`\n📊 Found ${settledMarkets.length} settled markets with results`);

  // Download candlesticks for a sample (first 100)
  const sampleMarkets = settledMarkets.slice(0, 100);
  console.log(`📊 Downloading candlesticks for ${sampleMarkets.length} sample markets...`);
  const candlesticks = await downloadCandlesticks(sampleMarkets);

  // Save data
  const summary = saveData(settledMarkets, candlesticks);

  // Print summary
  console.log('\n' + '=' .repeat(60));
  console.log('DOWNLOAD COMPLETE');
  console.log('=' .repeat(60));
  console.log();
  console.log('Summary:');
  console.log(`  Total markets: ${summary.totalMarkets}`);
  console.log(`  Markets with candlesticks: ${summary.marketsWithCandlesticks}`);
  console.log(`  Date range: ${summary.dateRange.earliest} to ${summary.dateRange.latest}`);
  console.log(`  Results: YES=${summary.byResult.yes}, NO=${summary.byResult.no}`);
  console.log();
  console.log('Top categories:');
  const sortedCats = Object.entries(summary.byCategory).sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of sortedCats.slice(0, 5)) {
    console.log(`  ${cat}: ${count}`);
  }

  console.log('\n⚠️  NOTE: Kalshi historical API only contains ~1 week of data.');
  console.log('For full 2024 backtest data, consider:');
  console.log('  1. PredictionData.dev (paid, $1000+/month)');
  console.log('  2. Build custom scraper (see github.com/mickbransfield/kalshi)');
  console.log('  3. Start collecting data now for future backtests');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
