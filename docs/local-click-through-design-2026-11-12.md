# check_app_in_browser on local Chrome, remote brain: MCP-side design (2026-11-12)

Status: draft for review. MCP side only. The platform lead owns the backend contract; section 7 is what the MCP needs from it. Builds on epic m7un, spike 3puf, `docs/local-chrome-browser-sizing-2026-11-12.md`, and `services/localBrowser.ts` (6.1.6: launch, `useProfile`, allowlist guard, `DEBUGGAI_LOCAL_BROWSER`).

## 1. Shape

The laptop dials out; the cloud never reaches in (this is what removes the tunnel; m7un "THE TRAP"). The cloud brain decides one step at a time. The MCP runs it in local Chrome and returns what it saw.

```
agent -> check_app_in_browser{browser:"local"} -> MCP
MCP  -> POST /executor/sessions {task, url, creds ref, limits}        -> {sessionId, token, firstAction?}
loop: MCP executes action in Chrome, then
      POST /executor/sessions/{id}/step {seq, actionResult, observation} -> {seq+1, action} | {done, verdict}
MCP  -> final result in the same shape the remote path returns (verdict adapter reused)
```

## 2. Transport: HTTPS request/response step loop (recommended), not websocket

The brain is turn-based and each turn is an LLM call of 1-10 s, so streaming buys nothing. A plain POST per step: works through every proxy/ALB, trivially retryable and idempotent (`seq`), cancel is one call, no connection-lifetime or sticky-routing problem, matches the existing poll style of the MCP's backend client. A websocket can come later if step latency, not LLM time, becomes the cost. Open for the platform lead: whether the step call blocks until the brain answers (simplest, needs a ~60 s server timeout) or returns 202 and is polled (matches today's workflow polling).

## 3. Action schema (brain -> executor)

JSON, one action per step, `seq` monotonic. Elements are addressed by `ref`, an index into the element list of the LAST observation (so the brain never needs selectors and the page cannot be driven by stale refs: a ref from an older observation is rejected as `STALE_REF`, brain re-observes).

| action | fields |
|---|---|
| `navigate` | `url` |
| `click` | `ref`, optional `button`, `doubleClick` |
| `type` | `ref`, `text`, `submit?` (press Enter), `clear?` |
| `press` | `key` (Playwright key names) |
| `select` | `ref`, `value` or `label` |
| `hover` / `scroll` | `ref` or `direction`+`amount` |
| `wait` | `ms` (cap 10 s) or `forText` / `forRef`, timeout |
| `back` / `reload` | none |
| `observe` | none (just re-perceive) |
| `done` | `verdict` (pass/fail/inconclusive), `reason`, `evidence` refs |

Deliberately not in v1: arbitrary JS evaluation, file upload, downloads, new-tab control beyond following a popup. `type` secrets: the brain sends a credential placeholder (`{{cred:label}}`) and the MCP substitutes locally, so passwords are never in the cloud (the remote path ships them; this is strictly better and costs nothing).

## 4. Observation payload (executor -> brain)

- `url`, `title`, `status` of last navigation, `loading` state.
- `elements[]`: interactive and text-bearing nodes, each `{ref, role, name, text, value, disabled, checked, visible, box:{x,y,w,h}}`. Built with one in-page script (or `ariaSnapshot`) per step, capped (e.g. 300 nodes, 200 chars each) and viewport-first.
- `screenshot`: JPEG, viewport, q70, <= ~150 KB, optional annotated with ref numbers; `fullPage` only when asked.
- `delta`: console errors/warnings and failed requests (status >= 400, aborted) since the previous step; `dialog` if an alert/confirm was auto-handled.
- `actionResult`: ok / error code (`NOT_FOUND`, `NOT_VISIBLE`, `STALE_REF`, `NAV_BLOCKED`, `TIMEOUT`) + message, so the brain can recover.

## 5. Auth, limits, cancel

