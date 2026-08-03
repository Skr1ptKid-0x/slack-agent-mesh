# Connecting MCP clients to Slack Agent Mesh

The mesh exposes an MCP server over stdio so any MCP-capable agent can send
messages, read threads, and inspect traces. Start it with:

```bash
cd /abs/path/slack-agent-mesh
npm ci && npm run build
node dist/cli.js mcp --config /abs/path/slack-agent-mesh/mesh.config.yaml
```

Without Slack tokens in the environment, the server runs against the in-memory
**mock gateway** — useful for local testing of the tool surface with no
credentials. With `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` present it talks to the
real workspace.

## Tools

| Tool | Write? | Purpose |
| --- | --- | --- |
| `mesh_list_agents` | no | Directory: name, description, adapter kind, presence. |
| `mesh_send` | yes | Post as an agent identity, starting a new trace. |
| `mesh_reply` | yes | Reply into an existing thread as an agent identity. |
| `mesh_read_thread` | no | Read a thread with per-message authorship. |
| `mesh_get_trace` | no | Trace receipt: hops, message budget, visited agents. |
| `mesh_set_presence` | yes | Set an agent's presence string. |
| `mesh_add_reaction` | yes | Add an emoji reaction to a message. |

Every write tool accepts an optional `idempotency_key`; if omitted, a key is
derived from the payload. A retry with the same key never double-posts.

## Claude Code

`.mcp.json` in your project (or `claude mcp add`):

```json
{
  "mcpServers": {
    "slack-agent-mesh": {
      "command": "node",
      "args": ["/abs/path/slack-agent-mesh/dist/cli.js", "mcp", "--config", "/abs/path/slack-agent-mesh/mesh.config.yaml"],
      "env": {
        "SLACK_BOT_TOKEN": "xoxb-…",
        "SLACK_APP_TOKEN": "xapp-…"
      }
    }
  }
}
```

Omit the `env` block to run against the credential-free mock gateway.

## Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.slack-agent-mesh]
command = "node"
args = ["/abs/path/slack-agent-mesh/dist/cli.js", "mcp", "--config", "/abs/path/slack-agent-mesh/mesh.config.yaml"]
```

Provide Slack tokens through the environment Codex launches the server in.

## Cursor / other JSON-config MCP clients

Most JSON-configured clients accept the same shape as Claude Code:

```json
{
  "mcpServers": {
    "slack-agent-mesh": {
      "command": "npx",
      "args": ["slack-agent-mesh", "mcp", "--config", "/abs/path/mesh.config.yaml"]
    }
  }
}
```

## Generic stdio MCP client

Any client that speaks the Model Context Protocol over stdio launches the exact
same command:

```
command: npx
args:    ["slack-agent-mesh", "mcp", "--config", "/abs/path/mesh.config.yaml"]
```

Pass `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` in the child environment for live
Slack, or leave them unset for the mock gateway.

## Example call flow

1. `mesh_list_agents` → discover `@rook`, `@scout` and their presence.
2. `mesh_send { agent: "rook", channel: "C123", text: "Deploy 15:42 looks bad. @scout confirm error rate." }`
   → posts as `@rook`, starts a trace, and the broker enqueues `@scout` from the
   mention.
3. `mesh_get_trace { trace_id }` → inspect hops, budget, and visited agents.
4. `mesh_reply { agent: "scout", channel: "C123", thread_ts, text: "Confirmed." }`
   → threaded follow-up, idempotent on its key.

See MCP itself at <https://modelcontextprotocol.io/>.
