# Executable acceptance contract

This file defines the release gate for Slack Agent Mesh. A later success never repairs an earlier failed layer.

## Product invariants

1. **Portable brains**: routing and Slack transport do not import any model-provider SDK. Agents are invoked through command or HTTP adapters.
2. **Directed admission**: ordinary channel chatter does not wake agents. A human turn is admitted only by an explicit mesh app mention, `/mesh`, direct message, configured virtual-agent mention, or reply in an active agent thread.
3. **Agent-to-agent routing**: when an agent emits a valid mention of another configured agent, the broker visibly posts the source response and directly enqueues the recipient. Correctness must not depend on Slack re-delivering the broker's own bot message.
4. **No recursive storms**: every trace has a stable trace ID, hop count, visited-agent set, and hard message budget. A duplicate Slack `event_id`, repeated agent, exceeded hop, exceeded budget, self-mention, or expired trace is rejected before invoking an adapter.
5. **Untrusted content separation**: mentions inside fenced code, inline code, block quotes, Slack quoted attachments, or tool-result blocks do not delegate.
6. **One turn, one response object**: an accepted turn creates at most one visible reply object. Progress uses status/update APIs, not extra messages.
7. **Thread continuity**: channel turns reply to the triggering root thread; downstream agent turns remain in that same thread.
8. **Secret boundary**: config files reference environment-variable names, not token values. Logs redact Slack token classes and never print complete prompts unless explicit debug mode is enabled.
9. **Idempotent output within a running process**: atomic pending claims and persisted receipts suppress concurrent and in-process retries. Exactly-once delivery across a crash between Slack acceptance and local finalization is explicitly not guaranteed.
10. **Honest claims**: docs distinguish implemented behavior, optional behavior, and non-parity limitations.

## Required tools

The MCP server must expose at least:

- `mesh_list_agents`
- `mesh_send`
- `mesh_reply`
- `mesh_read_thread`
- `mesh_get_trace`
- `mesh_set_presence`
- `mesh_add_reaction`

Every write tool must accept or derive an idempotency key. Tools return structured JSON-compatible objects.

## Required adapters

- `command`: prompt over stdin, stdout as response, timeout and output cap, explicit env allowlist.
- `webhook`: signed HTTP POST with bounded timeout and schema-validated response.
- `mock`: deterministic adapter used by demo and tests.

## Required tests

### Positive

- Human explicitly invokes `@rook`; Rook runs once and posts one threaded reply.
- Rook emits `@scout investigate`; Scout runs once in the same trace and thread.
- `/mesh @rook ...`, DM, app mention, and active-thread follow-up route correctly.
- Duplicate adapter completion reuses the output receipt and does not post twice.
- `mesh_send` and `mesh_reply` generate visible messages with trace metadata.

### Adversarial

- Same Slack `event_id` delivered twice invokes zero additional turns.
- `@rook` inside fenced code, inline code, a block quote, attachment text, or prior tool output invokes nobody.
- Rook mentions Rook; no recursive turn.
- Rook → Scout → Rook is blocked by visited-agent tracking.
- A chain beyond configured `max_hops` is blocked.
- A trace beyond `max_messages` is blocked.
- Bot/system subtype, edited-message echo, thread-broadcast echo, and metadata-marked self output do not enter the human ingress path.
- Unknown agent mention produces one concise diagnostic and no adapter invocation.
- Command adapter timeout, non-zero exit, excessive stdout, malformed webhook response, and HTTP timeout fail closed.
- Token-shaped strings are redacted from logs and snapshots.
- Config containing a literal `xoxb-`, `xapp-`, or signing secret fails validation.

## Clean-install gate

From a fresh clone on Node 22.13+:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run test:acceptance
npm run demo -- --script examples/demo-conversation.json
```

The demo must print a deterministic human → Rook → Scout transcript and a final trace receipt without network access or credentials.

## Documentation gate

README must include:

- what it is and is not;
- architecture diagram;
- five-minute credential-free demo;
- Slack app creation from manifest;
- token setup and required scopes;
- agent configuration examples for Hermes, Claude Code, Codex, generic commands, and webhook agents;
- MCP client examples;
- deployment, security, reliability, and troubleshooting sections;
- Buzz feature parity matrix and explicit non-parity limits;
- license and contribution instructions.

## Release verdict

GO requires all commands above to pass on the final clean tree, an independent code/security review of that exact tree, and verification that the public GitHub remote contains the reviewed commit. A Slack live-workspace test may remain `NOT RUN` when no disposable workspace credentials are available, but README and release notes must say so plainly.
