import { loadMarkets, loadCandlesticks, findLatestDataFiles, generateSnapshots } from './data-loader';

const files = findLatestDataFiles();
if (!files) process.exit(1);

const markets = loadMarkets(files.marketsFile);
const candlesticks = loadCandlesticks(files.candlesticksFile);

console.log('\nChecking markets with candlesticks:');
let count = 0;
for (const market of markets) {
  const candles = candlesticks.get(market.ticker);
  if (!candles) continue;
  
  const snapshots = generateSnapshots(market, candles);
  
  if (count < 5) {
    console.log(`\n${market.ticker}:`);
    console.log(`  Result: ${market.result}`);
    console.log(`  Candles: ${candles.length}`);
    console.log(`  Snapshots: ${snapshots.length}`);
    if (snapshots.length > 0) {
      console.log(`  First snapshot:`, JSON.stringify(snapshots[0], null, 2).slice(0, 200));
    }
    if (candles.length > 0) {
      console.log(`  First candle close: ${candles[0].close}`);
      console.log(`  First candle yesBid: ${candles[0].yesBid}`);
      console.log(`  First candle yesAsk: ${candles[0].yesAsk}`);
    }
  }
  count++;
}
console.log(`\nTotal markets with candles: ${count}`);
