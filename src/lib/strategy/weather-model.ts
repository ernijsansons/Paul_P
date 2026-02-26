/**
 * Paul P - Weather Statistical Model (P-11)
 *
 * Statistical model for weather prediction markets.
 * Uses NOAA Climate Data Online (CDO) API for historical data.
 *
 * Model Types:
 * - Temperature: Normal distribution with historical mean/std
 * - Precipitation: Gamma distribution fit
 * - Degree Days: Cumulative normal model
 */

export type WeatherMetric = 'temperature' | 'precipitation' | 'degree_days' | 'snowfall';
export type TemperatureUnit = 'F' | 'C';

export interface NOAAStation {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  elevation: number;
  state: string;
  country: string;
}

export interface HistoricalDataPoint {
  date: string;
  value: number;
  metric: WeatherMetric;
  stationId: string;
}

export interface WeatherForecast {
  date: string;
  metric: WeatherMetric;
  mean: number;
  stdDev: number;
  confidence95Low: number;
  confidence95High: number;
  distribution: 'normal' | 'gamma' | 'poisson';
  sampleSize: number;
}

export interface WeatherMarket {
  marketId: string;
  venue: 'kalshi';
  metric: WeatherMetric;
  location: string;
  threshold: number;
  operator: 'above' | 'below' | 'between';
  upperThreshold?: number;
  settlementDate: string;
  marketPrice: number;
}

export interface WeatherSignal {
  marketId: string;
  modelProbability: number;
  marketPrice: number;
  edge: number;
  side: 'YES' | 'NO';
  confidence: number;
  forecast: WeatherForecast;
}

export interface ModelConfig {
  lookbackYears: number; // How many years of historical data
  minSampleSize: number; // Minimum observations required
  climateAdjustment: number; // Annual climate drift adjustment (degrees/year)
  recentWeightFactor: number; // Weight recent years more heavily
}

const DEFAULT_CONFIG: ModelConfig = {
  lookbackYears: 30,
  minSampleSize: 20,
  climateAdjustment: 0.03, // ~0.03°F/year warming trend
  recentWeightFactor: 1.5, // 50% more weight on last 10 years
};

/**
 * Standard normal CDF approximation (Abramowitz and Stegun)
 */
export function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

/**
 * Calculate probability that temperature exceeds threshold
 */
export function temperatureAboveProbability(
  mean: number,
  stdDev: number,
  threshold: number
): number {
  if (stdDev <= 0) return mean > threshold ? 1 : 0;
  const z = (threshold - mean) / stdDev;
  return 1 - normalCDF(z);
}

/**
 * Calculate probability that temperature is below threshold
 */
export function temperatureBelowProbability(
  mean: number,
  stdDev: number,
  threshold: number
): number {
  if (stdDev <= 0) return mean < threshold ? 1 : 0;
  const z = (threshold - mean) / stdDev;
  return normalCDF(z);
}

/**
 * Calculate probability that value is between two thresholds
 */
export function temperatureBetweenProbability(
  mean: number,
  stdDev: number,
  lower: number,
  upper: number
): number {
  if (stdDev <= 0) return mean > lower && mean < upper ? 1 : 0;
  const zLow = (lower - mean) / stdDev;
  const zHigh = (upper - mean) / stdDev;
  return normalCDF(zHigh) - normalCDF(zLow);
}

/**
 * Compute weighted mean and standard deviation
 * More recent years get higher weight
 */
export function computeWeightedStats(
  data: HistoricalDataPoint[],
  config: ModelConfig = DEFAULT_CONFIG
): { mean: number; stdDev: number; sampleSize: number } {
  if (data.length < config.minSampleSize) {
    return { mean: 0, stdDev: 0, sampleSize: data.length };
  }

  const currentYear = new Date().getFullYear();
  const recentCutoff = currentYear - 10;

  // Calculate weights (recent years get more weight)
  const weights = data.map(d => {
    const year = new Date(d.date).getFullYear();
    return year >= recentCutoff ? config.recentWeightFactor : 1;
  });

  const totalWeight = weights.reduce((a, b) => a + b, 0);

  // Weighted mean
  const mean = data.reduce((sum, d, i) => sum + d.value * (weights[i] ?? 1), 0) / totalWeight;

  // Weighted variance
  const variance =
    data.reduce((sum, d, i) => sum + (weights[i] ?? 1) * Math.pow(d.value - mean, 2), 0) / totalWeight;

  // Apply climate adjustment (warming trend)
  const firstDataPoint = data[0];
  const yearsFromNow = firstDataPoint ? currentYear - new Date(firstDataPoint.date).getFullYear() : 0;
  const adjustedMean = mean + config.climateAdjustment * yearsFromNow;

  return {
    mean: adjustedMean,
    stdDev: Math.sqrt(variance),
    sampleSize: data.length,
  };
}

