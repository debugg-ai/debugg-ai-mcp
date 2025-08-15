// utils/axiosTransport.ts
import axios from "axios";

import {
  objToCamelCase,
  objToSnakeCase,
} from "./objectNaming.js";

import { Logger } from "./logger.js";
import { 
  handleExternalServiceError, 
  toMCPError, 
  isRetryableError
} from "./errors.js";
import { MCPError, MCPErrorCode } from "../types/index.js";

import type {
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
} from "axios";

// Augment AxiosRequestConfig to include metadata for tracking
declare module "axios" {
  interface AxiosRequestConfig {
    metadata?: {
      requestId: string;
      startTime: number;
      method: string;
      url: string;
    };
  }
}

import type {
  TransportConfig,
  RetryConfig,
  CacheConfig,
  MetricsConfig,
  RequestMetrics,
  CacheEntry,
  TransportMetrics,
} from "../types/index.js";
  
  /** Constructor options that come from the top‑level client */
  export interface AxiosTransportOptions {
    baseUrl: string;
    apiKey?: string;
    /** You can pass a pre‑configured axios instance (e.g. for tests) */
    instance?: AxiosInstance;
    /** Transport configuration for optimization features */
    config?: Partial<TransportConfig>;
  }
  
  /**
   * Default transport configuration
   */
  const defaultTransportConfig: TransportConfig = {
    retry: {
      maxAttempts: 3,
      baseDelay: 1000,
      maxDelay: 10000,
      exponentialBase: 2,
      retryableStatusCodes: [408, 429, 500, 502, 503, 504],
      retryableErrorCodes: [
        MCPErrorCode.EXTERNAL_SERVICE_ERROR,
        MCPErrorCode.INTERNAL_ERROR
      ]
    },
    cache: {
      enabled: true,
      ttl: 300000, // 5 minutes
      maxSize: 100,
      excludePatterns: ['/auth/', '/session/', '/logout']
    },
    metrics: {
      enabled: true,
      collectTiming: true,
      collectErrors: true,
      collectCacheStats: true
    },
    logging: {
      enabled: true,
      logRequests: true,
      logResponses: true,
      logErrors: true,
      sanitizeSensitiveData: true
    }
  };

  /**
   * Enhanced AxiosTransport with retry logic, caching, and comprehensive monitoring
   */
  export class AxiosTransport {
    readonly axios: AxiosInstance;
    private logger: Logger;
    private config: TransportConfig;
    private cache = new Map<string, CacheEntry>();
    private metrics: TransportMetrics = {
      totalRequests: 0,
      totalErrors: 0,
      totalCacheHits: 0,
      totalCacheMisses: 0,
      averageResponseTime: 0,
      requestsByMethod: {},
      errorsByCode: {}
    };
    private responseTimes: number[] = [];
    private cacheCleanupTimer?: NodeJS.Timeout;
  
    constructor({ baseUrl, apiKey, instance, config }: AxiosTransportOptions) {
      this.logger = new Logger({ module: 'axios-transport' });
      this.config = { ...defaultTransportConfig, ...config };
      
      // Use an injected instance or create one that mimics `axiosServices`
      // Use provided apiKey as the Token. Must be requested on the app.
      this.axios =
        instance ??
        axios.create({
          baseURL: baseUrl.replace(/\/+$/, "/"),
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Token ${apiKey}` } : {}),
          },
        });

      this.setupInterceptors();
      
      // Start cache cleanup timer
      if (this.config.cache.enabled) {
        this.cacheCleanupTimer = setInterval(() => this.cleanupCache(), 60000); // Clean every minute
      }
    }

    /**
     * Setup request and response interceptors with enhanced functionality
     */
    private setupInterceptors(): void {
      /* ---------- REQUEST INTERCEPTOR ---------- */
      this.axios.interceptors.request.use((cfg) => {
        const requestId = this.generateRequestId();
        const startTime = Date.now();
        
        // Store request metadata for metrics
        cfg.metadata = {
          requestId,
          startTime,
          method: cfg.method?.toUpperCase() || 'GET',
          url: cfg.url || ''
        };

        // Log request if enabled
        if (this.config.logging.enabled && this.config.logging.logRequests) {
          this.logger.debug('HTTP Request', {
            requestId,
            method: cfg.method?.toUpperCase(),
            url: cfg.url,
            params: this.config.logging.sanitizeSensitiveData 
              ? this.sanitizeData(cfg.params) 
              : cfg.params,
            data: this.config.logging.sanitizeSensitiveData 
              ? this.sanitizeData(cfg.data) 
              : cfg.data
          });
        }

        // Convert data and params to snake_case
        if (cfg.data && typeof cfg.data === "object") {
          cfg.data = objToSnakeCase(cfg.data);
        }
        if (cfg.params && typeof cfg.params === "object") {
          cfg.params = objToSnakeCase(cfg.params);
        }

        // Inject mcp_request: true parameter for backend identification
        const method = cfg.method?.toUpperCase();
        
        if (method === "GET" || method === "DELETE") {
          // For GET/DELETE requests, add to query parameters
          cfg.params = cfg.params || {};
          cfg.params.mcp_request = true;
        } else if (method === "POST" || method === "PUT" || method === "PATCH") {
          // For POST/PUT/PATCH requests, add to request body
          if (cfg.data && typeof cfg.data === "object") {
            cfg.data.mcp_request = true;
          } else if (!cfg.data) {
            cfg.data = { mcp_request: true };
          }
        }
        
        return cfg;
      });

      /* ---------- RESPONSE INTERCEPTOR ---------- */
      this.axios.interceptors.response.use(
        (res: AxiosResponse) => {
          const endTime = Date.now();
          const { requestId, startTime, method, url } = res.config.metadata || {};
          const duration = startTime ? endTime - startTime : 0;

          // Update metrics
          this.updateMetrics({
            startTime: startTime || endTime,
            endTime,
            duration,
            method: method || 'GET',
            url: url || '',
            statusCode: res.status
          });

          // Log response if enabled
          if (this.config.logging.enabled && this.config.logging.logResponses) {
            this.logger.debug('HTTP Response', {
              requestId,
              statusCode: res.status,
              duration: `${duration}ms`,
              size: JSON.stringify(res.data).length
            });
          }

          // Convert response data to camelCase
          res.data = objToCamelCase(res.data);
          return res;
        },
        (err) => {
          const endTime = Date.now();
          const { requestId, startTime, method, url } = err.config?.metadata || {};
          const duration = startTime ? endTime - startTime : 0;

          // Handle HTML error responses from Django
          if (err.response?.data && typeof err.response.data === 'string' && err.response.data.includes('<!DOCTYPE html>')) {
            const mcpError = new MCPError(
              MCPErrorCode.METHOD_NOT_FOUND,
              `API endpoint not found (${err.response.status})`,
              { statusCode: err.response.status, url: err.config?.url }
            );
            
            this.updateMetrics({
              startTime: startTime || endTime,
              endTime,
              duration,
              method: method || 'GET',
              url: url || '',
              statusCode: err.response.status,
              error: 'ENDPOINT_NOT_FOUND'
            });

            return Promise.reject(mcpError);
          }

          // Convert error to MCP format
          const mcpError = handleExternalServiceError(err, 'HTTP', method);
          
          // Update error metrics
          this.updateMetrics({
            startTime: startTime || endTime,
            endTime,
            duration,
            method: method || 'GET',
            url: url || '',
            statusCode: err.response?.status,
            error: mcpError.code.toString()
          });

          // Log error if enabled
          if (this.config.logging.enabled && this.config.logging.logErrors) {
            this.logger.error('HTTP Request failed', {
              requestId,
              statusCode: err.response?.status,
              duration: `${duration}ms`,
              error: mcpError.message
            });
          }
          
          return Promise.reject(mcpError);
        },
      );
    }

    /**
     * Enhanced request method with retry logic and caching
     */
    async request<T = unknown>(cfg: AxiosRequestConfig): Promise<T> {
      const cacheKey = this.getCacheKey(cfg);
      
      // Check cache for GET requests
      if (cfg.method?.toUpperCase() === 'GET' && this.config.cache.enabled) {
        const cached = this.getFromCache<T>(cacheKey);
        if (cached) {
          this.metrics.totalCacheHits++;
          this.logger.debug('Cache hit', { url: cfg.url, cacheKey });
          return cached;
        }
        this.metrics.totalCacheMisses++;
      }

      // Execute request with retry logic
      const response = await this.executeWithRetry<T>(cfg);
      
      // Cache successful GET responses
      if (cfg.method?.toUpperCase() === 'GET' && this.config.cache.enabled && response) {
        this.setCache(cacheKey, response, cfg);
      }

      return response;
    }

    /**
     * Execute request with exponential backoff retry logic
     */
    private async executeWithRetry<T>(cfg: AxiosRequestConfig, attempt = 1): Promise<T> {
      try {
        const res = await this.axios.request<T>(cfg);
        return res.data;
      } catch (error) {
        const mcpError = error instanceof MCPError ? error : toMCPError(error, 'HTTP Request');
        
        // Check if error is retryable and we haven't exceeded max attempts
        if (attempt < this.config.retry.maxAttempts && this.isRetryableError(mcpError)) {
          const delay = this.calculateDelay(attempt);
          
          this.logger.warn('Request failed, retrying', {
            attempt,
            maxAttempts: this.config.retry.maxAttempts,
            delay: `${delay}ms`,
            error: mcpError.message
          });

          await this.delay(delay);
          return this.executeWithRetry<T>(cfg, attempt + 1);
        }

        throw mcpError;
      }
    }

    /**
     * Check if error is retryable based on configuration
     */
    private isRetryableError(error: MCPError): boolean {
      // Check for retryable MCP error codes
      if (this.config.retry.retryableErrorCodes.includes(error.code)) {
        return true;
      }

      // Check for retryable HTTP status codes
      const statusCode = error.data?.statusCode;
      if (statusCode && this.config.retry.retryableStatusCodes.includes(statusCode)) {
        return true;
      }

      return false;
    }

    /**
     * Calculate exponential backoff delay
     */
    private calculateDelay(attempt: number): number {
      const delay = this.config.retry.baseDelay * 
        Math.pow(this.config.retry.exponentialBase, attempt - 1);
      return Math.min(delay, this.config.retry.maxDelay);
    }

    /**
     * Promise-based delay utility
     */
    private delay(ms: number): Promise<void> {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Cache management methods
     */
    private getCacheKey(cfg: AxiosRequestConfig): string {
      const url = cfg.url || '';
      const params = cfg.params ? JSON.stringify(cfg.params) : '';
      return `${cfg.method?.toUpperCase() || 'GET'}:${url}:${params}`;
    }

    private getFromCache<T>(key: string): T | null {
      const entry = this.cache.get(key);
      if (!entry) return null;

      // Check if entry is expired
      if (Date.now() - entry.timestamp > entry.ttl) {
        this.cache.delete(key);
        return null;
      }

      return entry.data as T;
    }

    private setCache<T>(key: string, data: T, cfg: AxiosRequestConfig): void {
      // Check if URL should be excluded from caching
      const url = cfg.url || '';
      if (this.config.cache.excludePatterns?.some(pattern => url.includes(pattern))) {
        return;
      }

      // Implement LRU eviction if cache is full
      if (this.cache.size >= this.config.cache.maxSize) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey) {
          this.cache.delete(firstKey);
        }
      }

      this.cache.set(key, {
        data,
        timestamp: Date.now(),
        ttl: this.config.cache.ttl,
        url,
        method: cfg.method?.toUpperCase() || 'GET'
      });
    }

    private cleanupCache(): void {
      const now = Date.now();
      for (const [key, entry] of this.cache.entries()) {
        if (now - entry.timestamp > entry.ttl) {
          this.cache.delete(key);
        }
      }
    }

    /**
     * Metrics management
     */
    private updateMetrics(metrics: RequestMetrics): void {
      if (!this.config.metrics.enabled) return;

      this.metrics.totalRequests++;
      
      if (metrics.error) {
        this.metrics.totalErrors++;
        this.metrics.errorsByCode[metrics.error] = 
          (this.metrics.errorsByCode[metrics.error] || 0) + 1;
      }

      if (metrics.duration && this.config.metrics.collectTiming) {
        this.responseTimes.push(metrics.duration);
        // Keep only last 1000 response times for rolling average
        if (this.responseTimes.length > 1000) {
          this.responseTimes = this.responseTimes.slice(-1000);
        }
        this.metrics.averageResponseTime = 
          this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length;
      }

      this.metrics.requestsByMethod[metrics.method] = 
        (this.metrics.requestsByMethod[metrics.method] || 0) + 1;
    }

    /**
     * Utility methods
     */
    private generateRequestId(): string {
      return Math.random().toString(36).substring(2) + Date.now().toString(36);
    }

    private sanitizeData(data: any): any {
      if (!data || typeof data !== 'object') return data;
      
      const sanitized = { ...data };
      const sensitiveKeys = ['password', 'token', 'key', 'secret', 'apiKey', 'authorization'];
      
      for (const key of Object.keys(sanitized)) {
        if (sensitiveKeys.some(sensitive => key.toLowerCase().includes(sensitive))) {
          sanitized[key] = '[REDACTED]';
        }
      }
      
      return sanitized;
    }

    /* ---------- PUBLIC METHODS ---------- */

    /**
     * Get current transport metrics
     */
    getMetrics(): TransportMetrics {
      return { ...this.metrics };
    }

    /**
     * Reset metrics counters
     */
    resetMetrics(): void {
      this.metrics = {
        totalRequests: 0,
        totalErrors: 0,
        totalCacheHits: 0,
        totalCacheMisses: 0,
        averageResponseTime: 0,
        requestsByMethod: {},
        errorsByCode: {}
      };
      this.responseTimes = [];
    }

    /**
     * Clear cache entries
     */
    clearCache(): void {
      this.cache.clear();
    }

    /**
     * Cleanup resources and timers
     */
    destroy(): void {
      if (this.cacheCleanupTimer) {
        clearInterval(this.cacheCleanupTimer);
        this.cacheCleanupTimer = undefined;
      }
      this.cache.clear();
    }

    /**
     * Get cache statistics
     */
    getCacheStats(): { size: number; maxSize: number; hitRatio: number } {
      const totalCacheRequests = this.metrics.totalCacheHits + this.metrics.totalCacheMisses;
      return {
        size: this.cache.size,
        maxSize: this.config.cache.maxSize,
        hitRatio: totalCacheRequests > 0 ? this.metrics.totalCacheHits / totalCacheRequests : 0
      };
    }

    /* ---------- SHORTHAND METHODS ---------- */
    get<T = unknown>(url: string, params?: any) {
      return this.request<T>({ url, method: "GET", params });
    }
  
    post<T = unknown>(url: string, data?: any, cfg?: AxiosRequestConfig) {
      return this.request<T>({ url, method: "POST", data, ...cfg });
    }
  
    put<T = unknown>(url: string, data?: any, cfg?: AxiosRequestConfig) {
      return this.request<T>({ url, method: "PUT", data, ...cfg });
    }
  
    patch<T = unknown>(url: string, data?: any, cfg?: AxiosRequestConfig) {
      return this.request<T>({ url, method: "PATCH", data, ...cfg });
    }
  
    delete<T = unknown>(url: string, cfg?: AxiosRequestConfig) {
      return this.request<T>({ url, method: "DELETE", ...cfg });
    }
  }
  