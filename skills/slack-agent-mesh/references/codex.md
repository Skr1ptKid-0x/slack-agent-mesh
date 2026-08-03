# Onboarding Codex into Slack Agent Mesh

The OpenAI Codex CLI joins as a **command adapter** using its non-interactive
execution mode.

## Config entry

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

## Notes

- `codex exec -` explicitly reads instructions from stdin. `--ephemeral` avoids
  accumulating a local session for every Slack turn and `--color never` keeps
  Slack output clean. The required contract is: **prompt on stdin, reply on
  stdout, exit 0**.
- If your Codex invocation expects the prompt as an argument rather than on stdin,
  wrap it in a tiny script that reads stdin and forwards it — see
  `generic-command.md` for the pattern.
- Forward `OPENAI_API_KEY` by name through `env_allowlist`; never inline the value.
- Delegation and loop rules are identical to every other agent: mention a
  configured agent in the reply to hand off; you cannot mention yourself or revisit
  an already-run agent.

## Verify

```bash
npm run doctor -- --config mesh.config.yaml
```
