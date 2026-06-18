# MCP Tool Surface — Decisions (2026-06-18)

Authoritative output of the P1 walkthrough for epic `debugg_ai_mcp-yg7o6` (*Tool surface curation*). Backed by the initial review (`tool-review-2026-06-18.md`) and real usage telemetry (PostHog `tool.executed`, all installs, last 365 days).

## Final target surface: 20 → 8 tools

Full **action-based** consolidation — one tool per entity, verbs become an `action` param.

| Tool | Actions | Notes |
|---|---|---|
| `check_app_in_browser` | — | always headless |
| `probe_page` | — | always headless |
| `trigger_crawl` | — | kept standalone; `headless` param removed |
| `project` | get / list / create | `update` + `delete` **cut** (web-app only) |
| `environment` | get / list / create / update / delete | credentials nested; `delete` guarded |
| `test_suite` | list / create / run / results / delete | `delete` guarded |
| `test_case` | create / update / delete | `delete` guarded |
| `executions` | get / list | recency sort added |

## Usage data that drove it (calls | distinct installs | last seen)

- **Core (heavy):** check_app_in_browser 1012|5, probe_page 186|4, search_executions 159|4, create_test_case 113|3, search_projects 81|4, get_test_suite_results 73|3, search_environments 59|4, run_test_suite 48|3
- **Moderate:** create_test_suite 23|3, update_environment 23|4, trigger_crawl 20|2, create_environment 17|4
- **Low:** search_test_suites 8|4, update_test_case 6|3, create_project 6|2
- **Barely touched:** delete_environment 3|2, delete_test_suite 3|2, delete_test_case 3|2, delete_project 3|**1** (stale since Apr 29), update_project 2|**1** (stale since Apr 29)

`check_app_in_browser` alone outweighs every other tool combined. Management CRUD and deletes are rare; `delete_project`/`update_project` are effectively dead (1 install each).

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Full action-based**, ~8 tools (verbs → `action` param) | Bulk of the 20 was per-verb CRUD repeated across 4 entities; collapsing kills the bloat. |
| D2 | **Destructive safety = elicitation prompt + `confirm:true` fallback** | Human-in-the-loop where the client supports elicitation; works everywhere via the confirm arg. Applies to all `delete` actions. |
| D6 | **Add recency sort + date filter** to `executions` (and list actions) | Current `search_*` can't sort; executions are polled most. |
| D7 | **Headless mandatory — no toggle anywhere** | The MCP always runs headless. Remove `trigger_crawl`'s `headless` param, force `headless:true` to the backend. Also verify the backend default is headless (backend-side). |
| D8 | **Removal-based exposure, no flag-gating.** Cut `update_project` + `delete_project`; expose everything else | Usage shows both dead (1 install, stale). A `DEBUGGAI_MANAGEMENT_TOOLS` flag is unnecessary once consolidated. |
| D9 | **Keep `trigger_crawl`** standalone (only the headless policy touches it) | Niche but cheap; do not cut/merge. |
| — | **Breaking change accepted** — rename/remove freely, **no deprecated aliases**, major version bump | Clients pick up the new surface on MCP restart. |

## Cross-epic impact (for downstream phases)

- **Annotations epic** (`p7gft`): action-based tools blur per-op annotations — a `project` tool with `create` can't be `readOnly`. Annotations now apply at the tool level (~8 tools); destructive safety shifts to D2 (elicitation/confirm) rather than the `destructiveHint` signal.
- **Structured output epic** (`3eb5l`): now ~8 tools to schema instead of 20 — less work.
- **Elicitation epic**: becomes the primary destructive-safety mechanism (D2), not just a UX nicety.
- **Resources epic**: the `get`/`list` actions overlap with read-only resources — consider exposing project/env/execution reads as resources instead of (or alongside) tool actions.

## Status

P1 walkthrough complete; all decisions recorded on the epic. Next: P2 (architecture) — design the action-tool dispatch, the destructive-guard helper, and the migration/version bump.
