/**
 * Paul P - NOAA Weather API Client
 *
 * Provides access to NOAA weather data for the Weather Economic Series strategy.
 * Follows evidence-first pattern: store raw response before parsing.
 *
 * Data Sources:
 * - NOAA Weather API (api.weather.gov) - Forecasts, current conditions
 * - NOAA Climate Data Online (ncdc.noaa.gov) - Historical data
 *
 * Rate Limits (per COMPLIANCE_MATRIX.md):
 * - Weather API: 10 req/sec
 * - Climate Data: 5 req/sec, 1000 daily cap
 */

import type { Env } from '../../types/env';
import { storeEvidence, type StoreEvidenceInput } from '../evidence/store';

// ============================================================
// TYPES
// ============================================================

export interface NOAAStation {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  elevation: number;
  state: string;
  datacoverage: number;
}

export interface NOAAObservation {
  stationId: string;
  timestamp: string;
  temperature: number | null;      // Celsius
  temperatureFahrenheit: number | null;
  dewpoint: number | null;
  humidity: number | null;         // Percentage
  windSpeed: number | null;        // km/h
  windDirection: number | null;    // Degrees
  pressure: number | null;         // Pascal
  precipitation: number | null;    // mm (last hour)
  visibility: number | null;       // meters
  textDescription: string | null;
}

export interface NOAAForecast {
  stationId: string;
  generatedAt: string;
  periods: Array<{
    name: string;
    startTime: string;
    endTime: string;
    isDaytime: boolean;
    temperature: number;
    temperatureUnit: 'F' | 'C';
    windSpeed: string;
    windDirection: string;
    shortForecast: string;
    detailedForecast: string;
    probabilityOfPrecipitation: number | null;
  }>;
}

export interface NOAAHistoricalData {
  stationId: string;
  startDate: string;
  endDate: string;
  dataType: string;
  values: Array<{
    date: string;
    value: number;
    attributes: string;
  }>;
}

export interface NOAAClientConfig {
  weatherApiBaseUrl: string;
  climateDataBaseUrl: string;
  climateDataToken?: string;
  userAgent: string;
  rateLimitPerSecond: number;
  maxRetries: number;
}

const DEFAULT_CONFIG: NOAAClientConfig = {
  weatherApiBaseUrl: 'https://api.weather.gov',
  climateDataBaseUrl: 'https://www.ncdc.noaa.gov/cdo-web/api/v2',
  userAgent: 'PaulP/1.0 (contact@paulp.dev)',
  rateLimitPerSecond: 5,
  maxRetries: 3,
};

// Major US city station IDs (NWS observation stations)
export const MAJOR_CITY_STATIONS: Record<string, string> = {
  'new_york': 'KNYC',
  'los_angeles': 'KLAX',
  'chicago': 'KORD',
  'houston': 'KIAH',
  'phoenix': 'KPHX',
  'philadelphia': 'KPHL',
  'san_antonio': 'KSAT',
  'san_diego': 'KSAN',
  'dallas': 'KDFW',
  'austin': 'KAUS',
  'miami': 'KMIA',
  'denver': 'KDEN',
  'seattle': 'KSEA',
  'boston': 'KBOS',
  'atlanta': 'KATL',
};

// ============================================================
// CLIENT
// ============================================================

export class NOAAClient {
  private config: NOAAClientConfig;
  private env: Env;
  private lastRequestTime = 0;

