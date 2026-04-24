# Changelog

All notable changes to the DebuggAI MCP project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed — tunnel provisioning flakiness surfaces as user-facing errors

- `check_app_in_browser` / `trigger_crawl` now automatically retry transient tunnel-provision failures (5xx, 408, 429, network errors like ECONNRESET) with exponential backoff (500ms → 1500ms → 3000ms, 3 attempts). Previously a single ngrok/backend blip forced the caller to manually retry the tool call. Bead `7nx`.
- **ngrok.connect() retry widened from 2 to 3 attempts** with 500ms / 1500ms backoff. A client still hit "Tunnel setup failed" after `7nx` shipped — the failure was in the ngrok-listener-bringup path, not the backend-provision path. Auth errors still fail fast. Bead `ixh`.
- Tunnel-provision error messages now carry structured diagnostic context — HTTP status, ngrok error code, backend `x-request-id`, retryable flag — so users have something actionable to file bug reports against instead of opaque "Tunnel setup failed". Bead `5wz`.
- 4xx auth/quota errors (401/403/404) fail fast without retry to avoid loops against a bad API key.
- New posthog telemetry event `tunnel.provision_retry` fires per retry attempt with outcome, status, stage (`ngrok_connect` vs backend-provision), and diagnostic fields so flaky rates become measurable.

## [2.0.0] - 2026-04-23

> **Republish note:** Versions `1.0.64`, `1.0.65`, and `1.0.66` shipped with this
> same breaking surface but were incorrectly versioned as patches (CI auto-bumped
> patch regardless of commit type). All three are now deprecated on npm; consumers
> should upgrade to `^2.0.0`. The underlying code in `2.0.0` is functionally
> identical to `1.0.66`.

This is a **breaking release**. The MCP surface collapsed from 22 tools to 11 through a uniform `search_*` pattern plus credential-management consolidation into the environment tools. The full old→new mapping is below.

### ⚠️ BREAKING CHANGES — 14 tools removed, replaced by 11-tool surface

| Removed tool | Replacement |
|---|---|
| `list_projects` | `search_projects({q?, page?, pageSize?})` (filter mode) |
| `get_project` | `search_projects({uuid})` (uuid mode — returns the curated detail shape) |
| `list_environments` | `search_environments({projectUuid?, q?, page?, pageSize?})` — credentials inlined per env |
| `get_environment` | `search_environments({uuid, projectUuid})` |
| `list_credentials` | `search_environments(...)` — credentials are inlined on each returned env (never include password) |
| `get_credential` | `search_environments({uuid, projectUuid})` — pull from the env's `credentials[]` |
| `create_credential` | `create_environment({name, url, credentials: [...]})` (seed on env create), or `update_environment({uuid, addCredentials: [...]})` |
| `update_credential` | `update_environment({uuid, updateCredentials: [{uuid, ...patch}]})` |
| `delete_credential` | `update_environment({uuid, removeCredentialIds: [uuid]})` |
| `list_teams` | `create_project({teamName, ...})` — backend name-resolved with exact-match + ambiguity handling |
| `list_repos` | `create_project({repoName, ...})` — same pattern |
| `list_executions` | `search_executions({status?, projectUuid?, page?, pageSize?})` |
| `get_execution` | `search_executions({uuid})` — full detail with `nodeExecutions` + state |
| `cancel_execution` | Dropped — backend spin-down is now automatic; no client action needed |

All `search_*` tools use a dual-mode signature: pass `{uuid}` for a single-record detail response, or pass filter params for a paginated summary list. 404 from the backend surfaces as `isError: true` with `{error: 'NotFound', message, uuid}`.

Credential mutations on `update_environment` execute as `remove → update → add` in a single call, so a freed label can be re-bound in one request. Per-cred failures surface in `credentialWarnings[]` without blocking the env update.

### Added

