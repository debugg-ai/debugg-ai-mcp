# Changelog

All notable changes to the DebuggAI MCP project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed — pagination is now mandatory on every `list_*` tool

- `list_projects`, `list_environments`, `list_credentials`, `list_executions` now accept optional `page` (1-indexed) and `pageSize` (default 20, max 200, oversized clamped).
- Response shape unified: `{ filter, pageInfo: {page, pageSize, totalCount, totalPages, hasMore}, <items> }`. The bare `count` field is gone — use `pageInfo.totalCount`.
- Removes silent first-page truncation. Previously accounts with more than ~10 of anything lost visibility into the rest.
- Eval flow `18-pagination.mjs` verifies default shape, page-walk disjointness, and pageSize clamping for every list tool.
- Reopened bead `hpo`: backend `?role=` filter on credentials list returns all creds regardless of filter value. MCP now applies client-side role filtering as defense.

### Added

- **Eval harness** (`scripts/evals/`): real-server/real-backend test runner with per-flow artifact capture. 16 flows cover MCP protocol, input validation, browser automation on public + localhost URLs, full CRUD lifecycles for environments/credentials/projects, execution history, multi-step credential resolution, concurrent calls, raw-credential auth, and cross-process tunnel isolation. Exposed via `npm run test:e2e`.
- **Project management tools**: `list_projects`, `get_project`, `update_project`, `delete_project`. (`create_project` deferred — backend requires `platform + repo + team` linkage.)
- **Environment management tools**: `list_environments`, `create_environment`, `get_environment`, `update_environment`, `delete_environment`.
- **Credential management tools**: `list_credentials`, `create_credential`, `get_credential`, `update_credential` (with password rotation), `delete_credential`. `password` is write-only across all paths; defensive stripper on update responses.
- **Execution history tools**: `list_executions` (with `status` + `limit` filters), `get_execution` (full node-level detail), `cancel_execution` (maps backend 409 → `AlreadyCompleted`).
- **Response sanitization**: `check_app_in_browser` now sanitizes the full response payload end-to-end — ngrok tunnel URLs no longer leak into agent-authored `actionTrace[*].intent` fields.
- **Verification protocol** in `CLAUDE.md`: mandates running `npm run test:e2e` instead of ad-hoc MCP calls to validate behavior.

### Changed

- **Boot-time behavior**: removed the background `resolveProjectContext()` call from `index.ts`. The server no longer makes any API calls at startup; project context resolves lazily on the first tool call that needs it.
- **`services/projectContext.ts`**: replaced the failure-caching singleton with a promise-dedup pattern. Concurrent callers share one in-flight promise; results are cached only on success, so transient network errors don't permanently disable context resolution.
- **Axios error handling**: all handlers map `err.statusCode` (surfaced by the transport's response interceptor) to tool-level `NotFound` errors. Previously they checked only `err.response?.status` which the interceptor strips.

### Tool count

The server now registers **18** tools (was 1). Verify via eval flow `01-protocol.mjs`.

## [1.0.15] - 2025-08-18

### Added
- **Live Session Monitoring Tools**: Added 5 new MCP tools for real-time browser session monitoring
  - `debugg_ai_start_live_session`: Launch live remote browser sessions with real-time monitoring
  - `debugg_ai_stop_live_session`: Stop active live sessions
  - `debugg_ai_get_live_session_status`: Monitor session status and health
  - `debugg_ai_get_live_session_logs`: Retrieve console logs and network requests from live sessions
  - `debugg_ai_get_live_session_screenshot`: Capture screenshots from active sessions
- **Enhanced Tunnel Management**: Complete rewrite of tunnel infrastructure with improved ngrok integration
  - New `TunnelManager` service for high-level tunnel abstraction
  - Automatic localhost URL detection and tunnel creation
  - Better error handling and connection stability
  - Integrated tunnel support in live session handlers
- **Browser Sessions Service**: New dedicated service for managing browser automation sessions
- **Comprehensive Test Infrastructure**: Added extensive test suite covering unit, integration, and end-to-end scenarios
  - Handler tests for E2E suites and live sessions
  - Backend services integration tests
  - Network and MCP tools validation tests
  - Mock infrastructure for reliable testing
- **Enhanced Project Analysis**: New utilities for analyzing codebases and extracting context
- **Improved Error Handling**: Centralized error management with structured error types
- **URL Parser Utilities**: Robust URL parsing and localhost detection capabilities
- **Configuration Management**: Centralized configuration system with environment-based settings
- **API Specification**: Complete OpenAPI specification for backend integration
- **GitHub Actions Workflows**: Automated publishing, version bumping, and validation workflows

### Changed
- **Major Architecture Refactoring**: Reorganized services, handlers, and utilities into cleaner modular structure
- **Moved Tunnel Services**: Relocated tunnel management from `tunnels/` to `services/ngrok/` for better organization
- **Enhanced E2E Runner**: Improved test execution with better progress tracking and error handling
- **Updated Package Dependencies**: Upgraded to latest versions of core dependencies including MCP SDK
- **Improved Documentation**: Updated README with comprehensive setup and usage instructions
- **Enhanced Type Definitions**: Expanded type system with better validation schemas

### Fixed
- **API Endpoint Updates**: Resolved compatibility issues with backend API changes
- **Image Support Improvements**: Enhanced handling of screenshots and visual test artifacts
- **Tunnel Connection Stability**: Fixed issues with ngrok tunnel reliability and reconnection
- **ES Module Compatibility**: Resolved module resolution issues for better Node.js compatibility

### Security
- **License Addition**: Added Apache 2.0 license for proper open source compliance
- **Environment Variable Validation**: Enhanced validation of sensitive configuration data

## [1.0.14] - 2025-06-09

### Added
- Final screen shot included.

## [1.0.12] - 2025-06-02

### Added
- Readme docs issue

## [1.0.11] - 2025-06-02

### Added
- New readme with instructions on install, usage, etc.

## [1.0.10] - 2025-05-29

### Fixed
- Most MCP clients still don't support images. removed that as a response.


## [1.0.7] - 2025-05-29

### Fixed
- Fixed tunneling issues
- Remove notifications when a token is not provided in the original request

## [1.0.2] - 2025-05-28

### Fixed
- Fixed ES module path resolution issues
- Added proper shebang line to executable files
- Ensured executable permissions are set during build

### Added
- Docker container support
- Improved error handling for E2E test runs

## [1.0.1] - 2025-05-28

### Fixed
- Fixed TypeScript configuration to target ES2022
- Resolved dependency issues with Zod library

### Added
- Initial implementation of E2E test runner
- Integration with DebuggAI server client

## [1.0.0] - 2025-05-28

### Added
- Initial release of DebuggAI MCP
- Support for running UI tests via MCP protocol
- Integration with ngrok for tunnel creation
- Basic test reporting functionality 