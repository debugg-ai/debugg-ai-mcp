/**
 * Tunnel Management Service
 * Provides high-level tunnel management abstraction for localhost URLs
 */

import { Logger } from '../../utils/logger.js';
import { isLocalhostUrl, extractLocalhostPort, generateTunnelUrl } from '../../utils/urlParser.js';
import { v4 as uuidv4 } from 'uuid';
import { createRequire } from 'module';

// Use createRequire to avoid ES module resolution issues
const require = createRequire(import.meta.url);
let ngrokModule: any = null;

async function getNgrok() {
  if (!ngrokModule) {
    try {
      ngrokModule = require('ngrok');
    } catch (error) {
      throw new Error(`Failed to load ngrok module: ${error}`);
    }
  }
  return ngrokModule;
}

const logger = new Logger({ module: 'tunnelManager' });

export interface TunnelInfo {
  tunnelId: string;
  originalUrl: string;
  tunnelUrl: string;
  publicUrl: string;
  port: number;
  createdAt: number;
  lastAccessedAt: number;
  autoShutoffTimer?: NodeJS.Timeout;
}

export interface TunnelResult {
  url: string;
  tunnelId?: string;
  isLocalhost: boolean;
}

class TunnelManager {
  private activeTunnels = new Map<string, TunnelInfo>();
  private pendingTunnels = new Map<number, Promise<TunnelInfo>>();
  private initialized = false;
  private readonly TUNNEL_TIMEOUT_MS = 60 * 55 * 1000; // 55 minutes (we get billed by the hour, so dont want to run 1 min past the hour)

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      try {
        const ngrok = await getNgrok();
        // Try to get the API to check if ngrok is running
        const api = ngrok.getApi();
        if (!api) {
          logger.debug('ngrok API not available, may need to start first tunnel');
        }
        this.initialized = true;
      } catch (error) {
        logger.debug(`ngrok initialization check: ${error}`);
        this.initialized = true; // Continue anyway, let connection attempt handle the error
      }
    }
  }

  /**
   * Reset the auto-shutoff timer for a tunnel
   */
  private resetTunnelTimer(tunnelInfo: TunnelInfo): void {
    // Clear existing timer
    if (tunnelInfo.autoShutoffTimer) {
      clearTimeout(tunnelInfo.autoShutoffTimer);
    }

    // Update last access time
    tunnelInfo.lastAccessedAt = Date.now();

    // Set new timer
    tunnelInfo.autoShutoffTimer = setTimeout(async () => {
      logger.info(`Auto-shutting down tunnel ${tunnelInfo.tunnelId} after 60 minutes of inactivity`);
      try {
        await this.stopTunnel(tunnelInfo.tunnelId);
      } catch (error) {
        logger.error(`Failed to auto-shutdown tunnel ${tunnelInfo.tunnelId}:`, error);
      }
    }, this.TUNNEL_TIMEOUT_MS);

    logger.debug(`Reset timer for tunnel ${tunnelInfo.tunnelId}, will auto-shutdown at ${new Date(tunnelInfo.lastAccessedAt + this.TUNNEL_TIMEOUT_MS).toISOString()}`);
  }

  /**
   * Touch a tunnel to reset its timer (called when the tunnel is used)
   */
  touchTunnel(tunnelId: string): void {
    const tunnelInfo = this.activeTunnels.get(tunnelId);
    if (tunnelInfo) {
      this.resetTunnelTimer(tunnelInfo);
    }
  }

  /**
   * Touch a tunnel by URL (convenience method)
   */
  touchTunnelByUrl(url: string): void {
    const tunnelId = this.extractTunnelId(url);
    if (tunnelId) {
      this.touchTunnel(tunnelId);
    }
  }

  /**
   * Process a URL and create a tunnel if needed
   * Returns the URL to use (either original or tunneled) and tunnel metadata
   */
  async processUrl(url: string, authToken?: string, specificTunnelId?: string): Promise<TunnelResult> {
    if (!isLocalhostUrl(url)) {
      return {
        url,
        isLocalhost: false
      };
    }

    const port = extractLocalhostPort(url);
    if (!port) {
      throw new Error(`Could not extract port from localhost URL: ${url}`);
    }

    // Check if we already have an active tunnel for this port
    const existingTunnel = this.findTunnelByPort(port);
    if (existingTunnel) {
      const publicUrl = generateTunnelUrl(url, existingTunnel.tunnelId);
      logger.info(`Reusing existing tunnel for port ${port}: ${publicUrl}`);
      return { url: publicUrl, tunnelId: existingTunnel.tunnelId, isLocalhost: true };
    }

    // If a tunnel creation is already in-flight for this port, wait for it
    const pending = this.pendingTunnels.get(port);
    if (pending) {
      logger.info(`Waiting for in-flight tunnel creation for port ${port}`);
      const tunnelInfo = await pending;
      return { url: tunnelInfo.publicUrl, tunnelId: tunnelInfo.tunnelId, isLocalhost: true };
    }

    // Create new tunnel
    if (!authToken) {
      throw new Error('Auth token required to create tunnel for localhost URL');
    }

    const tunnelId = specificTunnelId || uuidv4();
    const creationPromise = this.createTunnel(url, port, tunnelId, authToken);
    this.pendingTunnels.set(port, creationPromise);

    let tunnelInfo: TunnelInfo;
    try {
      tunnelInfo = await creationPromise;
    } finally {
      this.pendingTunnels.delete(port);
    }

    return {
      url: tunnelInfo.publicUrl,
      tunnelId: tunnelInfo.tunnelId,
      isLocalhost: true
    };
  }

  /**
   * Check if a URL is a tunnel URL
   */
  isTunnelUrl(url: string): boolean {
    return url.includes('.ngrok.debugg.ai');
  }

  /**
   * Extract tunnel ID from a tunnel URL
   */
  extractTunnelId(url: string): string | null {
    const match = url.match(/https?:\/\/([^.]+)\.ngrok\.debugg\.ai/);
    return match ? match[1] : null;
  }

  /**
   * Get tunnel info by ID
   */
  getTunnelInfo(tunnelId: string): TunnelInfo | undefined {
    return this.activeTunnels.get(tunnelId);
  }

  /**
   * Find tunnel by port
   */
  private findTunnelByPort(port: number): TunnelInfo | undefined {
    for (const tunnel of this.activeTunnels.values()) {
      if (tunnel.port === port) {
        return tunnel;
      }
    }
    return undefined;
  }

  /**
   * Create a new tunnel
   */
  private async createTunnel(originalUrl: string, port: number, tunnelId: string, authToken: string): Promise<TunnelInfo> {
    await this.ensureInitialized();

    const tunnelDomain = `${tunnelId}.ngrok.debugg.ai`;
    
    logger.info(`Creating tunnel for localhost:${port} with domain ${tunnelDomain}`);
    
    try {
      // Get ngrok module dynamically
      const ngrok = await getNgrok();
      
      // Set auth token first
      logger.debug(`Setting ngrok auth token`);
      await ngrok.authtoken({ authtoken: authToken });
      
      // Create tunnel options
      const tunnelOptions = {
        proto: 'http' as const,
        addr: process.env.DOCKER_CONTAINER === "true" ? `host.docker.internal:${port}` : port,
        hostname: tunnelDomain,
        authtoken: authToken
        // Don't override configPath - let ngrok use its default configuration
      };
      
      logger.debug(`Connecting tunnel with options: ${JSON.stringify({ ...tunnelOptions, authtoken: '[REDACTED]' })}`);
      
      // For ngrok v5, we might need to handle the connection differently
      let tunnelUrl: string;
      try {
        tunnelUrl = await ngrok.connect(tunnelOptions);
      } catch (connectError) {
        // If connection fails due to ngrok not running, try with different options
        if (connectError instanceof Error && connectError.message.includes('ECONNREFUSED')) {
          logger.info('ngrok daemon not running, attempting to start tunnel with minimal options');
          const minimalOptions = {
            proto: 'http' as const,
            addr: process.env.DOCKER_CONTAINER === "true" ? `host.docker.internal:${port}` : port,
            authtoken: authToken
          };
          tunnelUrl = await ngrok.connect(minimalOptions);
        } else {
          throw connectError;
        }
      }
      if (!tunnelUrl) {
        throw new Error('Failed to create tunnel');
      }
      
      // Generate the public URL maintaining path, search, and hash from original
      const publicUrl = generateTunnelUrl(originalUrl, tunnelId);
      
      // Store tunnel info
      const now = Date.now();
      const tunnelInfo: TunnelInfo = {
        tunnelId,
        originalUrl,
        tunnelUrl,
        publicUrl,
        port,
        createdAt: now,
        lastAccessedAt: now
      };
      
      this.activeTunnels.set(tunnelId, tunnelInfo);
      
      // Start the auto-shutoff timer
      this.resetTunnelTimer(tunnelInfo);
      
      logger.info(`Tunnel created: ${publicUrl} -> localhost:${port}`);
      return tunnelInfo;
      
    } catch (error) {
      logger.error(`Failed to create tunnel for ${originalUrl}:`, error);
      
      // Try to provide more helpful error messages
      if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
        throw new Error(`Failed to create tunnel: ngrok daemon not running or connection refused. Original error: ${error.message}`);
      } else if (error instanceof Error && error.message.includes('authtoken')) {
        throw new Error(`Failed to create tunnel: Invalid or missing auth token. Original error: ${error.message}`);
      } else {
        throw new Error(`Failed to create tunnel: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  }

  /**
   * Stop a tunnel by ID
   */
  async stopTunnel(tunnelId: string): Promise<void> {
    const tunnelInfo = this.activeTunnels.get(tunnelId);
    if (!tunnelInfo) {
      logger.warn(`Tunnel ${tunnelId} not found for cleanup`);
      return;
    }
    
    try {
      // Clear the auto-shutoff timer
      if (tunnelInfo.autoShutoffTimer) {
        clearTimeout(tunnelInfo.autoShutoffTimer);
      }

      const ngrok = await getNgrok();
      await ngrok.disconnect(tunnelInfo.tunnelUrl);
      this.activeTunnels.delete(tunnelId);
      logger.info(`Cleaned up tunnel: ${tunnelInfo.publicUrl}`);
    } catch (error) {
      logger.error(`Failed to cleanup tunnel ${tunnelId}:`, error);
      throw error;
    }
  }

  /**
   * Stop all active tunnels
   */
  async stopAllTunnels(): Promise<void> {
    const tunnelIds = Array.from(this.activeTunnels.keys());
    const cleanupPromises = tunnelIds.map(tunnelId => 
      this.stopTunnel(tunnelId).catch(error => 
        logger.error(`Failed to stop tunnel ${tunnelId}:`, error)
      )
    );
    
    await Promise.all(cleanupPromises);
    logger.info(`Stopped ${tunnelIds.length} tunnels`);
  }

  /**
   * Get all active tunnels
   */
  getActiveTunnels(): TunnelInfo[] {
    return Array.from(this.activeTunnels.values());
  }

  /**
   * Get tunnel status with timing information
   */
  getTunnelStatus(tunnelId: string): {
    tunnel: TunnelInfo;
    age: number;
    timeSinceLastAccess: number;
    timeUntilAutoShutoff: number;
  } | null {
    const tunnel = this.activeTunnels.get(tunnelId);
    if (!tunnel) {
      return null;
    }

    const now = Date.now();
    const age = now - tunnel.createdAt;
    const timeSinceLastAccess = now - tunnel.lastAccessedAt;
    const timeUntilAutoShutoff = Math.max(0, (tunnel.lastAccessedAt + this.TUNNEL_TIMEOUT_MS) - now);

    return {
      tunnel,
      age,
      timeSinceLastAccess,
      timeUntilAutoShutoff
    };
  }

  /**
   * Get all tunnel statuses
   */
  getAllTunnelStatuses() {
    const statuses = [];
    for (const tunnelId of this.activeTunnels.keys()) {
      const status = this.getTunnelStatus(tunnelId);
      if (status) {
        statuses.push(status);
      }
    }
    return statuses;
  }
}

// Singleton instance
const tunnelManager = new TunnelManager();

export { tunnelManager };
export default TunnelManager;