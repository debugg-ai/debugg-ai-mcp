import { createWorkflowsService, WorkflowsService } from "./workflows.js";
import { createTunnelsService, TunnelsService } from "./tunnels.js";
import { AxiosTransport, AxiosTransportOptions } from "../utils/axiosTransport.js";
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


export interface ProjectInfo {
  uuid: string;
  name: string;
  slug: string;
  repo?: { uuid: string; name: string } | null;
}

export class DebuggAIServerClient  {
  tx: DebuggTransport | undefined;
  url: URL | undefined;

  workflows: WorkflowsService | undefined;
  tunnels: TunnelsService | undefined;

  constructor(
    public userApiKey: string,
  ) {
    // Note: init() is async and should be called separately
  }

  public async init() {
    const serverUrl = config.api.baseUrl;
    this.url = new URL(serverUrl);
    this.tx = new DebuggTransport({ baseUrl: serverUrl, apiKey: this.userApiKey, tokenType: config.api.tokenType });
    this.workflows = createWorkflowsService(this.tx);
    this.tunnels = createTunnelsService(this.tx);
  }

  /**
   * Look up a project by repo name. Uses ?search= then client-side filters
   * on repo.name (which is "owner/repo-name" format).
   * Returns the first match or null.
   */
  public async findProjectByRepoName(repoName: string): Promise<ProjectInfo | null> {
    if (!this.tx) throw new Error('Client not initialized — call init() first');
    const response = await this.tx.get<{ results: ProjectInfo[] }>(
      'api/v1/projects/',
      { search: repoName }
    );
    const projects = response?.results ?? [];
    if (projects.length === 0) return null;

    // Exact match on project name or slug first
    const exact = projects.find(
      p => p.name === repoName || p.slug === repoName
    );
    if (exact) return exact;

    // Match on repo.name (owner/repo-name — check if it ends with /repoName)
    const repoMatch = projects.find(
      p => p.repo?.name === repoName || p.repo?.name?.endsWith(`/${repoName}`)
    );
    if (repoMatch) return repoMatch;

    // Fallback to first result from search
    return projects[0];
  }

  /**
   * Revoke an ngrok API key by its key ID.
   * Call this after workflow execution completes to clean up the short-lived key.
   */
  public async revokeNgrokKey(ngrokKeyId: string): Promise<void> {
    if (!this.tx) throw new Error('Client not initialized — call init() first');
    await this.tx.post('api/v1/ngrok/revoke/', { ngrokKeyId });
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