- Auth: the MCP's existing API key / per-request bearer to open the session; the response carries a short-lived session token used for step calls, scoped to that session id. Backend enforces the usual credit and rate limits at session open.
- Hard limits owned by the MCP regardless of what the brain asks: max steps (default 25, same as remote), per-step timeout 15 s, wall-clock 5 min, one local run at a time per MCP process, nothing runs after the abort signal fires.
- Cancel: MCP abort signal (client cancel, timeout, step cap) -> `POST .../cancel` best effort + Chrome closed immediately (reuses the 56kd.7 AbortSignal plumbing). If the MCP dies mid-run the backend session expires on its own after N s without a step call (platform side).
- Retries: a step POST that fails transiently is resent with the same `seq`; the backend returns the cached action instead of re-thinking.

## 6. Security and data handling

- Opt-in at the server: `DEBUGGAI_LOCAL_BROWSER=1` (already exists) gates everything; without it `browser:"local"` returns `LOCAL_BROWSER_DISABLED`. Not available over the remote HTTP/OAuth MCP (no local machine).
- Navigation guard: reuse the 6.1.6 CDP `Fetch` document guard (redirect hops included). Always on for brain-driven runs, because the brain can be steered by page content: allowed = the task URL's host, localhost, plus `allowedDomains` / `DEBUGGAI_PROFILE_ALLOWED_DOMAINS`. A `navigate` action off-list returns `NAV_BLOCKED` to the brain; it does not execute.
- Profile isolation: default is a fresh incognito-style context per run. `useProfile` uses the MCP-owned profile (`~/.debugg-ai/chrome-profile`), never the user's real Chrome, and requires the allowlist as today.
- Local-only artifacts: full screenshots, HAR, video, console log are written under `~/.debugg-ai/captures` (0600) and returned to the agent as local paths and inline images. What goes to the cloud is only what the brain needs to decide: the per-step observation above (DOM digest + screenshot). HAR and cookies/storage are never uploaded and never logged.
- Redaction before upload: `value` of password inputs is dropped, credential substitution is local, `Authorization`/`Set-Cookie` never appear in `delta`.
- Headless by default; headful opt-in via `headless:false` with a visible banner injected while a profile session is attached.

Decision for Quinn (one line): with `useProfile` + the cloud brain, screenshots and DOM of logged-in pages go to our backend (the sizing doc kept authed captures local-only). Acceptable, or should `useProfile` stay local-capture-only?

## 7. What the MCP needs from the backend (feedback for the platform lead)

1. The three endpoints above (create / step / cancel) behind the existing auth, with the action and observation schemas versioned (`protocol: 1`) and unknown fields ignored.
2. The brain behind it must be the brain that checks apps today (judge/verdict included) with perception arriving as the observation, not as a browser handle. m7un found `check_app_in_browser` rides `browser_use` (fused perceive/think/act), so this needs the intent-path brain or an equivalent think-only call; that is the platform lead's call, the MCP only needs the contract.
3. Final result in the same shape the remote path returns (verdict, steps, `logins`, timings) so `adaptVerdict` and the response builder are reused. Step history for the UI/execution record is posted by the backend from the step calls it already receives; screenshots shown there are the uploaded observation ones.
4. Idempotent `seq`, server-side idle expiry, and a stable error code list (`SESSION_EXPIRED`, `STEP_OUT_OF_ORDER`, `LIMIT_REACHED`).
5. Capability negotiation at open: MCP sends `{protocol, actions[], viewport, userAgent}`; backend picks accordingly. Lets old MCPs keep working when actions are added.
6. How credentials are referenced: the MCP resolves env/credential choices today and ships them in `env`/`contextData`. For local runs it should send labels only and keep passwords local.

## 8. MCP build slices (staging branch each, tests each)

1. `LocalExecutor` class: given an action, runs it in Playwright and returns `{actionResult, observation}`; element indexer, screenshot, delta collector. Tested against a fixture page; no backend. (Reuses `services/localBrowser.ts` launch + guard, which gets split out of that file as it grows.)
2. Policy layer: allowlist guard per action, step/time caps, secret placeholder substitution, redaction, artifact writer.
3. Brain client + loop against a stub brain (scripted actions) so the whole loop is testable and works offline; the real client is a thin swap once the contract exists.
4. `check_app_in_browser` input: `browser: "local" | "remote"` (default remote), `headless`, `useProfile`, `allowedDomains`; routing in `testPageChangesHandler`; local result shaped like the remote one.
5. Live verification against a local app with the DebuggAI MCP, then against the real brain when the platform lead's endpoint is on staging.

Slices 1-3 need nothing from the backend and start now.
