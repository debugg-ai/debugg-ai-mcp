// utils/axiosTransport.ts
import axios from "axios";

import {
  objToCamelCase,
  objToSnakeCase,
} from "./objectNaming.js";

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
  }
  
  /**
   * A tiny wrapper around axios that keeps all your interceptors
   * but gives service factories a clean, typed surface.
   */
  export class AxiosTransport {
    readonly axios: AxiosInstance;
  
    constructor({ baseUrl, apiKey, tokenType = 'token', instance }: AxiosTransportOptions) {
      // Use an injected instance or create one that mimics `axiosServices`
      // Use provided apiKey as the Token. Must be requested on the app.
      this.axios =
        instance ??
        axios.create({
          baseURL: baseUrl.replace(/\/+$/, "/"),
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
          const data = err.response?.data;
          if (data) {
            const msg =
              typeof data === 'string'
                ? data
                : data.detail || data.message || data.error || JSON.stringify(data);
            const newErr = new Error(String(msg));
            (newErr as any).statusCode = err.response?.status;
            (newErr as any).responseData = data;
            return Promise.reject(newErr);
          }
          return Promise.reject(new Error(err.message || 'Unknown Axios error'));
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
  