# Official MCP Server for Debugg AI

**AI-powered browser testing and monitoring** via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). Gives AI agents the ability to run end-to-end browser tests, monitor live sessions, and validate UI changes against your running application.

<a href="https://glama.ai/mcp/servers/@debugg-ai/debugg-ai-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@debugg-ai/debugg-ai-mcp/badge" alt="Debugg AI MCP server" />
</a>

---

## What it does

- **Run browser tests with natural language** — describe what to test, the AI agent clicks through your app and returns screenshots + results
- **Monitor live browser sessions** — capture console logs, network requests, and screenshots in real time
- **Manage test suites** — create, organize, and track E2E tests tied to features or commits
- **Seamless CI/CD** — view all results in your [Debugg.AI dashboard](https://app.debugg.ai)

---

## Demo

### Prompt: "Test the ability to create an account and login"

![Test Create Account and Login](/assets/recordings/test-create-account-login.gif)

**Result:**
- Duration: 86.80 seconds
- Status: Success — signed up and logged in with `alice.wonderland1234@example.com`

> [Full Use Case Demo](https://debugg.ai/demo)

---

## Quick Setup

### 1. Get your API key
Create a free account at [debugg.ai](https://debugg.ai) and generate your API key.

### 2. Add to Claude Desktop

```json
{
  "mcpServers": {
    "debugg-ai": {
      "command": "npx",
      "args": ["-y", "@debugg-ai/debugg-ai-mcp"],
      "env": {
        "DEBUGGAI_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

**Or with Docker:**
```bash
docker run -i --rm --init \
  -e DEBUGGAI_API_KEY=your_api_key \
  quinnosha/debugg-ai-mcp
```

---

## Tools

### E2E Testing
| Tool | Description |
|------|-------------|
| `check_app_in_browser` | Run a browser test with a natural language description. Returns screenshots and pass/fail result. |
| `create_test_suite` | Generate a suite of browser tests for a feature or workflow |
| `create_commit_suite` | Auto-generate tests from recent git commits |
| `get_test_status` | Check progress and results of a running or completed test suite |

### Test Management
| Tool | Description |
|------|-------------|
| `list_tests` | List all E2E tests with filtering and pagination |
| `list_test_suites` | List all test suites |
| `list_commit_suites` | List all commit-based test suites |

### Live Session Monitoring
| Tool | Description |
|------|-------------|
| `start_live_session` | Launch a remote browser session with real-time monitoring |
| `stop_live_session` | Stop an active session and save captured data |
| `get_live_session_status` | Check session status, current URL, and uptime |
| `get_live_session_logs` | Retrieve console logs, network requests, and JS errors |
| `get_live_session_screenshot` | Capture a screenshot of what the browser currently shows |

### Quick Operations
| Tool | Description |
|------|-------------|
| `quick_screenshot` | Capture a screenshot of any URL — no session setup required |

---

## Configuration

```bash
# Required
DEBUGGAI_API_KEY=your_api_key

# Optional — provide defaults so you don't have to pass them every time
DEBUGGAI_LOCAL_PORT=3000                    # Your app's local port
DEBUGGAI_LOCAL_REPO_NAME=your-org/repo      # GitHub repo name
DEBUGGAI_LOCAL_REPO_PATH=/path/to/project   # Absolute path to project root
DEBUGGAI_LOCAL_BRANCH_NAME=main             # Current branch

# Override API endpoint (defaults to https://api.debugg.ai)
DEBUGGAI_API_URL=https://api.debugg.ai
```

---

## Usage examples

```
"Test the user login flow on my app running on port 3000"

"Check that the checkout process works end to end"

"Take a screenshot of localhost:3000 and tell me if anything looks broken"

"Create a test suite for the user authentication feature"

"Generate browser tests for my last 3 commits"
```

---

## Local Development

```bash
npm install
npm test
npm run build

# Test with MCP inspector
npx @modelcontextprotocol/inspector --config test-config.json --server debugg-ai
```

---

## Links

- **Dashboard**: [app.debugg.ai](https://app.debugg.ai)
- **Docs**: [debugg.ai/docs](https://debugg.ai/docs)
- **Issues**: [GitHub Issues](https://github.com/debugg-ai/debugg-ai-mcp/issues)
- **Discord**: [debugg.ai/discord](https://debugg.ai/discord)

---

Apache-2.0 License © 2025 DebuggAI
