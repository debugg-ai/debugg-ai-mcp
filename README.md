# Debugg AI — MCP Server

AI-powered browser testing via the [Model Context Protocol](https://modelcontextprotocol.io). Point it at any URL (or localhost) and describe what to test — an AI agent browses your app and returns pass/fail with screenshots.

<a href="https://glama.ai/mcp/servers/@debugg-ai/debugg-ai-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@debugg-ai/debugg-ai-mcp/badge" alt="Debugg AI MCP server" />
</a>

## Setup

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

## Tools

The server exposes **18** tools. The headline one is `check_app_in_browser`; the rest manage projects, environments, credentials, and workflow execution history.

### `check_app_in_browser`

Runs an AI browser agent against your app. The agent navigates, interacts, and reports back with screenshots.

| Parameter | Type | Description |
|-----------|------|-------------|
| `description` | string **required** | What to test (natural language) |
| `url` | string **required** | Target URL — a localhost URL (`http://localhost:3000`) is auto-tunneled via ngrok |
| `environmentId` | string | UUID of a specific environment |
| `credentialId` | string | UUID of a specific credential |
| `credentialRole` | string | Pick a credential by role (e.g. `admin`, `guest`) |
| `username` | string | Username for login (ephemeral — not persisted) |
| `password` | string | Password for login (ephemeral — not persisted) |
| `repoName` | string | Override auto-detected git repo name (e.g. `my-org/my-repo`) |

### Project management

| Tool | Purpose |
|------|---------|
| `list_projects` | List projects accessible to your API key. Optional `q` for name/repo search. |
| `get_project` | Fetch a project by `uuid`. Simplified shape (no team/runner internals). |
| `update_project` | PATCH a project's `name` or `description`. |
| `delete_project` | Destructive delete. Cascades envs, creds, and history. |

### Environment management (scoped to a project)

| Tool | Purpose |
|------|---------|
| `list_environments` | List envs for a project. Optional `q`, `projectUuid`. |
| `create_environment` | Create a new env. Requires `name` + `url`. |
| `get_environment` | Fetch an env by `uuid`. |
| `update_environment` | PATCH `name` / `url` / `description`. |
| `delete_environment` | Destructive delete. |

### Credential management (scoped to an environment)

| Tool | Purpose |
|------|---------|
| `list_credentials` | List creds. Optional `environmentId`, `q`, `role` (server-side filter). **Never returns passwords.** |
| `create_credential` | Create a cred. Requires `environmentId`, `label`, `username`, `password`; optional `role`. |
| `get_credential` | Fetch by `uuid` + `environmentId`. |
| `update_credential` | Partial PATCH. Pass `password` to rotate — it is never echoed back. |
| `delete_credential` | Destructive delete. |

### Workflow execution history

| Tool | Purpose |
|------|---------|
| `list_executions` | Paginated history. Optional `status`, `limit`. |
| `get_execution` | Full detail for a single execution including node-level state. |
| `cancel_execution` | Cancel an in-flight execution. |

### Pagination

Every `list_*` tool is paginated by default. Response shape:

```json
{
  "filter": { "...echoed query params..." },
  "pageInfo": { "page": 1, "pageSize": 20, "totalCount": 47, "totalPages": 3, "hasMore": true },
  "<items>": [ ... ]
}
```

Pass optional `page` (1-indexed, default 1) and `pageSize` (default 20, max 200; oversized values are clamped) to any list tool. No tool ever silently truncates results.

### Security invariants

- Passwords are write-only. They never appear in any response body from any tool.
- Tunnel URLs (`*.ngrok.debugg.ai`) are stripped from all browser-agent responses, including agent-authored text.
- 404s from the backend surface as `isError: true` with `{error: 'NotFound', ...}`, never as thrown exceptions.

## Configuration

```bash
DEBUGGAI_API_KEY=your_api_key
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
