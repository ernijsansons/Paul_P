/**
 * Paul P - Strategy Weather Agent (P-11)
 *
 * Weather prediction market strategy using NOAA data.
 *
 * Strategy Overview:
 * - Fetch historical weather data from NOAA CDO API
 * - Build statistical model (normal distribution for temperature)
 * - Compare model probability vs Kalshi market price
 * - Generate signals when edge exceeds threshold
 */

import { PaulPAgent } from './base';
import {
  generateForecast,
  batchAnalyzeWeatherMarkets,
  parseWeatherMarketTicker,
  getStationForLocation,
  type WeatherMarket,
  type HistoricalDataPoint,
  type ModelConfig,
  type WeatherMetric,
} from '../lib/strategy/weather-model';
import { computeKellySize, type MonteCarloConfig } from '../lib/strategy/kelly-sizing';
import { createNOAAClient, MAJOR_CITY_STATIONS } from '../lib/weather/noaa-client';

// Trading signal for queue
export interface WeatherTradingSignal {
  signalId: string;
  strategy: 'weather';
  marketId: string;
  venue: 'kalshi';
  side: 'YES' | 'NO';
  targetSize: number;
  kellyFraction: number;
  modelProbability: number;
  marketPrice: number;
  edge: number;
  confidence: number;
  forecast: {
    mean: number;
    stdDev: number;
    sampleSize: number;
  };
  createdAt: string;
  expiresAt: string;
}

export class StrategyWeatherAgent extends PaulPAgent {
  readonly agentName = 'strategy-weather';

  // Model configuration
  private modelConfig: ModelConfig = {
    lookbackYears: 30,
    minSampleSize: 20,
    climateAdjustment: 0.03,
    recentWeightFactor: 1.5,
  };

  private monteCarloConfig: MonteCarloConfig = {
    simulations: 10000,
    assumedCV: 0.25, // Weather is more predictable than financial markets
  };


  // Minimum edge to generate signal (5 cents)
  private minEdge = 0.05;

  protected async initLocalTables(): Promise<void> {
    // Weather data cache
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS weather_cache (
        station_id TEXT NOT NULL,
        date TEXT NOT NULL,
        metric TEXT NOT NULL,
        value REAL NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (station_id, date, metric)
      )
    `);

    // Signal history
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS weather_signal_history (
        signal_id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL,
        model_probability REAL NOT NULL,
        market_price REAL NOT NULL,
        edge REAL NOT NULL,
        side TEXT NOT NULL,
        created_at TEXT NOT NULL,
        executed INTEGER DEFAULT 0,
        outcome TEXT
      )
    `);

