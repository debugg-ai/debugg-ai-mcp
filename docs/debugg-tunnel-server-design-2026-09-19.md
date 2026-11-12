# Debugg tunnel server — replacing ngrok with our own (design, 2026-09-19)

**Decisions (owner, 2026-09-19):**
- Same architecture as ngrok, with every ngrok piece replaced by a debugg-owned one.
- Written in-house, not an open-source tunnel server.
- Tunnel hostnames are `<id>.tunnel.debugg.ai`. Only the `tunnel.debugg.ai` subdomain is delegated from
  Namecheap to a Route53 zone, so its DNS lives in AWS; the rest of `debugg.ai` stays at Namecheap.
- Tunnel URLs are **reachable only from our infrastructure for now**, with a clean path to going public later.
- The tunnel server runs in the **debugg API server group** (the `debuggai-api` rc stack), **not in browser-mgr**. browser-mgr only gets changes needed to function, and is expected to need none.
- Reuse the existing nginx wherever possible.

**Decisions (owner, round 2 — after the design arcs reported):**
- **No staging rebuild: dark-launch in prod** behind the transport flag (staging was decommissioned 2026-09-18).
  The flag defaulting to ngrok is therefore the only safety net.
- **The rc change is approved** — the `extra_target_groups` feature plus the standalone terraform module.
- **Rollout selection** is an on/off switch plus named accounts; the percentage ramp exists but defaults to 0.
- **No proxy support: outbound 443 must be allowed.** ngrok's agent handled `HTTPS_PROXY` itself and our
  client won't, so connect failures must say so plainly. Accepted risk.
- Decided while the owner reviewed: keep the ngrok-named error fields in v1 so tool output doesn't change;
  a live tunnel may reconnect past `expires_at` up to the 24h cap, so a deploy can't kill long runs;
  every tunnel gets a DB row, ngrok ones included; the health PROBE traverses the real ingress path
  (proving DNS + internal ALB + nginx); a local-only tunnel service is added for development.

**Status (2026-09-25, after 5 days in production):** shipped and verified — 100% of tunnels use the
debugg transport, zero ngrok, every real run connecting. ngrok is deleted from the backend, the
client (`5.0.0`), the prod secrets and the task definitions. Two follow-ups came out of the review:
`CLOSED_URL` was never wired so `closed_at` stayed NULL on every row (fixed, `xkoh.14`), and
**local dev still runs on ngrok** — `sentinal/local.yml` for GitHub webhooks and
`react-web-app/dev-utils/` for VS Code dev. That blocks closing the ngrok account and is scoped as
`xkoh.17`. It is a genuinely different problem: it carries the PUBLIC INTERNET to a developer's
localhost, so it needs public reachability and stable hostnames, neither of which the product
tunnel wants.

**Status (2026-09-19):** scoped as five test-first arcs under bead `debugg_ai_mcp-xkoh`. All five have
closed phases 1.1–3.2 (requirements, failing tests, strategy, architecture); implementation (4.1) is
gated on owner review. Corrections the arcs proved against the real code are marked inline below.

---

## 1. Same shape, our pieces

```
TODAY                                              NEW
─────                                              ───
MCP ──POST api/v1/tunnels/──▶ debugg API           MCP ──POST api/v1/tunnels/──▶ debugg API
        (mints an ngrok key)                               (mints a debugg tunnel token)
MCP ngrok agent ──▶ ngrok servers                  MCP tunnel client ──▶ debugg tunnel server
        ▲                                                  ▲          (debuggai-api stack)
browser ─▶ https://<id>.ngrok.debugg.ai            browser ─▶ https://<id>.tunnel.debugg.ai
MCP: tunnel → local Caddy → localhost:<port>       MCP: tunnel → local Caddy → localhost:<port>   (unchanged)
```

