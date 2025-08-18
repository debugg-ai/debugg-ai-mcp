import { existsSync, promises } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { isError } from './error.js';

const { readFile } = promises;

import { mkdirp } from 'mkdirp';
import {
    authtoken,
    connect,
    disconnect,
    getApi,
    kill,
    Ngrok,
    NgrokClient
} from 'ngrok';
import download from 'ngrok/download';
import { parse } from 'yaml';

// ES module compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Use empty string to let ngrok use its default binary location  
const basePath = '';
export const binPath = () => basePath;


import { NgrokConfig, TunnelClient } from './types.js';

const DEFAULT_CONFIG_PATH = join(__dirname, 'ngrok-config.yml');

const getConfigPath = (): string => {
  return DEFAULT_CONFIG_PATH;
};

const getConfig: () => Promise<NgrokConfig | undefined> = async () => {
  const configPath = getConfigPath();
  try {
    const config = parse(await readFile(configPath, 'utf8'));
    if (config && typeof config.authtoken !== 'undefined') {
      await authtoken({ authtoken: config.authtoken, binPath });
    }
    return config;
  } catch (error) {
    if (isError(error) && (error as any).code === 'ENOENT') {
      if (configPath !== DEFAULT_CONFIG_PATH) {
        console.error(`Could not find config file at ${configPath}.`);
        (error as Error).message = `Could not find config file at ${configPath}`;
        throw error;
      }
    } else {
      console.error(`Could not parse config file at ${configPath}.`);
      throw error;
    }
  }
};

const tunnelsFromConfig = (tunnels: { [key: string]: Ngrok.Options }) => {
  return Object.keys(tunnels).map((tunnelName) => {
    return {
      label: tunnelName,
      tunnelOptions: { name: tunnelName, ...tunnels[tunnelName] },
    };
  });
};

const getActiveTunnels: (api: NgrokClient) => Promise<Ngrok.Tunnel[]> = async (
  api: NgrokClient
) => {
  const response = await api.listTunnels();
  return response.tunnels;
};

export const start = async (options?: Ngrok.Options) => {
  const config = await getConfig();
  const tunnel = options;
  if (typeof tunnel !== 'undefined') {
    const configPath = getConfigPath();
    if (existsSync(configPath)) {
      tunnel.configPath = configPath;
    }
    try {
      // Let ngrok use default binPath if ours is empty
      if (basePath) {
        tunnel.binPath = binPath;
      }
      try {
        const url = await connect(tunnel);
        return url;
      } catch (error) {
        if (isError(error)) {
          (error as Error).message = `There was an error starting your tunnel.`;
        }
        console.error(`There was an error starting your tunnel.`);
        throw error;
      }
    } catch (error) {
      if (isError(error)) {
        (error as Error).message = `There was an error finding the bin path.`;
      }
      console.error(`There was an error finding the bin path.`);
      throw error;
    }
  }
  return null;
};

export const stop = async (tunnel?: string) => {
  const api = getApi();
  if (!api) {
    console.error('ngrok is not currently running.');
    return;
  }
  try {
    const tunnels = await getActiveTunnels(api);
    console.log('tunnels', tunnels);
    console.log('attempting to stop tunnel', tunnel);
    if (tunnels.length > 0) {
      if (tunnel === 'All') {
        await closeAllTunnels();
      } else if (typeof tunnel !== 'undefined') {
        let tunnelUrl = tunnel.includes("http") ? tunnel : `https://${tunnel}`;
        await closeTunnel(tunnelUrl, api);
      }
    } else {
      console.error('There are no active ngrok tunnels.');
    }
  } catch (error) {
    console.error('Could not get active tunnels from ngrok.');
  }
};

const closeTunnel = async (tunnel: string, api: NgrokClient) => {
  try {
    await disconnect(tunnel);
    let message = `Debugg AI tunnel disconnected.`;
    if ((await getActiveTunnels(api)).length === 0) {
      await kill();
      message = `${message} DebuggAI test runner completed.`;
    }
  } catch (error) {
    console.error(error);
  }
};

const closeAllTunnels = async () => {
  try {
    await disconnect();
    await kill();
  } catch (error) {
    console.error(error);
  }
};

export const setAuthToken = async (token: string) => {
  if (typeof token !== 'undefined') {
    await authtoken({
      authtoken: token,
      configPath: getConfigPath(),
    });
  }
};

export async function downloadBinary() {
  const binaryLocations = [
    join(basePath, 'ngrok'),
    join(basePath, 'ngrok.exe'),
  ];
  if (binaryLocations.some((path) => existsSync(path))) {
    console.info('ngrok binary is already downloaded');
  } else {
    async function runDownload() {
      await mkdirp(basePath);
      try {
        await new Promise<void>((resolve, reject) =>
          download((error?: Error) => (error ? reject(error) : resolve()))
        );
      } catch (error) {
        console.error(
          `Can't update local tunnel configuration. The tests may not work correctly.`
        );
        console.error(error);
      }
    }
    await runDownload();
  }
};

export class NgrokTunnelClient implements TunnelClient {
  private api: NgrokClient | null = null;

  constructor() {
    this.api = getApi();
  }

  start = async (options?: Ngrok.Options) => {
    return await start(options);
  }
  stop = async (tunnel?: string) => {
    await stop(tunnel);
  }
  getActiveTunnels = async (api: NgrokClient) => {
    return await getActiveTunnels(api);
  }
  getUrl = async (api: NgrokClient) => {
    const tunnels = await getActiveTunnels(api);
    return tunnels.map((tunnel) => tunnel.public_url).join(', ');
  }
  getApi = async () => {
    if (!this.api) throw new Error('ngrok is not currently running.');
    return this.api;
  }
  downloadBinary = async () => {
    await downloadBinary();
  }
}

// Export tunnel manager for high-level API
export { tunnelManager } from './tunnelManager.js';
export type { TunnelInfo, TunnelResult } from './tunnelManager.js';