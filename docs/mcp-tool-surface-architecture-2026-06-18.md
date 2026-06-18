# MCP Tool Surface — Architecture & Design (P2)

Epic `debugg_ai_mcp-yg7o6`, phase P2. Implements the decisions in `mcp-tool-surface-decisions-2026-06-18.md`. Target: collapse 20 per-verb tools into **8 action-based tools**, add a destructive guard, enforce headless, ship as a breaking major.

## 1. Tool model: action-based discriminated union

Each consolidated entity tool takes a required `action` discriminator; params are validated per-action. Two schemas exist per tool today and both adopt the discriminated shape:

- **MCP-facing `inputSchema`** (hand-written JSON Schema in `build*Tool()`): `action` enum + `oneOf` branches, each branch a `const` action with its own `required`. Self-documenting for the model.
- **Runtime `inputSchema`** (Zod, on `ValidatedTool`): `z.discriminatedUnion('action', [...])`.

```ts
// types/index.ts
export const ProjectInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get'),  uuid: z.string() }),
  z.object({ action: z.literal('list'), q: z.string().optional(), page: z.number().optional(), pageSize: z.number().optional() }),
  z.object({ action: z.literal('create'), name: z.string().min(1), platform: z.string().min(1),
             teamUuid: z.string().optional(), teamName: z.string().optional(),
             repoUuid: z.string().optional(), repoName: z.string().optional() }),
]);
// NOTE: no 'update'/'delete' — cut per D8.
```

```jsonc
// MCP inputSchema (project) — oneOf keeps required-params precise per action
{
  "type": "object",
  "properties": {
    "action": { "type": "string", "enum": ["get", "list", "create"], "description": "..." },
    "uuid": { "type": "string" }, "q": { "type": "string" }, "page": { "type": "number" },
    "pageSize": { "type": "number" }, "name": { "type": "string" }, "platform": { "type": "string" },
    "teamUuid": {"type":"string"}, "teamName": {"type":"string"}, "repoUuid": {"type":"string"}, "repoName": {"type":"string"}
  },
  "required": ["action"],
  "oneOf": [
    { "properties": { "action": { "const": "get" } },    "required": ["action", "uuid"] },
    { "properties": { "action": { "const": "list" } },   "required": ["action"] },
    { "properties": { "action": { "const": "create" } }, "required": ["action", "name", "platform"] }
  ],
  "additionalProperties": false
}
```

**Risk / mitigation.** Some clients/models handle `oneOf` discriminated schemas less reliably than flat tools. Mitigations: (a) list `action` first with an enum'd description naming each action's required params; (b) Zod validation failures already return as **tool-execution errors** (2025-11-25 guidance), so the model self-corrects from a clear message rather than a hard protocol error. If field telemetry later shows action-selection errors, fall back to a flatter schema (all-optional params + runtime discriminated validation).

## 2. Dispatch: reuse existing tested handlers

Per-action logic already exists and is tested. Add one thin dispatcher per entity tool that routes `action` → existing handler internals; delete the cut paths.

```ts
// handlers/projectHandler.ts
export const projectHandler: ToolHandler = (input, ctx, progress) => {
  switch (input.action) {
    case 'get':
    case 'list':   return searchProjectsHandler(toSearchInput(input), ctx);   // reuse
    case 'create': return createProjectHandler(input, ctx);                    // reuse
  }
};
```

Mapping (old tool → new tool.action), all reusing current handler bodies:

| New | Actions → old handler |
|---|---|
| `project` | get/list→searchProjects · create→createProject |
| `environment` | get/list→searchEnvironments · create→createEnvironment · update→updateEnvironment · delete→deleteEnvironment |
| `test_suite` | list→searchTestSuites · create→createTestSuite · run→runTestSuite · results→getTestSuiteResults · delete→deleteTestSuite |
| `test_case` | create→createTestCase · update→updateTestCase · delete→deleteTestCase |
| `executions` | get/list→searchExecutions (+ recency sort, D6) |

`update_project` + `delete_project` handlers/schemas/tools are **deleted**.

## 3. Destructive guard (D2) — decoupled from the elicitation epic

Deletes route through one helper. The surface epic ships the **confirm-arg path only**; the elicitation epic later populates `ctx.elicit`. So this epic has **no hard dependency** on the elicitation epic.

