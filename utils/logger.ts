/**
 * Centralized logging utility using Winston
 * Replaces all console.error calls with structured logging
 */

import winston from 'winston';
import { config } from '../config/index.js';
import { LogLevel, LogContext } from '../types/index.js';

/**
 * Create winston logger instance
 */
const createLogger = (): winston.Logger => {
  const { level, format } = config.logging;
  
  const logFormat = format === 'json' 
    ? winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      )
    : winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
          return `[${timestamp}] ${level.toUpperCase()}: ${message}${metaStr}`;
        })
      );

  return winston.createLogger({
    level,
    format: logFormat,
    transports: [
      new winston.transports.Console({
        stderrLevels: ['error', 'warn', 'info', 'debug'],
      }),
    ],
    // Ensure uncaught exceptions and rejections are logged
    exceptionHandlers: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          winston.format.json()
        ),
      }),
    ],
    rejectionHandlers: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          winston.format.json()
        ),
      }),
    ],
  });
};

/**
 * Global logger instance - created lazily to avoid import-time config loading
 */
let _logger: winston.Logger | undefined;

export const logger = {
  error: (message: string, meta?: any) => getLogger().error(message, meta),
  warn: (message: string, meta?: any) => getLogger().warn(message, meta),
  info: (message: string, meta?: any) => getLogger().info(message, meta),
  debug: (message: string, meta?: any) => getLogger().debug(message, meta),
};

function getLogger(): winston.Logger {
  if (!_logger) {
    _logger = createLogger();
  }
  return _logger;
}

/**
 * Enhanced logging functions with context support
 */
export class Logger {
  private context: LogContext;

  constructor(context: LogContext = {}) {
    this.context = context;
  }

  /**
   * Create a child logger with additional context
   */
  child(additionalContext: LogContext): Logger {
    return new Logger({ ...this.context, ...additionalContext });
  }

  /**
   * Log error messages
   */
  error(message: string, meta?: any): void {
    logger.error(message, { ...this.context, ...meta });
  }

  /**
   * Log warning messages
   */
  warn(message: string, meta?: any): void {
    logger.warn(message, { ...this.context, ...meta });
  }

  /**
   * Log info messages
   */
  info(message: string, meta?: any): void {
    logger.info(message, { ...this.context, ...meta });
  }

  /**
   * Log debug messages
   */
  debug(message: string, meta?: any): void {
    logger.debug(message, { ...this.context, ...meta });
  }

  /**
   * Log tool execution start
   */
  toolStart(toolName: string, input: any): void {
    this.info(`Tool execution started: ${toolName}`, { 
      toolName, 
      input: this.sanitizeInput(input) 
    });
  }

  /**
   * Log tool execution completion
   */
  toolComplete(toolName: string, duration: number): void {
    this.info(`Tool execution completed: ${toolName}`, { 
      toolName, 
      duration: `${duration}ms` 
    });
  }

  /**
   * Log tool execution error
   */
  toolError(toolName: string, error: Error, duration: number): void {
    this.error(`Tool execution failed: ${toolName}`, { 
      toolName, 
      error: error.message,
      stack: error.stack,
      duration: `${duration}ms` 
    });
  }

  /**
   * Log progress updates
   */
  progress(message: string, progress: number, total: number): void {
    this.info(`Progress: ${message}`, { 
      progress, 
      total, 
      percentage: Math.round((progress / total) * 100) 
    });
  }

  /**
   * Sanitize input data for logging (remove sensitive information)
   */
  private sanitizeInput(input: any): any {
    if (typeof input !== 'object' || input === null) {
      return input;
    }

    const sanitized = { ...input };
    const sensitiveKeys = ['password', 'token', 'key', 'secret', 'apiKey'];
    
    for (const key of Object.keys(sanitized)) {
      if (sensitiveKeys.some(sensitive => key.toLowerCase().includes(sensitive))) {
        sanitized[key] = '[REDACTED]';
      }
    }

    return sanitized;
  }
}

/**
 * Default logger instance
 */
export const defaultLogger = new Logger();