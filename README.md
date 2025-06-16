# 🧪 Official MCP Server for Debugg AI

**AI-driven browser automation and E2E test server** implementing the [Model Context Protocol (MCP)](https://modelcontext.org), designed to help AI agents test UI changes, simulate user behavior, and analyze visual outputs of running web applications — all via natural language and CLI tools. 

End to end testing used to be a nightmare. Not just to setup, but to manage over time as you made changes to your app. 

Debugg AI's MCP server offers a NEW way to test, where you never have to worry about setting up `playwright`, local browsers or proxies with it fully remote, managed browsers that simply connect to a server running locally or remotely via a secure `tunnel`. 

That means no distracting chrome pop ups as it's running tests, no managing chrome or playwright versions, and best of all - ZERO CONFIGURATION. Just grab an API key and add us to your MCP server list. 

Should you want to later rerun those tests or create a suite of them to run in your CI / CD pipeline, you can see all historical test results in your dashboard - [Debugg.AI App](https://app.debugg.ai) 

<a href="https://glama.ai/mcp/servers/@debugg-ai/debugg-ai-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@debugg-ai/debugg-ai-mcp/badge" alt="Debugg AI MCP server" />
</a>

---

## 🚀 Features

* 🧠 **MCP Protocol Support**
  Full MCP server implementation with CLI and tool registry support.

* 🧪 **End-to-End Test Automation**
  Trigger UI tests based on user stories or natural language descriptions via the `debugg_ai_test_page_changes` tool.

* 🌐 **Localhost Web App Integration**
  Test your running dev app on any `localhost` port with simulated user flows.

* 🧾 **MCP Tool Notifications**
  Sends real-time progress updates back to clients with step descriptions and UI state goals.

* 🧷 **Screenshot Support**
  Capture final visual state of the page for LLMs with image rendering support.

* 🧱 **Stdio Server Compatible**
  Plug into any MCP-compatible client (like Claude Desktop, LangChain agents, etc.) via stdin/stdout.

---

## Examples

### Input prompt: "Test the ability to create an account and login"

![Test Create Account and Login](/assets/recordings/test-create-account-login.gif)

### Results:

    **Task Completed**

    - Duration: 86.80 seconds
    - Final Result: Successfully completed the task of signing up and logging into the account with the email 'alice.wonderland1234@example.com'.
    - Status: Success

### Full Demo:

> Watch a more in-depth, [Full Use Case Demo](https://debugg.ai/demo)


--- 



## 🛠️ Quickstart

### Ensure you have created a free account and generated an API Key - [DebuggAI](https://debugg.ai)

### Option 1: NPX (Local Development)

```bash
npx -y @debugg-ai/debugg-ai-mcp
```

Use this when testing or integrating into tools like Claude Desktop or your own AI agent.

### Option 2: Docker

```bash
docker run -i --rm --init \
  -e DEBUGGAI_API_KEY=your_api_key \
  -e TEST_USERNAME_EMAIL=your_test_email \
  -e TEST_USER_PASSWORD=your_password \
  -e DEBUGGAI_LOCAL_PORT=3000 \
  -e DEBUGGAI_LOCAL_REPO_NAME=your-org/your-repo \
  -e DEBUGGAI_LOCAL_BRANCH_NAME=main \
  -e DEBUGGAI_LOCAL_REPO_PATH=/app \
  -e DEBUGGAI_LOCAL_FILE_PATH=/app/index.ts \
  quinnosha/debugg-ai-mcp
```

---

## 🧰 MCP Tool: `debugg_ai_test_page_changes`

### Description

Run an end-to-end test on a running web app, testing a UI feature or flow described in natural language. Allows AI agents in ANY code gen platform to quickly evaluate proposed changes and 
ensure new functionality works as expected.

### Input Parameters

| Name          | Type   | Required  | Description                                            |
| ------------- | ------ | --------- | ------------------------------------------------------ |
| `description` | string | ✅        | What feature or page to test (e.g. "Signup page form") |
| `localPort`   | number | ❌        | Port of your running app (default: `3000`)             |
| `repoName`    | string | ❌        | GitHub repo name                                       |
| `branchName`  | string | ❌        | Current branch                                         |
| `repoPath`    | string | ❌        | Absolute path to the repo                              |
| `filePath`    | string | ❌        | File to test                                           |

---

## 🧪 Example Claude Desktop Config

```jsonc
{
  "mcpServers": {
    "debugg-ai-mcp": {
      "command": "npx",
      "args": ["-y", "@debugg-ai/debugg-ai-mcp"],
      "env": {
        "DEBUGGAI_API_KEY": "YOUR_API_KEY",
        "TEST_USERNAME_EMAIL": "test@example.com",
        "TEST_USER_PASSWORD": "supersecure",
        "DEBUGGAI_LOCAL_PORT": 3000,
        "DEBUGGAI_LOCAL_REPO_NAME": "org/project",
        "DEBUGGAI_LOCAL_BRANCH_NAME": "main",
        "DEBUGGAI_LOCAL_REPO_PATH": "/Users/you/project",
        "DEBUGGAI_LOCAL_FILE_PATH": "/Users/you/project/index.ts"
      }
    }
  }
}
```

---

## 🔐 Environment Variables

| Variable                                | Description                                | Required |
| --------------------------------------- | ------------------------------------------ | -------- |
| `DEBUGGAI_API_KEY`                      | API key for calling DebuggAI backend       | ✅       |
| `TEST_USERNAME_EMAIL`                   | Email of test user account                 | ❌       |
| `TEST_USER_PASSWORD`                    | Password of test user account              | ❌       |
| `DEBUGGAI_LOCAL_PORT`                   | Local port your app runs on                | ✅       |
| `DEBUGGAI_LOCAL_REPO_NAME`              | GitHub repo name                           | ❌       |
| `DEBUGGAI_LOCAL_BRANCH_NAME`            | Branch name                                | ❌       |
| `DEBUGGAI_LOCAL_REPO_PATH`              | Local path to repo root                    | ❌       |
| `DEBUGGAI_LOCAL_FILE_PATH`              | File to test                               | ❌       |


---

## 🧑‍💻 Local Development

```bash
# Clone the repo and install dependencies
npm install

# Copy the test config and insert your creds
cp test-config-example.json test-config.json

# Run the local node-built dist
npx @modelcontextprotocol/inspector --config test-config.json --server debugg-ai-mcp-node

# OR Run the MCP server locally from above toplevel dir. 
npx @modelcontextprotocol/inspector --config debugg-ai-mcp/test-config.json --server debugg-ai-mcp
```

---

## 📁 Repo Structure

```
.
├── e2e-agents/             # E2E browser test runners
├── services/               # Client for DebuggAI API
├── tunnels /               # Secure connections to remote web browsers
├── index.ts                # Main MCP server entry
├── Dockerfile              # Docker build config
└── README.md
```

---

## 🧱 Built With

* [Model Context Protocol SDK](https://github.com/modelcontextprotocol)

---

## 💬 Feedback & Issues

For bugs, ideas, or integration help, open an issue or contact the DebuggAI team directly.

---

## 🔒 License

MIT License © 2025 DebuggAI

---


<p style="padding-top: 20px; text-align: center;">Made with 🩸, 💦, and 😭 in San Francisco</p>