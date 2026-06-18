# MCP Upgrade — Epics Plan (2026-06-18)

Eight epics, one per actionable/strategic feature from `mcp-protocol-evaluation-2026-06-18.md`. Every epic is **test-driven** and **validation-gated**: its six phase sub-beads run as a linear `blocks` dependency chain (P1→P2→P3→P4→P5→P6), so no phase can start until the previous one closes, and the epic cannot close until the **P6 validation gate** passes.

**Review this file, then I create all beads via** `bd create --graph docs/mcp-epics-graph-2026-06-18.json` (followed immediately by `bd export -o .beads/issues.jsonl` to persist).

## The 6-phase chain (applies to every epic)

| Phase | Name | Intent |
|---|---|---|
| P1 | Detailed design review | Review the governing MCP spec section(s) and the CURRENT implementation. Capture concrete requirements, constraints, real-world client support, and risks. Deliverable: a design-review note on the epic + enumerated open questions. |
| P2 | Architecture analysis & design | Analyze approach options, choose one, and produce the technical design: interfaces, type/schema changes, file-level change map, capability negotiation, backward-compat and rollback plan. Design is reviewed/approved before scoping closes. |
| P3 | Scoping & test plan | Decompose into concrete commits and author the TDD test matrix (unit + integration) plus the epic's measurable acceptance criteria. Failing-test NAMES are written here, before any implementation. |
| P4 | Implementation (TDD) | TDD: land the failing tests from P3 FIRST, then implement to green. No production code without a preceding test. Existing suite stays green; lint + typecheck/build clean. |
| P5 | Documentation | Update README tool tables, docs/, tool descriptions, CHANGELOG, and AGENTS.md as needed so docs match behavior. Add usage examples. |
| P6 | Validation gate | VALIDATION GATE. Run full `npm test`, lint, and build; verify every epic acceptance criterion is demonstrably met. Gates epic closure. |

Labels: every bead gets `mcp-upgrade` + a per-epic label; P4 also gets `tdd`, P6 also gets `validation-gate`.

## Summary (9 epics, 63 beads total)

| # | Epic | Priority | Label | Beads |
|---|---|---|---|---|
| 1 | Tool surface curation: distribution, exposure & safety (DECIDE FIRST) | P0 | `mcp-tool-surface` | 1 epic + 6 phases |
| 2 | Tool annotations (readOnly/destructive/idempotent/openWorld) | P0 | `mcp-annotations` | 1 epic + 6 phases |
| 3 | Structured tool output (outputSchema + structuredContent) | P0 | `mcp-structured-output` | 1 epic + 6 phases |
| 4 | Resource links for artifacts (screenshots / HAR / console) | P1 | `mcp-resource-links` | 1 epic + 6 phases |
| 5 | Elicitation (delete-confirm + missing-credential prompts) | P1 | `mcp-elicitation` | 1 epic + 6 phases |
| 6 | Tasks (durable async) — spike / prototype | P2 | `mcp-tasks` | 1 epic + 6 phases |
| 7 | Resources + resource templates (project/env/execution) | P2 | `mcp-resources` | 1 epic + 6 phases |
| 8 | Streamable HTTP + OAuth (hosted / remote MCP) | P3 | `mcp-remote-transport` | 1 epic + 6 phases |
| 9 | MCP Apps (server-rendered UI) — RC watch / spike | P3 | `mcp-apps` | 1 epic + 6 phases |

## Epic 1 — Tool surface curation: distribution, exposure & safety (DECIDE FIRST)  ·  P0

**Label:** `mcp-tool-surface`  |  **Spec:** docs/tool-review-2026-06-18.md (initial 20-tool review). Overlaps the Annotations + Elicitation epics for the destructive-op safety model.

**Goal.** Decide the TARGET MCP tool surface — keep / cut / gate-behind-flag for each of the 20 registered tools — and implement the chosen distribution model (lean core vs. opt-in management surface), destructive-op safety, and doc accuracy, BEFORE the per-feature protocol epics touch individual tools. Blocks the Annotations and Structured-output epics.

