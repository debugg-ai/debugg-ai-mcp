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
   * Look up a project by repo name.
   * Accepts "owner/repo" or bare "repo" — searches with the short name
   * (more likely to match project names) then ranks results by match quality.
   */
  public async findProjectByRepoName(repoName: string): Promise<ProjectInfo | null> {
    if (!this.tx) throw new Error('Client not initialized — call init() first');

    // "debugg-ai/react-web-app" → short = "react-web-app"
    const short = repoName.includes('/') ? repoName.split('/').pop()! : repoName;

    const response = await this.tx.get<{ results: ProjectInfo[] }>(
      'api/v1/projects/',
      { search: short }
    );
    const projects = response?.results ?? [];
    if (projects.length === 0) return null;

    // Exact match on full "owner/repo" or short name against project name/slug
    const exact = projects.find(
      p => p.name === repoName || p.name === short
        || p.slug === repoName || p.slug === short
    );
    if (exact) return exact;

    // Match on repo.name — backend may store "owner/repo" or just "repo"
    const repoMatch = projects.find(
      p => p.repo?.name === repoName || p.repo?.name === short
        || p.repo?.name?.endsWith(`/${short}`)
    );
    if (repoMatch) return repoMatch;

    // Fallback to first search result
    return projects[0];
  }

  /**
   * Simplified project shape used by get/update tools — drops heavy internal
   * fields (team, runner_configuration, github_auth_details) that most MCP
   * clients don't need.
   */
  private mapProjectDetail(p: any): { uuid: string; name: string; slug: string; platform: string | null; repoName: string | null; description: string | null; status: string | null; language: string | null; framework: string | null; timestamp: string; lastMod: string } {
    return {
      uuid: p.uuid,
      name: p.name,
      slug: p.slug,
      platform: p.platform ?? null,
      repoName: p.repo?.name ?? null,
      description: p.description ?? null,
      status: p.status ?? null,
      language: p.language ?? null,
      framework: p.framework ?? null,
      timestamp: p.timestamp,
      lastMod: p.lastMod,
    };
  }

  public async getProject(uuid: string) {
    if (!this.tx) throw new Error('Client not initialized — call init() first');
    const p = await this.tx.get<any>(`api/v1/projects/${uuid}/`);
    return this.mapProjectDetail(p);
  }

  public async updateProject(uuid: string, patch: { name?: string; description?: string }) {
    if (!this.tx) throw new Error('Client not initialized — call init() first');
    const body: Record<string, any> = {};
    if (patch.name !== undefined) body.name = patch.name;
    if (patch.description !== undefined) body.description = patch.description;
    const p = await this.tx.patch<any>(`api/v1/projects/${uuid}/`, body);
    return this.mapProjectDetail(p);
  }

  public async deleteProject(uuid: string): Promise<void> {
    if (!this.tx) throw new Error('Client not initialized — call init() first');
    await this.tx.delete(`api/v1/projects/${uuid}/`);
  }

  /**
   * List projects accessible to the current API key. Paginated.
   * Optional q filters by project name / repo name server-side (backend `?search=`).
   */
  public async listProjects(
    pagination: { page: number; pageSize: number },
    q?: string,
  ): Promise<{ pageInfo: import('../utils/pagination.js').PageInfo; projects: ProjectInfo[] }> {
    if (!this.tx) throw new Error('Client not initialized — call init() first');
    const { makePageInfo } = await import('../utils/pagination.js');
    const params: Record<string, any> = { page: pagination.page, pageSize: pagination.pageSize };
    if (q) params.search = q;
    const response = await this.tx.get<{ count: number; next: string | null; results: ProjectInfo[] }>(
      'api/v1/projects/',
      params,
    );
    return {
      pageInfo: makePageInfo(pagination.page, pagination.pageSize, response?.count ?? 0, response?.next),
      projects: response?.results ?? [],
    };
  }

  /**
   * List environments for a project. Paginated.
   * Optional q filters by name via backend ?search=.
   * The bare-array variant (no pagination) is still used internally by
   * list_credentials when iterating across all envs.
   */
  public async listEnvironmentsForProject(
    projectUuid: string,
    q?: string,
  ): Promise<Array<{ uuid: string; name: string; url: string; isActive: boolean }>> {
    if (!this.tx) throw new Error('Client not initialized — call init() first');
    const params: Record<string, any> = { pageSize: 200 };
    if (q) params.search = q;
    const response = await this.tx.get<{ results: any[] }>(
      `api/v1/projects/${projectUuid}/environments/`,
      params,
    );
    return (response?.results ?? []).map((e: any) => ({
      uuid: e.uuid,
      name: e.name,
      url: e.url || e.activeUrl || '',
      isActive: e.isActive,
    }));
  }

  public async listEnvironmentsPaginated(
    projectUuid: string,
    pagination: { page: number; pageSize: number },
    q?: string,
  ): Promise<{ pageInfo: import('../utils/pagination.js').PageInfo; environments: Array<{ uuid: string; name: string; url: string; isActive: boolean }> }> {
    if (!this.tx) throw new Error('Client not initialized — call init() first');
    const { makePageInfo } = await import('../utils/pagination.js');
    const params: Record<string, any> = { page: pagination.page, pageSize: pagination.pageSize };
    if (q) params.search = q;
    const response = await this.tx.get<{ count: number; next: string | null; results: any[] }>(
      `api/v1/projects/${projectUuid}/environments/`,
      params,
    );
    return {
      pageInfo: makePageInfo(pagination.page, pagination.pageSize, response?.count ?? 0, response?.next),
      environments: (response?.results ?? []).map((e: any) => ({
        uuid: e.uuid,
        name: e.name,
        url: e.url || e.activeUrl || '',
        isActive: e.isActive,
      })),
    };
  }

  /**
   * Create a new environment under a project.
   * Backend requires `name`. Other fields optional.
   */
  public async createEnvironment(
    projectUuid: string,
    input: { name: string; url?: string; description?: string },
  ): Promise<{ uuid: string; name: string; url: string; isActive: boolean }> {
    if (!this.tx) throw new Error('Client not initialized — call init() first');
    const body: Record<string, any> = { name: input.name };
    if (input.url) body.url = input.url;
    if (input.description) body.description = input.description;
    const response = await this.tx.post<any>(
      `api/v1/projects/${projectUuid}/environments/`,
      body,
    );
    return {
      uuid: response.uuid,
      name: response.name,
      url: response.url || response.activeUrl || '',
      isActive: response.isActive,
    };
  }

  /**
   * Delete an environment. Used by evals to clean up throwaway test envs.
   */
  public async deleteEnvironment(projectUuid: string, envUuid: string): Promise<void> {
    if (!this.tx) throw new Error('Client not initialized — call init() first');
    await this.tx.delete(`api/v1/projects/${projectUuid}/environments/${envUuid}/`);
  }

  /**
   * Fetch a single environment by UUID. Throws AxiosError with status 404 if not found.
   */
  public async getEnvironment(
    projectUuid: string,
    envUuid: string,
  ): Promise<{ uuid: string; name: string; url: string; isActive: boolean; description: string | null; endpointType: string; activeUrl: string | null; timestamp: string; lastMod: string }> {
    if (!this.tx) throw new Error('Client not initialized — call init() first');
    const e = await this.tx.get<any>(`api/v1/projects/${projectUuid}/environments/${envUuid}/`);
    return {
      uuid: e.uuid,
      name: e.name,
      url: e.url ?? '',
      isActive: e.isActive,
      description: e.description ?? null,
      endpointType: e.endpointType,
      activeUrl: e.activeUrl ?? null,
      timestamp: e.timestamp,
      lastMod: e.lastMod,
    };
  }

  /**
   * Patch an environment. Backend PATCH response omits uuid — caller should echo it.
   */
  public async updateEnvironment(
    projectUuid: string,
    envUuid: string,
    patch: { name?: string; url?: string; description?: string },
  ): Promise<{ uuid: string; name: string; url: string; isActive: boolean; description: string | null; endpointType: string }> {
    if (!this.tx) throw new Error('Client not initialized — call init() first');
    const body: Record<string, any> = {};
    if (patch.name !== undefined) body.name = patch.name;
    if (patch.url !== undefined) body.url = patch.url;
    if (patch.description !== undefined) body.description = patch.description;
    const e = await this.tx.patch<any>(
      `api/v1/projects/${projectUuid}/environments/${envUuid}/`,
      body,
    );
    return {
      uuid: envUuid, // echo from input; backend PATCH response omits it
      name: e.name,
      url: e.url ?? '',
      isActive: e.isActive,
      description: e.description ?? null,
      endpointType: e.endpointType,
    };
  }

  /**
   * List credentials for a specific environment. Unpaginated (fetches up to
   * backend max pageSize). q filters label/username client-side (backend
   * ?search= is inconsistent on this endpoint); role filters server-side.
   * Used internally by list_credentials when iterating across envs.
   */
  public async listCredentialsForEnvironment(
    projectUuid: string,
    envUuid: string,
    q?: string,
    role?: string,
  ): Promise<Array<{ uuid: string; label: string; username: string; role: string | null; environmentUuid: string }>> {
    if (!this.tx) throw new Error('Client not initialized — call init() first');
    const params: Record<string, any> = { pageSize: 200 };
    if (role) params.role = role;
    const response = await this.tx.get<{ results: any[] }>(
      `api/v1/projects/${projectUuid}/environments/${envUuid}/credentials/`,
      params,
    );
    let creds = (response?.results ?? [])
      .filter((c: any) => c.isActive)
      .map((c: any) => ({
        uuid: c.uuid,
        label: c.label || c.username,
        username: c.username,
        role: c.role,
        environmentUuid: envUuid,
      }));
    if (q) {
      const needle = q.toLowerCase();
      creds = creds.filter(c =>
        c.label.toLowerCase().includes(needle) ||
        c.username.toLowerCase().includes(needle)
      );
    }
    return creds;
  }

  public async listCredentialsPaginated(
    projectUuid: string,
    envUuid: string,
    pagination: { page: number; pageSize: number },
    q?: string,
    role?: string,
  ): Promise<{ pageInfo: import('../utils/pagination.js').PageInfo; credentials: Array<{ uuid: string; label: string; username: string; role: string | null; environmentUuid: string }> }> {
    if (!this.tx) throw new Error('Client not initialized — call init() first');
    const { makePageInfo } = await import('../utils/pagination.js');
    const params: Record<string, any> = { page: pagination.page, pageSize: pagination.pageSize };
    // Backend ?role= filter is currently ignored (bead hpo) — pass it anyway for future fix-forward,
    // but re-apply the filter client-side so behavior is correct today.
    if (role) params.role = role;
    const response = await this.tx.get<{ count: number; next: string | null; results: any[] }>(
      `api/v1/projects/${projectUuid}/environments/${envUuid}/credentials/`,
      params,
    );
    let creds = (response?.results ?? [])
      .filter((c: any) => c.isActive)
      .map((c: any) => ({
        uuid: c.uuid,
        label: c.label || c.username,
        username: c.username,
        role: c.role,
        environmentUuid: envUuid,
      }));
    if (q) {
      const needle = q.toLowerCase();
      creds = creds.filter(c =>
        c.label.toLowerCase().includes(needle) ||
        c.username.toLowerCase().includes(needle)
      );
    }
    if (role) {
      creds = creds.filter(c => c.role === role);
    }
    return {
      pageInfo: makePageInfo(pagination.page, pagination.pageSize, response?.count ?? 0, response?.next),
      credentials: creds,
    };
  }

  /**
   * Create a credential on an environment. password is write-only — never echoed back.
   */
  public async createCredential(
    projectUuid: string,
    envUuid: string,
    input: { label: string; username: string; password: string; role?: string },
  ): Promise<{ uuid: string; label: string; username: string; role: string | null; environmentUuid: string }> {
    if (!this.tx) throw new Error('Client not initialized — call init() first');
    const body: Record<string, any> = {
      label: input.label,
      username: input.username,
      password: input.password,
    };
    if (input.role) body.role = input.role;
    const response = await this.tx.post<any>(
      `api/v1/projects/${projectUuid}/environments/${envUuid}/credentials/`,
      body,
    );
    return {
      uuid: response.uuid,
      label: response.label || response.username,
      username: response.username,
      role: response.role,
      environmentUuid: envUuid,
    };
  }

  /**
   * Delete a credential. Used by evals to clean up throwaway test creds.
   */
  public async deleteCredential(projectUuid: string, envUuid: string, credUuid: string): Promise<void> {
    if (!this.tx) throw new Error('Client not initialized — call init() first');
    await this.tx.delete(`api/v1/projects/${projectUuid}/environments/${envUuid}/credentials/${credUuid}/`);
  }

  /**
   * Fetch a single credential by UUID. Throws AxiosError wrapper with statusCode=404 if not found.
   * Response shape omits any password field — backend credential schema has no password field.
   */
  public async getCredential(
    projectUuid: string,
    envUuid: string,
    credUuid: string,
  ): Promise<{ uuid: string; label: string; username: string; role: string | null; environmentUuid: string; environmentName: string | null; isActive: boolean; isDefault: boolean; description: string | null; timestamp: string; lastMod: string }> {
    if (!this.tx) throw new Error('Client not initialized — call init() first');
    const c = await this.tx.get<any>(`api/v1/projects/${projectUuid}/environments/${envUuid}/credentials/${credUuid}/`);
    return {
      uuid: c.uuid,
      label: c.label ?? c.username,
      username: c.username,
      role: c.role ?? null,
      environmentUuid: envUuid,
      environmentName: c.environmentName ?? null,
      isActive: c.isActive,
      isDefault: c.isDefault,
      description: c.description ?? null,
      timestamp: c.timestamp,
      lastMod: c.lastMod,
    };
  }

  /**
   * Update a credential via partial PATCH. Only the specified fields change.
   */
  public async updateCredential(
    projectUuid: string,
    envUuid: string,
    credUuid: string,
    patch: { label?: string; username?: string; password?: string; role?: string },
  ): Promise<{ uuid: string; label: string; username: string; role: string | null; environmentUuid: string; isActive: boolean }> {
    if (!this.tx) throw new Error('Client not initialized — call init() first');
    const body: Record<string, any> = {};
    if (patch.label !== undefined) body.label = patch.label;
    if (patch.username !== undefined) body.username = patch.username;
    if (patch.password !== undefined) body.password = patch.password;
    if (patch.role !== undefined) body.role = patch.role;
    const c = await this.tx.patch<any>(
      `api/v1/projects/${projectUuid}/environments/${envUuid}/credentials/${credUuid}/`,
      body,
    );
    return {
      uuid: credUuid, // echo from input; backend PATCH response omits it
      label: c.label,
      username: c.username,
      role: c.role ?? null,
      environmentUuid: envUuid,
      isActive: c.isActive,
    };
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
