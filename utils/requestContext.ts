/**
 * Request-scoped context (epic lybfq).
 *
 * stdio is single-user: one API key from the environment for the whole process.
 * The HTTP transport is multi-user: each request carries its own bearer token.
 * Rather than thread a token through every handler + backend-client call site,
 * we stash it in AsyncLocalStorage for the duration of the request and let
 * `config.api.key` resolve it (see config/index.ts). Outside an HTTP request
 * (i.e. stdio, or tests) the store is empty and the env key is used — so the
 * stdio path is completely unchanged.
 *
 * This module intentionally has NO imports so any layer (incl. config) can use
 * it without creating an import cycle.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestStore {
  apiKey?: string;
}

const storage = new AsyncLocalStorage<RequestStore>();

/** Run `fn` with a request-scoped API key (used by the HTTP transport per request). */
export function runWithApiKey<T>(apiKey: string | undefined, fn: () => T): T {
  return storage.run({ apiKey }, fn);
}

/** The request-scoped API key if inside runWithApiKey(), else undefined (stdio). */
export function currentApiKey(): string | undefined {
  return storage.getStore()?.apiKey;
}
