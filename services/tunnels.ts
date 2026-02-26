/**
 * Tunnels Service
 * Provisions short-lived ngrok keys for MCP-managed tunnel setup.
 * Called before executeWorkflow so the tunnel URL is known before execution starts.
 */

import { AxiosTransport } from '../utils/axiosTransport.js';

export interface TunnelProvision {
  tunnelId: string;
  tunnelKey: string;
  keyId: string;
  expiresAt: string;
}

export interface TunnelsService {
  provision(purpose?: string): Promise<TunnelProvision>;
}

export const createTunnelsService = (tx: AxiosTransport): TunnelsService => ({
  async provision(purpose = 'workflow'): Promise<TunnelProvision> {
    const response = await tx.post<{
      tunnelId: string;
      tunnelKey: string;
      keyId: string;
      expiresAt: string;
    }>('api/v1/tunnels/', { purpose });

    if (!response?.tunnelId || !response?.tunnelKey) {
      throw new Error('Tunnel provisioning failed: missing tunnelId or tunnelKey in response');
    }

    return {
      tunnelId: response.tunnelId,
      tunnelKey: response.tunnelKey,
      keyId: response.keyId,
      expiresAt: response.expiresAt,
    };
  },
});