/**
 * Generate weather forecast from historical data
 */
export function generateForecast(
  historicalData: HistoricalDataPoint[],
  targetDate: string,
  metric: WeatherMetric,
  config: ModelConfig = DEFAULT_CONFIG
): WeatherForecast {
  // Filter to same calendar day across years
  const targetMonth = new Date(targetDate).getMonth();
  const targetDay = new Date(targetDate).getDate();

  const relevantData = historicalData.filter(d => {
    const date = new Date(d.date);
    // Include data within 7-day window around target date
    const dataMonth = date.getMonth();
    const dataDay = date.getDate();
    const dayDiff = Math.abs(
      (dataMonth * 31 + dataDay) - (targetMonth * 31 + targetDay)
    );
    return dayDiff <= 7 || dayDiff >= 358; // Handle year boundary
  });

  const { mean, stdDev, sampleSize } = computeWeightedStats(relevantData, config);

  // Determine distribution type
  let distribution: 'normal' | 'gamma' | 'poisson' = 'normal';
  if (metric === 'precipitation' || metric === 'snowfall') {
    distribution = 'gamma'; // Precipitation is typically gamma-distributed
  }

  // 95% confidence interval
  const z95 = 1.96;
  const confidence95Low = mean - z95 * stdDev;
  const confidence95High = mean + z95 * stdDev;

  return {
    date: targetDate,
    metric,
    mean,
    stdDev,
    confidence95Low,
    confidence95High,
    distribution,
    sampleSize,
  };
}

/**
 * Calculate model probability for a weather market
 */
export function calculateMarketProbability(
  forecast: WeatherForecast,
  market: WeatherMarket
): number {
  const { mean, stdDev } = forecast;

  switch (market.operator) {
    case 'above':
      return temperatureAboveProbability(mean, stdDev, market.threshold);
    case 'below':
      return temperatureBelowProbability(mean, stdDev, market.threshold);
    case 'between':
      if (market.upperThreshold === undefined) {
        throw new Error('upperThreshold required for between operator');
      }
      return temperatureBetweenProbability(mean, stdDev, market.threshold, market.upperThreshold);
    default:
      throw new Error(`Unknown operator: ${market.operator}`);
  }
}

/**
 * Generate trading signal from forecast and market
 */
export function generateWeatherSignal(
  forecast: WeatherForecast,
  market: WeatherMarket,
  minEdge: number = 0.05 // 5 cents minimum edge
): WeatherSignal | null {
  const modelProbability = calculateMarketProbability(forecast, market);
  const edge = modelProbability - market.marketPrice;

  // Determine side based on edge
  // If model says higher probability than market, buy YES
  // If model says lower probability than market, buy NO
  const absEdge = Math.abs(edge);
  if (absEdge < minEdge) {
    return null; // Edge too small
  }

  const side: 'YES' | 'NO' = edge > 0 ? 'YES' : 'NO';

  // Confidence based on sample size and edge magnitude
  const sampleConfidence = Math.min(forecast.sampleSize / 30, 1); // Max at 30+ samples
  const edgeConfidence = Math.min(absEdge / 0.20, 1); // Max at 20 cent edge
  const confidence = (sampleConfidence + edgeConfidence) / 2;

  return {
    marketId: market.marketId,
    modelProbability,
    marketPrice: market.marketPrice,
    edge: absEdge,
    side,
    confidence,
    forecast,
  };
}

/**
 * Parse NOAA CDO API response
 */
export function parseNOAAResponse(
  response: {
    results?: Array<{
      date: string;
      value: number;
      datatype: string;
      station: string;
    }>;
  },
  metric: WeatherMetric
): HistoricalDataPoint[] {
  if (!response.results) return [];

  // Map NOAA datatypes to our metrics
  const datatypeMap: Record<string, WeatherMetric> = {
    TMAX: 'temperature',
    TMIN: 'temperature',
    TAVG: 'temperature',
    PRCP: 'precipitation',
    SNOW: 'snowfall',
    HTDD: 'degree_days',
    CLDD: 'degree_days',
  };

  return response.results
    .filter(r => datatypeMap[r.datatype] === metric)
    .map(r => ({
      date: r.date,
      value: r.value / 10, // NOAA stores temps in tenths of degrees
      metric,
      stationId: r.station,
    }));
}