- **`trigger_crawl` tool**: server-side browser-agent crawl to populate the project's knowledge graph. Returns `{executionId, status, targetUrl, durationMs, outcome?, crawlSummary?, knowledgeGraph?}` with `knowledgeGraph.imported` = true on successful KG ingestion. Supports localhost via automatic ngrok tunneling with per-process reuse.
- **`create_project` name-based resolution**: pass `teamName` instead of `teamUuid`, or `repoName` instead of `repoUuid`. Backend-side search with case-insensitive exact match. Returns `AmbiguousMatch` with candidates if multiple hits, `NotFound` if none.
- **`create_environment` credential seeding**: pass `credentials: [{label, username, password, role?}]` to create creds atomically with the env.
- **`update_environment` credential sub-actions**: `addCredentials[]`, `updateCredentials[]`, `removeCredentialIds[]` in one call.
- **`engines.node: ">=20.20.0"`** in `package.json`. Driven by `posthog-node@^5.26.0` requiring Node 20.20+.
- **Boot-smoke CI** (`.github/workflows/boot-smoke.yml`): matrix `{ubuntu, macos} × {Node 20, 22}` verifies the MCP server boots + completes `tools/list` with published-style spawn.
- **Eval runner tag filtering**: `--tag=<name>`, `--skip-tag=<name>`, `--flow=<csv>`; `--list` prints flows + tags. `--tag=fast` runs 12 non-browser flows in ~40s; `--tag=browser` runs heavy flows.
- **27 eval flows total** (up from 16 in prior unreleased work). New flows since the last published version: response-structure (20), tunnel reuse (21), long-running check (22), crawl triggers public + localhost + with-project (23/24/26), published-boot-smoke (25), localhost deep-path (27).
- **Response sanitization**: `check_app_in_browser` strips ngrok tunnel URLs from the full response including agent-authored `actionTrace[*].intent`.

### Changed

- **Deferred API-key validation**: missing `DEBUGGAI_API_KEY` no longer crashes the subprocess at boot (the bug that surfaced in Claude Code as "Failed to reconnect to debugg-ai"). The server starts, `tools/list` succeeds, and the error surfaces only when a tool is actually invoked — as a structured `isError: true` response pointing the caller at the missing env var.
- **Boot-time behavior**: `index.ts` no longer calls `resolveProjectContext()` at startup. Project context resolves lazily on first tool call that needs it.
- **`services/projectContext.ts`**: promise-dedup pattern replaces the failure-caching singleton. Concurrent callers share one in-flight promise; results cached on success only, so transient network errors don't permanently disable context resolution.
- **Pagination mandatory on every list response**: `search_projects` / `search_environments` / `search_executions` accept optional `page` (1-indexed) and `pageSize` (default 20, max 200, oversized clamped). Response shape: `{filter, pageInfo: {page, pageSize, totalCount, totalPages, hasMore}, <items>}`.
- **Axios error handling**: handlers map `err.statusCode` (surfaced by the transport's response interceptor) to tool-level `NotFound` errors instead of checking `err.response?.status` which the interceptor strips.

### Fixed

- **Progress-notification race** (bead `0bq`) in both `testPageChangesHandler` and `triggerCrawlHandler`: a progress callback firing after the handler resolved could tear down the stdio transport. Circuit breaker suppresses subsequent callbacks after the first throw; terminal-status detection emits the final `progress === total` notification inside `onUpdate` before the poll loop exits.
- **"Failed to reconnect to debugg-ai" UX** (bead `cma`): missing API key now surfaces as a per-tool-call error instead of a silent subprocess exit at boot. MCP clients see the server register normally and get a readable error only when a tool is actually invoked.
- **Credential role filter** (bead `hpo`): backend `?role=` filter on credentials list was returning all creds regardless. MCP now applies client-side role filtering as defense-in-depth.

### Security invariants

- Passwords are write-only. No response body from any tool contains a password (verified by unit tests + eval flows 06/10/12/15).
- Tunnel URLs (`*.ngrok.debugg.ai`) are stripped from all `check_app_in_browser` responses including agent-authored text (verified by flow 05).
- 404s from the backend surface as `isError: true` with structured `{error: 'NotFound', ...}`, never as thrown exceptions.

### Tool count

The server registers **11** tools (was 22 pre-collapse, 18 in the previous unreleased snapshot). Verified by eval flow `01-protocol.mjs` which locks the roster.

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