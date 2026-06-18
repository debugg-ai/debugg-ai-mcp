# MCP Tool Review — 2026-06-18

## Summary

The server registers **20 tools** in `tools/index.ts`, though the README documents only 12 — the 8 test-suite/test-case tools were added later and were never documented. Tools fall into five groups: Browser (3), Search (3), Project CRUD (3), Environment CRUD (3), and Test suite/case (8).

The high-signal core is the three **Browser** tools (`check_app_in_browser`, `probe_page`, `trigger_crawl`) plus the three dual-mode **Search** tools — these are the product and a clean design. The management CRUD (project/env delete, the six test-authoring tools) is roughly half the surface, adds context-window weight, and is arguably web-app work rather than something an autonomous IDE agent needs.

Key issues:
- **20 tools is heavy** for an MCP; consider gating management CRUD behind a config flag so the default surface stays lean.
- **Destructive ops are LLM-callable** — `delete_project` cascades with no undo. Flag or require explicit `confirm`.
- **README is stale** — claims 12 tools; the 8 test-suite tools are undocumented.
- **No sort anywhere** — `search_*` tools paginate but can't sort; `search_executions` especially needs recency/date.

## Combined Tool Table

| Tool | Group | What it does | Filters / options | Why we have it | Keep? |
|---|---|---|---|---|---|
| `check_app_in_browser` | Browser | Remote browser agent drives a live URL (localhost auto-tunneled), interacts, reports pass/fail on an NL check | `description`, `url`, `environmentId`/`credentialId`/`credentialRole`, `username`/`password`, `repoName`; description enriched with project envs+creds | Headline value prop — agentic visual/flow QA | ✅ Keep — core |
| `probe_page` | Browser | No-LLM batch render probe of 1–20 URLs; returns screenshot, metadata, console errors, network summary | `targets[]` (per-URL `waitForSelector`/`waitForLoadState`/`timeoutMs`), `includeHtml`, `captureScreenshots`, `repoName` | Fast/cheap smoke check when the agent loop is overkill | ✅ Keep — strong complement |
| `trigger_crawl` | Browser | Long-running crawl that builds the backend knowledge graph for a project | `url`, `projectUuid`, env/cred selectors, `headless`, `timeoutSeconds`, `repoName` | Onboarding / context-building for later evals | ⚠️ Keep but niche — onboarding only, no pass/fail |
| `search_projects` | Search | Look up one project (uuid) or search many | `uuid` \| `q`, `page`, `pageSize` (1–200); no sort | Resolve project UUIDs for other tools | ✅ Keep |
| `search_environments` | Search | Env(s) with credentials inlined (passwords stripped) | `uuid` \| `projectUuid`+`q`, `page`, `pageSize`; auto-resolves project from git; no sort | Discover envs/creds for browser tools | ✅ Keep |
| `search_executions` | Search | Workflow run history; uuid mode adds `nodeExecutions`/state/errorInfo | `uuid` \| `status`+`projectUuid`, `page`, `pageSize`; no sort | Poll async results & renew presigned artifact URLs | ✅ Keep — add recency sort/date filter |
| `create_project` | Project | New project; team & repo resolve by uuid or name (case-insensitive, ambiguity-aware) | `name`, `platform`, `teamUuid`/`teamName`, `repoUuid`/`repoName` | Self-service onboarding from the IDE | ✅ Keep |
| `update_project` | Project | Patch `name`/`description` only | `uuid`, `name`, `description` | Rename/redescribe | 🔸 Weak — only 2 editable fields; low IDE value |
| `delete_project` | Project | Destructive cascade (envs, creds, test history; no undo) | `uuid` | Cleanup | 🔴 Reconsider — dangerous, rare; gate behind flag/confirm or move to web app |
| `create_environment` | Env | New env, optional credential seeding in one call | `name`, `url` (required), `description`, `projectUuid`, `credentials[]` | Authenticated testing needs envs+creds | ✅ Keep |
| `update_environment` | Env | Patch env fields + add/update/remove credentials (remove→update→add, best-effort) | `uuid` + fields + `addCredentials`/`updateCredentials`/`removeCredentialIds` | Full credential lifecycle in one tool | ✅ Keep |
| `delete_environment` | Env | Destructive; cascades credentials | `uuid`, `projectUuid` | Cleanup | 🔸 Lower priority — management-console work |
| `create_test_suite` | Test | Named suite under a project | `name`, `description`, `projectUuid`/`projectName` | Build persistent test collections | 🔸 Reconsider — test-authoring, better in web app; undocumented |
| `search_test_suites` | Test | List/search suites w/ status, counts, pass rates | `search`, `page`, `pageSize` (max 100) + project id | Browse suites | 🔸 Reconsider — undocumented |
| `delete_test_suite` | Test | Soft-delete suite | `suiteUuid` \| `suiteName`+project | Cleanup | 🔸 Reconsider — undocumented |
| `create_test_case` | Test | Add a test case to a suite (not auto-run) | `name`, `description`, `agentTaskDescription`, suite+project ids, `relativeUrl`, `maxSteps` (1–100) | Author tests | 🔸 Reconsider — undocumented |
| `update_test_case` | Test | Patch name/description/task | `testUuid` + ≥1 field | Edit tests | 🔸 Reconsider — undocumented |
| `delete_test_case` | Test | Soft-delete case | `testUuid` | Cleanup | 🔸 Reconsider — undocumented |
| `run_test_suite` | Test | Fire all cases async | `suiteUuid` \| `suiteName`+project, `targetUrl` | Execute a saved suite (CI-like flow) | ✅ Keep — higher value; document it |
| `get_test_suite_results` | Test | Poll suite + per-test outcomes | `suiteUuid` \| `suiteName`+project | Read results | ✅ Keep — higher value; document it |

**Legend:** ✅ keep · ⚠️ keep but niche · 🔸 weak / reconsider · 🔴 reconsider (dangerous or rarely needed)
