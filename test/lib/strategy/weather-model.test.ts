/**
 * Weather Statistical Model Tests (P-11)
 */
import { describe, it, expect } from 'vitest';
import {
  normalCDF,
  temperatureAboveProbability,
  temperatureBelowProbability,
  temperatureBetweenProbability,
  computeWeightedStats,
  generateForecast,
  calculateMarketProbability,
  generateWeatherSignal,
  parseNOAAResponse,
  getStationForLocation,
  parseWeatherMarketTicker,
  batchAnalyzeWeatherMarkets,
  type HistoricalDataPoint,
  type WeatherMarket,
  type WeatherForecast,
  type ModelConfig,
} from '../../../src/lib/strategy/weather-model';

describe('Weather Statistical Model', () => {
  describe('normalCDF', () => {
    it('returns 0.5 for z=0', () => {
      expect(normalCDF(0)).toBeCloseTo(0.5, 4);
    });

    it('returns ~0.84 for z=1', () => {
      expect(normalCDF(1)).toBeCloseTo(0.8413, 2);
    });

    it('returns ~0.98 for z=2', () => {
      expect(normalCDF(2)).toBeCloseTo(0.9772, 2);
    });

    it('returns ~0.16 for z=-1', () => {
      expect(normalCDF(-1)).toBeCloseTo(0.1587, 2);
    });

    it('returns ~0.02 for z=-2', () => {
      expect(normalCDF(-2)).toBeCloseTo(0.0228, 2);
    });

    it('handles extreme values', () => {
      expect(normalCDF(5)).toBeGreaterThan(0.99999);
      expect(normalCDF(-5)).toBeLessThan(0.00001);
    });
  });

  describe('temperatureAboveProbability', () => {
    it('returns probability above threshold', () => {
      // Mean 70, stdDev 5, threshold 75 → z = 1 → prob ≈ 0.16
      const prob = temperatureAboveProbability(70, 5, 75);
      expect(prob).toBeCloseTo(0.1587, 2);
    });

    it('returns ~0.5 when threshold equals mean', () => {
      const prob = temperatureAboveProbability(70, 5, 70);
      expect(prob).toBeCloseTo(0.5, 2);
    });

    it('returns 1 for very low threshold', () => {
      const prob = temperatureAboveProbability(70, 5, 50);
      expect(prob).toBeGreaterThan(0.99);
    });

    it('returns 0 for very high threshold', () => {
      const prob = temperatureAboveProbability(70, 5, 90);
      expect(prob).toBeLessThan(0.01);
    });

    it('handles zero stdDev', () => {
      expect(temperatureAboveProbability(70, 0, 65)).toBe(1);
      expect(temperatureAboveProbability(70, 0, 75)).toBe(0);
    });
  });

  describe('temperatureBelowProbability', () => {
    it('returns probability below threshold', () => {
      // Mean 70, stdDev 5, threshold 65 → z = -1 → prob ≈ 0.16
      const prob = temperatureBelowProbability(70, 5, 65);
      expect(prob).toBeCloseTo(0.1587, 2);
    });

    it('returns ~0.5 when threshold equals mean', () => {
      const prob = temperatureBelowProbability(70, 5, 70);
      expect(prob).toBeCloseTo(0.5, 2);
    });

    it('handles zero stdDev', () => {
      expect(temperatureBelowProbability(70, 0, 75)).toBe(1);
      expect(temperatureBelowProbability(70, 0, 65)).toBe(0);
    });
  });

  describe('temperatureBetweenProbability', () => {
    it('returns probability between thresholds', () => {
      // Mean 70, stdDev 5, 65-75 → -1 to +1 → prob ≈ 0.68
      const prob = temperatureBetweenProbability(70, 5, 65, 75);
      expect(prob).toBeCloseTo(0.6827, 2);
    });

    it('returns ~0.95 for 2 stdDev range', () => {
      const prob = temperatureBetweenProbability(70, 5, 60, 80);
      expect(prob).toBeCloseTo(0.9545, 2);
    });

    it('handles zero stdDev', () => {
      expect(temperatureBetweenProbability(70, 0, 65, 75)).toBe(1);
      expect(temperatureBetweenProbability(70, 0, 60, 65)).toBe(0);
      expect(temperatureBetweenProbability(70, 0, 75, 80)).toBe(0);
    });
  });

  describe('computeWeightedStats', () => {
    const createData = (values: number[], startYear: number): HistoricalDataPoint[] => {
      return values.map((value, i) => ({
        date: `${startYear + i}-03-15`,
        value,
        metric: 'temperature' as const,
        stationId: 'TEST',
      }));
    };

    it('returns zeros for insufficient data', () => {
      const data = createData([70, 72], 2020);
      const config: ModelConfig = { lookbackYears: 30, minSampleSize: 20, climateAdjustment: 0, recentWeightFactor: 1 };
      const result = computeWeightedStats(data, config);
      expect(result.sampleSize).toBe(2);
      expect(result.mean).toBe(0);
    });

    it('calculates mean correctly', () => {
      const data = createData(Array(25).fill(70), 2000);
      const config: ModelConfig = { lookbackYears: 30, minSampleSize: 20, climateAdjustment: 0, recentWeightFactor: 1 };
      const result = computeWeightedStats(data, config);
      expect(result.mean).toBeCloseTo(70, 1);
    });

    it('calculates stdDev correctly', () => {
      // Values: 68, 69, 70, 71, 72 (repeated 5 times = 25 samples)
      const values = [68, 69, 70, 71, 72, 68, 69, 70, 71, 72, 68, 69, 70, 71, 72, 68, 69, 70, 71, 72, 68, 69, 70, 71, 72];
      const data = createData(values, 2000);
      const config: ModelConfig = { lookbackYears: 30, minSampleSize: 20, climateAdjustment: 0, recentWeightFactor: 1 };
      const result = computeWeightedStats(data, config);
      expect(result.stdDev).toBeCloseTo(1.414, 1);
    });

    it('weights recent years more heavily', () => {
      // Old years: 60, Recent years: 80
      const oldData = createData(Array(15).fill(60), 2000);
      const recentData = createData(Array(10).fill(80), 2016);
      const data = [...oldData, ...recentData];

      const config: ModelConfig = { lookbackYears: 30, minSampleSize: 20, climateAdjustment: 0, recentWeightFactor: 2 };
      const result = computeWeightedStats(data, config);

      // With weighting, mean should be pulled toward 80
      expect(result.mean).toBeGreaterThan(70);
    });

    it('applies climate adjustment', () => {
      const data = createData(Array(25).fill(70), 2000);
      const config: ModelConfig = { lookbackYears: 30, minSampleSize: 20, climateAdjustment: 0.1, recentWeightFactor: 1 };
      const result = computeWeightedStats(data, config);

      // Should add years * adjustment to mean
      expect(result.mean).toBeGreaterThan(70);
    });
  });

  describe('generateForecast', () => {
    const createHistoricalData = (): HistoricalDataPoint[] => {
      const data: HistoricalDataPoint[] = [];
      for (let year = 1994; year <= 2024; year++) {
        // March data around target date (March 15)
        for (let day = 10; day <= 20; day++) {
          data.push({
            date: `${year}-03-${day.toString().padStart(2, '0')}`,
            value: 65 + Math.random() * 10, // 65-75 range
            metric: 'temperature',
            stationId: 'TEST',
          });
        }
      }
      return data;
    };

    it('generates forecast for target date', () => {
      const data = createHistoricalData();
      const forecast = generateForecast(data, '2025-03-15', 'temperature');

      expect(forecast.date).toBe('2025-03-15');
      expect(forecast.metric).toBe('temperature');
      expect(forecast.mean).toBeGreaterThan(60);
      expect(forecast.mean).toBeLessThan(80);
      expect(forecast.stdDev).toBeGreaterThan(0);
    });

    it('sets distribution type based on metric', () => {
      const data = createHistoricalData();

      const tempForecast = generateForecast(data, '2025-03-15', 'temperature');
      expect(tempForecast.distribution).toBe('normal');

      const precipData = data.map(d => ({ ...d, metric: 'precipitation' as const }));
      const precipForecast = generateForecast(precipData, '2025-03-15', 'precipitation');
      expect(precipForecast.distribution).toBe('gamma');
    });

    it('calculates 95% confidence interval', () => {
      const data = createHistoricalData();
      const forecast = generateForecast(data, '2025-03-15', 'temperature');

      expect(forecast.confidence95Low).toBeLessThan(forecast.mean);
      expect(forecast.confidence95High).toBeGreaterThan(forecast.mean);
      expect(forecast.confidence95High - forecast.confidence95Low).toBeCloseTo(4 * 1.96 * forecast.stdDev / 2, 0);
    });
  });

  describe('calculateMarketProbability', () => {
    const forecast: WeatherForecast = {
      date: '2025-03-15',
      metric: 'temperature',
      mean: 70,
      stdDev: 5,
      confidence95Low: 60.2,
      confidence95High: 79.8,
      distribution: 'normal',
      sampleSize: 30,
    };

    it('calculates above probability', () => {
      const market: WeatherMarket = {
        marketId: 'm1',
        venue: 'kalshi',
        metric: 'temperature',
        location: 'NYC',
        threshold: 75,
        operator: 'above',
        settlementDate: '2025-03-15',
        marketPrice: 0.20,
      };

      const prob = calculateMarketProbability(forecast, market);
      expect(prob).toBeCloseTo(0.16, 1);
    });

    it('calculates below probability', () => {
      const market: WeatherMarket = {
        marketId: 'm1',
        venue: 'kalshi',
        metric: 'temperature',
        location: 'NYC',
        threshold: 65,
        operator: 'below',
        settlementDate: '2025-03-15',
        marketPrice: 0.20,
      };

      const prob = calculateMarketProbability(forecast, market);
      expect(prob).toBeCloseTo(0.16, 1);
    });

    it('calculates between probability', () => {
      const market: WeatherMarket = {
        marketId: 'm1',
        venue: 'kalshi',
        metric: 'temperature',
        location: 'NYC',
        threshold: 65,
        operator: 'between',
        upperThreshold: 75,
        settlementDate: '2025-03-15',
        marketPrice: 0.70,
      };

      const prob = calculateMarketProbability(forecast, market);
      expect(prob).toBeCloseTo(0.68, 1);
    });

    it('throws for between without upperThreshold', () => {
      const market: WeatherMarket = {
        marketId: 'm1',
        venue: 'kalshi',
        metric: 'temperature',
        location: 'NYC',
        threshold: 65,
        operator: 'between',
        settlementDate: '2025-03-15',
        marketPrice: 0.70,
      };

      expect(() => calculateMarketProbability(forecast, market)).toThrow('upperThreshold required');
    });
  });

  describe('generateWeatherSignal', () => {
    const forecast: WeatherForecast = {
      date: '2025-03-15',
      metric: 'temperature',
      mean: 70,
      stdDev: 5,
      confidence95Low: 60.2,
      confidence95High: 79.8,
      distribution: 'normal',
      sampleSize: 30,
    };

    it('generates YES signal when model prob > market price', () => {
      const market: WeatherMarket = {
        marketId: 'm1',
        venue: 'kalshi',
        metric: 'temperature',
        location: 'NYC',
        threshold: 60, // Low threshold = high prob of above
        operator: 'above',
        settlementDate: '2025-03-15',
        marketPrice: 0.70, // Underpriced
      };

      const signal = generateWeatherSignal(forecast, market);
      expect(signal).not.toBeNull();
      expect(signal!.side).toBe('YES');
      expect(signal!.edge).toBeGreaterThan(0.05);
    });

    it('generates NO signal when model prob < market price', () => {
      const market: WeatherMarket = {
        marketId: 'm1',
        venue: 'kalshi',
        metric: 'temperature',
        location: 'NYC',
        threshold: 80, // High threshold = low prob of above
        operator: 'above',
        settlementDate: '2025-03-15',
        marketPrice: 0.30, // Overpriced
      };

      const signal = generateWeatherSignal(forecast, market);
      expect(signal).not.toBeNull();
      expect(signal!.side).toBe('NO');
    });

    it('returns null when edge too small', () => {
      const market: WeatherMarket = {
        marketId: 'm1',
        venue: 'kalshi',
        metric: 'temperature',
        location: 'NYC',
        threshold: 70, // At mean
        operator: 'above',
        settlementDate: '2025-03-15',
        marketPrice: 0.48, // Close to 0.5
      };

      const signal = generateWeatherSignal(forecast, market, 0.05);
      expect(signal).toBeNull();
    });

    it('respects custom minEdge', () => {
      const market: WeatherMarket = {
        marketId: 'm1',
        venue: 'kalshi',
        metric: 'temperature',
        location: 'NYC',
        threshold: 72,
        operator: 'above',
        settlementDate: '2025-03-15',
        marketPrice: 0.30,
      };

      const signalWithHighMin = generateWeatherSignal(forecast, market, 0.20);
      const signalWithLowMin = generateWeatherSignal(forecast, market, 0.01);

      expect(signalWithHighMin).toBeNull();
      expect(signalWithLowMin).not.toBeNull();
    });
  });

  describe('parseNOAAResponse', () => {
    it('parses temperature data correctly', () => {
      const response = {
        results: [
          { date: '2024-03-15', value: 650, datatype: 'TMAX', station: 'STATION1' },
          { date: '2024-03-15', value: 450, datatype: 'TMIN', station: 'STATION1' },
          { date: '2024-03-15', value: 10, datatype: 'PRCP', station: 'STATION1' },
        ],
      };

      const data = parseNOAAResponse(response, 'temperature');
      expect(data.length).toBe(2); // TMAX and TMIN
      expect(data[0]!.value).toBe(65); // 650 / 10
      expect(data[1]!.value).toBe(45); // 450 / 10
    });

    it('filters by metric', () => {
      const response = {
        results: [
          { date: '2024-03-15', value: 650, datatype: 'TMAX', station: 'STATION1' },
          { date: '2024-03-15', value: 100, datatype: 'PRCP', station: 'STATION1' },
        ],
      };

      const tempData = parseNOAAResponse(response, 'temperature');
      const precipData = parseNOAAResponse(response, 'precipitation');

      expect(tempData.length).toBe(1);
      expect(precipData.length).toBe(1);
    });

    it('handles empty response', () => {
      const data = parseNOAAResponse({}, 'temperature');
      expect(data).toEqual([]);
    });
  });

  describe('getStationForLocation', () => {
    it('returns NYC station for NYC', () => {
      expect(getStationForLocation('NYC')).toBe('GHCND:USW00094728');
    });

    it('returns LAX station for LAX', () => {
      expect(getStationForLocation('LAX')).toBe('GHCND:USW00023174');
    });

    it('handles lowercase', () => {
      expect(getStationForLocation('nyc')).toBe('GHCND:USW00094728');
    });

    it('returns default for unknown location', () => {
      expect(getStationForLocation('UNKNOWN')).toBe('GHCND:USW00094728');
    });
  });

  describe('parseWeatherMarketTicker', () => {
    it('parses TEMP ticker format', () => {
      const result = parseWeatherMarketTicker('TEMP-NYC-26MAR25-T50');
      expect(result).not.toBeNull();
      expect(result!.location).toBe('NYC');
      expect(result!.threshold).toBe(50);
      expect(result!.operator).toBe('above');
      expect(result!.settlementDate).toBe('2025-03-26');
    });

    it('parses HIGH ticker format', () => {
      const result = parseWeatherMarketTicker('HIGHNY-25OCT15-T60');
      expect(result).not.toBeNull();
      expect(result!.location).toBe('NY');
      expect(result!.threshold).toBe(60);
    });

    it('returns null for invalid format', () => {
      expect(parseWeatherMarketTicker('INVALID')).toBeNull();
      expect(parseWeatherMarketTicker('WEATHER-NYC')).toBeNull();
    });
  });

  describe('batchAnalyzeWeatherMarkets', () => {
    it('generates signals for valid markets', () => {
      const markets: WeatherMarket[] = [
        { marketId: 'm1', venue: 'kalshi', metric: 'temperature', location: 'NYC', threshold: 60, operator: 'above', settlementDate: '2025-03-15', marketPrice: 0.70 },
        { marketId: 'm2', venue: 'kalshi', metric: 'temperature', location: 'NYC', threshold: 80, operator: 'above', settlementDate: '2025-03-15', marketPrice: 0.30 },
      ];

      const nycData: HistoricalDataPoint[] = [];
      for (let year = 1994; year <= 2024; year++) {
        nycData.push({ date: `${year}-03-15`, value: 70, metric: 'temperature', stationId: 'NYC' });
      }

      const dataMap = new Map([['NYC', nycData]]);
      const signals = batchAnalyzeWeatherMarkets(markets, dataMap);

      expect(signals.length).toBeGreaterThan(0);
    });

    it('skips markets with insufficient data', () => {
      const markets: WeatherMarket[] = [
        { marketId: 'm1', venue: 'kalshi', metric: 'temperature', location: 'NYC', threshold: 60, operator: 'above', settlementDate: '2025-03-15', marketPrice: 0.70 },
      ];

      const insufficientData: HistoricalDataPoint[] = [
        { date: '2024-03-15', value: 70, metric: 'temperature', stationId: 'NYC' },
      ];

      const dataMap = new Map([['NYC', insufficientData]]);
      const signals = batchAnalyzeWeatherMarkets(markets, dataMap);

      expect(signals.length).toBe(0);
    });

    it('sorts signals by edge descending', () => {
      const markets: WeatherMarket[] = [
        { marketId: 'm1', venue: 'kalshi', metric: 'temperature', location: 'NYC', threshold: 55, operator: 'above', settlementDate: '2025-03-15', marketPrice: 0.50 },
        { marketId: 'm2', venue: 'kalshi', metric: 'temperature', location: 'NYC', threshold: 50, operator: 'above', settlementDate: '2025-03-15', marketPrice: 0.40 },
      ];

      const nycData: HistoricalDataPoint[] = [];
      for (let year = 1994; year <= 2024; year++) {
        nycData.push({ date: `${year}-03-15`, value: 70, metric: 'temperature', stationId: 'NYC' });
      }

      const dataMap = new Map([['NYC', nycData]]);
      const signals = batchAnalyzeWeatherMarkets(markets, dataMap);

      if (signals.length >= 2) {
        expect(signals[0]!.edge).toBeGreaterThanOrEqual(signals[1]!.edge);
      }
    });
  });
});
