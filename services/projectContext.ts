/**
 * Project Context Service
 * At startup: detect repo → resolve project → fetch environments + credentials.
 * Exposes the result so tool descriptions can be enriched dynamically.
 */

import { config } from '../config/index.js';
import { DebuggAIServerClient, ProjectInfo } from './index.js';
import { detectRepoName } from '../utils/gitContext.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger({ module: 'projectContext' });

export interface CredentialInfo {
  uuid: string;
  label: string;
  username: string;
  role: string | null;
  environmentName: string;
  environmentUuid: string;
}

export interface EnvironmentInfo {
  uuid: string;
  name: string;
  url: string;
  credentials: CredentialInfo[];
}

export interface ProjectContext {
  repoName: string;
  project: ProjectInfo;
  environments: EnvironmentInfo[];
}

let cached: ProjectContext | null = null;
let inFlight: Promise<ProjectContext | null> | null = null;

/**
 * Resolve the current project context: repo → project → environments → credentials.
 *
 * Caches the first successful result. Concurrent calls share a single in-flight
 * promise. Failures are NOT cached — the next call will retry — so a transient
 * network error on the first tool call doesn't permanently disable the service.
 */
const STARTUP_TIMEOUT_MS = 10_000;

export async function resolveProjectContext(): Promise<ProjectContext | null> {
  if (cached) return cached;
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<ProjectContext | null> => {
    const repoName = detectRepoName();
    if (!repoName) {
      logger.info('No git repo detected — skipping project context');
      return null;
    }

    let timer: NodeJS.Timeout | null = null;
    try {
      const result = await Promise.race([
        resolveProjectContextInner(repoName),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => {
            logger.warn('Project context resolution timed out');
            resolve(null);
          }, STARTUP_TIMEOUT_MS);
        }),
      ]);
      if (result) cached = result;
      return result;
    } catch (err) {
      logger.warn(`Failed to resolve project context: ${err}`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

async function resolveProjectContextInner(repoName: string): Promise<ProjectContext | null> {
  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    const project = await client.findProjectByRepoName(repoName);
    if (!project) {
      logger.info(`No project found for repo "${repoName}"`);
      return null;
    }
    logger.info(`Resolved project: ${project.name} (${project.uuid})`);

    // Fetch environments for this project
    const envResponse = await client.tx!.get<{ results: any[] }>(
      `api/v1/projects/${project.uuid}/environments/`
    );
    const rawEnvs = envResponse?.results ?? [];

    // Fetch credentials for each environment in parallel
    const environments: EnvironmentInfo[] = await Promise.all(
      rawEnvs
        .filter((e: any) => e.isActive)
        .map(async (env: any): Promise<EnvironmentInfo> => {
          let credentials: CredentialInfo[] = [];
          try {
            const credResponse = await client.tx!.get<{ results: any[] }>(
              `api/v1/projects/${project.uuid}/environments/${env.uuid}/credentials/`
            );
            credentials = (credResponse?.results ?? [])
              .filter((c: any) => c.isActive)
              .map((c: any) => ({
                uuid: c.uuid,
                label: c.label || c.username,
                username: c.username,
                role: c.role,
                environmentName: env.name,
                environmentUuid: env.uuid,
              }));
          } catch {
            // Some environments may not support credentials
          }
          return {
            uuid: env.uuid,
            name: env.name,
            url: env.url || env.activeUrl || '',
            credentials,
          };
        })
    );

    cached = { repoName, project, environments };

    const totalCreds = environments.reduce((n, e) => n + e.credentials.length, 0);
    logger.info(`Project context ready: ${environments.length} environments, ${totalCreds} credentials`);

    return cached;

  } catch (err) {
    logger.warn(`Failed to resolve project context: ${err}`);
    return null;
  }
}

export function getProjectContext(): ProjectContext | null {
  return cached;
}
