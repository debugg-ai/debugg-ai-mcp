// index.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequest,
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { DebuggAIServerClient } from "./services/index.js";
import { E2eTestRunner } from "./e2e-agents/e2eRunner.js";
import { Message } from "./services/types.js";

const createE2eTestTool: Tool = {
  name: "debugg_ai_test_page_changes",
  description: "Use DebuggAI to run & and test UI changes that have been made with its User emulation agents",
  inputSchema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "Description of what page (relative url) and features should be tested.",
      },
      localPort: {
        type: "number",
        description: "Localhost port number where the app is running. Eg. 3000",
      },
      filePath: {
        type: "string",
        description: "Absolute path to the file to test",
      },
      repoName: {
        type: "string",
        description: "The name of the current repository",
      },
      branchName: {
        type: "string",
        description: "Current branch name",
      },
      repoPath: {
        type: "string",
        description: "Local path of the repo root",
      },
    },
    required: ["description",],
  },
};

async function configureTestRunner(client: DebuggAIServerClient): Promise<E2eTestRunner> {
    const e2eTestRunner = new E2eTestRunner(client);
    return e2eTestRunner;
}

const server = new Server(
  {
    name: "DebuggAI MCP Server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(CallToolRequestSchema, async (req: CallToolRequest) => {
  console.error("Received CallToolRequest:", req);

  const apiKey = process.env.DEBUGGAI_API_KEY;
  const testUsername = process.env.TEST_USERNAME_EMAIL;
  const testPassword = process.env.TEST_USER_PASSWORD;

  if (!apiKey || !testUsername || !testPassword) {
    console.error("Missing one or more required environment variables: DEBUGGAI_API_KEY, TEST_USERNAME_EMAIL, TEST_USER_PASSWORD");
    process.exit(1);
  }

  try {
    const { name, arguments: args } = req.params;


    if (name === "debugg_ai_test_page_changes") {
      const { description } = args as any;

      let localPort = parseInt(process.env.DEBUGGAI_LOCAL_PORT ?? "3000");
      let repoName = process.env.DEBUGGAI_LOCAL_REPO_NAME ?? "test-user-repo/test-repo";
      let branchName = process.env.DEBUGGAI_LOCAL_BRANCH_NAME ?? "main";
      let repoPath = process.env.DEBUGGAI_LOCAL_REPO_PATH ?? "/Users/test-user-repo/test-repo";
      let filePath = process.env.DEBUGGAI_LOCAL_FILE_PATH ?? "/Users/test-user-repo/test-repo/index.ts";

      const progressToken = req.params._meta?.progressToken;

      if (args?.localPort) {
        localPort = args.localPort as number;
      }
      if (args?.repoName) {
        repoName = args.repoName as string;
      }
      if (args?.branchName) {
        branchName = args.branchName as string;
      }
      if (args?.repoPath) {
        repoPath = args.repoPath as string;
      }
      if (args?.filePath) {  
        filePath = args.filePath as string;
      }

      if (progressToken == undefined) {
        console.error("No progress token found");
        return {
          content: [
            { type: "text", text: "No progress token found" },
          ],
        };
      }

      const client = new DebuggAIServerClient(process.env.DEBUGGAI_API_KEY ?? "");
      const e2eTestRunner = await configureTestRunner(client);

      const e2eRun = await e2eTestRunner.createNewE2eTest(
          localPort, description, repoName, branchName, repoPath, filePath
      );

      if (!e2eRun) {
        console.error("Failed to create E2E test");
        return {
          content: [
            { type: "text", text: "Failed to create E2E test" },
          ],
        };
      }

      await server.notification({
        method: "notifications/progress",
        params: {
          progress: 0,
          total: 20,
          progressToken,
        },
      });

      const finalRun = await e2eTestRunner.handleE2eRun(e2eRun, async(update) => {
        console.error(`📢 Status: ${update.status}`);
        const curStep = update.conversations?.[0]?.messages?.length;
        const totalSteps = update.conversations?.[0]?.messages?.length;
        await server.notification({
          method: "notifications/progress",
          params: {
            progress: curStep,
            total: 20,
            progressToken,
          },
        });
      });

      const testOutcome = finalRun?.outcome;
      const testDetails = finalRun?.conversations?.[0]?.messages?.map((message: Message) => message.jsonContent?.currentState?.nextGoal);

      const runGif = finalRun?.runGif;
      let base64 = "";
      if (runGif) {
        const response = await fetch(runGif);
        const arrayBuffer = await response.arrayBuffer();
        base64 = Buffer.from(arrayBuffer).toString('base64');
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ testOutcome, testDetails }, null, 2),
          },
          {
            type: "image",
            data: base64,
            mimeType: "image/jpeg",
          }
        ],
      };
    }

    throw new Error(`Tool not found: ${name}`);
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        },
      ],
    };
  }
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [createE2eTestTool],
  };
});

async function main() {
  console.error("Starting DebuggAI MCP server...");
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("DebuggAI MCP Server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error in main():", err);
  process.exit(1);
});
