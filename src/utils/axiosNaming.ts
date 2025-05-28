import { objToCamelCase, objToSnakeCase } from "../utils/objectNaming.js";

import { destroy as destroyAxios, get as getAxios, post as postAxios, put as putAxios } from "./axios.js";

interface AxiosResponse<T = any> {
  data: T;
  [key: string]: any;
}

export async function get(url: string, params?: any): Promise<AxiosResponse> {
  const fmtdParams = objToSnakeCase(params);
  return getAxios(url, fmtdParams).then((response: AxiosResponse) => {
    console.error("response", response);
    const fmtdData = objToCamelCase(response.data);
    response.data = fmtdData;
    return response;
  });
}

export async function post(url: string, data?: any, config?: any): Promise<AxiosResponse> {
  const fmtdData = objToSnakeCase(data);
  return postAxios(url, fmtdData, config).then((response: AxiosResponse) => {
    response.data = objToCamelCase(response.data);
    return response;
  });
}

export async function put(url: string, data?: any, config?: any): Promise<AxiosResponse> {
  const fmtdData = objToSnakeCase(data);
  return putAxios(url, fmtdData, config).then((response: AxiosResponse) => {
    response.data = objToCamelCase(response.data);
    return response;
  });
}

export async function destroy(url: string, config?: any): Promise<AxiosResponse> {
  return destroyAxios(url, config).then((response: AxiosResponse) => {
    response.data = objToCamelCase(response.data);
    return response;
  });
}
