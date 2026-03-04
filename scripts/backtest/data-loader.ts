/**
 * Paul P - Backtest Data Loader
 * Loads and normalizes historical market data for backtesting
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import type { HistoricalMarket, Candlestick, MarketSnapshot } from './types';

const DATA_DIR = './data/kalshi-historical';

// ============================================================
// RAW DATA TYPES (from Kalshi API)
// ============================================================

interface RawMarket {
  ticker: string;
  event_ticker?: string;
  title?: string;
  rules_primary?: string;
  rules_secondary?: string;
  category?: string;
  series_ticker?: string;
  open_time?: string;
  close_time?: string;
  settlement_ts?: string;
  status?: string;
  result?: string;
  last_price?: number;
  volume?: number;
  open_interest?: number;
}

interface RawCandlestick {
  end_period_ts: number;
  price: {
    open: string | null;
    high: string | null;
    low: string | null;
    close: string | null;
    mean?: string | null;
  };
  volume: string;
  open_interest: string;
  yes_bid: { open: string; close: string; high?: string; low?: string };
  yes_ask: { open: string; close: string; high?: string; low?: string };
}

// ============================================================
// DATA LOADING
// ============================================================

/**
 * Find the most recent data files in the data directory
 */
export function findLatestDataFiles(): { marketsFile: string; candlesticksFile: string } | null {
  if (!existsSync(DATA_DIR)) {
    console.error(`Data directory not found: ${DATA_DIR}`);
    return null;
  }

  const files = readdirSync(DATA_DIR);

  const marketsFiles = files.filter((f) => f.startsWith('markets-') && f.endsWith('.json')).sort();
  const candlesticksFiles = files.filter((f) => f.startsWith('candlesticks-') && f.endsWith('.json')).sort();

  if (marketsFiles.length === 0 || candlesticksFiles.length === 0) {
    console.error('No data files found. Run download-kalshi-historical.ts first.');
    return null;
  }

  return {
    marketsFile: `${DATA_DIR}/${marketsFiles[marketsFiles.length - 1]}`,
    candlesticksFile: `${DATA_DIR}/${candlesticksFiles[candlesticksFiles.length - 1]}`,
  };
}

/**
 * Load and normalize markets from JSON file
 */
export function loadMarkets(filePath: string): HistoricalMarket[] {
  console.log(`Loading markets from ${filePath}...`);

  const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as RawMarket[];

  const markets: HistoricalMarket[] = raw
    .filter((m) => m.result && (m.result === 'yes' || m.result === 'no'))
    .map((m) => ({
      ticker: m.ticker,
      eventTicker: m.event_ticker || '',
      title: m.title || '',
      rulesText: (m.rules_primary || '') + (m.rules_secondary ? '\n' + m.rules_secondary : ''),
      category: m.category || 'unknown',
      seriesTicker: m.series_ticker || '',
      openTime: m.open_time || '',
      closeTime: m.close_time || '',
      settlementTime: m.settlement_ts || '',
      status: normalizeStatus(m.status),
      result: m.result as 'yes' | 'no',
      lastPrice: (m.last_price ?? 0) / 100, // Convert from cents
      volume: m.volume ?? 0,
      openInterest: m.open_interest ?? 0,
    }));

  console.log(`  Loaded ${markets.length} markets with valid results`);
  return markets;
}

function normalizeStatus(status?: string): 'finalized' | 'settled' | 'voided' {
  if (status === 'finalized' || status === 'settled') return status;
  if (status === 'voided') return 'voided';
  return 'finalized';
}

/**
 * Load and normalize candlesticks from JSON file
 */
