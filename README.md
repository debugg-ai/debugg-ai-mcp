# 🧪 Official MCP Server for Debugg AI

**AI-powered development and testing toolkit** implementing the [Model Context Protocol (MCP)](https://modelcontext.org), designed to give AI agents comprehensive testing, debugging, and code analysis capabilities.

Transform your development workflow with:
- **Zero-config E2E testing** - Run browser tests with natural language descriptions
- **Live session monitoring** - Real-time browser console, network, and screenshot monitoring
- **Test suite management** - Create and manage comprehensive test suites
- **Seamless CI/CD integration** - View all test results in your [Debugg.AI App](https://app.debugg.ai) dashboard 

<a href="https://glama.ai/mcp/servers/@debugg-ai/debugg-ai-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@debugg-ai/debugg-ai-mcp/badge" alt="Debugg AI MCP server" />
</a>

---

## 🚀 Features

### **12 Focused Development Tools**

* 🧪 **E2E Testing Suite** - Run browser tests, create test suites, and generate commit-based tests
* 🖥️ **Live Session Monitoring** - Real-time browser console, network traffic, and screenshot monitoring
* 📊 **Test Management** - List, create, and track test suites and commit-based test suites
* 📱 **Real-time Progress** - Live updates with screenshots and step-by-step execution
* 🌐 **Universal Compatibility** - Works with any MCP-compatible client (Claude Desktop, LangChain, etc.)

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



## 🛠️ Quick Setup

### 1. Get Your API Key
Create a free account at [debugg.ai](https://debugg.ai) and generate your API key.

### 2. Choose Your Installation Method

**Option A: NPX (Recommended)**
```bash
npx -y @debugg-ai/debugg-ai-mcp
```

**Option B: Docker**
```bash
docker run -i --rm --init \
  -e DEBUGGAI_API_KEY=your_api_key \
  quinnosha/debugg-ai-mcp
```

---

## 🧰 Available Tools

### **E2E Testing Tools**
- `debugg_ai_test_page_changes` - Run browser tests with natural language descriptions
- `debugg_ai_create_test_suite` - Create organized test suites for features
- `debugg_ai_create_commit_suite` - Generate tests based on git commits
- `debugg_ai_get_test_status` - Monitor test execution and results

### **Test Management Tools**
- `debugg_ai_list_tests` - List all E2E tests with filtering and pagination
- `debugg_ai_list_test_suites` - List all test suites with filtering options
- `debugg_ai_list_commit_suites` - List all commit-based test suites

### **Live Session Monitoring Tools**
- `debugg_ai_start_live_session` - Start a live browser session with real-time monitoring
- `debugg_ai_stop_live_session` - Stop an active live session
- `debugg_ai_get_live_session_status` - Get the current status of a live session
- `debugg_ai_get_live_session_logs` - Retrieve console and network logs from a live session
- `debugg_ai_get_live_session_screenshot` - Capture screenshots from an active live session

---

## ⚙️ Configuration

### **For Claude Desktop**

Add this to your MCP settings file:

```json
{
  "mcpServers": {
    "debugg-ai-mcp": {
      "command": "npx",
      "args": ["-y", "@debugg-ai/debugg-ai-mcp"],
      "env": {
        "DEBUGGAI_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### **Optional Environment Variables**
```bash
# Required
DEBUGGAI_API_KEY=your_api_key

# Optional (with sensible defaults)
DEBUGGAI_LOCAL_PORT=3000                    # Your app's port
DEBUGGAI_LOCAL_REPO_NAME=your-org/repo      # GitHub repo name
DEBUGGAI_LOCAL_REPO_PATH=/path/to/project   # Project directory
```

## 💡 Usage Examples

### **Run a Quick E2E Test**
```
"Test the user login flow on my app running on port 3000"
```

### **Analyze Your Project** 
```
"What frameworks and languages are used in my codebase?"
```

### **Get Issue Insights**
```
"Show me all high-priority issues in my project"
```

### **Generate Test Coverage**
```
"Generate test coverage for the authentication module"
```

---

## 🧑‍💻 Local Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Build project
npm run build

# Start server locally
node dist/index.js
```

---

## 📁 Project Structure

```
debugg-ai-mcp/
├── config/          # Configuration management  
├── tools/           # 14 MCP tool definitions
├── handlers/        # Tool implementation logic
├── services/        # DebuggAI API integration
├── utils/           # Shared utilities & logging
├── types/           # TypeScript type definitions
├── __tests__/       # Comprehensive test suite
└── index.ts         # Main server entry point
```

---

## 🚀 Publishing & Releases

This project uses automated publishing to NPM. Here's how it works:

### **Automatic Publishing**
- Every push to `main` triggers automatic NPM publishing
- Only publishes if the version doesn't already exist
- Includes full test suite validation and build verification

### **Version Management**
```bash
# Bump version locally
npm run version:patch  # 1.0.15 → 1.0.16
npm run version:minor  # 1.0.15 → 1.1.0
npm run version:major  # 1.0.15 → 2.0.0

# Check package contents
npm run publish:check
```

### **Manual Version Bump via GitHub**
1. Go to **Actions** → **Version Bump**
2. Click **"Run workflow"**
3. Select version type or enter custom version
4. Workflow will update version and trigger publish

### **Setup for Contributors**
See [`.github/PUBLISHING_SETUP.md`](.github/PUBLISHING_SETUP.md) for complete setup instructions.

---

## 💬 Support & Links

- 📖 **Documentation**: [debugg.ai/docs](https://debugg.ai/docs)
- 🐛 **Issues**: [GitHub Issues](https://github.com/debugg-ai/debugg-ai-mcp/issues)
- 💬 **Discord**: [Join our community](https://debugg.ai/discord)
- 🌐 **Dashboard**: [app.debugg.ai](https://app.debugg.ai)

---

## 🔒 License

Apache-2.0 License © 2025 DebuggAI

---

<p align="center">Made with ❤️ in San Francisco</p>