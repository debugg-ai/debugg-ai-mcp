import { CoverageService, createCoverageService } from "./coverage.js";
import { createE2esService, E2esService } from "./e2es.js";
import { createIssuesService, IssuesService } from "./issues.js";
import { createReposService, ReposService } from "./repos.js";
import { AxiosTransport } from "../utils/axiosTransport.js";

export class DebuggAIServerClient  {
  tx: AxiosTransport | undefined;
  url: URL | undefined;

  // Public “sub‑APIs”
  repos: ReposService | undefined;
  issues: IssuesService | undefined;
  coverage: CoverageService | undefined;
  e2es: E2esService | undefined;

  constructor(
    public userApiKey: string,
  ) {
    this.init();
  }

  public async init() {
    const serverUrl = await this.getServerUrl();
    console.error("Server URL:", serverUrl);

    this.url = new URL(serverUrl);
    this.tx = new AxiosTransport({ baseUrl: serverUrl, apiKey: this.userApiKey });
    this.repos = createReposService(this.tx);
    this.issues = createIssuesService(this.tx);
    this.coverage = createCoverageService(this.tx);
    this.e2es = createE2esService(this.tx);
  }

  /**
   * Get the server URL based on the deployment environment
   * @returns The server URL
   */
  public async getServerUrl(): Promise<string> {
    return "http://localhost:8002";

  }

}
