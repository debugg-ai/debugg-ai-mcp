import { GetExecutionInput, ToolContext, ToolResponse } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';
import { fetchImageAsBase64, imageContentBlock } from '../utils/imageUtils.js';

const logger = new Logger({ module: 'getExecutionHandler' });

function notFound(uuid: string): ToolResponse {
  return {
    content: [{ type: 'text', text: JSON.stringify({
      error: 'NotFound',
      message: `Execution ${uuid} not found.`,
      uuid,
    }, null, 2) }],
    isError: true,
  };
}

export async function getExecutionHandler(
  input: GetExecutionInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  logger.toolStart('get_execution', { uuid: input.uuid });

  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    try {
      const execution = await client.workflows!.getExecution(input.uuid);
      logger.toolComplete('get_execution', Date.now() - start);

      const content: ToolResponse['content'] = [
        { type: 'text', text: JSON.stringify({ execution }, null, 2) },
      ];

      const SCREENSHOT_URL_KEYS = ['finalScreenshot', 'screenshot', 'screenshotUrl', 'screenshotUri'];
      const GIF_KEYS = ['runGif', 'gifUrl', 'gif', 'videoUrl', 'recordingUrl'];
      const nodes = execution.nodeExecutions ?? [];
      const subworkflowNode = nodes.find((n: any) => n.nodeType === 'subworkflow.run');

      let screenshotEmbedded = false;
      let screenshotUrl: string | null = null;
      let gifUrl: string | null = null;

      const screenshotB64 = subworkflowNode?.outputData?.screenshotB64;
      if (typeof screenshotB64 === 'string' && screenshotB64) {
        content.push(imageContentBlock(screenshotB64, 'image/png'));
        screenshotEmbedded = true;
      }

      for (const node of nodes) {
        const data = (node as any).outputData ?? {};
        if (!screenshotEmbedded && !screenshotUrl) {
          for (const key of SCREENSHOT_URL_KEYS) {
            if (typeof data[key] === 'string' && data[key]) {
              screenshotUrl = data[key] as string;
              break;
            }
          }
        }
        if (!gifUrl) {
          for (const key of GIF_KEYS) {
            if (typeof data[key] === 'string' && data[key]) {
              gifUrl = data[key] as string;
              break;
            }
          }
        }
        if ((screenshotEmbedded || screenshotUrl) && gifUrl) break;
      }

      if (!screenshotEmbedded && screenshotUrl) {
        const img = await fetchImageAsBase64(screenshotUrl).catch(() => null);
        if (img) content.push(imageContentBlock(img.data, img.mimeType));
      }
      if (gifUrl) {
        const gif = await fetchImageAsBase64(gifUrl).catch(() => null);
        if (gif) content.push(imageContentBlock(gif.data, 'image/gif'));
      }

      return { content };
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.response?.status === 404) return notFound(input.uuid);
      throw err;
    }
  } catch (error) {
    logger.toolError('get_execution', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'get_execution');
  }
}