    // Forecast cache
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS forecast_cache (
        location TEXT NOT NULL,
        target_date TEXT NOT NULL,
        metric TEXT NOT NULL,
        mean REAL NOT NULL,
        std_dev REAL NOT NULL,
        sample_size INTEGER NOT NULL,
        computed_at TEXT NOT NULL,
        PRIMARY KEY (location, target_date, metric)
      )
    `);

    // Historical returns for CV calculation
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS weather_returns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_value REAL NOT NULL,
        recorded_at TEXT NOT NULL
      )
    `);
  }

  protected async handleRequest(request: Request, path: string): Promise<Response> {
    await this.initLocalTables();

    switch (path) {
      case '/analyze':
        return this.analyzeWeatherData(request);
      case '/generate-signals':
        return this.generateSignals(request);
      case '/forecast':
        return this.getForecast(request);
      case '/markets':
        return this.getWeatherMarkets();
      case '/historical':
        return this.getHistoricalData(request);
      case '/refresh-data':
        return this.refreshNOAAData(request);
      case '/config':
        return this.getConfig();
      case '/config/update':
        return this.updateConfig(request);
      case '/status':
        return this.getStatus();
      case '/metrics':
        return this.getMetrics();
      default:
        return Response.json({ error: 'Not found' }, { status: 404 });
    }
  }

  /**
   * Analyze weather data for a specific location/date
   */
  private async analyzeWeatherData(request: Request): Promise<Response> {
    const body = await request.json() as {
      location: string;
      targetDate: string;
      metric?: WeatherMetric;
    };

    if (!body.location || !body.targetDate) {
      return Response.json({ error: 'location and targetDate required' }, { status: 400 });
    }

    const metric = body.metric ?? 'temperature';
    const stationId = getStationForLocation(body.location);

    // Get historical data
    const historicalData = await this.getHistoricalDataForStation(stationId, metric);

    if (historicalData.length < this.modelConfig.minSampleSize) {
      return Response.json({
        error: 'Insufficient historical data',
        dataPoints: historicalData.length,
        required: this.modelConfig.minSampleSize,
      }, { status: 400 });
    }

    // Generate forecast
    const forecast = generateForecast(
      historicalData,
      body.targetDate,
      metric,
      this.modelConfig
    );

    // Cache forecast
    this.sql.exec(
      `INSERT OR REPLACE INTO forecast_cache
       (location, target_date, metric, mean, std_dev, sample_size, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      body.location,
      body.targetDate,
      metric,
      forecast.mean,
      forecast.stdDev,
      forecast.sampleSize,
      new Date().toISOString()
    );

    return Response.json({
      location: body.location,
      stationId,
      forecast,
      historicalDataPoints: historicalData.length,
    });
  }

  /**
   * Generate trading signals for weather markets
   */
  private async generateSignals(request: Request): Promise<Response> {
    const body = await request.json() as {
      capital: number;
      markets?: WeatherMarket[];
    };

    if (!body.capital || body.capital <= 0) {
      return Response.json({ error: 'Capital required' }, { status: 400 });
    }

    // Get weather markets from D1 or use provided markets
    let markets = body.markets;
    if (!markets) {
      markets = await this.fetchWeatherMarketsFromDB();
    }

    if (markets.length === 0) {
      return Response.json({
        signals: [],
        message: 'No weather markets found',
      });
    }

    // Get historical data for each unique location
    const locations = [...new Set(markets.map(m => m.location))];
    const historicalDataByLocation = new Map<string, HistoricalDataPoint[]>();

    for (const location of locations) {
      const stationId = getStationForLocation(location);
      const data = await this.getHistoricalDataForStation(stationId, 'temperature');
      historicalDataByLocation.set(location, data);
    }

    // Batch analyze markets
    const weatherSignals = batchAnalyzeWeatherMarkets(
      markets,
      historicalDataByLocation,
      this.modelConfig
    );

    // Get historical returns for CV adjustment
    const historicalReturns = this.getHistoricalReturns();
    const mcConfig: MonteCarloConfig = {
      ...this.monteCarloConfig,
      historicalReturns: historicalReturns.length >= 5 ? historicalReturns : undefined,
    };

    // Generate trading signals with Kelly sizing
    const tradingSignals: WeatherTradingSignal[] = [];
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 12 * 60 * 60 * 1000); // 12h expiry (weather markets move fast)

    for (const ws of weatherSignals) {
      const fairProb = ws.modelProbability;
      const marketPrice = ws.marketPrice;

      const kellyResult = computeKellySize(
        {
          fairProbability: ws.side === 'YES' ? fairProb : 1 - fairProb,
          marketPrice: ws.side === 'YES' ? marketPrice : 1 - marketPrice,
          side: ws.side,
          bankroll: body.capital,
          maxPositionPct: 5, // Max 5% per weather position
        },
        mcConfig
      );

      if (kellyResult.hasEdge && ws.edge >= this.minEdge) {
        const signal: WeatherTradingSignal = {
          signalId: `sig_weather_${ws.marketId}_${now.getTime()}`,
          strategy: 'weather',
          marketId: ws.marketId,
          venue: 'kalshi',
          side: ws.side,
          targetSize: kellyResult.positionSize,
          kellyFraction: kellyResult.adjustedFraction,
          modelProbability: ws.modelProbability,
          marketPrice: ws.marketPrice,
          edge: ws.edge,
          confidence: ws.confidence,
          forecast: {
            mean: ws.forecast.mean,
            stdDev: ws.forecast.stdDev,
            sampleSize: ws.forecast.sampleSize,
          },
          createdAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
        };

        tradingSignals.push(signal);

        // Store in history
        this.sql.exec(
          `INSERT INTO weather_signal_history
           (signal_id, market_id, model_probability, market_price, edge, side, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          signal.signalId,
          signal.marketId,
          signal.modelProbability,
          signal.marketPrice,
          signal.edge,
          signal.side,
          signal.createdAt
        );
      }
    }

    // Send to queue
    if (tradingSignals.length > 0) {
      await this.env.QUEUE_SIGNALS.send({
        type: 'WEATHER_SIGNALS',
        signals: tradingSignals,
        timestamp: now.toISOString(),
      });

      await this.logAudit('WEATHER_SIGNALS_GENERATED', {
        signalCount: tradingSignals.length,
        marketsAnalyzed: markets.length,
        capital: body.capital,
      });
    }

    return Response.json({
      signals: tradingSignals,
      marketsAnalyzed: markets.length,
      signalsGenerated: tradingSignals.length,
    });
  }

  /**
   * Get forecast for specific location/date
   */
  private async getForecast(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const location = url.searchParams.get('location');
    const targetDate = url.searchParams.get('date');
    const metric = (url.searchParams.get('metric') ?? 'temperature') as WeatherMetric;

    if (!location || !targetDate) {
      return Response.json({ error: 'location and date required' }, { status: 400 });
    }

    // Check cache first
    const cached = this.sql.exec<{
      mean: number;
      std_dev: number;
      sample_size: number;
      computed_at: string;
    }>(
      `SELECT mean, std_dev, sample_size, computed_at
       FROM forecast_cache
       WHERE location = ? AND target_date = ? AND metric = ?`,
      location,
      targetDate,
      metric
    ).one();

    if (cached) {
      // Check if cache is fresh (< 24 hours)
      const cacheAge = Date.now() - new Date(cached.computed_at).getTime();
      if (cacheAge < 24 * 60 * 60 * 1000) {
        return Response.json({
          location,
          targetDate,
          metric,
          forecast: {
            mean: cached.mean,
            stdDev: cached.std_dev,
            sampleSize: cached.sample_size,
          },
          cached: true,
        });
      }
    }

    // Generate fresh forecast
    const stationId = getStationForLocation(location);
    const historicalData = await this.getHistoricalDataForStation(stationId, metric);
    const forecast = generateForecast(historicalData, targetDate, metric, this.modelConfig);

    // Update cache
    this.sql.exec(
      `INSERT OR REPLACE INTO forecast_cache
       (location, target_date, metric, mean, std_dev, sample_size, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      location,
      targetDate,
      metric,
      forecast.mean,
      forecast.stdDev,
      forecast.sampleSize,
      new Date().toISOString()
    );

    return Response.json({
      location,
      targetDate,
      metric,
      forecast,
      cached: false,
    });
  }

  /**
   * Get available weather markets from Kalshi
   */
  private async getWeatherMarkets(): Promise<Response> {
    const markets = await this.fetchWeatherMarketsFromDB();

    return Response.json({
      count: markets.length,
      markets,
    });
  }

  /**
   * Get historical weather data
   */
  private async getHistoricalData(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const location = url.searchParams.get('location');
    const metric = (url.searchParams.get('metric') ?? 'temperature') as WeatherMetric;

    if (!location) {
      return Response.json({ error: 'location required' }, { status: 400 });
    }

    const stationId = getStationForLocation(location);
    const data = await this.getHistoricalDataForStation(stationId, metric);

    return Response.json({
      location,
      stationId,
      metric,
      dataPoints: data.length,
      data: data.slice(0, 100), // Return first 100 for brevity
    });
  }

  /**
   * Refresh NOAA data for a location
   * Uses the NOAA CDO API to fetch historical weather data
   */
  private async refreshNOAAData(request: Request): Promise<Response> {
    const body = await request.json() as {
      location: string;
      startDate?: string;
      endDate?: string;
      metric?: WeatherMetric;
    };

    if (!body.location) {
      return Response.json({ error: 'location required' }, { status: 400 });
    }

    const stationId = getStationForLocation(body.location);
    const endDate = body.endDate ?? (new Date().toISOString().split('T')[0] ?? '');
    const startDate = body.startDate ?? (new Date(
      Date.now() - this.modelConfig.lookbackYears * 365 * 24 * 60 * 60 * 1000
    ).toISOString().split('T')[0] ?? '');
    const metric = body.metric ?? 'temperature';

    // Use real NOAA client
    const noaaClient = createNOAAClient(this.env);

    // Check if we have the CDO token configured
    if (!this.env.NOAA_CDO_TOKEN) {
      // Fall back to Weather API for current observations only
      try {
        const nwsStationId = MAJOR_CITY_STATIONS[body.location.toLowerCase().replace(/\s+/g, '_')];
        if (nwsStationId) {
          const { observation, evidenceHash } = await noaaClient.getCurrentObservations(nwsStationId);

          // Store in cache
          if (observation.temperature !== null) {
            this.sql.exec(
              `INSERT OR REPLACE INTO weather_cache
               (station_id, date, metric, value, fetched_at)
               VALUES (?, ?, ?, ?, ?)`,
              stationId,
              observation.timestamp.split('T')[0],
              'temperature',
              observation.temperature,
              new Date().toISOString()
            );
          }

          await this.logAudit('NOAA_WEATHER_API_REFRESH', {
            location: body.location,
            stationId: nwsStationId,
            evidenceHash,
            observation: {
              timestamp: observation.timestamp,
              temperature: observation.temperature,
            },
          });

          return Response.json({
            message: 'Current observation fetched (CDO token not configured for historical data)',
            location: body.location,
            stationId: nwsStationId,
            observation,
            evidenceHash,
          });
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return Response.json({
          error: 'Failed to fetch NOAA data',
          details: errorMessage,
          location: body.location,
        }, { status: 500 });
      }

      return Response.json({
        error: 'NOAA_CDO_TOKEN not configured and no NWS station found for location',
        location: body.location,
      }, { status: 400 });
    }

    // Map metric to NOAA data type ID
    const dataTypeMap: Record<WeatherMetric, string> = {
      temperature: 'TAVG',   // Daily average temperature
      precipitation: 'PRCP', // Daily precipitation
      snowfall: 'SNOW',      // Daily snowfall
      degree_days: 'HDD',    // Heating degree days
    };
    const dataTypeId = dataTypeMap[metric] ?? 'TAVG';

    try {
      // Fetch historical data from Climate Data Online
      const { data, evidenceHash } = await noaaClient.getHistoricalData(
        `GHCND:${stationId}`, // GHCND station format
        dataTypeId,
        startDate,
        endDate
      );

      // Store in cache
      let insertedCount = 0;
      for (const point of data.values) {
        this.sql.exec(
          `INSERT OR REPLACE INTO weather_cache
           (station_id, date, metric, value, fetched_at)
           VALUES (?, ?, ?, ?, ?)`,
          stationId,
          point.date,
          metric,
          point.value,
          new Date().toISOString()
        );
        insertedCount++;
      }

      await this.logAudit('NOAA_CDO_DATA_REFRESH', {
        location: body.location,
        stationId,
        startDate,
        endDate,
        metric,
        dataTypeId,
        pointsReceived: data.values.length,
        pointsInserted: insertedCount,
        evidenceHash,
      });

      return Response.json({
        message: 'Historical data refresh completed',
        location: body.location,
        stationId,
        startDate,
        endDate,
        metric,
        dataPointsReceived: data.values.length,
        dataPointsInserted: insertedCount,
        evidenceHash,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      await this.logAudit('NOAA_DATA_REFRESH_FAILED', {
        location: body.location,
        stationId,
        error: errorMessage,
      });

      return Response.json({
        error: 'Failed to fetch NOAA data',
        details: errorMessage,
        location: body.location,
        stationId,
      }, { status: 500 });
    }
  }

  /**
   * Get current configuration
   */
  private async getConfig(): Promise<Response> {
    return Response.json({
      model: this.modelConfig,
      monteCarlo: this.monteCarloConfig,
      minEdge: this.minEdge,
    });
  }

  /**
   * Update configuration
   */
  private async updateConfig(request: Request): Promise<Response> {
    const body = await request.json() as {
      model?: Partial<ModelConfig>;
      monteCarlo?: Partial<MonteCarloConfig>;
      minEdge?: number;
    };

    if (body.model) {
      this.modelConfig = { ...this.modelConfig, ...body.model };
    }
    if (body.monteCarlo) {
      this.monteCarloConfig = { ...this.monteCarloConfig, ...body.monteCarlo };
    }
    if (body.minEdge !== undefined) {
      this.minEdge = body.minEdge;
    }

    await this.logAudit('WEATHER_CONFIG_UPDATED', {
      model: this.modelConfig,
      monteCarlo: this.monteCarloConfig,
      minEdge: this.minEdge,
    });

    return Response.json({
      model: this.modelConfig,
      monteCarlo: this.monteCarloConfig,
      minEdge: this.minEdge,
    });
  }

  /**
   * Get agent status
   */
  private async getStatus(): Promise<Response> {
    const cachedForecasts = this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM forecast_cache`
    ).one();

    const cachedDataPoints = this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM weather_cache`
    ).one();

    const recentSignals = this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM weather_signal_history
       WHERE created_at > datetime('now', '-1 day')`
    ).one();

    return Response.json({
      agent: this.agentName,
      strategyType: 'weather',
      status: 'paper',
      config: {
        model: this.modelConfig,
        minEdge: this.minEdge,
      },
      cachedForecasts: cachedForecasts?.count ?? 0,
      cachedDataPoints: cachedDataPoints?.count ?? 0,
      recentSignals: recentSignals?.count ?? 0,
      lastActivity: new Date().toISOString(),
    });
  }

  /**
   * Get strategy metrics
   */
  private async getMetrics(): Promise<Response> {
    const totalSignals = this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM weather_signal_history`
    ).one();

    const executedSignals = this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM weather_signal_history WHERE executed = 1`
    ).one();

    const returns = this.getHistoricalReturns();
    const mean = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const variance = returns.length > 0
      ? returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length
      : 0;
    const sharpe = variance > 0 ? mean / Math.sqrt(variance) : 0;

    const avgEdge = this.sql.exec<{ avg_edge: number }>(
      `SELECT AVG(edge) as avg_edge FROM weather_signal_history`
    ).one();

    return Response.json({
      totalSignals: totalSignals?.count ?? 0,
      executedSignals: executedSignals?.count ?? 0,
      averageEdge: avgEdge?.avg_edge ?? 0,
      sharpeRatio: sharpe,
      returnCount: returns.length,
    });
  }

  /**
   * Get historical data from cache
   */
  private async getHistoricalDataForStation(
    stationId: string,
    metric: WeatherMetric
  ): Promise<HistoricalDataPoint[]> {
    const rows = this.sql.exec<{
      date: string;
      value: number;
      metric: string;
      station_id: string;
    }>(
      `SELECT date, value, metric, station_id
       FROM weather_cache
       WHERE station_id = ? AND metric = ?
       ORDER BY date DESC`,
      stationId,
      metric
    ).toArray();

    return rows.map(r => ({
      date: r.date,
      value: r.value,
      metric: r.metric as WeatherMetric,
      stationId: r.station_id,
    }));
  }

  /**
   * Fetch weather markets from D1
   */
  private async fetchWeatherMarketsFromDB(): Promise<WeatherMarket[]> {
    const markets = await this.env.DB.prepare(`
      SELECT
        condition_id as marketId,
        question as title,
        last_yes_price as marketPrice,
        end_date as settlementDate,
        category
      FROM markets
      WHERE category = 'weather'
        AND status = 'active'
        AND end_date > datetime('now')
      ORDER BY end_date ASC
      LIMIT 50
    `).all<{
      marketId: string;
      title: string;
      marketPrice: number;
      settlementDate: string;
      category: string;
    }>();

    // Parse market tickers to extract weather parameters
    return (markets.results ?? [])
      .map(m => {
        const parsed = parseWeatherMarketTicker(m.marketId);
        if (!parsed) return null;

        return {
          marketId: m.marketId,
          venue: 'kalshi' as const,
          metric: parsed.metric ?? 'temperature',
          location: parsed.location ?? 'NYC',
          threshold: parsed.threshold ?? 0,
          operator: parsed.operator ?? 'above',
          upperThreshold: parsed.upperThreshold,
          settlementDate: m.settlementDate,
          marketPrice: m.marketPrice,
        } as WeatherMarket;
      })
      .filter((m): m is WeatherMarket => m !== null);
  }

  /**
   * Get historical returns for CV calculation
   */
  private getHistoricalReturns(): number[] {
    const rows = this.sql.exec<{ return_value: number }>(
      `SELECT return_value FROM weather_returns ORDER BY recorded_at DESC LIMIT 100`
    ).toArray();

    return rows.map(r => r.return_value);
  }
}
