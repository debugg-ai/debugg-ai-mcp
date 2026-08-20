# Debugg AI — MCP Server

AI-powered browser testing via the [Model Context Protocol](https://modelcontextprotocol.io). Point it at any URL (or localhost) and describe what to test — an AI agent browses your app and returns pass/fail with screenshots.

<a href="https://glama.ai/mcp/servers/@debugg-ai/debugg-ai-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@debugg-ai/debugg-ai-mcp/badge" alt="Debugg AI MCP server" />
</a>

## Setup

**Requires Node.js 20.20.0 or later** (transitive requirement from `posthog-node@^5.26.0`).

**Testing `http://localhost:...` URLs requires the `caddy` binary** — `check_app_in_browser`,
`probe_page`, and `trigger_crawl` tunnel localhost targets through a local Caddy reverse proxy.
This installs automatically: the `@radically-straightforward/caddy` npm dependency downloads a
pinned Caddy release for your platform during `npm install`/`npx`, same as this project already
does for the `ngrok` binary — nothing to install yourself in the normal case. If that download
never ran (`npm install --ignore-scripts`, an offline/air-gapped install), point `CADDY_BIN` at
your own install (`brew install caddy` / `apt install caddy` / see
[caddyserver.com/docs/install](https://caddyserver.com/docs/install)) — missing it surfaces as a
clear error on the first localhost-URL call, not a silent hang. Public-URL calls, every
non-browser tool, and `test_suite {action:"run"}` (which uses its own dedicated tunnel and
bypasses Caddy entirely) don't need it either way.

Get an API key at [debugg.ai](https://debugg.ai), then add to your MCP client config:

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

Or with Docker:

```bash
docker run -i --rm --init -e DEBUGGAI_API_KEY=your_api_key quinnosha/debugg-ai-mcp
```

The `Dockerfile`'s `npm install` step would pick up `caddy` the same automatic way local installs
do, in principle — but as of this writing the `Dockerfile` doesn't `COPY` several directories the
build now needs (`handlers`, `tools`, `types`, `config`) and still references a `tunnels/`
directory that no longer exists, so a fresh build likely fails before that matters. That's a
pre-existing gap, unrelated to Caddy. The **currently published** `quinnosha/debugg-ai-mcp` image
predates the Caddy dependency regardless — localhost-URL calls to
`check_app_in_browser`/`probe_page`/`trigger_crawl` will fail with `CaddyBinaryNotFoundError`
inside that image until it's rebuilt (Dockerfile fixed) and republished, or `CADDY_BIN` points at
one baked in separately. Public-URL calls, the non-browser tools, and `test_suite {action:"run"}`
are unaffected either way.

## Tools

The server exposes **8** tools: three **Browser** tools plus one **action-based** tool per managed entity. The headline tools are `check_app_in_browser` (full AI agent) and `probe_page` (lightweight no-LLM page probe). The rest — `project`, `environment`, `test_suite`, `test_case`, `executions` — each take an `action` discriminator (e.g. `{"action":"list"}`) that selects the operation. Destructive `delete` actions require confirmation (an elicitation prompt where supported, otherwise `confirm: true`).

### Browser

#### `check_app_in_browser`

Runs an AI browser agent against your app. The agent navigates, interacts, and reports back with screenshots. Localhost URLs are auto-tunneled via ngrok.

| Parameter | Type | Description |
|-----------|------|-------------|
| `description` | string **required** | What to test (natural language) |
| `url` | string **required** | Target URL — `http://localhost:3000` is auto-tunneled |
| `environmentId` | string | UUID of a specific environment |
| `credentialId` | string | UUID of a specific credential |
| `credentialRole` | string | Pick a credential by role (e.g. `admin`, `guest`) |
| `username` | string | Username for login (ephemeral — not persisted) |
| `password` | string | Password for login (ephemeral — not persisted) |
| `loginCredentials` | array | Accounts for logins the agent hits **during** the task — `[{username, password, label?}]` |
| `useEnvironmentCredentials` | boolean | Default `true`. `false` forbids auto-filling the environment's stored credentials; with no account named it means **do not log in at all** |
| `freshSession` | boolean | Default `false`. `true` forces a real login instead of reusing the warm session held for that account |
| `auth` | object | Auth precondition — `{precondition, entryUrl, deepUrl, environmentId, username, password}` |
| `repoName` | string | Override auto-detected git repo name (e.g. `my-org/my-repo`) |

One focused check per call. The agent has a ~25-step internal budget; split broader suites across multiple calls.

##### Credentials: pass them as parameters, not prose

Naming an account only in `description` does **not** make the agent use it — it falls back to the environment's stored credential, and the app's rejection of the wrong account comes back looking like an application failure. Anything you pass as a parameter beats the environment default for **every** login in the run, not just the first:

- `username` / `password` (or `credentialId` / `credentialRole`) — the run's identity.
- `auth.username` / `auth.password` — pins the precondition login when you also use `auth.precondition: "login"`.
- `loginCredentials` — accounts for a login form the agent reaches **part-way through** the task. This is the one for flows like *set a password → get bounced to sign-in → log in as the account you just created*, where splitting into separate calls would lose browser state.

Set `useEnvironmentCredentials: false` when a silent fallback to the default test user would invalidate the check.

**Checking a page that needs no login at all?** Pass `useEnvironmentCredentials: false` and name no account. That combination means exactly what it says — *do not log in* — and the run skips authentication entirely instead of hunting for a login form. Use it for public pages, marketing sites, docs, and anything pre-auth. It is also faster: on the default (`auto`) the agent will follow a "Log in" link off your page and try the environment's stored account before it evaluates anything.

##### Session reuse: why a check can report "no login form"

Runs don't log in every time. After a verified login the backend captures that account's session and **restores** it on the next run for the same identity, which skips the login entirely — that's why a check can legitimately come back with `submitted: false` and no login form: it was already signed in. A restored run reports itself in `logins` with `reason: "restored_session"`, so you can tell it apart from a run that genuinely found no form.

Sessions are keyed per **account**, so naming a different account never reuses somebody else's. Two ways to bypass reuse:

- `freshSession: true` on a single call — log in for real this once, then re-capture. Use it when the login flow *is* what you're checking, when you suspect the stored session is stale, or when the app's only route between personas is a logout.
- `environment` tool, `action: "clearSessions"` — invalidate the stored sessions so subsequent runs log in. Narrow with `username` / `credentialId`; unscoped clears require confirmation because every account on the environment then re-authenticates.

Use `action: "sessions"` to see what an environment is currently holding and whether each would be reused.

Results report the identity actually used, so a wrong one is visible rather than masquerading as a broken app:

```json
"logins": [
  { "username": "qa+invitefix@example.com", "source": "task", "submitted": true, "authenticated": true }
],
"credentialWarning": {
  "requested": "qa+invitefix@example.com",
  "used": ["qatest123@example.com"],
  "message": "This run signed in with an environment default credential even though '…' was specified. …"
}
```

`source` is `task` | `explicit` | `credential_id` (an account you named) or `env` | `env_default` (the environment's stored account). `credentialWarning` appears only when you named an account and an environment default was used anyway. `loginError` appears when a named account could not be resolved and the run declined to substitute a different one.

Every successful run returns a `browserSession` block alongside the screenshot — presigned S3 URLs for the captured **HAR** (full network trace) and **console log** (every JS console message). Use them to detect refetch loops, hydration errors, and other runtime issues that pass type-checks and unit tests:

```json
"browserSession": {
  "harUrl": "https://...session_18139.har?X-Amz-...",
  "consoleLogUrl": "https://...session_18139_console.json?X-Amz-...",
  "recordingUrl": "https://...session_18139_recording.webm?X-Amz-...",
  "harStatus": "downloaded",
  "consoleLogStatus": "downloaded",
  "harRedactionStatus": "redacted",
  "consoleLogRedactionStatus": "redacted"
}
```

URLs are short-lived presigned S3 — refetch the parent execution via `executions {action:"get", uuid}` to renew. `harStatus` / `consoleLogStatus` disambiguate `'downloaded'` (URL fetchable), `'not_available'` (page emitted nothing), `'failed'` (capture broke). On a fresh run the URLs are commonly `null` because capture uploads async after the agent finishes — poll `executions {action:"get", uuid: executionId}` until status reaches `'downloaded'`. Authorization / Cookie / `token`/`secret`/`api_key` headers are scrubbed server-side before the artifacts are persisted.

#### `trigger_crawl`

Fires a server-side browser-agent crawl to populate the project's knowledge graph. Localhost URLs tunnel automatically. Returns `{executionId, status, targetUrl, durationMs, outcome?, crawlSummary?, knowledgeGraph?, browserSession?}` with `knowledgeGraph.imported === true` on successful ingestion. The `browserSession` block (HAR + console-log URLs, same shape as above) is also present on completed crawls.

#### `probe_page`

**Lightweight no-LLM batch page probe.** Pass 1-20 URLs; each navigates, settles on content (the DOM going quiet, bounded — never on network silence, which a live app never reaches), and returns rendered state — screenshot + page metadata + structured console errors + network summary. No agent loop, no LLM cost, no scenario assertions. Use it for "did I just break /settings?", multi-route smoke after a refactor, CI per-PR sweeps, and quick is-it-up checks where `check_app_in_browser`'s 60-150s agent loop is overkill.

| Parameter | Type | Description |
|-----------|------|-------------|
| `targets` | array **required** | 1-20 entries: `[{url, waitForSelector?, waitForLoadState?, timeoutMs?}]` |
| `targets[].url` | string **required** | Public URL or localhost (auto-tunneled) |
| `targets[].waitForLoadState` | enum | `'domcontentloaded'` (default, + a bounded content settle) / `'load'` (also blocks on third-party embeds) / `'networkidle'` (accepted, never issued — a live site's network does not go idle) |
| `targets[].waitForSelector` | string | Optional CSS selector to wait for after navigation |
| `targets[].timeoutMs` | number | Per-URL timeout, 1000-30000 (default 10000) |
| `includeHtml` | boolean | Return raw HTML in each result (default false) |
| `captureScreenshots` | boolean | Return one PNG per target (default true) |

All targets in a batch share one session tunnel, but only same-port (or all-public) batches share a **single** backend execution — 5 URLs on one port in one call is dramatically faster than 5 parallel single-URL calls. A batch that mixes multiple **local** ports decomposes into one sequential backend execution per port group (still one call, still one merged `results[]` in your original order, but N backend round-trips instead of one — slower, not rejected). Per-URL `error` field preserves batch resilience: a single failed target doesn't fail the others.

**`networkSummary` aggregation key is `origin + pathname`** — refetch loops (`?n=0..4` repeatedly hitting the same endpoint) collapse into a single entry with the count, so `/api/poll` showing up with `count: 47` is the actionable "infinite refetch loop" signal users originally asked for.

Performance budget: <10s for 1 URL, <25s for 20. Localhost dead-port returns `LocalServerUnreachable` in <2s without burning a workflow execution.

### `project`

| Action | Params | Result |
|--------|--------|--------|
| `get` | `{uuid}` | Curated project detail |
| `list` | `{q?, page?, pageSize?}` | Paginated summaries |
| `create` | `{name, platform, (teamUuid\|teamName), (repoUuid\|repoName)}` | Created project |

Team and repo resolve by **either** uuid **or** name (case-insensitive exact match; `NotFound` if none, `AmbiguousMatch` if multiple). There is **no** `update`/`delete` — rename or delete a project from the DebuggAI web app.

### `environment`

| Action | Params | Result |
|--------|--------|--------|
| `get` | `{uuid, projectUuid?}` | Env with credentials inlined (passwords never returned) |
| `list` | `{projectUuid?, q?, page?, pageSize?}` | Paginated envs, each with a credentials array |
| `create` | `{name, url, description?, projectUuid?, credentials?}` | Created env (optionally seeds credentials) |
| `update` | `{uuid, name?, url?, description?, addCredentials?, updateCredentials?, removeCredentialIds?}` | Patched env; credential ops run **remove → update → add** |
| `delete` | `{uuid, projectUuid?, confirm?}` | Deletes env (cascades credentials) — **requires confirmation** |
| `sessions` | `{uuid, username?, credentialId?}` | Captured login sessions the env holds, per account, with `isUsable` and a `usableCount` |
| `clearSessions` | `{uuid, username?, credentialId?, confirm?}` | Invalidates them so the next run logs in for real — **unscoped clears require confirmation** |

`projectUuid` auto-resolves from the git repo when omitted. Per-cred failures surface in `credentialWarnings[]` without blocking the env op.

`sessions` / `clearSessions` manage the warm authenticated sessions the backend reuses to skip login (see [Session reuse](#session-reuse-why-a-check-can-report-no-login-form)). Session contents are never returned — a session cookie is a bearer credential. `clearSessions` marks sessions invalid rather than deleting the rows, so reuse stops immediately while the capture history stays readable.

### `test_suite`

| Action | Params | Result |
|--------|--------|--------|
| `list` | `{projectUuid\|projectName, search?, page?, pageSize?}` | Paginated suites with status + pass rate |
| `create` | `{name, description, projectUuid\|projectName}` | Created suite |
| `run` | `{suiteUuid\|(suiteName+project), targetUrl?}` | Triggers all tests async |
| `results` | `{suiteUuid\|(suiteName+project)}` | Suite + per-test outcomes |
| `delete` | `{suiteUuid\|(suiteName+project), confirm?}` | Soft-delete — **requires confirmation** |

### `test_case`

| Action | Params | Result |
|--------|--------|--------|
| `create` | `{name, description, agentTaskDescription, suiteUuid\|(suiteName+project), relativeUrl?, maxSteps?}` | Created test case (not auto-run) |
| `update` | `{testUuid, name?, description?, agentTaskDescription?}` | Patched test case |
| `delete` | `{testUuid, confirm?}` | Soft-delete — **requires confirmation** |

### `executions`

| Action | Params | Result |
|--------|--------|--------|
| `get` | `{uuid}` | Full detail (`nodeExecutions` + state + errorInfo) + screenshot/gif artifacts |
| `list` | `{status?, projectUuid?, page?, pageSize?}` | Paginated summaries |

404 from the backend surfaces as `isError: true` with `{error: 'NotFound', message, uuid}`. Credentials are **always** returned without passwords.

### Pagination

Every filter-mode response is paginated. Response shape:

```json
{
  "filter": { "...echoed query params..." },
  "pageInfo": { "page": 1, "pageSize": 20, "totalCount": 47, "totalPages": 3, "hasMore": true },
  "<items>": [ ... ]
}
```

Pass optional `page` (1-indexed, default 1) and `pageSize` (default 20, max 200; oversized values are clamped). No response is ever silently truncated.

## Resources

Alongside tools, the server exposes the read-only entities as MCP **resources**
so clients can browse and @-mention them as context:

| URI | What |
|---|---|
| `debugg-ai://projects` | All projects (first page) |
| `debugg-ai://environments` | Environments for the auto-detected project |
| `debugg-ai://executions` | Recent executions (first page) |
| `debugg-ai://project/{uuid}` | One project, full detail |
| `debugg-ai://environment/{uuid}` | One environment (credentials inline, passwords redacted) |
| `debugg-ai://execution/{uuid}` | One execution, full node detail + artifact links |

Reads dispatch to the same handlers as the `project` / `environment` /
`executions` tools, so the data and auth are identical. Resources are additive —
clients without resource support keep using the tools.

### Security invariants

- Passwords are write-only. They never appear in any response body from any tool.
- Tunnel URLs (`*.ngrok.debugg.ai`) are stripped from all browser-agent responses, including agent-authored text.
- 404s from the backend surface as `isError: true` with `{error: 'NotFound', ...}`, never as thrown exceptions.
- Missing `DEBUGGAI_API_KEY` surfaces as a structured tool error on first invocation — the server still registers and lists tools normally.

## Migration to v3.0.0 (action-based tools)

v3 consolidated the 20 per-verb tools into 8 action-based tools. Old tool → new `tool {action}`:

| Removed | Replacement |
|---------|-------------|
| `search_projects` | `project {action:"get"}` / `project {action:"list"}` |
| `create_project` | `project {action:"create"}` |
| `update_project`, `delete_project` | **Dropped** — use the DebuggAI web app |
| `search_environments` | `environment {action:"get"}` / `{action:"list"}` |
| `create_environment` / `update_environment` / `delete_environment` | `environment {action:"create"\|"update"\|"delete"}` |
| `create_test_suite` / `search_test_suites` / `run_test_suite` / `get_test_suite_results` / `delete_test_suite` | `test_suite {action:"create"\|"list"\|"run"\|"results"\|"delete"}` |
| `create_test_case` / `update_test_case` / `delete_test_case` | `test_case {action:"create"\|"update"\|"delete"}` |
| `search_executions` | `executions {action:"get"\|"list"}` |
| `trigger_crawl` `headless` param | **Dropped** — always headless |

`delete` actions now require confirmation (elicitation prompt, or `confirm: true`). Clients pick up the new surface on MCP restart.

## Migration from v1.x (breaking change in v2.0.0)

v2 collapsed a 22-tool surface to 11. Old-tool → new-tool mapping:

| Removed | Replacement |
|---------|-------------|
| `list_projects`, `get_project` | `search_projects` (uuid mode vs filter mode) |
| `list_environments`, `get_environment` | `search_environments` |
| `list_credentials`, `get_credential` | `search_environments` — credentials inline on each env |
| `create_credential` | `create_environment({credentials: [...]})` seed, or `update_environment({addCredentials: [...]})` |
| `update_credential` | `update_environment({updateCredentials: [{uuid, ...patch}]})` |
| `delete_credential` | `update_environment({removeCredentialIds: [uuid]})` |
| `list_teams`, `list_repos` | `create_project({teamName, repoName})` — name resolution with ambiguity handling |
| `list_executions`, `get_execution` | `search_executions` |
| `cancel_execution` | **Dropped** — backend spin-down is automatic |

Response-shape changes: the bare `count` field on list responses is gone — use `pageInfo.totalCount`.

## Configuration

| Env var | Required | Purpose |
|---|---|---|
| `DEBUGGAI_API_KEY` | yes | Backend API key. Aliases: `DEBUGGAI_API_TOKEN`, `DEBUGGAI_JWT_TOKEN`. |
| `DEBUGGAI_API_URL` | no | Backend base URL. Defaults to `https://api.debugg.ai`. |
| `DEBUGGAI_TOKEN_TYPE` | no | `token` (default) or `bearer`. |
| `DEBUGGAI_EVAL_TEMPLATE` | no | Override the App Evaluation workflow **slug** that `check_app_in_browser` dispatches to. Defaults to `flow/e2es/app-eval`. Dispatch pins to this slug so a backend template rename can't break it. |
| `LOG_LEVEL` | no | `error` / `warn` / `info` (default) / `debug`. |
| `POSTHOG_API_KEY` | no | Override the embedded telemetry project key (e.g. private fork). |
| `DEBUGGAI_TELEMETRY_DISABLED` | no | Set to `1` / `true` / `yes` / `on` to disable telemetry entirely. |

```bash
DEBUGGAI_API_KEY=your_api_key
```

## Remote / HTTP transport (optional)

By default the server speaks **stdio** (local `npx`). It can instead run as a
hosted, multi-user remote MCP over **stateless Streamable HTTP** + OAuth:

```bash
DEBUGGAI_MCP_TRANSPORT=http PORT=3000 DEBUGGAI_TOKEN_TYPE=bearer npx -y @debugg-ai/debugg-ai-mcp@latest
```

It is an OAuth **Resource Server**: every `POST /mcp` needs
`Authorization: Bearer <token>`; missing/invalid tokens get a `401` with a
`WWW-Authenticate` pointing at the RFC 9728 metadata, and clients run the OAuth
flow against the advertised authorization server. The bearer is request-scoped —
`api.debugg.ai` validates it.

| Endpoint | Purpose |
|---|---|
| `POST /mcp` | MCP Streamable HTTP (bearer-protected) |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 metadata (authorization server discovery) |
| `GET /health` | Load-balancer / ECS health check |

| Env var | Default | Purpose |
|---|---|---|
| `DEBUGGAI_MCP_TRANSPORT` | `stdio` | Set to `http` for the remote transport |
| `PORT` | `3000` | HTTP listen port |
| `DEBUGGAI_MCP_PUBLIC_URL` | `https://mcp.debugg.ai` | This server's public resource URL (RFC 9728 `resource`) |
| `DEBUGGAI_OAUTH_ISSUER` | `https://auth.debugg.ai` | Authorization server advertised to clients |
| `DEBUGGAI_TOKEN_TYPE` | `token` | Set to `bearer` so OAuth tokens forward as `Authorization: Bearer` |

stdio installs need none of these.

**Multi-replica deployments (go/no-go before rollout):** tunnel state (the ngrok session tunnel,
its Caddy instance, and its port-route lock) is in-process, keyed per caller by a hash of the
bearer token — there is no cross-process coordination. Running several replicas behind a plain
round-robin load balancer means one caller's calls can land on different replicas and mint one
tunnel **per replica they hit** instead of one for the whole session (extra ngrok cost, bounded by
replica count, self-healing via the existing 55-minute idle auto-shutoff — never a cross-session
correctness bug, since any single tool call stays on one replica for its whole duration). To get
the intended "one tunnel per session" behavior on a multi-replica HTTP deployment, configure
**session-affine routing** at the load balancer (sticky/consistent-hash keyed on the same identity
`getSessionKey()` derives — in practice, the caller's `Authorization` bearer token). See
`docs/local-tunnel-multiplexer-architecture-2026-07-31.md` §2.1 for the full reasoning and the
honest degrade path if this isn't configured.

## Telemetry

The MCP server ships with telemetry enabled by default — an embedded write-only PostHog project key (`phc_*`) so the team can observe cache hit rates, poll cadence, tunnel reliability, and other operational metrics across the install base. Captured events:

| Event | When |
|---|---|
| `tool.executed` / `tool.failed` | Per tool call |
| `workflow.executed` | Per browser-agent execution (carries `pollCount`, `durationMs`, `finalIntervalMs`) |
| `tunnel.provisioned` / `tunnel.provision_retry` / `tunnel.stopped` | Per tunnel lifecycle event |
| `template.lookup` / `project.lookup` | Cache hit/miss with `durationMs` on cold-call |

Privacy posture:
- The distinct ID is `SHA-256(api_key).slice(0, 16)` — never the raw key, no PII.
- `phc_*` keys are write-only by PostHog convention; safe to embed in source.
- Set `DEBUGGAI_TELEMETRY_DISABLED=1` to opt out entirely (resolves to a no-op provider; no events leave the process).

The active mode is logged at boot:
```
Telemetry enabled (PostHog, DebuggAI default project). Set DEBUGGAI_TELEMETRY_DISABLED=1 to opt out.
Telemetry enabled (PostHog, custom POSTHOG_API_KEY)
Telemetry disabled (DEBUGGAI_TELEMETRY_DISABLED is set)
```

## Local Development

```bash
npm install
npm run build
npm run test:e2e        # real end-to-end evals against the backend
```

The eval suite spawns the built MCP server as a subprocess, exercises every tool against a real backend, and writes per-flow artifacts to `scripts/evals/artifacts/<timestamp>/`. See `scripts/evals/flows/` for the individual scenarios.

### MCP registration: `debugg-ai-local` vs `debugg-ai`

This repo ships a `.mcp.json` that registers a **project-scoped** server named `debugg-ai-local` pointing at `node dist/index.js` — the freshly-built local code. It only activates when Claude Code's working directory is this repo.

Your other projects should use the **user-scoped** `debugg-ai` registration that pulls from the published npm package:

```bash
npm run mcp:global      # registers debugg-ai in ~/.claude.json to npx -y @debugg-ai/debugg-ai-mcp
```

After editing code here, run `npm run mcp:local` (which just rebuilds) so the next invocation of `debugg-ai-local` picks up your changes.

## Links

[Dashboard](https://app.debugg.ai) · [Docs](https://debugg.ai/docs) · [Issues](https://github.com/debugg-ai/debugg-ai-mcp/issues) · [Discord](https://debugg.ai/discord)

---

Apache-2.0 License © 2025 DebuggAI
