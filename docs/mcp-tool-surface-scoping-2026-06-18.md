# MCP Tool Surface — Scoping & Test Plan (P3)

Epic `debugg_ai_mcp-yg7o6`, phase P3. Turns the approved architecture (`mcp-tool-surface-architecture-2026-06-18.md`) into an ordered commit sequence and a **failing-test matrix authored before P4 implementation** (TDD red set).

## Commit sequence (each: tests red → code green → suite stays green)

| # | Commit | Scope | New/changed tests (red first) |
|---|---|---|---|
| C1 | Destructive guard + `ctx.elicit` plumbing | `utils/confirmDestructive.ts`; `ToolContext.elicit?`; build `ctx.elicit` in `index.ts` (no-op until elicitation epic) | `confirmDestructive.test.ts` |
| C2 | Discriminated schemas | `types/index.ts`: `Project/Environment/TestSuite/TestCase/Executions InputSchema` (Zod discriminated unions) | `actionSchemas.test.ts` |
| C3 | Dispatcher handlers | `handlers/{project,environment,testSuite,testCase,executions}Handler.ts` calling existing handler bodies | `*.dispatch.test.ts` per entity |
| C4 | Action tool defs + registry swap | `tools/{project,environment,testSuite,testCase,executions}.ts`; `tools/index.ts` registers 8; old per-verb registrations removed | `registry.test.ts` |
| C5 | Wire destructive guard | `ensureConfirmed` into `delete` actions (environment/test_suite/test_case) | extend `*.dispatch.test.ts` (delete paths) |
| C6 | Headless enforcement | drop `headless` from `trigger_crawl` tool + `TriggerCrawlInputSchema`; hardcode `contextData.headless=true` | extend `triggerCrawlHandler.test.ts` |
| C7 | Cut `update_project` + `delete_project` | remove tools/schemas (no dedicated tests exist) | covered by `registry.test.ts` (absent) |
| C8 | `executions` recency sort (D6) | sort/recency param on list action + handler thread | extend `searchExecutionsHandler.test.ts` |
| C9 | Remove folded per-verb tool files | delete `tools/{createProject,updateProject,deleteProject,searchProjects,createEnvironment,...}.ts` (keep handler bodies as internal fns) | build/lint clean; update integration tests |
| C10 | Migration + version bump | `package.json` → 3.0.0; `CHANGELOG`; (README is P5) | `mcp-tools.test.ts`, `e2e-suite-tools.test.ts` updated |

## Failing-test matrix (the TDD red set)

**`__tests__/utils/confirmDestructive.test.ts`**
- `proceeds (null) for non-destructive actions`
- `requires confirm:true when no elicit capability`
- `proceeds on confirm:true (no elicit)`
- `elicits and proceeds on accept + confirm:true`
- `elicits and declines on reject`

**`__tests__/types/actionSchemas.test.ts`**
- `project.get requires uuid`
- `project.create requires name + platform`
- `project rejects action "update" and "delete"` (cut)
- `environment.delete accepts optional confirm`
- `environment.create keeps nested credentials[]`
- `test_suite validates list/create/run/results/delete`
- `test_case.create requires agentTaskDescription`
- `executions.list accepts sort/recency params`
- `unknown action → self-correctable validation error`

**`__tests__/handlers/{project,environment,testSuite,testCase,executions}.dispatch.test.ts`** (service layer mocked)
- `<entity>.<action> routes to the reused handler body` (one per action)
- `environment.delete / test_suite.delete / test_case.delete are guarded by ensureConfirmed`

**`__tests__/tools/registry.test.ts`**
- `registers exactly 8 tools`
- `names == [check_app_in_browser, probe_page, trigger_crawl, project, environment, test_suite, test_case, executions]`
- `update_project and delete_project are NOT registered`
- `each entity tool exposes the expected action enum`

**`__tests__/handlers/triggerCrawlHandler.test.ts`** (extend)
- `always sets contextData.headless = true`
- `trigger_crawl inputSchema has no headless property`

**`__tests__/handlers/searchExecutionsHandler.test.ts`** (extend → executions)
- `list threads recency sort param to the backend`

## Existing-test impact

- **Survive (reused handler bodies):** `createProjectHandler`, `create/update/delete*` env + test handlers, `search*Handler` tests — keep, optionally re-point through dispatchers.
- **Update (tool names/count):** `__tests__/integration/mcp-tools.test.ts`, `__tests__/integration/e2e-suite-tools.test.ts`, `__tests__/tools/toolDescription.test.ts`.
- **No action needed for cuts:** no `updateProjectHandler`/`deleteProjectHandler`/`deleteEnvironmentHandler` dedicated test files exist.

## Epic acceptance criteria (P6 will verify)

1. `getTools()` returns exactly the 8 named tools; `update_project`/`delete_project` absent.
2. Every entity tool validates per-action params (discriminated), with wrong-action params rejected as a tool-execution error.
3. Every old capability except the 2 cuts is reachable via a `tool` + `action`.
4. `delete` actions refuse without `confirm:true` (and via elicit when `ctx.elicit` present).
5. `trigger_crawl` always runs headless; no `headless` param anywhere in the surface.
6. `executions` list supports recency sort.
7. Full suite + lint + build green; version 3.0.0; README migration table present (P5).

## Risks / sequencing notes
- C4 (registry swap) is the breaking flip — keep it one commit so `git bisect` is clean.
- Do C9 (file deletions) only after C3/C4 prove the dispatchers cover every action, to avoid losing reused logic.
- Recommend implementing P4 in a **git worktree** (breaking refactor across ~25 files); merge once the suite is green.
