// utils/axiosTransport.ts
import axios from "axios";

import {
  objToCamelCase,
  objToSnakeCase,
} from "./objectNaming.js";

import { resolveTunnelProxy, type TunnelProxy } from "../services/tunnel/proxy.js";

import type {
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
} from "axios";
  
  /** Constructor options that come from the top‑level client */
  export interface AxiosTransportOptions {
    baseUrl: string;
    apiKey?: string;
    tokenType?: 'token' | 'bearer';
    /** You can pass a pre‑configured axios instance (e.g. for tests) */
    instance?: AxiosInstance;
    /** Environment used for proxy selection (default process.env). */
    env?: NodeJS.ProcessEnv;
  }
  
  /**
   * A tiny wrapper around axios that keeps all your interceptors
   * but gives service factories a clean, typed surface.
   */
  export class AxiosTransport {
    readonly axios: AxiosInstance;
  
    constructor({ baseUrl, apiKey, tokenType = 'token', instance, env = process.env }: AxiosTransportOptions) {
      // HTTPS_PROXY / NO_PROXY via the same selection the tunnel websocket uses
      // (platform-y2ob.3). axios's built-in env proxy sends an absolute-URI
      // request, which CONNECT-only proxies answer 405; use a CONNECT tunnel.
      // No proxy applies => the config below is exactly what it always was.
      const proxy: TunnelProxy | undefined = instance ? undefined : resolveTunnelProxy(baseUrl, env);
      const proxyConfig = proxy
        ? { proxy: false as const, httpAgent: proxy.agent, httpsAgent: proxy.agent }
        : {};
      // Use an injected instance or create one that mimics `axiosServices`
      // Use provided apiKey as the Token. Must be requested on the app.
      this.axios =
        instance ??
        axios.create({
          baseURL: baseUrl.replace(/\/+$/, "/"),
          timeout: 30_000,
          ...proxyConfig,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `${tokenType === 'bearer' ? 'Bearer' : 'Token'} ${apiKey}` } : {}),
          },
        });
  
      /* ---------- INTERCEPTORS ---------- */
      // Response → camelCase
      this.axios.interceptors.response.use(
        (res: AxiosResponse) => {
          res.data = objToCamelCase(res.data);
          return res;
        },
        (err) => {
          if (proxy && err.response?.status === 407) {
            const e407 = new Error(
              `the HTTP proxy ${proxy.display} (from ${proxy.varName}) demanded authentication for the connection to ` +
              `${new URL(baseUrl).host} (HTTP 407). Put valid credentials in the proxy URL ` +
              `(http://user:password@${proxy.display}) or ask your network admin to allow it.`,
            );
            (e407 as any).statusCode = 407;
            return Promise.reject(e407);
          }
          const data = err.response?.data;
          if (data) {
            const strField = (v: unknown): string | null =>
              typeof v === 'string' && v ? v : null;
            const msg =
              typeof data === 'string'
                ? data
                : strField(data.detail) ??
                  strField(data.message) ??
                  strField(data.error) ??
                  JSON.stringify(data);
            const newErr = new Error(String(msg));
            (newErr as any).statusCode = err.response?.status;
            (newErr as any).responseData = data;
            (newErr as any).responseHeaders = err.response?.headers;
            return Promise.reject(newErr);
          }
          // Network-class error (no response received) — preserve err.code (ECONNRESET, etc.)
          const networkErr = new Error(err.message || 'Unknown Axios error');
          if (err.code) (networkErr as any).networkCode = err.code;
          return Promise.reject(networkErr);
        },
      );
  
      // Request → snake_case
      this.axios.interceptors.request.use((cfg) => {
        if (cfg.data && typeof cfg.data === "object") {
          cfg.data = objToSnakeCase(cfg.data);
        }
        if (cfg.params && typeof cfg.params === "object") {
          cfg.params = objToSnakeCase(cfg.params);
        }
        return cfg;
      });
    }
  
    /* ---------- SHORTHAND METHODS ---------- */
    async request<T = unknown>(
      cfg: AxiosRequestConfig,
    ): Promise<T> {
      const res = await this.axios.request<T>(cfg);
      return res.data;
    }
  
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
  