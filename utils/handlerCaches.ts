/**
 * Shared, process-scoped caches for handler hot-path lookups.
 *
 * Replaces per-handler `let cachedX: string | null = null` singletons with
 * a single source of truth. Two handlers (testPageChanges + triggerCrawl)
 * resolve the same workflow templates and the same project UUIDs; sharing
 * the cache avoids duplicate backend roundtrips when the user invokes both.
 *
 * Each lookup emits a telemetry event with `hit: boolean` so the cache
 * effectiveness is observable in PostHog without log-grepping.
 *
 * Caches are NEVER persisted across processes. Cleared explicitly by the
 * handlers on auth failures (so a rotated API key doesn't keep serving
 * stale UUIDs).
 */

import { Telemetry, TelemetryEvents } from './telemetry.js';

type TemplateLookup = (name: string) => Promise<{ uuid: string; name: string } | null>;
type ProjectLookup = (repoName: string) => Promise<{ uuid: string; name: string } | null>;

const templateUuidByName = new Map<string, string>();
const projectUuidByRepo = new Map<string, string>();

/**
 * Get a workflow template UUID by name, populating the cache on miss.
 * Returns null if the lookup function returns null (template doesn't exist).
 */
export async function getCachedTemplateUuid(
  name: string,
  lookup: TemplateLookup,
): Promise<string | null> {
  const cached = templateUuidByName.get(name);
  if (cached) {
    Telemetry.capture(TelemetryEvents.TEMPLATE_LOOKUP, { templateName: name, hit: true });
    return cached;
  }
  const t0 = Date.now();
  const template = await lookup(name);
  Telemetry.capture(TelemetryEvents.TEMPLATE_LOOKUP, {
    templateName: name,
    hit: false,
    durationMs: Date.now() - t0,
    found: !!template,
  });
  if (!template) return null;
  templateUuidByName.set(name, template.uuid);
  return template.uuid;
}

/**
 * Get a project UUID by repo name, populating the cache on miss.
 * Returns undefined if the lookup function returns null (no matching project).
 */
export async function getCachedProjectUuid(
  repoName: string,
  lookup: ProjectLookup,
): Promise<string | undefined> {
  const cached = projectUuidByRepo.get(repoName);
  if (cached) {
    Telemetry.capture(TelemetryEvents.PROJECT_LOOKUP, { repoName, hit: true });
    return cached;
  }
  const t0 = Date.now();
  const project = await lookup(repoName);
  Telemetry.capture(TelemetryEvents.PROJECT_LOOKUP, {
    repoName,
    hit: false,
    durationMs: Date.now() - t0,
    found: !!project,
  });
  if (!project) return undefined;
  projectUuidByRepo.set(repoName, project.uuid);
  return project.uuid;
}

/**
 * Clear the template cache. Called by handlers on auth failures.
 */
export function invalidateTemplateCache(): void {
  templateUuidByName.clear();
}

/**
 * Clear the project cache. Same trigger as templates.
 */
export function invalidateProjectCache(): void {
  projectUuidByRepo.clear();
}