export function loadCandlesticks(filePath: string): Map<string, Candlestick[]> {
  console.log(`Loading candlesticks from ${filePath}...`);

  const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, RawCandlestick[]>;

  const candlesticks = new Map<string, Candlestick[]>();

  for (const [ticker, candles] of Object.entries(raw)) {
    const normalized = candles.map((c) => {
      const yesBid = parseFloat(c.yes_bid.close);
      const yesAsk = parseFloat(c.yes_ask.close);

      // Use price.close if available, otherwise derive from bid/ask midpoint
      let close = c.price.close ? parseFloat(c.price.close) : null;
      if (close === null && yesBid > 0 && yesAsk > 0 && yesAsk < 1) {
        close = (yesBid + yesAsk) / 2;
      }

      return {
        endPeriodTs: c.end_period_ts,
        open: c.price.open ? parseFloat(c.price.open) : null,
        high: c.price.high ? parseFloat(c.price.high) : null,
        low: c.price.low ? parseFloat(c.price.low) : null,
        close,
        volume: parseFloat(c.volume),
        openInterest: parseFloat(c.open_interest),
        yesBid,
        yesAsk,
      };
    });

    candlesticks.set(ticker, normalized);
  }

  console.log(`  Loaded candlesticks for ${candlesticks.size} markets`);
  return candlesticks;
}

// ============================================================
// DATA FILTERING
// ============================================================

export interface FilterOptions {
  // Date range
  startDate?: string;
  endDate?: string;

  // Market type
  categories?: string[];
  seriesTickers?: string[];
  tickerPrefixes?: string[];

  // Volume
  minVolume?: number;
  minOpenInterest?: number;

  // Result
  results?: ('yes' | 'no')[];
}

/**
 * Filter markets based on criteria
 */
export function filterMarkets(markets: HistoricalMarket[], options: FilterOptions): HistoricalMarket[] {
  return markets.filter((m) => {
    // Date range
    if (options.startDate && m.settlementTime < options.startDate) return false;
    if (options.endDate && m.settlementTime > options.endDate) return false;

    // Categories
    if (options.categories && !options.categories.includes(m.category)) return false;

    // Series
    if (options.seriesTickers && !options.seriesTickers.includes(m.seriesTicker)) return false;

    // Ticker prefixes
    if (options.tickerPrefixes) {
      const hasPrefix = options.tickerPrefixes.some((p) => m.ticker.startsWith(p));
      if (!hasPrefix) return false;
    }

    // Volume
    if (options.minVolume && m.volume < options.minVolume) return false;
    if (options.minOpenInterest && m.openInterest < options.minOpenInterest) return false;

    // Results
    if (options.results && m.result && !options.results.includes(m.result)) return false;

    return true;
  });
}

// ============================================================
// SNAPSHOT GENERATION
// ============================================================

/**
 * Generate price snapshots from candlesticks
 * Returns snapshots sorted by timestamp
 */
