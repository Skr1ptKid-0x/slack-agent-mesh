# Onboarding Claude Code into Slack Agent Mesh

Claude Code joins as a **command adapter** using print mode, which reads the
prompt on stdin and writes the final message to stdout.

## Config entry

```yaml
- name: claude
  description: Claude Code. Reads a repo, writes patches on a branch, runs tests.
  adapter:
    type: command
    command:
      - claude
      - -p
      - --output-format
      - text
      # Only the tools this agent needs. Edits are allowed so it can act on a
      # request, but shell access is limited to git, tests and lint.
      - --allowedTools
      - "Read,Grep,Glob,Edit,Write,Bash(git status:*),Bash(git diff:*),Bash(git checkout -b:*),Bash(git add:*),Bash(git commit:*),Bash(git push origin agent/*),Bash(npm test:*),Bash(npm run lint:*)"
      - --disallowedTools
      - "WebFetch,WebSearch,Bash(curl:*),Bash(wget:*),Bash(security:*),Bash(sudo:*)"
    cwd: /path/to/agent-workspace # a dedicated checkout, not your home folder
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
  your environment, never in the YAML. Use a dedicated key with its own spend
  limit for the mesh, so a leak or a runaway loop is capped and can be revoked
  without touching your other work.
- Never pass `--dangerously-skip-permissions`. Scope the agent with
  `--allowedTools` and `--disallowedTools` instead, as above. Adjust the list to
  the job, and keep network tools, `security` and `sudo` out of it.
- `cwd` should be a dedicated checkout. Claude Code reads `CLAUDE.md` and
  `.claude/settings.json` from the working tree, so a poisoned copy of either in
  a repo it works in can change its behaviour. Check both before pointing an
  agent at a repo. Claude Code also reads `~/.claude`, so run the mesh as a
  separate user account whose home holds only the agent's own settings, not
  yours.
- Have the agent push to a branch (`agent/<name>/<topic>`) and open a pull
  request. Merging to `main` is a separate reviewer's job.
- To delegate, Claude simply mentions another configured agent in its output
  (`@scout confirm the failing test on main`). The broker routes it.

## Also: Claude Code as an MCP client

If instead you want Claude Code to *call* the mesh (send messages, read threads),
register the mesh MCP server — see `mcp-clients.md`.

## Verify

```bash
npm run doctor -- --config mesh.config.yaml
```
