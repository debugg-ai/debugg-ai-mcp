import { createE2esService, E2esService } from "./e2es.js";
import { createBrowserSessionsService, BrowserSessionsService } from "./browserSessions.js";
import { AxiosTransport } from "../utils/axiosTransport.js";

import { AxiosRequestConfig } from "axios";


export class DebuggAIServerClient  {
  tx: AxiosTransport | undefined;
  url: URL | undefined;

  // Public "sub‑APIs"
  e2es: E2esService | undefined;
  browserSessions: BrowserSessionsService | undefined;

  constructor(
    public userApiKey: string,
  ) {
    // Note: init() is async and should be called separately
  }

  public async init() {
    const serverUrl = await this.getServerUrl();
    console.error("Server URL:", serverUrl);

    this.url = new URL(serverUrl);
    this.tx = new AxiosTransport({ baseUrl: serverUrl, apiKey: this.userApiKey });
    this.e2es = createE2esService(this.tx);
    this.browserSessions = createBrowserSessionsService(this.tx);
  }

  /**
   * Get the server URL based on the deployment environment
   * @returns The server URL
   */
  public async getServerUrl(): Promise<string> {
    if (process.env.ENVIRONMENT === "local") {
      return "https://debuggai-backend.ngrok.app";
    } else {
      return "https://api.debugg.ai";
    }
  }

}