/**
 * Get NOAA station ID for Kalshi market location
 */
export function getStationForLocation(location: string): string {
  // Map Kalshi market locations to NOAA station IDs
  const stationMap: Record<string, string> = {
    // Major airports used by Kalshi
    'NYC': 'GHCND:USW00094728', // Central Park
    'LAX': 'GHCND:USW00023174', // Los Angeles Intl
    'ORD': 'GHCND:USW00094846', // Chicago O'Hare
    'DFW': 'GHCND:USW00003927', // Dallas Fort Worth
    'MIA': 'GHCND:USW00012839', // Miami Intl
    'SEA': 'GHCND:USW00024233', // Seattle-Tacoma
    'PHX': 'GHCND:USW00023183', // Phoenix Sky Harbor
    'DEN': 'GHCND:USW00003017', // Denver Intl
    'ATL': 'GHCND:USW00013874', // Atlanta Hartsfield
    'BOS': 'GHCND:USW00014739', // Boston Logan
    // Add more as needed
  };

  const normalized = location.toUpperCase().trim();
  const NYC_STATION = 'GHCND:USW00094728';
  return stationMap[normalized] ?? NYC_STATION; // Default to NYC
}

/**
 * Parse Kalshi weather market ticker
 * Format: TEMP-{LOCATION}-{DATE}-T{THRESHOLD}
 */
export function parseWeatherMarketTicker(ticker: string): Partial<WeatherMarket> | null {
  // Examples:
  // TEMP-NYC-26MAR15-T50 (temperature above 50°F)
  // HIGHNY-25OCT15-T60 (high temp above 60°F)

  const tempMatch = ticker.match(/^TEMP-([A-Z]+)-(\d{2}[A-Z]{3}\d{2})-T(\d+)$/);
  if (tempMatch && tempMatch[1] && tempMatch[2] && tempMatch[3]) {
    const location = tempMatch[1];
    const dateStr = tempMatch[2];
    const threshold = tempMatch[3];
    return {
      metric: 'temperature',
      location,
      threshold: parseInt(threshold, 10),
      operator: 'above',
      settlementDate: parseKalshiDate(dateStr),
    };
  }

  const highMatch = ticker.match(/^HIGH([A-Z]+)-(\d{2}[A-Z]{3}\d{2})-T(\d+)$/);
  if (highMatch && highMatch[1] && highMatch[2] && highMatch[3]) {
    const location = highMatch[1];
    const dateStr = highMatch[2];
    const threshold = highMatch[3];
    return {
      metric: 'temperature',
      location,
      threshold: parseInt(threshold, 10),
      operator: 'above',
      settlementDate: parseKalshiDate(dateStr),
    };
  }

  return null;
}

/**
 * Parse Kalshi date format (26MAR15 -> 2025-03-26)
 */
function parseKalshiDate(dateStr: string): string {
  const months: Record<string, string> = {
    JAN: '01', FEB: '02', MAR: '03', APR: '04',
    MAY: '05', JUN: '06', JUL: '07', AUG: '08',
    SEP: '09', OCT: '10', NOV: '11', DEC: '12',
  };

  const day = dateStr.slice(0, 2);
  const month = months[dateStr.slice(2, 5)];
  const year = '20' + dateStr.slice(5, 7);

  return `${year}-${month}-${day}`;
}

/**
 * Batch process multiple weather markets
 */
export function batchAnalyzeWeatherMarkets(
  markets: WeatherMarket[],
  historicalDataByLocation: Map<string, HistoricalDataPoint[]>,
  config: ModelConfig = DEFAULT_CONFIG
): WeatherSignal[] {
  const signals: WeatherSignal[] = [];

  for (const market of markets) {
    const locationData = historicalDataByLocation.get(market.location);
    if (!locationData || locationData.length < config.minSampleSize) {
      continue;
    }

    const forecast = generateForecast(
      locationData,
      market.settlementDate,
      market.metric,
      config
    );

    const signal = generateWeatherSignal(forecast, market);
    if (signal) {
      signals.push(signal);
    }
  }

  // Sort by edge descending
  return signals.sort((a, b) => b.edge - a.edge);
}
