🧠 Prompt: Enhance and Scale the DebuggAI MCP Server for Production-Ready E2E Testing

You are tasked with evolving a robust, TypeScript-based MCP (Model Context Protocol) server that provides AI-powered end-to-end testing capabilities for web applications.

This system should be a comprehensive testing platform that enables AI agents to create, execute, and monitor automated tests through natural language descriptions, with real-time browser session monitoring and seamless CI/CD integration.

🧭 Goal

Enhance and scale the DebuggAI MCP Server to become the definitive AI testing platform that:

- Provides comprehensive E2E testing capabilities through natural language descriptions
- Enables real-time browser session monitoring with console logs, network traffic, and screenshots
- Manages test suites and commit-based automated test generation
- Integrates seamlessly with CI/CD pipelines and development workflows
- Maintains production-grade reliability, performance, and observability
- Supports multi-tenant usage through secure API authentication

⚙️ Requirements

✅ Stack

Language: TypeScript (strict mode with ES2022 target)
Transport & Protocol: JSON-RPC 2.0 over STDIO (Model Context Protocol)
MCP SDK: Anthropic's TypeScript MCP SDK (@modelcontextprotocol/sdk)
Testing Infrastructure: DebuggAI API integration with browser automation
Data Management: Zod schemas for validation, Winston for structured logging
Frameworks: Node.js ESM modules with comprehensive testing suite

🧩 Architecture Overview

1. MCP Server Core (index.ts)
- Handles JSON-RPC 2.0 requests from MCP clients (Claude, VS Code, etc.)
- Manages tool registry with 12 specialized testing and monitoring tools
- Provides progress notifications for long-running test operations
- Implements structured error handling with MCP error codes
- Maintains request correlation and comprehensive logging

2. Tool Categories (tools/)
- **E2E Testing Tools**: Natural language test execution, suite management, commit-based testing
- **Live Session Tools**: Real-time browser monitoring with console logs and screenshots
- **Management Tools**: Test listing, status tracking, and result aggregation

3. Handler Implementation (handlers/)
- Executes tool logic with input validation and error handling
- Manages DebuggAI API integration for test execution
- Provides real-time progress updates during test runs
- Handles result formatting and response structuring

4. Service Layer (services/)
- **E2esService**: Test execution, suite management, commit-based test generation
- **BrowserSessionsService**: Live browser session management and monitoring
- **AxiosTransport**: HTTP client with authentication and retry logic

5. Configuration & Utilities (config/, utils/)
- Centralized configuration with environment variable validation
- Winston-based structured logging with request correlation
- Input validation using Zod schemas
- Error handling with MCP-compliant error responses

📜 Core Workflows

## E2E Test Execution Flow
1. Client sends natural language test description via `debugg_ai_test_page_changes`
2. Handler validates input and creates test request with DebuggAI API
3. Real-time progress updates sent via MCP progress notifications
4. Test executes in browser environment with step-by-step screenshots
5. Results formatted and returned with execution summary and artifacts

## Live Session Monitoring Flow
1. Client initiates session via `debugg_ai_start_live_session`
2. Browser session created with real-time monitoring capabilities
3. Console logs, network traffic, and screenshots captured continuously
4. Client polls for updates via `debugg_ai_get_live_session_logs` and screenshots
5. Session terminated via `debugg_ai_stop_live_session`

🔁 Development Process (Design, Plan, Build, Iterate, Test, Repeat)

The system follows a structured engineering workflow:
- **Design**: Architecture decisions documented in project_management/
- **Plan**: Features broken down into JIRA-style tickets with priorities
- **Build**: TypeScript-first development with strict typing
- **Iterate**: Agent-coordinated development with specialized responsibilities
- **Test**: Comprehensive unit and integration test suites
- **Repeat**: Continuous improvement based on usage patterns and feedback

🧪 Quality Assurance

Testing Framework:
- Unit tests with Jest and comprehensive mocking
- Integration tests with 90-second timeouts for API interactions
- Separate test configurations for unit vs integration testing
- Code coverage reporting for services, handlers, and utilities

Performance & Reliability:
- Progress notifications for operations > 5 seconds
- Structured error handling with retry logic
- Request correlation for debugging and observability
- Environment variable validation at startup

📁 Project Structure

```
debugg-ai-mcp/
├── config/                 # Centralized configuration management  
├── tools/                  # 12 MCP tool definitions with Zod schemas
├── handlers/               # Tool implementation logic with error handling
├── services/               # DebuggAI API integration (E2E & Browser Sessions)
├── utils/                  # Shared utilities, logging, and validation
├── types/                  # TypeScript type definitions and interfaces
├── __tests__/             # Comprehensive unit and integration test suite
├── project_management/     # Engineering workflow and ticket tracking
└── index.ts               # Main MCP server entry point
```

🛡 Security & Authentication

- API key validation for DebuggAI service integration
- Input sanitization and validation using Zod schemas
- Structured logging without sensitive data exposure
- Environment-based configuration for secure deployment

🧠 Agent Coordination Framework

The project uses specialized AI agents for development:

| Role | Responsibility |
|------|----------------|
| backend-architect | API design, service architecture, integration patterns |
| ai-engineer | MCP protocol optimization, tool design, AI workflow integration |
| debug-specialist | Error resolution, performance optimization, testing validation |
| code-reviewer | Code quality, TypeScript patterns, security review |
| deployment-engineer | CI/CD pipelines, Docker containerization, production deployment |
| frontend-testing-expert | Test strategy, browser automation, E2E workflow optimization |
| changelogger | Version management, release documentation, change tracking |
| project-coordinator-and-team-lead | Feature coordination, priority management, delivery tracking |

🏁 Production Readiness Checklist

Core Functionality:
- [ ] All 12 MCP tools functional and tested
- [ ] E2E test execution with natural language descriptions
- [ ] Live browser session monitoring with real-time updates
- [ ] Test suite management and commit-based test generation
- [ ] Progress notifications for all long-running operations

Quality & Reliability:
- [ ] Comprehensive test suite with >90% coverage
- [ ] TypeScript compilation with zero errors
- [ ] Structured logging and error handling
- [ ] Performance monitoring and optimization
- [ ] Security review and vulnerability assessment

Deployment & Integration:
- [ ] Docker containerization for consistent deployment
- [ ] CI/CD pipeline with automated testing and publishing
- [ ] Documentation for MCP client integration
- [ ] API rate limiting and error recovery
- [ ] Multi-environment configuration support

🎯 Success Metrics

Technical Excellence:
- Zero critical bugs in production
- <2 second response time for tool execution
- 99.9% uptime for core testing functionality
- Comprehensive test coverage across all components

User Experience:
- Natural language test creation success rate >95%
- Real-time session monitoring with <500ms latency
- Seamless integration with popular MCP clients
- Clear error messages and debugging information

Business Impact:
- Reduced manual testing effort by 80%+
- Faster bug detection and resolution cycles
- Improved code quality through automated testing
- Enhanced developer productivity and confidence