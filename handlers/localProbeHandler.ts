/**
 * probe_page with browser:'local' (bead jpw3.1/.2): capture each target with the
 * user's own Chrome on this machine. No backend call, no tunnel.
 */
import { localCapture, LocalBrowserError, type LocalCaptureResult } from '../services/localBrowser.js';
import { imageContentBlock } from '../utils/imageUtils.js';
import { logger } from '../utils/logger.js';
import type { ProbePageInput } from '../types/index.js';
import type { ToolContext, ToolResponse } from '../types/index.js';

export async function localProbe(input: ProbePageInput, context: ToolContext): Promise<ToolResponse> {
  const results: Array<Record<string, unknown>> = [];
  const images: Array<ReturnType<typeof imageContentBlock>> = [];
  for (const t of input.targets) {
    try {
      const r: LocalCaptureResult = await localCapture({
        url: t.url,
        headless: input.headless,
        useProfile: input.useProfile,
        loginWindowMs: input.loginWindowMs,
        allowedDomains: input.allowedDomains,
        waitForSelector: t.waitForSelector,
        waitForLoadState: t.waitForLoadState,
        timeoutMs: t.timeoutMs,
        includeHtml: input.includeHtml,
        captureScreenshot: input.captureScreenshots,
        signal: (context as { signal?: AbortSignal }).signal,
      });
      const { screenshotBase64, ...rest } = r;
      results.push(rest);
      if (screenshotBase64) images.push(imageContentBlock(screenshotBase64, 'image/png'));
    } catch (err) {
      if (err instanceof LocalBrowserError && (err.code === 'LOCAL_BROWSER_DISABLED' || err.code === 'PLAYWRIGHT_MISSING' || err.code === 'PROFILE_ALLOWLIST_REQUIRED')) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.code, message: err.message }, null, 2) }], isError: true };
      }
      const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
      logger.warn(`probe_page local: ${t.url} failed: ${message}`);
      results.push({ url: t.url, error: message, ...(err instanceof LocalBrowserError ? { errorCode: err.code } : {}) });
    }
  }
  return {
    content: [
      { type: 'text', text: JSON.stringify({ browser: 'local', results }, null, 2) },
      ...images,
    ],
  };
}
