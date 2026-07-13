/**
 * Project Context Service
 * At startup (lazily, on first tool call): detect repo → resolve project →
 * fetch environments + credential LABELS. Exposes the result so tool
 * descriptions can be enriched dynamically (see tools/index.ts).
 *
 * Thin relay: we consume the backend's environment/credential contract and
 * surface LABELS ONLY — never a password or any other secret. The
 * backend→internal field mapping lives in ONE place: mapEnvironments().
 */

import { config } from '../config/index.js';
import { DebuggAIServerClient, ProjectInfo } from './index.js';
import { detectRepoName } from '../utils/gitContext.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger({ module: 'projectContext' });

export interface CredentialInfo {
  /** Human-readable label from the backend contract. */
  label: string;
  /** Login username. Not a secret — safe to surface to the agent. */
  username: string;
  /** Optional — present only if the backend contract includes it. */
  uuid?: string;
  /** Optional — present only if the backend contract includes it. */
  role?: string | null;
  environmentName?: string;
  environmentUuid?: string;
}

export interface EnvironmentInfo {
  uuid: string;
  name: string;
  url: string;
  /** Optional — from the backend contract (is_default). */
  isDefault?: boolean;
  /** Optional — from the backend contract (is_active). */
  isActive?: boolean;
  /** Optional — from the backend contract (endpoint_type). */
  endpointType?: string | null;
  credentials: CredentialInfo[];
}

export interface ProjectContext {
  repoName: string;
  project: ProjectInfo;
  environments: EnvironmentInfo[];
}

let cached: ProjectContext | null = null;
let inFlight: Promise<ProjectContext | null> | null = null;

const STARTUP_TIMEOUT_MS = 10_000;

/**
 * The ONE place the backend environment/credential contract is mapped to our
 * internal shape. Pinned contract (backend epic sentinal-k8x1f.8):
 *
 *   GET /api/v1/environments/?project=<uuid>
 *     → [{ uuid, name, url, is_default, is_active, endpoint_type,
 *          credentials: [{ label, username }] }]
 *
 * (The axios transport auto-converts snake_case → camelCase, so we read
 * `isDefault`/`isActive`/`endpointType` here.) Password is write-only and
 * NEVER returned; we defensively copy only label/username (+ uuid/role if the
 * backend ever includes them) — we never spread a raw credential object, so a
 * secret can't leak into a tool description even if the contract regresses.
 */
export function mapEnvironments(rawEnvs: any[]): EnvironmentInfo[] {
  return (rawEnvs ?? [])
    // Surface only active environments (is_active !== false).
    .filter((e: any) => e?.isActive !== false)
    .map((env: any): EnvironmentInfo => ({
      uuid: env.uuid,
      name: env.name,
      url: env.url || env.activeUrl || '',
      isDefault: env.isDefault ?? false,
      isActive: env.isActive ?? true,
      endpointType: env.endpointType ?? null,
      credentials: (env.credentials ?? [])
        .filter((c: any) => c && c.isActive !== false)
        .map((c: any): CredentialInfo => ({
          label: c.label || c.username,
          username: c.username,
          ...(c.uuid ? { uuid: c.uuid } : {}),
          ...(c.role !== undefined ? { role: c.role } : {}),
          environmentName: env.name,
          environmentUuid: env.uuid,
        })),
    }));
}

/**
 * Resolve the current project context: repo → project → environments →
 * credential labels.
 *
 * Caches the first successful result. Concurrent calls share a single in-flight
 * promise. Failures are NOT cached — the next call retries — so a transient
 * network error on the first tool call doesn't permanently disable enrichment.
 * The whole resolution is bounded by STARTUP_TIMEOUT_MS so a slow/hung backend
 * can never block boot or a tool call.
 */
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

    // Pinned contract: environments (with credentials inlined) for the project.
    const envResponse = await client.tx!.get<any>('api/v1/environments/', {
      project: project.uuid,
    });
    const rawEnvs = Array.isArray(envResponse) ? envResponse : (envResponse?.results ?? []);
    const environments = mapEnvironments(rawEnvs);

    cached = { repoName, project, environments };

    const totalCreds = environments.reduce((n, e) => n + e.credentials.length, 0);
    logger.info(`Project context ready: ${environments.length} environments, ${totalCreds} credential labels`);

    return cached;

  } catch (err) {
    logger.warn(`Failed to resolve project context: ${err}`);
    return null;
  }
}

export function getProjectContext(): ProjectContext | null {
  return cached;
}

/** Test-only: reset the module cache so each test starts clean. */
export function __resetProjectContextForTests(): void {
  cached = null;
  inFlight = null;
}
