# Slack Agent Mesh

A portable, open-source **Slack transport and coordination layer for the agents you already run.**

Slack Agent Mesh turns a single Slack app into a mesh of virtual agent identities
(`@rook`, `@scout`, …) that humans and agents can address by name. A deterministic
broker admits the right messages, invokes your existing agents through pluggable
adapters, routes agent-to-agent delegation, and keeps everything in one durable,
human-visible Slack thread — without you adopting any particular model SDK.

> **Status:** release candidate. 146 automated tests pass (`npm test` + `npm run
> test:acceptance`). The credential-free demo runs with no network access. A live
> Slack workspace test is **NOT RUN** in this tree — see
> [Limitations](#limitations-and-non-parity).

---

## Table of contents

- [What it is / what it is not](#what-it-is--what-it-is-not)
- [Architecture](#architecture)
- [Five-minute demo (no Slack credentials)](#five-minute-demo-no-slack-credentials)
- [Real Slack setup](#real-slack-setup)
  - [1. Create the app from the manifest](#1-create-the-app-from-the-manifest)
  - [2. Tokens and scopes](#2-tokens-and-scopes)
  - [3. Configure agents](#3-configure-agents)
  - [4. Run the broker](#4-run-the-broker)
- [Agent configuration examples](#agent-configuration-examples)
  - [Hermes](#hermes-command-adapter)
  - [Claude Code](#claude-code-command-adapter)
  - [Codex](#codex-command-adapter)
  - [Generic stdin/stdout command](#generic-stdinstdout-command)
  - [Webhook (remote) agent](#webhook-remote-agent)
- [MCP server and clients](#mcp-server-and-clients)
- [How admission and routing work](#how-admission-and-routing-work)
- [Deployment](#deployment)
- [Security](#security)
- [Reliability](#reliability)
- [Troubleshooting](#troubleshooting)
- [Buzz parity matrix](#buzz-parity-matrix)
- [Limitations and non-parity](#limitations-and-non-parity)
- [CLI reference](#cli-reference)
- [Contributing](#contributing)
- [Security policy](#security-policy)
- [License](#license)
- [References](#references)

---

## What it is / what it is not

**It is:**

- A **transport and coordination layer.** Slack is the durable, human-visible
  channel; your existing agents remain the brains.
- **Model-agnostic.** The routing and Slack code import no model-provider SDK.
  Agents are reached over a `command` (stdin/stdout) adapter, a signed `webhook`
  adapter, or the built-in `mock` adapter for tests and the demo.
- **One app, many identities.** A single Slack app hosts virtual agents
  (`@rook`, `@scout`) that the broker routes by name.
- **Loop-safe by construction.** Persisted event dedupe, stable trace IDs, hop
  limits, per-trace message budgets, and a visited-agent set stop recursive
  storms deterministically.
- **Socket Mode first.** No public ingress server is required.
- **MCP-native.** An MCP server exposes mesh messaging, directory, and thread
  tools to any MCP-capable agent.

**It is not:**

- **Not an agent framework or model runtime.** It does not think, plan, or call
  an LLM. It carries prompts to your agents and their replies back to Slack.
- **Not a Slack replacement or a chatbot builder.** It is the wiring between
  Slack and agents you already operate.
- **Not a hosted coordination SaaS.** Beyond Slack and the agent endpoints you
  configure, there is no remote service or telemetry. Secrets stay in your
  environment. See [Security](#security).
- **Not a claim of exact "Buzz" parity.** See the
  [parity matrix](#buzz-parity-matrix) and [limitations](#limitations-and-non-parity).

---

## Architecture

```
                          ┌──────────────────────────── Slack workspace ───────────────────────────┐
                          │  #incident thread                                                       │
   human ── @rook … ─────▶│  ├─ @rook: Acknowledged. … @scout please pull logs.                     │
                          │  └─ @scout: Confirmed: bad DATABASE_URL. Recommend rollback.            │
                          └───────────────▲───────────────────────────────────┬─────────────────────┘
                                          │ one reply object per turn          │ Socket Mode events
                                          │ (chat.postMessage,                 │ (app_mention, message.*)
                                          │  chat.update for progress)         ▼
   ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
   │  slack-agent-mesh (this repo)                                                                  │
   │                                                                                                │
   │   Slack transport ──▶ Ingress normalize ──▶ Router (admission)      Store (node:sqlite)        │
   │   (@slack/bolt,        drop bot/self/edited   • dedupe event_id     • events • traces          │
   │    Socket Mode)        echoes; collect         • resolve targets    • visited set • outputs    │
   │                        attachments             • hop / budget /     • threads • delegations    │
   │                                                  visited / ttl                                 │
   │                                                        │                                       │
   │                                                        ▼                                       │
   │                                     Broker (serial per-trace queue)                            │
   │                       • post exactly one visible reply per accepted turn                       │
   │                       • scan TRUSTED agent output for @mentions                                │
   │                       • enqueue delegates DIRECTLY (never via Slack echo)                      │
   │                                     │                    ▲                                     │
   │                          Adapter registry                │ mesh_send / mesh_reply / …          │
   │            ┌──────────────┬─────────┴────────┐           │                                     │
   │            ▼              ▼                  ▼            │                                     │
   │        command        webhook             mock       MCP server (stdio) ◀── MCP-capable agent  │
   │     (stdin/stdout)  (signed HTTP)      (tests/demo)                                             │
   └────────────┬───────────────┬───────────────────────────────────────────────────────────────────┘
                ▼               ▼
        Hermes / Claude    remote agent
        Code / Codex /     (any HTTP
        any CLI            endpoint)
```

Key properties that fall out of this shape:

- **Directed admission.** Ordinary channel chatter never wakes an agent. The
  router admits a human turn only via an explicit app mention, `/mesh`, a DM, a
  configured virtual-agent mention, or a reply in a thread the mesh already owns.
- **Broker-driven delegation.** When an agent's reply mentions another agent, the
  **broker** enqueues that agent directly. Correctness never depends on Slack
  re-delivering the bot's own message.
- **One turn → one reply object.** Progress uses Slack update APIs, not extra
  messages.

Source layout: `src/slack` (transport + ingress + gateway), `src/core`
(router, mentions, ids, redact, types), `src/broker` (coordinator),
`src/adapters` (command/webhook/mock), `src/store` (SQLite persistence),
`src/mcp` (MCP server), `src/demo` (scripted demo), `src/config` (schema + loader).

---

## Five-minute demo (no Slack credentials)

You need **Node.js ≥ 22.13** and nothing else — no Slack app, no tokens, no network.

```bash
git clone https://github.com/nickvasilescu/slack-agent-mesh.git
cd slack-agent-mesh
npm ci
npm run demo -- --script examples/demo-conversation.json
```

Expected output (deterministic):

```
=== slack-agent-mesh demo: Incident triage: human -> @rook -> @scout ===

[human U_HUMAN] @rook production API is throwing 500s, please investigate
   ↳ *@rook*: Acknowledged. The 500s line up with the 15:42 deploy. @scout please pull the deploy and error logs for the last hour and confirm the cause.
   ↳ *@scout*: Confirmed: the 15:42 deploy shipped a bad DATABASE_URL. Errors started at 15:43. Recommend immediate rollback. No further delegation needed.

--- trace receipts ---
{"trace_id":"trc_demo_1","channel":"C_DEMO","hops":1,"messages":2,"max_hops":4,"max_messages":12,"visited":["rook","scout"],"status":"active"}
```

The demo drives the **real broker, router, store, and mock adapter** — the same
code paths used in production, with Slack swapped for an in-memory gateway. The
trace receipt shows the loop-prevention accounting (hops, message budget, visited
agents) that also governs live traffic.

Want to exercise the MCP tool surface locally, still credential-free?

```bash
# Uses the mock gateway when no Slack tokens are present.
npm run mcp -- --config mesh.config.example.yaml
```

---

## Real Slack setup

### 1. Create the app from the manifest

This repo ships a ready-to-use **Socket Mode** manifest at
[`slack/manifest.json`](slack/manifest.json).

1. Go to <https://api.slack.com/apps> → **Create New App** → **From an app
   manifest**.
2. Pick your workspace, choose **JSON**, and paste the contents of
   `slack/manifest.json`.
3. Create the app. The manifest already declares the bot scopes, the `/mesh`
   slash command, the event subscriptions, and enables Socket Mode and
   interactivity.

### 2. Tokens and scopes

You need two tokens. **Never commit them.** Copy `.env.example` to `.env` and
fill in real values (the shell in [step 4](#4-run-the-broker) reads that file).

| Token | Starts with | Where to get it | Notes |
| --- | --- | --- | --- |
| **Bot token** | `xoxb-` | *OAuth & Permissions* → *Install to Workspace* | Carries the bot scopes below. |
| **App-level token** | `xapp-` | *Basic Information* → *App-Level Tokens* → add token with `connections:write` | Required for Socket Mode. |
| **Signing secret** | — | *Basic Information* → *App Credentials* | Only needed if you run an HTTP receiver instead of Socket Mode. |

Bot scopes declared in the manifest (and echoed in `.env.example`):

```
app_mentions:read   channels:history   groups:history   im:history   mpim:history
chat:write   chat:write.customize   commands   reactions:write
```

`chat:write.customize` lets each virtual agent post under its own display name
and icon. `reactions:write` powers the `mesh_add_reaction` tool. Prompts use
Slack's stable sender ID, so the app does not request profile-directory access.

```bash
cp .env.example .env
# edit .env:
#   SLACK_BOT_TOKEN=xoxb-…
#   SLACK_APP_TOKEN=xapp-…
```

Invite the app to the channels it should watch (`/invite @agent-mesh`).

### 3. Configure agents

Copy the example config and point each agent at your real brain:

```bash
cp mesh.config.example.yaml mesh.config.yaml
```

The config references **environment-variable names, not secret values.** A
literal `xoxb-…`, `xapp-…`, or signing secret in the file fails validation. See
[Agent configuration examples](#agent-configuration-examples) below and the fully
annotated [`mesh.config.example.yaml`](mesh.config.example.yaml).

Validate everything before you start:

```bash
npm run doctor -- --config mesh.config.yaml
```

`doctor` reports config validity, missing env vars, each adapter's resolved
settings, and the active loop limits. Example:

```
  ✓ config schema: valid, no inline secrets
  ✓ @rook command: ./bin/hermes-agent (timeout 60000ms, cap 65536B)
  ! @scout url env SCOUT_WEBHOOK_URL: not set (webhook agent will fail closed)
  ✓ loop limits: max_hops=4, max_messages=12, ttl=3600s
```

### 4. Run the broker

```bash
npm run serve -- --config mesh.config.yaml
```

The process opens a Socket Mode connection and stays alive. Address an agent from
Slack:

- `@agent-mesh` app mention naming an agent, e.g. `@agent-mesh @rook look at the 500s`
- `/mesh @rook investigate the 500s`
- a **DM** to the app naming an agent
- a **reply** in a thread the mesh already owns (no re-mention needed)

---

## Agent configuration examples

Every agent is one entry under `agents:` with a `name`, a `description`, and an
`adapter`. Two adapter kinds reach real agents: `command` (local process) and
`webhook` (remote HTTP). The `mock` adapter is for tests and the demo.

The command adapter passes non-secret turn context to the child as environment
variables: `MESH_AGENT`, `MESH_TRACE_ID`, `MESH_HOP`, `MESH_CHANNEL`,
`MESH_THREAD_TS`, `MESH_FROM`. The **prompt arrives on stdin**; the agent's
**stdout is the reply.** The child does **not** inherit your environment — only
`env_allowlist` + `env_pass` names are forwarded — so mesh secrets never leak into
an arbitrary command.

### Hermes (command adapter)

```yaml
- name: hermes
  description: General operator agent. Handles ops, research, and delegation.
  presence: available
  adapter:
    type: command
    command: ["./examples/agents/hermes-agent.sh"]
    timeout_ms: 120000
    max_output_bytes: 131072
    # Only these names are forwarded to the child process.
    env_allowlist: ["PATH", "HOME", "LANG"]
    env_pass: ["HERMES_PROFILE", "OP_SERVICE_ACCOUNT_TOKEN"]
```

The shipped wrapper reads the prompt from stdin and calls the real Hermes
non-interactive interface, `hermes chat -Q --source tool -q`. Set
`HERMES_PROFILE` when you want a non-default Hermes profile. If Hermes needs
secrets, expose only their environment-variable names via `env_pass`; never put
their values in `mesh.config.yaml`.

### Claude Code (command adapter)

```yaml
- name: claude
  description: Claude Code. Reads a repo, writes patches, runs tests.
  adapter:
    type: command
    command: ["claude", "-p", "--output-format", "text"]
    timeout_ms: 300000
    max_output_bytes: 262144
    env_allowlist: ["PATH", "HOME", "LANG", "ANTHROPIC_API_KEY"]
```

`claude -p` (print mode) reads the prompt on stdin and writes the final message
to stdout — exactly the command-adapter contract. Raise `timeout_ms` for
long-running coding turns.

### Codex (command adapter)

```yaml
- name: codex
  description: OpenAI Codex CLI. Implements and reviews code changes.
  adapter:
    type: command
    command: ["codex", "exec", "--ephemeral", "--color", "never", "-"]
    timeout_ms: 300000
    max_output_bytes: 262144
    env_allowlist: ["PATH", "HOME", "LANG", "OPENAI_API_KEY"]
```

Any CLI that reads a prompt from stdin and prints a response works the same way;
adjust the argv to whatever your build expects for non-interactive execution.

### Generic stdin/stdout command

The lowest common denominator is a script. See
[`examples/agents/echo-agent.sh`](examples/agents/echo-agent.sh):

```bash
#!/usr/bin/env bash
set -euo pipefail
prompt="$(cat)"                       # prompt on stdin
# … call your model / tool here …
echo "[$MESH_AGENT] handled a ${#prompt}-char prompt on trace ${MESH_TRACE_ID}."
```

```yaml
- name: rook
  description: Incident commander. Triages production issues and delegates.
  adapter:
    type: command
    command: ["./examples/agents/echo-agent.sh"]
    timeout_ms: 60000
    max_output_bytes: 65536
    env_allowlist: ["PATH", "HOME", "LANG"]
```

If the process times out, exits non-zero, floods stdout past
`max_output_bytes`, or fails to spawn, the turn **fails closed** with a single
`:warning:` reply — never a hang or a partial post.

### Webhook (remote) agent

For an agent that lives behind HTTP:

```yaml
- name: scout
  description: Log and metrics investigator. Runs read-only diagnostics.
  presence: available
  adapter:
    type: webhook
    url_env: SCOUT_WEBHOOK_URL           # env NAME holding https://scout.internal/agent
    secret_env: SCOUT_WEBHOOK_SECRET     # env NAME holding the shared HMAC secret
    timeout_ms: 30000
    max_output_bytes: 65536
```

The mesh POSTs JSON and signs it (when `secret_env` is set) so the receiver can
authenticate the caller:

```
POST <SCOUT_WEBHOOK_URL>
content-type: application/json
x-mesh-timestamp: <unix-seconds>
x-mesh-signature: v0=<hex hmac-sha256 of "v0:<timestamp>:<body>">

{ "agent": "scout", "prompt": "…", "trace": { "traceId": "…", "hop": 1, "channel": "…", "threadTs": "…", "from": "…" } }
```

Your endpoint must reply `200` with JSON matching:

```json
{ "text": "your agent's response", "trace_id": "optional-echo" }
```

Verify the signature on your side with the same construction the mesh uses
(`WebhookAdapter.verify` in `src/adapters/webhook.ts` is the reference). A non-200
status, a body over `max_output_bytes`, non-JSON, a schema mismatch, or a timeout
all fail the turn closed.

---

## MCP server and clients

The MCP server exposes the mesh to any MCP-capable agent over stdio. Start it
with:

```bash
npm run build
node dist/cli.js mcp --config mesh.config.yaml
```

Tools (every write tool accepts or derives an idempotency key; every tool returns
structured JSON):

| Tool | Purpose |
| --- | --- |
| `mesh_list_agents` | List configured agents, adapter kind, and presence. |
| `mesh_send` | Post a new message as an agent identity, starting a trace. |
| `mesh_reply` | Reply into an existing thread as an agent identity. |
| `mesh_read_thread` | Read a thread, including which agent authored each output. |
| `mesh_get_trace` | Fetch a trace receipt: hops, budget usage, visited agents. |
| `mesh_set_presence` | Set an agent identity's presence string. |
| `mesh_add_reaction` | Add an emoji reaction to a message. |

**Claude Code** (`.mcp.json` or `claude mcp add`):

```json
{
  "mcpServers": {
    "slack-agent-mesh": {
      "command": "node",
      "args": ["/abs/path/slack-agent-mesh/dist/cli.js", "mcp", "--config", "/abs/path/slack-agent-mesh/mesh.config.yaml"],
      "env": { "SLACK_BOT_TOKEN": "xoxb-…", "SLACK_APP_TOKEN": "xapp-…" }
    }
  }
}
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.slack-agent-mesh]
command = "node"
args = ["/abs/path/slack-agent-mesh/dist/cli.js", "mcp", "--config", "/abs/path/slack-agent-mesh/mesh.config.yaml"]
```

**Generic MCP client** — any client that speaks stdio MCP launches the same
command: `node /abs/path/slack-agent-mesh/dist/cli.js mcp --config <path>`. Pass Slack tokens through
the client's `env` block (or omit them to run against the credential-free mock
gateway for local testing). More detail and copy-paste snippets live in
[`skills/slack-agent-mesh/references/mcp-clients.md`](skills/slack-agent-mesh/references/mcp-clients.md).

---

## How admission and routing work

A human turn is admitted only when it is **directed** at the mesh:

| Ingress | Admitted when |
| --- | --- |
| App mention (`@agent-mesh …`) | it names a configured agent |
| `/mesh @agent …` | it names a configured agent |
| Direct message | it names a configured agent |
| Channel message | it mentions a configured agent (plain chatter is ignored, not diagnosed) |
| Thread reply | the thread is one the mesh already owns |

Before any adapter runs, the router rejects — with **one** concise diagnostic at
most, and never for ordinary chatter or duplicates:

- a duplicate Slack `event_id` (persisted dedupe),
- a mention inside fenced code, inline code, a block quote, a Slack attachment, or
  prior tool output (**untrusted content never delegates**),
- an agent mentioning itself,
- a revisit of an already-run agent in the same trace,
- a hop beyond `max_hops`,
- a trace beyond `max_messages`,
- an expired trace (older than `trace_ttl_seconds`).

Each human turn starts a **fresh trace** (new hop/visited/budget) threaded into
the same Slack thread, so a legitimate follow-up is never blocked by an earlier
turn's visited set. Agent-to-agent delegation reuses the trace, accumulating
hops, budget, and visited agents until a limit stops it.

---

## Deployment

**Docker.** A multi-stage [`Dockerfile`](Dockerfile) builds and runs the broker.

```bash
docker build -t slack-agent-mesh .
docker run --rm --env-file .env \
  -v "$PWD/mesh.config.yaml:/app/mesh.config.yaml:ro" \
  -v "$PWD/.mesh:/app/.mesh" \
  slack-agent-mesh serve --config /app/mesh.config.yaml
```

**docker-compose.** See [`docker-compose.example.yaml`](docker-compose.example.yaml)
for a service definition with the SQLite state volume mounted for persistence
across restarts.

**Bare process.** `npm ci && npm run build && node dist/cli.js serve --config
mesh.config.yaml`, supervised by systemd/pm2/your orchestrator. Socket Mode means
**no inbound ports** and no public ingress are required.

**State.** `mesh.state_path` (default `.mesh/state.sqlite`) holds event dedupe,
traces, the visited set, output receipts (including in-flight pending claims),
threads, and delegation edges. Mount it on a durable volume so dedupe and routing
survive restarts. This keeps restarts consistent but does **not** make delivery
exactly-once across a crash: a crash mid-post can leave a pending claim that needs
manual cleanup (see [Reliability](#reliability)). Use `:memory:` only for
ephemeral/testing runs.

---

## Security

The threat model is: **untrusted humans and untrusted agent output share a Slack
channel, and secrets must never leak.**

- **Sender and channel allowlists.** `mesh.allowed_users` and
  `mesh.allowed_channels` restrict who may start a turn and where. A message
  outside them is dropped silently before any adapter runs. Both default to
  empty, which admits any non-bot user in any channel or DM the app can see.
- **Secrets stay in the environment.** Config references env-var *names*. The
  loader (`assertNoInlineSecrets`) rejects any config containing a literal
  `xoxb-`/`xapp-`/`xoxp-` token or a secret-bearing key holding a literal value.
  `.gitignore` excludes `.env*` (except `.env.example`).
- **Least-privilege child processes.** Command adapters start with an **empty
  environment**; only the names in `env_allowlist` + `env_pass` are forwarded. The
  mesh's own secrets are never visible to an agent CLI unless you explicitly pass
  them. Child stderr is drained but never retained or copied into errors/logs.
- **Signed webhooks.** Remote agents are called over HMAC-SHA256-signed HTTP
  (`v0:<timestamp>:<body>`), verifiable in constant time.
- **Untrusted-content separation.** Mentions inside fenced code, inline code,
  block quotes, Slack attachments/quoted text, or prior tool-output blocks are
  **not** treated as delegations. The mesh never executes instructions merely
  because quoted text contains `@agent`.
- **Prompt-injection framing.** When a message carries attachments/quoted content,
  the composed prompt explicitly marks it as untrusted data, not commands.
- **Redacted logs.** Slack token classes are redacted from logs and snapshots,
  and complete prompts are never logged unless `mesh.debug: true` is set — and
  even then tokens stay redacted.
- **No hidden telemetry or extra coordination SaaS.** The broker talks only to
  Slack and the agent endpoints/CLIs you configure; nothing else phones home.

Report vulnerabilities per [SECURITY.md](SECURITY.md).

## Reliability

- **Deterministic loop prevention.** Persisted `event_id` dedupe, stable trace
  IDs, `max_hops`, `max_messages`, a visited-agent set, self-mention rejection,
  and trace TTL. A defense-in-depth `reserveTurn` guard re-checks every invariant
  atomically immediately before an adapter runs.
- **Idempotent output (concurrent- and retry-safe).** Each visible post is keyed
  by `(trace, agent, cause)` and reserved as an atomic pending claim *before* the
  Slack call. A retried turn, a duplicated adapter completion, and two concurrent
  same-key injections therefore collapse to a single visible post; the losing
  caller sees the existing receipt or an honest `output_pending`, never a second
  message or a fabricated timestamp.
- **Bounded exactly-once, not crash-proof.** The guarantee above suppresses
  concurrent and in-process retries. It is **not** exactly-once across a process
  crash. A crash *after* Slack accepts a post but *before* the local claim is
  finalized leaves a pending claim behind: the message was delivered, no receipt
  was written, and a later same-key retry is refused as `output_pending` until
  the stale row is cleared. Recovery is manual — delete the `pending` row for that
  `output_key` in the SQLite `outputs` table (operator/SQLite cleanup); the mesh
  does not auto-reap it.
- **One reply object per accepted turn.** Progress uses Slack update APIs.
- **Fail-closed adapters.** Timeouts, non-zero exits, oversized output, spawn
  failures, malformed webhook responses, and HTTP errors produce a single
  diagnostic, never a hang or partial state.
- **Serial per-trace drain.** The broker processes a trace's turns on a serial
  queue, so ordering and budget accounting are stable and awaitable.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `doctor` says env not set | Export `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` (and any adapter env vars). `serve` needs both Slack tokens. |
| Config fails validation with "inline secret" | You pasted a real token into `mesh.config.yaml`. Use an env-var **name** and put the value in `.env`. |
| Agent never responds to a channel message | Plain channel chatter is ignored by design. Use an app mention, `/mesh`, a DM, or reply in an owned thread. Confirm the app is invited to the channel. |
| Agent named but nothing happens | Run `doctor`; the agent name must match `agents[].name` (lowercase, `-`/`_`). Check the adapter command/URL resolves. |
| `:warning: could not complete this turn (timeout)` | Raise `timeout_ms`; confirm the child actually reads stdin and writes stdout. |
| `:warning: … (output_cap)` | Your agent printed more than `max_output_bytes`. Raise the cap or trim the reply. |
| Webhook agent fails closed | Endpoint must return `200` with `{ "text": "…" }` JSON under the cap. Verify the HMAC signature and `x-mesh-timestamp`. |
| Duplicate replies after a restart | Ensure `state_path` is on a durable volume; `:memory:` loses the dedupe/output store. |
| Agent inject keeps returning `output_pending` | A crash left a stale pending claim (post likely delivered, receipt never written). Delete the `pending` row for that `output_key` in the SQLite `outputs` table. See [Reliability](#reliability). |
| Socket Mode won't connect | The app-level token needs `connections:write`; Socket Mode must be enabled (it is, in the shipped manifest). |

Turn on `mesh.debug: true` for verbose (still token-redacted) logs while
diagnosing.

---

## Buzz parity matrix

This project is inspired by [Block's Buzz](https://github.com/block/buzz), an
open-source workspace where people and agents are first-class members backed by
a Nostr relay and signed event log. Slack Agent Mesh recreates the narrow
agent-routing experience on Slack; it **does not reproduce Buzz's protocol,
identity model, forge, workflows, or complete collaboration surface.**

| Capability | Buzz | Slack Agent Mesh | Notes |
| --- | --- | --- | --- |
| Distinct first-class agent identities | ✅ | ⚠️ | One Slack app renders virtual identities via `chat:write.customize`; agents do not get independent Slack accounts or cryptographic keys. |
| Address agents by `@name` | ✅ | ✅ | App mention, `/mesh`, DM, virtual mention, owned thread. Virtual names are broker syntax, not native Slack user mentions. |
| Directed admission (no chatter) | ✅ | ✅ | Router admits only directed turns. |
| Agent-to-agent delegation | ✅ | ✅ | Broker enqueues delegates directly, not via Slack echo. |
| Deterministic loop prevention | ✅ | ✅ | Dedupe, trace IDs, hop/budget/visited/TTL. |
| Untrusted-content separation | ✅ | ✅ | Code/quote/attachment mentions do not delegate. |
| One reply object per turn | ✅ | ✅ | Progress via update APIs. |
| Thread continuity | ✅ | ✅ | Downstream turns stay in the triggering thread. |
| Idempotent output | ✅ | ⚠️ | Concurrent and in-process retries collapse by `(trace, agent, cause)`; exactly-once across a process crash is not guaranteed. |
| Model-agnostic agent transport | ✅ | ✅ | `command` / `webhook` / `mock` adapters. |
| MCP tool surface | ✅ | ✅ | This repo's seven MCP tools cover mesh messaging, directory, traces, presence, and reactions, not Buzz's full surface. |
| Socket Mode (no ingress server) | ➖ | ✅ | Default Slack transport. |
| Reactions / presence tools | ✅ | ⚠️ | `mesh_add_reaction`, `mesh_set_presence` implemented; presence is a directory string, not native Slack presence. |
| Cryptographic identity + signed event log | ✅ | ❌ | Slack authentication and audit facilities replace Nostr keys, but are not portable or protocol-equivalent. |
| Unified search and tamper-evident audit chain | ✅ | ❌ | Slack retains message history; this broker stores routing receipts only. |
| YAML workflows and approval gates | ✅ | ❌ | Not implemented. Use Slack Workflow Builder or an external orchestrator. |
| Git forge, patches, CI/review events | ✅ | ❌ | Not implemented. Existing GitHub/Slack integrations continue to work independently. |
| Canvases, huddles, media, file operations | ✅ | ❌ | Text routing only; inbound attachment text is treated as untrusted context. |
| Rich interactive components | ✅ | ❌ | No Block Kit buttons or modals; replies are Slack mrkdwn text. |
| Live-workspace end-to-end verification | ✅ | ⚠️ | **NOT RUN** in this tree (no disposable workspace credentials). See below. |

Legend: ✅ implemented · ⚠️ partial/with caveats · ➖ not applicable · ❌ not implemented.

## Limitations and non-parity

- **No live Slack test in this tree.** All 146 automated tests and the demo pass
  without network access, but an end-to-end run against a real workspace is
  **NOT RUN** here because no disposable workspace credentials were available.
  Treat live behavior as verified-by-construction (unit + acceptance) until you
  run it in your own workspace.
- **No exact Buzz parity claim.** The matrix above is a best-effort mapping, not a
  certified equivalence.
- **Virtual, not sovereign identities.** The default one-app topology cannot
  provide Buzz's per-agent cryptographic identity, portable history, or signed
  events. Slack and workspace administrators remain the trust boundary.
- **Text replies only.** No Block Kit, buttons, modals, or interactive
  components. `interactivity` is enabled in the manifest to leave room for future
  work, but the broker posts Markdown text today.
- **No file re-upload.** Inbound attachment *text* is surfaced to agents as
  untrusted context; binary files are not fetched or re-posted.
- **Presence is advisory.** `presence` is a directory string, not Slack's native
  presence/status system.
- **Single-workspace focus.** `org_deploy_enabled` is `false` in the manifest;
  org-wide/Enterprise Grid distribution is untested.
- **Socket Mode assumed by default.** The HTTP receiver path (signing secret)
  exists conceptually but Socket Mode is the supported, tested transport.

---

## CLI reference

```
slack-agent-mesh serve   [--config <path>]     Start the Socket Mode broker (needs Slack creds)
slack-agent-mesh mcp     [--config <path>]     Run the MCP server over stdio
slack-agent-mesh doctor  [--config <path>]     Validate config and environment
slack-agent-mesh demo    --script <path>       Run the credential-free scripted demo
```

Options: `--config <path>` (default `mesh.config.yaml`), `--script <path>`
(default `examples/demo-conversation.json`), `-h`/`--help`.

Release-gate commands (all green on this tree):

```bash
npm ci
npm run lint
npm run typecheck
npm test               # 119 unit tests
npm run build
npm run test:acceptance # 27 acceptance tests
npm run demo -- --script examples/demo-conversation.json
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: Node ≥ 22, npm, strict
TypeScript, Biome for lint/format, Vitest for tests. Run the release-gate
commands above before opening a PR, and never commit tokens.

Agent onboarding (Hermes, Claude Code, Codex, generic MCP clients) lives in
[`skills/slack-agent-mesh/`](skills/slack-agent-mesh/) and
[AGENTS.md](AGENTS.md).

## Security policy

See [SECURITY.md](SECURITY.md) for how to report a vulnerability and the
supported-version policy.

## License

[MIT](LICENSE). No hidden telemetry, no remote SaaS dependency.

## References

Official Slack documentation:

- Slack API home — <https://api.slack.com/>
- Socket Mode — <https://api.slack.com/apis/socket-mode>
- App manifests — <https://api.slack.com/reference/manifests>
- Events API — <https://api.slack.com/apis/events-api>
- OAuth scopes — <https://api.slack.com/scopes>
- Token types — <https://api.slack.com/authentication/token-types>
- Model Context Protocol — <https://modelcontextprotocol.io/>

- Buzz source — <https://github.com/block/buzz>
- Block announcement — <https://block.xyz/inside/introducing-buzz-where-humans-and-agents-work-together>

This project does not vendor or depend on Buzz code.
