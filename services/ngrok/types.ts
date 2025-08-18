import { Ngrok, NgrokClient } from 'ngrok';

export interface TunnelClient {
  start: (options?: Ngrok.Options) => Promise<string | null>;
  stop: (tunnel?: string) => Promise<void>;
  getActiveTunnels: (api: NgrokClient) => Promise<Ngrok.Tunnel[]>;
  getUrl: (api: NgrokClient) => Promise<string>;
  getApi: () => Promise<NgrokClient>;
  downloadBinary: () => Promise<void>;
}

export type TunnelsResponse = {
  tunnels: Ngrok.Tunnel[];
  uri: string;
};

/* eslint-disable @typescript-eslint/naming-convention */
export type NgrokConfig = {
  authtoken?: string;
  region?: string;
  console_ui?: string | false;
  console_ui_color?: string;
  http_proxy?: string;
  inspect_db_size?: number;
  log_level?: string;
  log_format?: string;
  log?: string | false;
  metadata?: string;
  root_cas?: string;
  socks5_proxy?: string;
  update?: boolean;
  update_channel?: string;
  web_addr?: string | false;
  tunnels?: { [key: string]: Ngrok.Options };
};
/* eslint-enable */
