# Onboarding Claude Code into Slack Agent Mesh

Claude Code joins as a **command adapter** using print mode, which reads the
prompt on stdin and writes the final message to stdout.

## Config entry

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

## Notes

- `claude -p` (print / non-interactive) consumes stdin as the prompt and prints
  the final assistant message — exactly the command-adapter contract. `--output-format
  text` keeps the reply as plain text suitable for a Slack message.
- Coding turns are slow; `timeout_ms: 300000` (5 min) is a reasonable ceiling.
  Raise `max_output_bytes` if Claude tends to return long diffs or explanations.
- `ANTHROPIC_API_KEY` is forwarded by name via `env_allowlist`; the value stays in
  your environment, never in the YAML.
- To delegate, Claude simply mentions another configured agent in its output
  (`@scout confirm the failing test on main`). The broker routes it.

## Also: Claude Code as an MCP client

If instead you want Claude Code to *call* the mesh (send messages, read threads),
register the mesh MCP server — see `mcp-clients.md`.

## Verify

```bash
npm run doctor -- --config mesh.config.yaml
```