  constructor(env: Env, config: Partial<NOAAClientConfig> = {}) {
    this.env = env;
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      climateDataToken: env.NOAA_CDO_TOKEN ?? config.climateDataToken,
    };
  }

  /**
   * Rate limit enforcement
   */
  private async enforceRateLimit(): Promise<void> {
    const minInterval = 1000 / this.config.rateLimitPerSecond;
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < minInterval) {
      await new Promise(resolve => setTimeout(resolve, minInterval - elapsed));
    }
    this.lastRequestTime = Date.now();
  }

  /**
   * Fetch with evidence-first storage
   */
  private async fetchWithEvidence<T>(
    url: string,
    sourceId: string,
    headers: Record<string, string> = {}
  ): Promise<{ data: T; evidenceHash: string }> {
    await this.enforceRateLimit();

    const response = await fetch(url, {
      headers: {
        'User-Agent': this.config.userAgent,
        'Accept': 'application/geo+json,application/json',
        ...headers,
      },
    });

    if (!response.ok) {
      throw new Error(`NOAA API error: ${response.status} ${response.statusText}`);
    }

    // Get raw response as text for evidence storage
    const rawText = await response.text();
    const rawBytes = new TextEncoder().encode(rawText);

    // Store evidence BEFORE parsing
    const input: StoreEvidenceInput = {
      source: sourceId,
      endpoint: url,
      rawBytes: rawBytes.buffer as ArrayBuffer,
      fetchedAt: new Date().toISOString(),
      requestMethod: 'GET',
    };

    const result = await storeEvidence(this.env, input);
    if (!result.ok) {
      throw result.error;
    }
    const evidenceHash = result.value.evidenceHash;

    // Now parse the response
    const data = JSON.parse(rawText) as T;

    return { data, evidenceHash };
  }

  /**
   * Get current weather observations for a station
   */
  async getCurrentObservations(stationId: string): Promise<{
    observation: NOAAObservation;
    evidenceHash: string;
  }> {
    const url = `${this.config.weatherApiBaseUrl}/stations/${stationId}/observations/latest`;

    const { data, evidenceHash } = await this.fetchWithEvidence<{
      properties: {
        timestamp: string;
        temperature: { value: number | null };
        dewpoint: { value: number | null };
        relativeHumidity: { value: number | null };
        windSpeed: { value: number | null };
        windDirection: { value: number | null };
        barometricPressure: { value: number | null };
        precipitationLastHour: { value: number | null };
        visibility: { value: number | null };
        textDescription: string | null;
      };
    }>(url, 'noaa_weather_api');

    const props = data.properties;

    const observation: NOAAObservation = {
      stationId,
      timestamp: props.timestamp,
      temperature: props.temperature?.value ?? null,
      temperatureFahrenheit: props.temperature?.value != null
        ? (props.temperature.value * 9/5) + 32
        : null,
      dewpoint: props.dewpoint?.value ?? null,
      humidity: props.relativeHumidity?.value ?? null,
      windSpeed: props.windSpeed?.value != null
        ? props.windSpeed.value * 3.6  // m/s to km/h
        : null,
      windDirection: props.windDirection?.value ?? null,
      pressure: props.barometricPressure?.value ?? null,
      precipitation: props.precipitationLastHour?.value ?? null,
      visibility: props.visibility?.value ?? null,
      textDescription: props.textDescription ?? null,
    };

    return { observation, evidenceHash };
  }

  /**
   * Get forecast for a grid point
   */
  async getForecast(latitude: number, longitude: number): Promise<{
    forecast: NOAAForecast;
    evidenceHash: string;
  }> {
    // First get the grid point
    const pointUrl = `${this.config.weatherApiBaseUrl}/points/${latitude},${longitude}`;
    const { data: pointData } = await this.fetchWithEvidence<{
      properties: {
        forecastGridData: string;
        forecast: string;
        observationStations: string;
      };
    }>(pointUrl, 'noaa_weather_api');

    // Then get the forecast
    const forecastUrl = pointData.properties.forecast;
    const { data, evidenceHash } = await this.fetchWithEvidence<{
      properties: {
        generatedAt: string;
        periods: Array<{
          name: string;
          startTime: string;
          endTime: string;
          isDaytime: boolean;
          temperature: number;
          temperatureUnit: 'F' | 'C';
          windSpeed: string;
          windDirection: string;
          shortForecast: string;
          detailedForecast: string;
          probabilityOfPrecipitation: { value: number | null };
        }>;
      };
    }>(forecastUrl, 'noaa_weather_api');

    const forecast: NOAAForecast = {
      stationId: `${latitude},${longitude}`,
      generatedAt: data.properties.generatedAt,
      periods: data.properties.periods.map(p => ({
        name: p.name,
        startTime: p.startTime,
        endTime: p.endTime,
        isDaytime: p.isDaytime,
        temperature: p.temperature,
        temperatureUnit: p.temperatureUnit,
        windSpeed: p.windSpeed,
        windDirection: p.windDirection,
        shortForecast: p.shortForecast,
        detailedForecast: p.detailedForecast,
        probabilityOfPrecipitation: p.probabilityOfPrecipitation?.value ?? null,
      })),
    };

    return { forecast, evidenceHash };
  }

  /**
   * Get historical data from Climate Data Online
   * Requires NOAA CDO API token
   */
  async getHistoricalData(
    stationId: string,
    dataTypeId: string,
    startDate: string,
    endDate: string
  ): Promise<{
    data: NOAAHistoricalData;
    evidenceHash: string;
  }> {
    if (!this.config.climateDataToken) {
      throw new Error('NOAA CDO API token not configured');
    }

    const url = `${this.config.climateDataBaseUrl}/data?` + new URLSearchParams({
      datasetid: 'GHCND',
      stationid: stationId,
      datatypeid: dataTypeId,
      startdate: startDate,
      enddate: endDate,
      units: 'metric',
      limit: '1000',
    });

    const { data, evidenceHash } = await this.fetchWithEvidence<{
      results: Array<{
        date: string;
        value: number;
        attributes: string;
      }>;
    }>(url, 'noaa_cdo', {
      token: this.config.climateDataToken,
    });

    const historicalData: NOAAHistoricalData = {
      stationId,
      startDate,
      endDate,
      dataType: dataTypeId,
      values: data.results ?? [],
    };

    return { data: historicalData, evidenceHash };
  }

  /**
   * Get station info for a location
   */
  async getStations(
    extent: string  // bbox format: "minLon,minLat,maxLon,maxLat"
  ): Promise<{
    stations: NOAAStation[];
    evidenceHash: string;
  }> {
    if (!this.config.climateDataToken) {
      throw new Error('NOAA CDO API token not configured');
    }

    const url = `${this.config.climateDataBaseUrl}/stations?` + new URLSearchParams({
      extent,
      limit: '100',
    });

    const { data, evidenceHash } = await this.fetchWithEvidence<{
      results: Array<{
        id: string;
        name: string;
        latitude: number;
        longitude: number;
        elevation: number;
        elevationUnit: string;
        datacoverage: number;
        mindate: string;
        maxdate: string;
      }>;
    }>(url, 'noaa_cdo', {
      token: this.config.climateDataToken,
    });

    const stations: NOAAStation[] = (data.results ?? []).map(s => ({
      id: s.id,
      name: s.name,
      latitude: s.latitude,
      longitude: s.longitude,
      elevation: s.elevation,
      state: s.id.split(':')[1]?.substring(0, 2) ?? '',
      datacoverage: s.datacoverage,
    }));

    return { stations, evidenceHash };
  }

  /**
   * Get station ID for a major US city
   */
  getStationIdForCity(city: string): string | undefined {
    const normalizedCity = city.toLowerCase().replace(/\s+/g, '_');
    return MAJOR_CITY_STATIONS[normalizedCity];
  }

  /**
   * Check if a temperature reading is an outlier
   * Used for weather market signal generation
   */
  isTemperatureOutlier(
    current: number,
    historicalMean: number,
    historicalStdDev: number,
    threshold: number = 2.0  // Standard deviations
  ): { isOutlier: boolean; zScore: number; direction: 'above' | 'below' | 'normal' } {
    const zScore = (current - historicalMean) / historicalStdDev;

    return {
      isOutlier: Math.abs(zScore) > threshold,
      zScore,
      direction: zScore > threshold ? 'above' : zScore < -threshold ? 'below' : 'normal',
    };
  }
}

/**
 * Create a NOAA client instance
 */
export function createNOAAClient(env: Env, config?: Partial<NOAAClientConfig>): NOAAClient {
  return new NOAAClient(env, config);
}
