/**
 * Tunnel Management Service
 * Provides high-level tunnel management abstraction for localhost URLs
 */

import { Logger } from '../../utils/logger.js';
import { isLocalhostUrl, extractLocalhostPort, generateTunnelUrl } from '../../utils/urlParser.js';
import { NgrokTunnelClient, setAuthToken } from './index.js';
import { v4 as uuidv4 } from 'uuid';

const logger = new Logger({ module: 'tunnelManager' });

export interface TunnelInfo {
  tunnelId: string;
  originalUrl: string;
  tunnelUrl: string;
  publicUrl: string;
  port: number;
}

export interface TunnelResult {
  url: string;
  tunnelId?: string;
  isLocalhost: boolean;
}

class TunnelManager {
  private client: NgrokTunnelClient | null = null;
  private activeTunnels = new Map<string, TunnelInfo>();
  private initialized = false;

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.client = new NgrokTunnelClient();
      await this.client.downloadBinary();
      this.initialized = true;
    }
  }

  /**
   * Process a URL and create a tunnel if needed
   * Returns the URL to use (either original or tunneled) and tunnel metadata
   */
  async processUrl(url: string, authToken?: string): Promise<TunnelResult> {
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

    // Check if we already have a tunnel for this port
    const existingTunnel = this.findTunnelByPort(port);
    if (existingTunnel) {
      const publicUrl = generateTunnelUrl(url, existingTunnel.tunnelId);
      logger.info(`Reusing existing tunnel for port ${port}: ${publicUrl}`);
      return {
        url: publicUrl,
        tunnelId: existingTunnel.tunnelId,
        isLocalhost: true
      };
    }

    // Create new tunnel
    if (!authToken) {
      throw new Error('Auth token required to create tunnel for localhost URL');
    }

    const tunnelId = uuidv4();
    const tunnelInfo = await this.createTunnel(url, port, tunnelId, authToken);
    
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
    
    if (!this.client) {
      throw new Error('Tunnel client not initialized');
    }

    const tunnelDomain = `${tunnelId}.ngrok.debugg.ai`;
    
    logger.info(`Creating tunnel for localhost:${port} with domain ${tunnelDomain}`);
    
    try {
      // Set auth token
      await setAuthToken(authToken);
      
      // Create tunnel options
      const tunnelOptions = {
        proto: 'http' as const,
        addr: process.env.DOCKER_CONTAINER === "true" ? `host.docker.internal:${port}` : port,
        hostname: tunnelDomain,
        authtoken: authToken
      };
      
      const tunnelUrl = await this.client.start(tunnelOptions);
      if (!tunnelUrl) {
        throw new Error('Failed to create tunnel');
      }
      
      // Generate the public URL maintaining path, search, and hash from original
      const publicUrl = generateTunnelUrl(originalUrl, tunnelId);
      
      // Store tunnel info
      const tunnelInfo: TunnelInfo = {
        tunnelId,
        originalUrl,
        tunnelUrl,
        publicUrl,
        port
      };
      
      this.activeTunnels.set(tunnelId, tunnelInfo);
      
      logger.info(`Tunnel created: ${publicUrl} -> localhost:${port}`);
      return tunnelInfo;
      
    } catch (error) {
      logger.error(`Failed to create tunnel for ${originalUrl}:`, error);
      throw new Error(`Failed to create tunnel: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
      if (this.client) {
        await this.client.stop(tunnelInfo.tunnelUrl);
        this.activeTunnels.delete(tunnelId);
        logger.info(`Cleaned up tunnel: ${tunnelInfo.publicUrl}`);
      }
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
}

// Singleton instance
const tunnelManager = new TunnelManager();

export { tunnelManager };
export default TunnelManager;