**Acceptance criteria (verified at P6 gate):**
- A documented keep/cut/gate decision for ALL 20 tools (decision record on the epic).
- Exposure model implemented: lean default vs. opt-in (env flag) for management/CRUD tools, per the decision.
- Destructive tools (delete_*) gated/guarded per decision (flag and/or explicit confirm) — coordinated with Annotations + Elicitation epics.
- README documents the FINAL surface accurately (fixes the 12-vs-20 staleness incl. the 8 undocumented test-suite tools).
- Any cut tools removed from the registry with tests updated; no dead handlers; version + migration note for the breaking change.
- Decision recorded on the open gaps from the review (update_project thinness, search_* sort/recency, delete_environment).

**Phases (linear gate chain):**

- **P1 · Detailed design review**
  - WALKTHROUGH (collaborative): for each of the 20 tools record keep / cut / gate-behind-flag / merge, with rationale.
  - Resolve the contested calls from the review: delete_project danger, update_project thinness, the 8 test-suite tools, delete_environment, search_* sort gap.
  - Decide the exposure model: single lean set vs. core+management split, and what gates management/destructive tools.
- **P2 · Architecture analysis & design**
  - Design the tiered registration mechanism (env flag(s) / build-time) and how tools/index.ts initTools filters by tier.
  - Design the destructive-op guard model (flag + explicit confirm arg + future elicitation) and how it composes with the Annotations epic.
  - Back-compat: cutting/gating tools is a breaking change for dependent clients → version bump + migration plan.
- **P3 · Scoping & test plan**
  - Concrete change list (tools cut/gated/kept). Test matrix: registry-composition tests for default vs. flagged sets; destructive-guard tests; acceptance.
- **P4 · Implementation (TDD)**
  - Tests first (registry composition per flag; guard behavior), then implement tier-gated registration + guards + any removals (green).
- **P5 · Documentation**
  - Rewrite the README tools section to match the final surface (the 12→20 fix); document exposure flags, destructive model, and the migration.
- **P6 · Validation gate**
  - Full suite + lint/build; verify default surface == lean set, flagged surface == full, destructive guards engaged, every decision reflected; close gate.

## Epic 2 — Tool annotations (readOnly/destructive/idempotent/openWorld)  ·  P0

**Label:** `mcp-annotations`  |  **Spec:** MCP 2025-06-18 tool annotations; SDK Tool.annotations (ToolAnnotations).

**Goal.** Add ToolAnnotations to all 20 registered tools so clients can render and confirm-gate by behavior, closing the destructive-ops safety gap from the tool review.

**Acceptance criteria (verified at P6 gate):**
- Every registered tool exposes an `annotations` object.
- delete_project, delete_environment, delete_test_suite, delete_test_case → destructiveHint:true.
- search_*, probe_page, get_test_suite_results → readOnlyHint:true.
- probe_page, check_app_in_browser, trigger_crawl, run_test_suite → openWorldHint:true.
- create_*/update_* annotated (not readOnly; idempotentHint set where it holds).
- A test enumerates tools and asserts the annotation invariants (incl. destructive set == the 4 deletes).

**Phases (linear gate chain):**

- **P1 · Detailed design review**
  - Inventory all 20 tools; classify each on the 4 hint axes.
  - Confirm SDK 1.27 ToolAnnotations field names; note hints are ADVISORY (clients MAY ignore).