export function generateSnapshots(
  market: HistoricalMarket,
  candlesticks: Candlestick[]
): MarketSnapshot[] {
  return candlesticks
    .filter((c) => c.close !== null)
    .map((c) => {
      const midPrice = (c.yesBid + c.yesAsk) / 2;
      const spread = c.yesAsk - c.yesBid;

      return {
        timestamp: new Date(c.endPeriodTs * 1000).toISOString(),
        ticker: market.ticker,
        yesBid: c.yesBid,
        yesAsk: c.yesAsk,
        midPrice,
        spread,
        volume24h: c.volume,
        depth: c.openInterest,
      };
    })
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

// ============================================================
// CLOSING LINE COMPUTATION
// ============================================================

export interface ClosingLineResult {
  closingLinePrice: number;
  qualityScore: number;
  method: string;
  dataPoints: number;
}

/**
 * Compute closing line price using TWAP methodology
 * Based on blueprint P-17: Robust Closing Line Estimation
 */
export function computeClosingLine(
  market: HistoricalMarket,
  candlesticks: Candlestick[],
  windowMinutes: number = 60
): ClosingLineResult | null {
  if (!candlesticks || candlesticks.length === 0) {
    return null;
  }

  // Find settlement timestamp
  const settlementTs = new Date(market.settlementTime).getTime() / 1000;

  // Get candlesticks within the closing window
  const windowStart = settlementTs - windowMinutes * 60;
  const closingCandles = candlesticks.filter(
    (c) => c.endPeriodTs >= windowStart && c.endPeriodTs <= settlementTs
  );

  if (closingCandles.length === 0) {
    return null;
  }

  // Filter out low-quality data points (wide spreads, low depth)
  const validCandles = closingCandles.filter((c) => {
    const spread = c.yesAsk - c.yesBid;
    const depth = c.openInterest;
    return spread < 0.15 && depth >= 50; // 15% max spread, $50 min depth
  });

  if (validCandles.length === 0) {
    // Fallback to all candles if no valid ones
    return computeTwap(closingCandles, 'fallback_all');
  }

  return computeTwap(validCandles, 'robust_twap');
}

function computeTwap(candles: Candlestick[], method: string): ClosingLineResult {
  // Compute depth-weighted TWAP
  let sumWeightedPrice = 0;
  let sumWeights = 0;

  for (const c of candles) {
    if (c.close === null) continue;

    const weight = Math.min(c.openInterest, 500); // Cap weight to prevent outliers
    sumWeightedPrice += c.close * weight;
    sumWeights += weight;
  }

  const closingLinePrice = sumWeights > 0 ? sumWeightedPrice / sumWeights : candles[candles.length - 1]?.close ?? 0;

  // Compute quality score
  const avgDepth = candles.reduce((sum, c) => sum + c.openInterest, 0) / candles.length;
  const avgSpread = candles.reduce((sum, c) => sum + (c.yesAsk - c.yesBid), 0) / candles.length;
  const priceStdDev = computeStdDev(candles.filter((c) => c.close !== null).map((c) => c.close!));

  // Quality score factors (per blueprint P-17)
  let qualityScore = 0;

  // Depth factor (40%)
  if (avgDepth > 500) qualityScore += 0.4;
  else if (avgDepth > 100) qualityScore += 0.28;
  else if (avgDepth > 50) qualityScore += 0.16;

  // Spread factor (30%)
  if (avgSpread < 0.03) qualityScore += 0.3;
  else if (avgSpread < 0.08) qualityScore += 0.21;
  else if (avgSpread < 0.15) qualityScore += 0.09;

  // Sample count factor (20%)
  if (candles.length > 10) qualityScore += 0.2;
  else if (candles.length >= 5) qualityScore += 0.12;
  else qualityScore += 0.04;

  // Stability factor (10%)
  if (priceStdDev < 0.02) qualityScore += 0.1;
  else if (priceStdDev < 0.05) qualityScore += 0.05;
  else qualityScore += 0.02;

  return {
    closingLinePrice,
    qualityScore,
    method,
    dataPoints: candles.length,
  };
}

function computeStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// ============================================================
// DATA SUMMARY
// ============================================================

export interface DataSummary {
  totalMarkets: number;
  marketsWithCandlesticks: number;
  dateRange: { earliest: string; latest: string };
  resultDistribution: { yes: number; no: number };
  volumeStats: { min: number; max: number; median: number; mean: number };
  categoryBreakdown: Record<string, number>;
  seriesBreakdown: Record<string, number>;
}

/**
 * Generate summary statistics for loaded data
 */
export function summarizeData(
  markets: HistoricalMarket[],
  candlesticks: Map<string, Candlestick[]>
): DataSummary {
  const volumes = markets.map((m) => m.volume).sort((a, b) => a - b);

  const categoryBreakdown: Record<string, number> = {};
  const seriesBreakdown: Record<string, number> = {};

  for (const m of markets) {
    categoryBreakdown[m.category] = (categoryBreakdown[m.category] || 0) + 1;

    const prefix = m.ticker.split('-')[0];
    seriesBreakdown[prefix] = (seriesBreakdown[prefix] || 0) + 1;
  }

  return {
    totalMarkets: markets.length,
    marketsWithCandlesticks: candlesticks.size,
    dateRange: {
      earliest: markets.map((m) => m.settlementTime).filter(Boolean).sort()[0] || 'N/A',
      latest: markets.map((m) => m.settlementTime).filter(Boolean).sort().pop() || 'N/A',
    },
    resultDistribution: {
      yes: markets.filter((m) => m.result === 'yes').length,
      no: markets.filter((m) => m.result === 'no').length,
    },
    volumeStats: {
      min: volumes[0] || 0,
      max: volumes[volumes.length - 1] || 0,
      median: volumes[Math.floor(volumes.length / 2)] || 0,
      mean: volumes.reduce((a, b) => a + b, 0) / volumes.length || 0,
    },
    categoryBreakdown,
    seriesBreakdown,
  };
}