```ts
// utils/confirmDestructive.ts
const DESTRUCTIVE = new Set(['delete']);
export async function ensureConfirmed(action, label, input, ctx): Promise<ToolResponse | null> {
  if (!DESTRUCTIVE.has(action)) return null;            // not destructive → proceed
  if (ctx.elicit) {                                     // populated by elicitation epic
    const r = await ctx.elicit({ message: `Delete ${label}? This cannot be undone.`,
      requestedSchema: { type:'object', properties:{ confirm:{type:'boolean'} }, required:['confirm'] } });
    return (r.action === 'accept' && r.content?.confirm === true) ? null
         : errorResponse('confirmation_declined', 'Deletion was not confirmed.');
  }
  if (input.confirm === true) return null;              // fallback works on every client
  return errorResponse('confirmation_required', 'Pass confirm:true to delete (or use an elicitation-capable client).');
}
```

**Threading `ctx.elicit`.** Handlers currently receive `(input, ctx, progress)` with no server handle. Extend `ToolContext` with an optional `elicit?` (mirrors how `progressCallback` is created in `index.ts` closing over `server`):

```ts
// types/index.ts — ToolContext
elicit?: (req: ElicitRequest) => Promise<ElicitResult>;
// index.ts CallTool handler — create from server.elicitInput when client advertises the capability
```

Each consolidated schema's destructive branch carries an optional `confirm: z.boolean().optional()`.

## 4. Headless enforcement (D7)

- Remove `headless` from `TriggerCrawlInputSchema` (types) and the `trigger_crawl` tool def.
- In `triggerCrawlHandler`, replace the conditional with an unconditional `contextData.headless = true`.
- Add a test asserting `contextData.headless === true` regardless of input.
- Backend default headless = a separate backend task (out of repo) — tracked, not blocking.

## 5. Registry & capabilities

- `tools/index.ts` `initTools()` registers **8** tools. Browser tools unchanged.
- New files: `tools/project.ts`, `tools/environment.ts`, `tools/testSuite.ts`, `tools/testCase.ts`, `tools/executions.ts` (action defs + validated builders).
- Server capabilities unchanged (`tools` only) for this epic. Elicitation needs no server capability (it's a client capability the server calls into). Structured-output/resources capabilities arrive in their own epics.

## 6. File-level change map

| Action | Files |
|---|---|
| **Add** | `tools/{project,environment,testSuite,testCase,executions}.ts`, `handlers/{project,environment,testSuite,testCase,executions}Handler.ts` (dispatchers), `utils/confirmDestructive.ts` |
| **Modify** | `types/index.ts` (discriminated-union schemas + `ToolContext.elicit`), `tools/index.ts` (register 8), `index.ts` (build `ctx.elicit`), `tools/triggerCrawl.ts` + `handlers/triggerCrawlHandler.ts` (drop headless), `README.md` (surface + migration) |
| **Delete** | `tools/{createProject,updateProject,deleteProject,searchProjects,...per-verb...}.ts` and matching handlers/schemas being folded; `update_project` + `delete_project` removed entirely |

(Existing per-verb handler *bodies* are retained as internal functions the dispatchers call; only their standalone tool/registry entries go away.)

## 7. Migration & versioning

- Breaking: tool renames + 2 removals. **Major bump → 3.0.0.**
- README migration table: old tool → new `tool` + `action` (e.g. `search_projects` → `project {action:"get"|"list"}`; `delete_project` → removed, use the web app).
- No deprecated aliases (per decision). Clients pick up the new surface on MCP restart (ListTools re-fetch).

## 8. Test strategy (handed to P3)

- Registry composition: exactly 8 tools, expected names + action enums; `update_project`/`delete_project` absent.
- Discriminated-union validation: each action accepts its required params, rejects wrong-action params with a self-correctable error.
- Dispatch: each `action` reaches the right reused handler (mock service layer).
- Destructive guard: `delete` without confirm → `confirmation_required`; with `confirm:true` → proceeds; with `ctx.elicit` accept/decline → proceeds/declines.
- Headless: `trigger_crawl` always sends `headless:true`; no `headless` in its schema.
- Back-compat smoke: old tool names no longer resolve.

## Open items for P3 scoping
- Confirm `executions` recency-sort param shape (D6) against the backend list API.
- Decide whether `environment` create/update keep the nested credentials arrays as-is (they do today) under the `action` schema.