- **P2 · Architecture analysis & design**
  - Produce the tool→hints matrix (table).
  - Decide where hints are set (each tools/*.ts build*Tool) and title vs name handling.
  - Confirm change is purely additive (no client breakage).
- **P3 · Scoping & test plan**
  - Author __tests__/tools/toolAnnotations.test.ts spec: presence + per-class invariants.
  - Define acceptance: destructive flagged set, readOnly set, openWorld set.
- **P4 · Implementation (TDD)**
  - Write the invariant test (red).
  - Add `annotations` to every build*Tool() in tools/ (green).
- **P5 · Documentation**
  - Add a behavior/annotations column to the README tools table; CHANGELOG; note in AGENTS.md.
- **P6 · Validation gate**
  - Full suite + lint/build; verify the matrix; (no UI) close gate.

## Epic 3 — Structured tool output (outputSchema + structuredContent)  ·  P0

**Label:** `mcp-structured-output`  |  **Spec:** MCP 2025-06-18 structured tool output (structuredContent + outputSchema).

**Goal.** Promote today's JSON-in-text responses to spec structured output: declare an outputSchema per data tool and return structuredContent, keeping the serialized text block for back-compat.

**Acceptance criteria (verified at P6 gate):**
- Each read/data tool declares an `outputSchema`.
- Handlers return `structuredContent` conforming to that schema, PLUS a back-compat text block.
- A validator test asserts structuredContent ⊨ outputSchema for each handler's representative output.
- isError response shape unchanged.

**Phases (linear gate chain):**

- **P1 · Detailed design review**
  - Catalog current response shapes (search_* {filter,pageInfo,...}, probe_page, suite results, CRUD {created/updated/deleted}).
  - Review spec rules: structuredContent + SHOULD include serialized text; client MUST validate when outputSchema present.
- **P2 · Architecture analysis & design**
  - Design a buildToolResult(payload) helper emitting structuredContent + text block.
  - Author per-tool outputSchemas (reuse README shapes); set JSON Schema 2020-12 dialect.
  - Pick a validator (check if ajv is already a dep); define isError path.
- **P3 · Scoping & test plan**
  - Test matrix: schema-conformance test per handler; back-compat text-block test; acceptance.
- **P4 · Implementation (TDD)**
  - Add conformance tests (red); implement buildToolResult, wire all handlers, add outputSchema to tool defs (green).
- **P5 · Documentation**
  - README response-shape + outputSchema docs; CHANGELOG; additive-migration note.
- **P6 · Validation gate**
  - Full suite + lint/build; validate every handler's structuredContent against its schema; close gate.

## Epic 4 — Resource links for artifacts (screenshots / HAR / console)  ·  P1

**Label:** `mcp-resource-links`  |  **Spec:** MCP 2025-06-18 resource links (resource_link content type).

**Goal.** Return screenshots/HAR/console artifacts as resource_link content (renewable presigned URIs) instead of inlining large base64/URLs, shrinking responses and enabling on-demand fetch.

**Acceptance criteria (verified at P6 gate):**
- check_app_in_browser artifacts (HAR, console logs) and probe_page screenshots are available as resource_link items (uri/name/mimeType).
- Screenshots keep an inline-preview path where useful (decision recorded).
- Expiry/renewal documented (refetch presigned URLs via search_executions).

**Phases (linear gate chain):**

- **P1 · Detailed design review**
  - Inventory artifact outputs: presigned S3 (check_app_in_browser), base64 PNG (probe_page).
  - Review resource_link semantics (not guaranteed in resources/list; for direct retrieval); note presigned expiry.
- **P2 · Architecture analysis & design**
  - Design: which artifacts → resource_link vs inline image; whether to also implement resources/read (defer to Resources epic); response-size targets.
  - Note: extends buildToolResult from the Structured-output epic if scheduled after it.
- **P3 · Scoping & test plan**
  - Test plan: assert resource_link items carry required fields; response-size reduction assertion; acceptance.
- **P4 · Implementation (TDD)**
  - TDD then implement in probePageHandler + testPageChangesHandler (and getTestSuiteResults if it returns artifacts).
- **P5 · Documentation**
  - README artifacts section (link fields + renewal); CHANGELOG.
- **P6 · Validation gate**
  - Full suite + lint/build; verify link fields + renewal note; close gate.

## Epic 5 — Elicitation (delete-confirm + missing-credential prompts)  ·  P1

**Label:** `mcp-elicitation`  |  **Spec:** MCP 2025-06-18 elicitation; 2025-11-25 enums/defaults/URL-mode. (CLIENT capability.)

**Goal.** Use elicitation/create for human-in-the-loop: confirm destructive deletes and prompt for missing credentials — degrading gracefully when the client lacks the capability.

**Acceptance criteria (verified at P6 gate):**
- delete_* tools request confirmation via elicitation when the client supports it; proceed/abort accordingly.
- check_app_in_browser/trigger_crawl prompt for missing username/password via elicitation when login is needed.
- When the client lacks elicitation → current behavior preserved (no hang; documented fallback).

**Phases (linear gate chain):**

- **P1 · Detailed design review**
  - Review elicitation flow (server→client request; primitive-type schema only); detect client capability from initialize result.
  - Assess CI/non-interactive risk (must never hang).
- **P2 · Architecture analysis & design**
  - Design capability gate + maybeElicit() helper; per-tool elicitation schemas (confirm boolean; cred fields).
  - Fallback policy: deletes require explicit confirm arg if no elicitation; creds keep current error. Timeouts/no-hang guarantees.
- **P3 · Scoping & test plan**
  - Test plan: mock client with/without elicitation; accept/reject paths; fallback path; acceptance.
- **P4 · Implementation (TDD)**
  - TDD then implement maybeElicit() + wire delete_* and browser/crawl handlers.
- **P5 · Documentation**
  - README + AGENTS.md interaction model; CHANGELOG.
- **P6 · Validation gate**
  - Full suite + lint/build; verify BOTH capability paths (present/absent); close gate.

## Epic 6 — Tasks (durable async) — spike / prototype  ·  P2

**Label:** `mcp-tasks`  |  **Spec:** MCP 2025-11-25 tasks (EXPERIMENTAL); restructured as an extension in the 2026-07-28 RC.

**Goal.** Evaluate and prototype the experimental Tasks primitive for long-running tools (check_app_in_browser, trigger_crawl, run_test_suite) behind an experimental flag; produce a go/no-go decision. Do NOT ship-depend.

**Acceptance criteria (verified at P6 gate):**
- SDK 1.27 task support assessed and documented (supported or not).
- A flagged prototype (DEBUGGAI_EXPERIMENTAL_TASKS) maps one long-running tool to task handle + tasks/get polling — OR a written blocker rationale.
- Default behavior unchanged when the flag is off.
- A decision record (keep-as-spike / adopt-later / drop) appended to the epic.

**Phases (linear gate chain):**

- **P1 · Detailed design review**
  - Review tasks spec + check SDK 1.27 for task schemas/handlers; compare with current executionId + search_executions polling.
  - Note 2026 RC restructuring risk (experimental→extension).
- **P2 · Architecture analysis & design**
  - Design execution→task mapping; flag-gated + additive; trivial rollback (flag off).
- **P3 · Scoping & test plan**
  - Scope a minimal spike (one tool); test plan for the flagged path; acceptance + decision criteria.
- **P4 · Implementation (TDD)**
  - TDD-style spike implementation behind the flag (default OFF).
- **P5 · Documentation**
  - Document as EXPERIMENTAL; CHANGELOG; write the decision record.
- **P6 · Validation gate**
  - Validate flag-off == no behavior change; spike acceptance; record go/no-go; close gate.

## Epic 7 — Resources + resource templates (project/env/execution)  ·  P2

**Label:** `mcp-resources`  |  **Spec:** MCP core resources + resource templates + argument completions.

**Goal.** Expose projects/environments/executions as read-only MCP resources via templates (debugg-ai://project/{uuid}, …), declaring the resources (+ completions) capability — reduces reliance on search_* tools and backs the Resource-links epic.

**Acceptance criteria (verified at P6 gate):**
- resources/list, resources/read, and resource templates implemented for project/environment/execution.
- `resources` (and completions) capability declared in server capabilities.
- search_* tools remain (back-compat); docs explain resource vs tool.

**Phases (linear gate chain):**

- **P1 · Detailed design review**
  - Review resources/templates/completions spec; map entities→URIs; assess client support; note overlap with Resource-links epic.
- **P2 · Architecture analysis & design**
  - Design URI scheme + handlers (ListResources, ReadResource, templates, completion); capability declaration; reuse the service layer; decide read-through caching.
- **P3 · Scoping & test plan**
  - Test plan: list/read/template/completion handlers; acceptance.
- **P4 · Implementation (TDD)**
  - TDD then implement handlers + capability.
- **P5 · Documentation**
  - README resources section; CHANGELOG.
- **P6 · Validation gate**
  - Full suite + lint/build; verify read/list/template/completion; close gate.

## Epic 8 — Streamable HTTP + OAuth (hosted / remote MCP)  ·  P3

**Label:** `mcp-remote-transport`  |  **Spec:** MCP 2025-03-26 Streamable HTTP; 2025-06-18/11-25 OAuth Resource Server + RFC 9728; 2026-07-28 RC stateless core.

**Goal.** Enable an OPTIONAL hosted/remote MCP over Streamable HTTP with OAuth (server as Resource Server) so users connect without local npx; leverages the 2026 RC stateless core for simple deployment. Starts with a product/architecture decision.

**Acceptance criteria (verified at P6 gate):**
- Decision/ADR on whether to offer hosted MCP (with scope) recorded.
- If GO: StreamableHTTPServerTransport selectable via env (stdio stays default); OAuth bearer validation against api.debugg.ai; RFC 9728 protected-resource-metadata endpoint.
- Stdio path unchanged and remains the default.

**Phases (linear gate chain):**

- **P1 · Detailed design review**
  - DECISION review: demand, security model, auth reuse, hosting. Review transport + OAuth specs + stateless-core RC. Produce an ADR (go/no-go).
- **P2 · Architecture analysis & design**
  - Architecture: transport selection (DEBUGGAI_TRANSPORT); session vs stateless; token validation integration with existing auth; RFC 9728 metadata; threat model.
- **P3 · Scoping & test plan**
  - Scope the MVP (single-tenant first?); test plan (transport + auth, unit + integration); acceptance.
- **P4 · Implementation (TDD)**
  - TDD then implement the HTTP transport option + auth middleware (flagged; stdio default).
- **P5 · Documentation**
  - Deployment + config docs; CHANGELOG; security notes.
- **P6 · Validation gate**
  - Full suite + lint/build; auth/transport integration tests; deploy smoke; close gate.

## Epic 9 — MCP Apps (server-rendered UI) — RC watch / spike  ·  P3

**Label:** `mcp-apps`  |  **Spec:** MCP 2026-07-28 RC: MCP Apps (sandboxed-iframe server-rendered HTML).

**Goal.** Research-spike an MCP App that renders probe_page/check_app_in_browser results (screenshots, network waterfall, pass/fail) as sandboxed HTML UI. RC feature with nascent client support — prototype + decision only; NOT default-shipped.

**Acceptance criteria (verified at P6 gate):**
- RC spec + client-support reality assessed and documented.
- A prototype UI template renders a real result against a supporting client — OR a written blocker rationale.
- DebuggAI MCP visual verification of the prototype (per repo UI policy).
- Decision record (pursue-when-stable / park) appended to the epic.

**Phases (linear gate chain):**

- **P1 · Detailed design review**
  - Review MCP Apps RC (declared templates, sandboxed iframe, action→tool-call audit/consent path); survey client support; pick a candidate result view.
- **P2 · Architecture analysis & design**
  - Design the app template + data contract + security review (sandbox + consent path).
- **P3 · Scoping & test plan**
  - Scope a minimal prototype; test/verify plan incl. DebuggAI MCP visual check; acceptance.
- **P4 · Implementation (TDD)**
  - Build the prototype template (flagged / experimental).
- **P5 · Documentation**
  - Document EXPERIMENTAL/RC; CHANGELOG; write the decision record.
- **P6 · Validation gate**
  - Validate against a supporting client + DebuggAI MCP visual check; record decision; close gate.

