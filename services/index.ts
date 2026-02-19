import { createE2esService, E2esService } from "./e2es.js";
import { createBrowserSessionsService, BrowserSessionsService } from "./browserSessions.js";
import { createWorkflowsService, WorkflowsService } from "./workflows.js";
import { AxiosTransport, AxiosTransportOptions } from "../utils/axiosTransport.js";
import axios, { AxiosRequestConfig, AxiosInstance } from "axios";
import { config } from "../config/index.js";

/**
 * DebuggTransport extends AxiosTransport to automatically add isMcpRequest=true
 * to all requests so the server knows they're coming from MCP
 */
class DebuggTransport extends AxiosTransport {
  constructor(options: AxiosTransportOptions) {
    super(options);
    
    // Override the request interceptor to add isMcpRequest to all requests
    this.axios.interceptors.request.use((config) => {
      // For GET requests, add to params
      if (config.method?.toLowerCase() === 'get') {
        config.params = config.params || {};
        config.params.isMcpRequest = true;
      } else {
        // For POST, PUT, PATCH, DELETE requests, add to data
        if (config.data && typeof config.data === 'object') {
          config.data.isMcpRequest = true;
        } else if (!config.data) {
          config.data = { isMcpRequest: true };
        }
      }
      return config;
    });
  }
}


export class DebuggAIServerClient  {
  tx: DebuggTransport | undefined;
  url: URL | undefined;

  // Public "sub‑APIs"
  e2es: E2esService | undefined;
  browserSessions: BrowserSessionsService | undefined;
  workflows: WorkflowsService | undefined;

  constructor(
    public userApiKey: string,
  ) {
    // Note: init() is async and should be called separately
  }

  public async init() {
    const serverUrl = config.api.baseUrl;
    this.url = new URL(serverUrl);
    this.tx = new DebuggTransport({ baseUrl: serverUrl, apiKey: this.userApiKey, tokenType: config.api.tokenType });
    this.e2es = createE2esService(this.tx);
    this.browserSessions = createBrowserSessionsService(this.tx);
    this.workflows = createWorkflowsService(this.tx);
  }

}

/**
 * Create and initialize a service client
 */
export async function createClientService(): Promise<DebuggAIServerClient> {
  const client = new DebuggAIServerClient(config.api.key);
  await client.init();
  return client;
}