| Role | Today | New |
|---|---|---|
| Token issuance and scoping | `POST api/v1/tunnels/` → `ngrok_api.py` (ngrok Service User + API key) | `POST api/v1/tunnels/` → debugg `Tunnel` record + tunnel token issued by the debugg API |
| Token revoke | `POST api/v1/ngrok/revoke/` → ngrok API | `POST api/v1/tunnels/<id>/revoke/` → debugg API |
| Client in the MCP | `ngrok` npm package (downloads the ngrok binary) | pure-TS tunnel client in the MCP, no binary |
| Server | ngrok's cloud | **debugg tunnel server**: new ECS service in `debuggai-api`, behind the existing nginx |
| Public-facing hostname | `*.ngrok.debugg.ai` on ngrok's edge | `*.tunnel.debugg.ai` → internal ALB → nginx → tunnel server |
| Everything above the tunnel | handlers, `tunnelContext`, Caddy, PortLock, URL rewriting | **unchanged** |

The MCP's `TunnelManager` keeps its API. Only the connect/disconnect step behind `connectWithRetry`
changes. The `ngrok.connect()` call becomes a `TunnelTransport` interface with two implementations,
the ngrok one kept for the migration window and the debugg one.

---

## 2. Token management — debugg API (sentinal)

- **New `Tunnel` model** in `backend/tunnels/`:
  - Fields: `id` (uuid, the tunnelId / hostname label), `user`, `purpose`, `token_hash`, `created_at`,
    `expires_at`, `revoked_at`, `connected_at`, `closed_at`, `client_version`.
  - This also fills today's gap where nothing records tunnels (the `tunnelId` is generated and thrown away).
- **`POST api/v1/tunnels/`** (same auth as today):
  - Creates the row and returns the **same response shape**, `{tunnelId, tunnelKey, keyId, expiresAt}`,
    plus `{transport: "debugg", relayUrl, tunnelDomain, maxExpiresAt}`.
  - **Old-client bytes are locked by a snapshot test.** `expiresAt` is Python `isoformat()`, ending
    `+00:00` — not `Z`, whatever the view docstring says.
  - `tunnelKey` is an opaque random secret; only its hash is stored. `keyId` is the `Tunnel.id`.
  - **Transport negotiation:** new clients send `transports: ["debugg", "ngrok"]`. The backend picks
    one per request, driven by a setting or feature flag (per-user or percentage), so rollout and
    rollback are server-side with no MCP release. Clients that send nothing get ngrok exactly as today.
