#!/usr/bin/env node
/**
 * Thin entry point. Delegates to scripts/evals/runner.mjs.
 * Kept so `npm run test:e2e` stays stable. See scripts/evals/ for actual logic.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
await import(join(here, 'evals', 'runner.mjs'));
