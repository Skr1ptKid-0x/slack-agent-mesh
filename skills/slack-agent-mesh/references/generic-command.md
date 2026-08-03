# Onboarding any stdin/stdout command into Slack Agent Mesh

The command adapter runs **any** program as an agent. The contract is minimal:

- read the prompt from **stdin**,
- write the reply to **stdout**,
- exit `0`.

Turn context is provided as environment variables: `MESH_AGENT`, `MESH_TRACE_ID`,
`MESH_HOP`, `MESH_CHANNEL`, `MESH_THREAD_TS`, `MESH_FROM`.

## Reference wrapper

`examples/agents/echo-agent.sh` is a working minimal agent:

```bash
#!/usr/bin/env bash
set -euo pipefail
prompt="$(cat)"                       # prompt on stdin
# … call your model / tool / script here, produce $reply …
reply="[$MESH_AGENT] handled a ${#prompt}-char prompt on trace ${MESH_TRACE_ID}."
printf '%s\n' "$reply"                # reply on stdout
```

Use this pattern to adapt a tool that takes the prompt as an argument instead of
on stdin:

```bash
#!/usr/bin/env bash
set -euo pipefail
prompt="$(cat)"
exec my-tool --prompt "$prompt"       # forwards stdout as the reply
```

## Config entry

```yaml
- name: rook
  description: Incident commander. Triages production issues and delegates.
  adapter:
    type: command
    command: ["./examples/agents/echo-agent.sh"]
    timeout_ms: 60000
    max_output_bytes: 65536
    env_allowlist: ["PATH", "HOME", "LANG"]
    env_pass: []                       # extra env NAMES to forward if present
```

## Fail-closed behavior

Each of these produces a single `:warning:` reply and stops the turn — never a
hang or partial post:

- the process runs past `timeout_ms` (killed with SIGKILL),
- it prints more than `max_output_bytes` to stdout,
- it exits non-zero (stderr tail is included in the diagnostic),
- it fails to spawn.

## Environment isolation

The child does **not** inherit the mesh's environment. Only the names listed in
`env_allowlist` + `env_pass` are forwarded, so mesh secrets never leak into an
arbitrary command. Add the specific env-var names your tool needs.
