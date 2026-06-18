# MCP Protocol Evaluation — 2026-06-18

What newer Model Context Protocol features the `debugg-ai-mcp` server could adopt, ranked by value vs. effort. Researched against the official spec changelogs (2025-06-18, 2025-11-25 stable, 2026-07-28 release candidate).

## Where this server sits today

- **SDK**: `@modelcontextprotocol/sdk@1.27.0` → already supports the latest stable spec, **2025-11-25**. The library is current; the gap is in *using* what it offers, not upgrading it.
- **Transport**: stdio only (`StdioServerTransport`) — local `npx` install only, no hosted/remote option.
- **Capabilities declared**: `tools` only (`listChanged: false`). No `resources`, `prompts`, `completions`, or `logging`.
- **Tool results**: every handler returns `{ content: [{ type:'text', text: JSON.stringify(payload) }] }` — structured data stuffed into a text blob. No `structuredContent`, no `outputSchema`, no tool `annotations`, no `resource_link`.
- **Already good**: `notifications/progress` is wired up for long-running calls; input-validation failures already return as `isError` tool responses (model-self-correctable), matching 2025-11-25 guidance.

**Conclusion:** the gap is entirely "adopt newer primitives," not "upgrade the SDK."

## Protocol landscape

- **2025-06-18** (prior stable): structured tool output (`outputSchema`/`structuredContent`), elicitation (human-in-the-loop), resource links in tool results, removed JSON-RPC batching, OAuth-as-Resource-Server.
- **2025-11-25** (current stable, SDK target): experimental **Tasks** (durable async requests with polling/deferred results), **icons** for tools/resources/prompts, **sampling with tool calling** (server-side agent loops), elicitation upgrades (enums, defaults, URL-mode), OpenID Connect discovery + OAuth Client ID Metadata Documents, JSON Schema 2020-12 default dialect.
- **2026-07-28** (release candidate, draft): **stateless core** (no `initialize` handshake / session header → deploy behind round-robin LBs), **MCP Apps** (server-rendered interactive HTML UIs in sandboxed iframes), **Tasks** graduated to an extension, an **extensions framework** (reverse-DNS, opt-in), more OAuth/OIDC hardening.

## Feature-by-feature evaluation

| Spec feature | Since | Relevance to debugg-ai tools | Effort | Verdict |
|---|---|---|---|---|
| **Tool annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) | 2025-03-26 | Closes the tool-review red flag: `delete_project`/`delete_*` are LLM-callable with no signal. Mark deletes `destructive`, `search_*`/`probe_page` `readOnly`, browser/crawl `openWorld`. Clients (Claude, Cursor) surface these for confirm-gating. | Low | **Do now** |
| **Structured output** (`outputSchema` + `structuredContent`) | 2025-06-18 | Already emit JSON-in-text. Promote to `structuredContent` + declare `outputSchema` so clients parse/validate reliably instead of regexing a string. Keep text block for back-compat. | Low–med | **Do now** |
| **Resource links** in results | 2025-06-18 | Screenshots, HAR, console logs are presigned S3 URLs today, inlined or base64. Return as `resource_link` → smaller responses, renewable artifacts, on-demand fetch. | Med | **Plan** |
| **Tasks** (durable async) | 2025-11-25 (exp) → 2026 ext | Biggest fit. `check_app_in_browser`, `trigger_crawl`, `run_test_suite` all "fire then poll `search_executions`/`get_test_suite_results` manually." Tasks standardizes that (`tasks/get`/`cancel`, deferred results). But experimental and being restructured in the RC. | Med–high | **Prototype, don't ship-depend** |
| **Elicitation** (human-in-the-loop) | 2025-06-18 (enums/URL/defaults in 11-25) | Confirm destructive deletes; prompt for missing `username`/`password` instead of erroring; disambiguate when multiple envs match. URL-mode could drive an OAuth/login handoff. Must degrade gracefully — it's a *client* capability. | Med | **Plan** |
| **Resources + resource templates** | core | Expose projects/envs/executions as addressable read URIs (`debugg-ai://project/{uuid}`) with completion. Could shrink the 20-tool surface by moving reads off tools. Trade-off: client resource support more uneven than tools. | Med–high | **Consider** |
| **Streamable HTTP + OAuth + stateless core** | 2025-03-26 / 2026 RC | SaaS with `api.debugg.ai` but ships stdio-only. A hosted remote MCP (OAuth via existing auth) → users connect with no `npx`/local install. RC stateless core makes this deployable behind plain LBs. | High | **Strategic — decide** |
| **MCP Apps** (server-rendered UI) | 2026-07-28 RC | Highest ceiling: render screenshots, pass/fail, network waterfalls, crawl knowledge graph as *interactive UI* in the client instead of JSON+base64. Same audit/consent path as tool calls. RC + nascent client support. | High | **Watch** |
| **Icons** for tools | 2025-11-25 | Cosmetic branding in client tool pickers. | Low | Optional |
| **Sampling w/ tool calling** | 2025-11-25 | Lets a server borrow the client's LLM. You run your own backend agents — little upside. | — | **Skip** |

## Ranked recommendation

1. **Tool annotations** — a few lines per `build*Tool()`; immediately makes the destructive surface honest to every client. Pairs with the tool-review safety finding.
2. **Structured output (`structuredContent` + `outputSchema`)** — ~90% there; mostly lifting the payload out of the `JSON.stringify` text block and writing schemas you already validate inputs against.
3. **Resource links for artifacts** — leaner responses, renewable presigned URLs, sets up #4.
4. **Elicitation** for delete-confirm and missing-credential prompts — turns hard failures into recoverable, safer interactions.
5. **Decide the hosted/remote MCP question** (Streamable HTTP + OAuth) — product strategy, not a code change; the 2026 stateless core lowers the bar.
6. **Prototype Tasks + watch MCP Apps** — both map extremely well to your async/visual workflows, but both are experimental/RC. Spike them; keep them off the critical path until they stabilize.

Items 1–2 are the clear quick wins: low effort, every modern client benefits, and they directly close gaps from the tool review (destructive ops + JSON-in-text parsing).

## Sources

- [MCP 2025-11-25 changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog)
- [2026-07-28 release candidate (MCP blog)](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- [MCP 2025-06-18 spec update — security, structured output, elicitation (ForgeCode)](https://forgecode.dev/blog/mcp-spec-updates/)
- [What's new in MCP: elicitation, structured content, OAuth (Cisco)](https://blogs.cisco.com/developer/whats-new-in-mcp-elicitation-structured-content-and-oauth-enhancements)
- [MCP 2025-11-25: async Tasks, OAuth, extensions (WorkOS)](https://workos.com/blog/mcp-2025-11-25-spec-update)
- [Tools spec — annotations & structured output (modelcontextprotocol.io)](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
