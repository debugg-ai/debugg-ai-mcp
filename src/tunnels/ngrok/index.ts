import { existsSync, promises } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import { isError } from './error.js';

const { readFile } = promises;

import { mkdirp } from 'mkdirp';
import {
  authtoken,
  connect,
  disconnect,
  getApi,
  getUrl,
  kill,
  Ngrok,
  NgrokClient,
} from 'ngrok';
import download from 'ngrok/download';
import { parse } from 'yaml';

// Get the equivalent of __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const basePath = join(__dirname, 'bin');

export const binPath = () => basePath;

import { NgrokConfig } from './types.js';

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
    if (isError(error) && error.code === 'ENOENT') {
      if (configPath !== DEFAULT_CONFIG_PATH) {
        console.error(`Could not find config file at ${configPath}.`);
      }
    } else {
      console.error(`Could not parse config file at ${configPath}.`);
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

  if (!tunnel) {
    console.error('No tunnel provided');
    return;
  }

  if (typeof tunnel !== 'undefined') {
    const configPath = getConfigPath();
    if (existsSync(configPath)) {
      tunnel.configPath = configPath;
    }
    try {
      tunnel.binPath = binPath;
      try {
        const url = await connect(tunnel);
      } catch (error) {
        console.error(`There was an error starting your tunnel.`);
        console.error(error);
      }
    } catch (error) {
      console.error(`There was an error finding the bin path.`);
      console.error(error);
    }
  }
};

export const stop = async (tunnel?: string) => {
  const api = getApi();
  if (!api) {
    console.error('ngrok is not currently running.');
    return;
  }
  try {
    const tunnels = await getActiveTunnels(api);
    console.error('tunnels', tunnels);
    console.error('attempting to stop tunnel', tunnel);
    if (tunnels.length > 0) {
      if (tunnel === 'All') {
        await closeAllTunnels();
      } else if (typeof tunnel !== 'undefined') {
        await closeTunnel(tunnel, api);
      }
    } else {
      console.error('There are no active ngrok tunnels.');
    }
  } catch (error) {
    console.error('Could not get active tunnels from ngrok.');
    console.error(error);
  }
};

const closeTunnel = async (tunnel: string, api: NgrokClient) => {
  try {
    await disconnect(tunnel);
    let message = `Debugg AI tunnel disconnected.`;
    if ((await getActiveTunnels(api)).length === 0) {
      await kill();
      message = `${message} DebuggAI test runner completed.`;
      // hideStatusBarItem();
    }
    console.error(message);
  } catch (error) {
    // window.showErrorMessage(
    //   `There was a problem stopping the tunnel ${tunnel}, see the log for details.`
    // );
    console.error(error);
  }
};

const closeAllTunnels = async () => {
  try {
    await disconnect();
    await kill();
    // window.showInformationMessage(
    //   'All ngrok tunnels disconnected. ngrok has been shutdown.'
    // );
    // hideStatusBarItem();
  } catch (error) {
    // window.showErrorMessage(
    //   'There was an issue closing the ngrok tunnels, check the log for details.'
    // );
    console.error(error);
  }
};

export const downloadBinary = async () => {
  const binaryLocations = [
    join(basePath, 'ngrok'),
    join(basePath, 'ngrok.exe'),
  ];
  if (binaryLocations.some((path) => existsSync(path))) {
    console.info('ngrok binary is already downloaded');
  } else {
    await mkdirp(basePath);
    try {
      await new Promise<void>((resolve, reject) =>
        download((error) => (error ? reject(error) : resolve()))
      );
    } catch (error) {
      console.error(
        `Can't update local tunnel configuration. The tests may not work correctly.`
      );
      console.error(error);
    }
  }
};
