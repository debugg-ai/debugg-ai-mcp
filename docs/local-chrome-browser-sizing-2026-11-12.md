# Sizing: local Chrome for the MCP, and reusing the user's Chrome profile (2026-11-12)

Investigate-and-size only; nothing is built. Builds on epic `debugg_ai_mcp-m7un` (local browser executor) and spike `debugg_ai_mcp-3puf`, which already found that the cloud brain/surfer is browser-agnostic but that the cloud must not keep the browser handle or a tunnel comes back.

## Request 1: agent picks a local Chrome (headless or headful) instead of the remote browser

Today `check_app_in_browser` is a cloud workflow: remote browser + cloud agent loop (browser_use). The MCP only tunnels localhost to it. `playwright` is not a dependency of this repo.

Options:

| | What | Lift | Notes |
|---|---|---|---|
| A. Local capture only | New `browser: "local"` on `probe_page` (and a `trigger_crawl`-lite): MCP launches Chrome via `playwright-core`, loads URL(s), returns screenshot, console, HAR, DOM text. No agent loop, no tunnel, no cloud. | S-M (about 1 week) | Fully inside this repo. Covers "screenshot my logged-in thing". Does not do click-through testing. |
| B. Local executor, cloud brain | MCP runs Playwright locally and a thin loop: sends perception (screenshot + DOM digest) to a new backend "decide next action" endpoint, executes the action locally, repeats. Cloud never holds the browser. | L (3-6 weeks) | Needs a NEW backend endpoint and refactor of the browser_use path in sentinal (the m7un spike scope). Kills the tunnel bug class for the full tool. Judge/verdict stays in cloud. |
| C. Cloud drives local Chrome over CDP via our tunnel | Expose local Chrome's CDP through the existing debugg tunnel; cloud agent attaches. | M (2-3 weeks) | Re-creates the tunnel failure modes and hands the cloud full control of a browser on the user's machine. Not recommended. |

Recommendation: A first (cheap, immediately useful), B as the real m7un build gated on spike 3puf. Skip C.

Selection surface (agent-visible): `browser: "remote" | "local"` plus `headless: boolean` and optional `chromePath`. Default stays `remote`. `local` only works when the MCP server is on the same machine as Chrome (stdio use; unavailable over the remote HTTP/OAuth MCP). Opt-in at server level too: env `DEBUGGAI_LOCAL_BROWSER=1` (or config), so an agent cannot start browsers on a machine whose owner has not allowed it.

Risks: Chrome discovery per OS; headful windows stealing focus; zombie browser processes on abort (reuse the AbortSignal plumbing from 56kd.7); memory (one browser per session, cap it); CI/containers without Chrome.

## Request 2: reuse the logged-in state of the user's real Chrome profile

Facts that shape the options:
- Chrome refuses `--remote-debugging-port` with the DEFAULT user-data-dir (since Chrome 136). Automation needs a non-default dir.
- A profile dir is locked by a running Chrome (`SingletonLock`); two Chromes cannot share one dir.
- macOS/Windows cookies are encrypted with an OS-keychain key; copying `Cookies`/`Login Data` into another browser or build often yields undecryptable data, and prompts keychain access.

Options:

| | What | Lift | Notes |
|---|---|---|---|
| 1. Dedicated automation profile (recommended) | MCP-owned persistent profile dir (e.g. `~/.debugg-ai/chrome-profile`). User logs in once (headful, `login` helper), then runs reuse the cookies. | S on top of Request 1A | Not the "same" cookies as daily Chrome, but stable, lock-free, no keychain games. Covers most "see my authed artifact" needs. |
| 2. Attach to the user's running Chrome via CDP | User launches Chrome with `--remote-debugging-port=9222 --user-data-dir=<non-default>`; MCP `connectOverCDP`. | S-M | Real live session, but only if the user relaunches Chrome that way; the agent then controls their actual browser, tabs and all. |
| 3. Copy the real profile | Clone `Default` into a temp dir and launch with it. | M, fragile | Keychain decryption, lock handling, GB-sized copies, and a copy of every credential on disk. Not recommended. |
| 4. Browser extension bridge | Extension in the real Chrome relays commands (like the Claude-in-Chrome extension already used elsewhere). | L | Best fidelity and consent UX; separate product. |

Security implications (apply to every option):
- The agent, and any prompt injection in a page it visits, gets the user's authenticated sessions. Treat as high-privilege.
- Screenshots/DOM of authed pages go to the cloud backend if the cloud brain (Request 1B) sees them. Local-only capture (1A) keeps data on the machine; say so in the tool description.
- Required guards (all opt-in, none on by default): server-level enable flag; explicit profile path; per-call domain allowlist (refuse navigation off-list, including redirects); never log cookies/storage; headful confirmation or a visible banner while a real-profile session is attached; secrets redaction in HAR (HAR from an authed session contains tokens, so store locally with 0600 perms, do not upload).
- Option 2 and 4 should require the user to start the session deliberately; the agent must not be able to attach on its own.

## Proposed order and beads
1. Local capture mode for `probe_page` + dedicated persistent profile (Request 1A + 2.1). About 1-1.5 weeks, repo-local, no backend change.
2. Optional attach-via-CDP (2.2) behind the same flags.
3. Full local executor with cloud brain (1B) = epic m7un, after spike 3puf returns go/no-go. Needs a backend owner.

Decisions needed from Quinn: (a) is "own persistent profile, log in once" acceptable for v1, or must it be the daily Chrome's exact cookies; (b) is it OK that authed screenshots stay local-only in v1 (no cloud agent on authed pages).
