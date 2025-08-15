/**
 * Test Page Changes Handler Implementation
 * Handles the execution of the debugg_ai_test_page_changes tool
 */

import { 
  TestPageChangesInput, 
  ToolResponse, 
  ToolContext, 
  ProgressCallback,
  E2ETestResult 
} from '../types/index.js';
import { config } from '../config/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { E2eTestRunner } from '../e2e-agents/e2eRunner.js';
import { resolveUrl, suggestUrls, addCustomPattern, addCustomKeywords } from '../utils/urlResolver.js';

const logger = new Logger({ module: 'testPageChangesHandler' });

// Initialize custom URL patterns from config
function initializeUrlPatterns() {
  if (config.urlPatterns?.customPatterns) {
    for (const [pageType, patterns] of Object.entries(config.urlPatterns.customPatterns)) {
      addCustomPattern(pageType, patterns);
      logger.info(`Loaded custom URL patterns for ${pageType}`, { patterns });
    }
  }
  
  if (config.urlPatterns?.customKeywords) {
    for (const [pageType, keywords] of Object.entries(config.urlPatterns.customKeywords)) {
      addCustomKeywords(pageType, keywords);
      logger.info(`Loaded custom keywords for ${pageType}`, { keywords });
    }
  }
}

// Initialize patterns once when module loads
initializeUrlPatterns();

/**
 * Handler for the test page changes tool
 */
export async function testPageChangesHandler(
  input: TestPageChangesInput,
  context: ToolContext,
  progressCallback?: ProgressCallback
): Promise<ToolResponse> {
  const startTime = Date.now();
  const { description } = input;
  
  logger.toolStart('debugg_ai_test_page_changes', input);

  try {
    // Use the progress callback from the main handler

    // Resolve target URL from description if not explicitly provided
    let targetUrl = input.targetUrl;
    let enhancedDescription = description;
    
    if (!targetUrl && config.urlPatterns?.enableIntelligence !== false) {
      targetUrl = resolveUrl(description);
      logger.info('URL resolved from description', { 
        originalDescription: description,
        resolvedUrl: targetUrl 
      });
      
      // Enhance description with the resolved URL for better test context
      if (targetUrl !== '/') {
        enhancedDescription = `${description} (testing at ${targetUrl})`;
      }
      
      // Log suggested alternatives for debugging
      const suggestions = suggestUrls(description);
      if (suggestions.length > 0) {
        logger.debug('Alternative URL suggestions', { suggestions });
      }
    } else if (targetUrl) {
      logger.info('Using explicit target URL', { targetUrl });
      enhancedDescription = `${description} (at ${targetUrl})`;
    } else {
      logger.info('URL intelligence disabled, using description as-is');
    }

    // Merge input with config defaults, providing reasonable fallbacks only when needed
    const params = {
      localPort: input.localPort ?? config.defaults.localPort ?? 3000,
      repoName: input.repoName ?? config.defaults.repoName ?? 'unknown-repo',
      branchName: input.branchName ?? config.defaults.branchName ?? 'main',
      repoPath: input.repoPath ?? config.defaults.repoPath ?? process.cwd(),
      filePath: input.filePath ?? config.defaults.filePath ?? '',
      targetUrl: targetUrl,
    };

    logger.info('Starting E2E test with parameters', { 
      description: enhancedDescription,
      ...params,
      progressToken: context.progressToken 
    });

    // Initialize DebuggAI client and runner
    const client = new DebuggAIServerClient(config.api.key);
    await client.init(); // Make sure client is fully initialized
    const e2eTestRunner = new E2eTestRunner(client);

    // Create new E2E test with enhanced description containing URL context
    const e2eRun = await e2eTestRunner.createNewE2eTest(
      params.localPort,
      enhancedDescription,
      params.repoName,
      params.branchName,
      params.repoPath,
      params.filePath
    );

    if (!e2eRun) {
      throw new Error('Failed to create E2E test run');
    }

    logger.info('E2E test created successfully', { runId: e2eRun.id });

    // Send initial progress notification
    if (progressCallback) {
      await progressCallback({
        progress: 0,
        total: 20,
        message: 'E2E test started'
      });
    }

    // Handle E2E run execution with progress tracking
    const finalRun = await e2eTestRunner.handleE2eRun(e2eRun, async (update) => {
      logger.info(`E2E test status update: ${update.status}`, { status: update.status });
      
      const curStep = update.conversations?.[0]?.messages?.length || 0;
      const updateMessage = update.conversations?.[0]?.messages?.[curStep - 1]?.jsonContent?.currentState?.nextGoal;
      
      logger.progress(
        updateMessage || `Step ${curStep}`,
        curStep,
        20
      );

      // Send MCP progress notification to reset timeout
      if (progressCallback) {
        await progressCallback({
          progress: curStep,
          total: 20,
          message: updateMessage || `Processing step ${curStep}`
        });
      }
    });

    const duration = Date.now() - startTime;
    
    if (!finalRun) {
      throw new Error('E2E test execution failed');
    }

    // Extract results
    const testResult: E2ETestResult = {
      testOutcome: finalRun.outcome,
      testDetails: finalRun.conversations?.[0]?.messages?.map(
        (message) => message.jsonContent?.currentState?.nextGoal
      ).filter(Boolean),
      finalScreenshot: finalRun.finalScreenshot || undefined,
      runGif: finalRun.runGif || undefined,
    };

    logger.info('E2E test completed successfully', { 
      testOutcome: testResult.testOutcome,
      duration: `${duration}ms`
    });

    // Prepare response content
    const responseContent: ToolResponse['content'] = [
      {
        type: 'text',
        text: JSON.stringify({
          testOutcome: testResult.testOutcome,
          testDetails: testResult.testDetails,
          targetUrl: params.targetUrl,
          executionTime: `${duration}ms`,
          timestamp: new Date().toISOString()
        }, null, 2)
      }
    ];

    // Add screenshot if available
    if (testResult.finalScreenshot) {
      try {
        const response = await fetch(testResult.finalScreenshot);
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          const base64Image = Buffer.from(arrayBuffer).toString('base64');
          
          responseContent.push({
            type: 'image',
            data: base64Image,
            mimeType: 'image/png'
          });

          logger.info('Screenshot included in response');
        }
      } catch (error) {
        logger.warn('Failed to fetch screenshot', { 
          screenshotUrl: testResult.finalScreenshot,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    logger.toolComplete('debugg_ai_test_page_changes', duration);

    return { content: responseContent };

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.toolError('debugg_ai_test_page_changes', error as Error, duration);
    
    throw handleExternalServiceError(error, 'DebuggAI', 'test execution');
  }
}