- **`POST api/v1/tunnels/<id>/revoke/`:** sets `revoked_at`, checks that the tunnel belongs to the
  caller (today's ngrok revoke does not), and tells the tunnel server to drop the connection.
- **Internal verify endpoint** for the tunnel server, e.g. `POST /api/internal/tunnels/verify/`
  `{tunnelId, tunnelKey, event: "connect"|"reverify"}` → `{ok, tunnelId, userId, expiresAt, maxExpiresAt}`
  or `{ok:false, reason}` with reasons `unknown | bad_key | revoked | max_lifetime | expired`, checked
  in that order (`expired` only on connect). It uses service-to-service auth (bearer
  `TUNNEL_SERVICE_TOKEN`; a valid *user* credential is also 401) and is never routed publicly.
  - The public nginx `location /` forwards every path to django, so nginx must explicitly block
    `/api/internal/` on the public server blocks. The service token alone is not the only guard.
  - The tunnel server calls it on every client connect and reconnect, so **the debugg API is the
    only authority on tokens**. That's roughly one call per session plus reconnects, so the load
    is negligible.
- **Lifetime:** `expires_at` bounds **connects and reconnects**, not a live connection, so a tunnel in
  active use isn't cut off at the hour (matching how ngrok keys behave today). A live tunnel ends on
  revoke, on client disconnect, or at a hard maximum lifetime (e.g. 24h).
- **Revoke propagation:** Django publishes `tunnel.revoked <id>` on the existing Redis
  (`redis.debuggai-api.local`) and the tunnel server subscribes, so revokes take effect immediately.
  Redis is only the fast path: the server re-verifies live tunnels every few minutes, so a lost Redis
  message can't leave a revoked tunnel up.

---

## 3. Debugg tunnel server (new service in the `debuggai-api` stack)

- **Language and location (CORRECTED by the server arc):** Node/TS, at top level `tunnel-server/` in
  the **sentinal repo** (`debugg-ai/debuggai-api`) — NOT the platform repo, as this doc first said.
  `.github/workflows/deploy.yml` checks out only `debuggai-api`, and rc builds every image from
  `docker-compose.ecs.yml` contexts inside that checkout, so code outside it cannot be built or
  deployed. It is deployed as a new service in `deploy/prod/rc.yml` next to `nginx`/`django`/`redis`,
  is **not** part of browser-mgr, and imports nothing from it.
  - The wire protocol is a **vendored copy** of the MCP's `services/tunnel/protocol/`, kept in sync by
    a script and two CI gates — not an npm subpath import. Importing the MCP package would make the
    server download the ngrok binary at build time (`ngrok` and `@radically-straightforward/caddy`
    both fetch binaries in postinstall), and would couple server deploys to MCP npm releases.
- **Ports (VPC-only, never public):**
  - `:8080` is the **control port**: MCP clients' websockets, reached through nginx `location /tunnel/`.
  - `:8081` is the **ingress port**: browser HTTP for `<id>.tunnel.debugg.ai`, reached through nginx's tunnel server block.
  - Registered in Cloud Map as `tunnel.debuggai-api.local`, the same pattern as `django.debuggai-api.local:8001`.
- **Wire protocol:** one websocket per tunnel, carrying multiplexed streams.
  - Binary frames: `OPEN`, `DATA`, `END`, `RST`, `WINDOW`, `PING`/`PONG`, `GOAWAY`, `PROBE`/`PROBE_RESULT`.
  - Flow control is per stream and credit-based, so a large JS chunk can't block the HMR socket.
    Multiplexing is in v1: a single Next.js dev page has been measured at 54 requests, and a
    websocket per stream would pay a round trip from the user to us-east-2 for each new connection.
  - The client pings every 20s, below the ALB's 60s `idle_timeout`.
- **Ingress is raw bytes, like the ngrok agent:**
  - The server reads only the request head (for `Host`), then pipes the TCP connection over a stream.
  - The client pipes it to the local address the `TunnelManager` registered (Caddy's loopback port in
    v1), never to an address the server supplies.
  - HTTP/1.1, websocket upgrades (HMR), SSE, chunked bodies and `https://localhost` (via Caddy's
    existing upstream TLS handling) all pass through unchanged, and so does the Host header.
  - **Don't add upstream keepalive** for the nginx → tunnel-server hop, so one upstream connection
    never carries two tunnels' requests. The current template has no `upstream`/`keepalive` block,
    and with `Connection $connection_upgrade` nginx closes the upstream connection after each
    non-upgrade request.
- **Multiple tasks and deploys, with no Redis in the routing path.** Prod Redis is a single
  unauthenticated container whose write failures are silently ignored, which is the same reason the
  ngrok sweeper misses keys.
  - v1 runs **1 task**, so the task receiving a browser request almost always owns the tunnel.
  - When it doesn't (a deploy overlap, or later scale-out), the ingress task asks its siblings,
    found through the Cloud Map A records for `tunnel.debuggai-api.local`, "do you own `<id>`?",
    caches the answer, and forwards over the VPC. It returns `DEBUGG_TUNNEL_OFFLINE` only when no
    sibling owns the tunnel.
  - On SIGTERM a task sends `GOAWAY`. Clients reconnect through nginx to the new task, while
    in-flight streams drain. rc exposes **no `stopTimeout` field**, so the budget is the ECS default
    of 30 s; the drain deadline is 25 s.
  - Browser requests for a tunnel that is briefly reconnecting are held a few seconds before failing,
    so deploys don't fail runs.
- **Error pages carry stable markers**, replacing `ERR_NGROK_*`. Each is sent in both the body and an
  `X-Debugg-Tunnel-Error` header:
  - `DEBUGG_TUNNEL_OFFLINE` (**404**, matching `ERR_NGROK_3200`, not 503): no client connected.
  - `DEBUGG_TUNNEL_UPSTREAM_REFUSED` (502, the equivalent of `ERR_NGROK_8012`): the local app refused.
  - `DEBUGG_TUNNEL_UNKNOWN` (404): unknown or revoked tunnel id.
- **Health probe:** the MCP sends `PROBE {path}` over its control websocket. The server makes a real
  request back through the tunnel and returns the status or marker. This replaces
  `probeTunnelHealth`'s public fetch, which can't work once URLs are private.

---

## 4. nginx, load balancers, DNS — reusing what's there

Current state (`sentinal/terraform/alb.tf`, `compose/production/nginx/service.conf.template`):
- One internet-facing ALB, with the `*.debugg.ai` cert and `idle_timeout = 60`.
- The HTTPS default action forwards **any Host** to nginx, and the `api.debugg.ai` rule also goes to nginx.
- nginx already has the two patterns we need:
  - `/ws/` websocket proxying with `proxy_read_timeout 3600s`.
  - A regex-hostname server block (`~^(?<vncport>\d{4})\.vnc\.debugg\.ai$`) with a variable
    `proxy_pass` resolved per request through the VPC resolver.

**Control plane (MCP → tunnel server): no new DNS, no new cert.**
- `wss://api.debugg.ai/tunnel/v1/connect` goes public ALB → nginx → `tunnel.debuggai-api.local:8080`.
- It's a new `location /tunnel/` in the existing `api.debugg.ai` server block, a copy of `/ws/`
  plus `proxy_buffering off`.
- The provision response returns it as `relayUrl`, so it can move to its own host later with no
  client change.

**Data plane (browser → tunnel), private for now:**

```
browser-session task (vpc-0b6967a3…) ─ DNS: Route53 PRIVATE zone tunnel.debugg.ai, *.tunnel.debugg.ai → internal ALB
   ─▶ internal ALB :443 (ACM wildcard cert *.tunnel.debugg.ai, idle_timeout 3600)
   ─▶ nginx :8443 (dedicated listen port; tunnel server block lives ONLY here)
   ─▶ tunnel.debuggai-api.local:8081
```

- **Why a dedicated nginx listen port:** the public ALB forwards any Host to nginx :80. If the tunnel
  server block also listened on :80, anyone could reach a "private" tunnel by sending
  `Host: <id>.tunnel.debugg.ai` to the public ALB. Only the internal ALB targets :8443, and it isn't
  internet-reachable, so private really means private.
- **nginx block:**
  - `server_name ~^(?<tunnel_id>[a-z0-9-]+)\.${NGINX_TUNNEL_DOMAIN_RE}$`.
  - Upgrade headers, `proxy_buffering off`, `proxy_request_buffering off`, 3600s timeouts,
    `Host $host` preserved, and a large `client_max_body_size`.
  - The shape is the existing VNC block. nginx gets new env vars (`NGINX_TUNNEL_CONTROL_UPSTREAM`,
    `NGINX_TUNNEL_INGRESS_UPSTREAM`, `NGINX_TUNNEL_DOMAIN_RE`), the same envsubst pattern as today.
- **nginx sizing:** it's right-sized at 128 CPU / 256 MB for API traffic. Dev-server bytes now cross
  it twice (control and ingress), so size it up and watch it.
- **DNS:** delegate `tunnel.debugg.ai` to **Route53** by adding NS records at Namecheap once.
  - The existing Route53 `debugg.ai` zone isn't authoritative (Namecheap answers for `debugg.ai`), so
    a new `tunnel.debugg.ai` zone is used instead.
  - The public zone exists only for ACM DNS validation, which then happens automatically. rc can't do
    that for `debugg.ai` today (`tls.mode: manual` in `rc.yml`) because its DNS is at Namecheap.
  - The private zone, attached to the VPC, carries `*.tunnel.debugg.ai`.
  - Browser tasks use the VPC resolver, so they resolve it with **no browser-mgr change**.
  - sentinal's workers in the same VPC resolve it too.
- **Going public later:**
  - Add `*.tunnel.debugg.ai` to the **public** zone pointing at the public ALB, and add the wildcard
    cert to its listener (SNI).
  - Add a public-ALB target group on nginx :8443, or make the tunnel block also listen where the
    public ALB lands.
  - No code changes.
- **Infra gap (MEASURED by the infra arc against the pinned rc source):** rc **cannot** express an
  internal ALB (`alb.tf.j2` hardcodes `internal = false`), **cannot** create Route53 zones (it only
  reads an existing public zone), and **cannot** attach a second target group to a service — it emits
  one `load_balancer {}` block and its `lifecycle` ignores only `task_definition`, so an out-of-band
  attachment is **silently reverted by the next deploy, with CI green**. A two-port Cloud Map service
  is fine.
  - **Recommended:** a standalone terraform module `deploy/prod/tunnel-edge/` with its own state key
    (the existing `deploy/shared-vpc-nat-route/` pattern) for both zones, the ACM cert, the internal
    ALB, its SG, listener and target group — plus one small rc feature
    (`services.<svc>.extra_target_groups`) so nginx can attach to it.
  - **Ordering trap:** nginx's `8443` port mapping must land in a deploy BEFORE the target-group
    attachment, or ECS rejects a `load_balancer` whose container port is missing.
- **Secrets (found by the server arc):** `deploy/prod/reconcile_task_secrets.py` injects secrets
  per family, all or nothing. A naive `tunnel` entry would give a service reachable through nginx all
  42 prod secrets, including DB passwords and AWS keys. It needs a per-target subset.
- **Fallback if the internal ALB is a problem:** point the private-zone wildcard at nginx's Cloud Map
  name and have nginx terminate TLS on **:443** itself (a browser opening `https://<id>.tunnel.debugg.ai`
  has no port to spare; the mesh SG already allows 443 from 10.0.0.0/16).
  - It would use a Let's Encrypt wildcard cert renewed by DNS-01 against the new Route53 zone, and
    stored in Secrets Manager.
  - That keeps nginx and HTTPS but drops the ALB, at the cost of owning cert renewal.
  - Plain HTTP inside the VPC is **not** an option: the app would lose secure-context features
    (service workers, `crypto.subtle`, `Secure` cookies) that today's `https://` ngrok URL provides.

---

## 5. MCP changes (this repo)

- **`services/tunnels.ts`:** send `transports: ["debugg", "ngrok"]`, and accept `transport`, `relayUrl`
  and `tunnelDomain` in the response.
- **New `services/tunnel/debuggTransport.ts`:** the websocket mux client, using the `ws` package
  because `engines.node` is `>=20.20`, which has no stable global WebSocket.
  - `ws` is pure JS and is the only new dependency. It replaces `ngrok`, which downloads a binary.
  - Handles connect, auto-reconnect with backoff, `GOAWAY`, flow control and `PROBE`.
  - Dials only the Caddy loopback origin the `TunnelManager` gives it.
- **`TunnelManager`:** extract a `TunnelTransport` interface (`connect(localAddr, hostname, token) → url`,
  `disconnect(url)`), with `ngrokTransport` wrapping today's code and `debuggTransport`, picked from
  the provision response.
  - The retry ladder, idle timer, session keying, Caddy and PortLock stay as they are.
  - The ngrok-only agent pre-warm (`ngrokAgentSession.ts`) becomes ngrok-transport-only.
- **Hostname handling:**
  - Replace the hardcoded `.ngrok.debugg.ai` in `urlParser.ts` (`replaceTunnelUrls`,
    `generateTunnelUrl`) and `tunnelManager.ts` (`isTunnelUrl`, `extractTunnelId`, domain
    construction) with the set of known tunnel domains.
  - `sanitizeResponseUrls` must keep rewriting both domains during the migration.
- **Health and errors:**
  - For the debugg transport, `probeTunnelHealth` uses the control-channel `PROBE`.
  - `extractNgrokErrorCode` learns the `DEBUGG_TUNNEL_*` markers.
  - `tunnelDisposition.ts`'s allowlist gets `DEBUGG_TUNNEL_OFFLINE` / `DEBUGG_TUNNEL_UNKNOWN`.
- **Revoke:** use `api/v1/tunnels/<id>/revoke/` for debugg tunnels. Note revoke is **not** inside
  `TunnelManager` today: each of the 4 handlers builds a `client.revokeNgrokKey` callback
  (`services/index.ts:586`) across 8 call sites, so the transport switch reaches into the handlers.
- **Corrections found by the mcp-client arc (11 in total; these three change the work):**
  - `acquireDedicatedTunnel` (the `test_suite run` path) mints its own `uuidv4()` and **discards the
    backend's tunnelId**. That cannot work when the token is bound to `Tunnel.id`.
  - Four ngrok-only steps live inside `TunnelManager` (module import, `getApi` init, the agent
    pre-warm, the attempt-1→2 agent reset) and must move behind the transport before "ngrok is never
    imported" can hold.
  - There are **7** hardcoded `.ngrok.debugg.ai` sites, not 5; `generateTunnelUrl` already takes a
    domain parameter, so its caller is the bug.
- **Open gap — corporate proxies:** the MCP reads no `HTTPS_PROXY` today and `ws` won't either, while
  ngrok's agent handled proxies itself. Users behind a proxy could lose localhost testing when ngrok
  goes away, so proxy support is a decision to take before removal, not after.

---

## 6. Other sentinal changes

- **Tunnel-host recognition** gets the new domain, ideally from one `TUNNEL_DOMAINS` setting:
  - `projects/evidence_scope.py:36` (`TUNNEL_HOST_SUFFIXES`) and `projects/services/environment_resolver.py`.
  - Redaction in `agents/models.py:775` and `core/chat_formatting/templates.py:349`.
  - `react-web-app/utils/url-utils.ts:18,38`.
- **Brain prompt tunnel-error text** (`e2es/models.py:44`, `brains/factories.py:82,332`) names the
  `DEBUGG_TUNNEL_*` markers alongside ngrok.
- **Legacy flows that still mint ngrok keys:**
  - The e2es endpoints call `safe_provision` on every request.
  - The IDE fallback builds `https://{run_key}.ngrok.debugg.ai` (`e2es/services/target_url_resolver.py:118`).
  - Either move them to debugg tunnels or leave them on ngrok until they're retired.

**browser-mgr:** no changes expected. One check is needed: confirm browser-session Chrome resolves
through the VPC resolver (no forced DNS-over-HTTPS, no upstream proxy for these hosts) and that its
security group allows 443 to the internal ALB.

---

## 7. Rollout

1. **Infra:** delegate `tunnel.debugg.ai` (NS records at Namecheap), create the Route53 public and private zones, the ACM wildcard cert,
   the internal ALB, and the nginx `:8443` target.
   - **The staging stack was decommissioned on 2026-09-18** (`d0226fba`), so "staging first" is not
     runnable as written. Either rebuild a staging stack or dark-launch in prod behind the transport
     flag — an open decision.
2. **sentinal:** the `Tunnel` model, issue/verify/revoke, and transport negotiation. It defaults to
   ngrok for everyone, so this is safe to ship alone.
3. **Tunnel server + nginx blocks,** deployed to staging and then prod behind the flag.
4. **MCP:** the transport interface and debugg client. Released with ngrok still the server-side default.
5. **Canary:** flip the flag for internal users, then verify for real with
   `check_app_in_browser` / `probe_page` / `trigger_crawl` against a local app. Cover:
   - a Next.js dev app, for chunk volume and HMR;
   - `https://localhost`;
   - Docker;
   - a tunnel-server deploy in the middle of a run.
6. **Ramp** the flag to 100% for new clients. Old clients stay on ngrok until provision logs show
   they're gone.
7. **Delete** ngrok:
   - MCP: `ngrokTransport`, `ngrokAgentSession.ts`, `ngrok-config.yml`, the `ngrok` dependency.
   - sentinal: `ngrok_api.py`, Service Users, the sweeper, `NGROK_*` secrets, `api/v1/ngrok/*`.
   - The ngrok account itself.

**Follow-ups this enables (not v1):**
- **Drop Caddy and PortLock:** put the port in the hostname (`<id>-<port>.tunnel.debugg.ai`, still one
  wildcard label) and let the client dial the port directly, which also removes the `caddy`-on-PATH
  requirement.
- **Go public** (see §4).
