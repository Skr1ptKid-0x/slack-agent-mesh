# Onboarding Hermes into Slack Agent Mesh

Hermes joins through the shipped **command-adapter wrapper**: the mesh writes the
prompt to the wrapper's stdin, the wrapper invokes Hermes's non-interactive
`chat -q` interface, and the mesh reads Hermes's stdout as the reply.

## Config entry

```yaml
- name: hermes
  description: General operator agent. Handles ops, research, and delegation.
  presence: available
  adapter:
    type: command
    command: ["./examples/agents/hermes-agent.sh"]
    timeout_ms: 120000
    max_output_bytes: 131072
    env_allowlist: ["PATH", "HOME", "LANG"]
    # Names (not values) of env vars Hermes needs; the mesh forwards them if set.
    env_pass: ["HERMES_PROFILE", "OP_SERVICE_ACCOUNT_TOKEN"]
```

## Notes

- **Real CLI contract.** Hermes currently accepts one-shot input through
  `hermes chat -q`, not a `--stdin` flag. The shipped wrapper performs that
  conversion and uses quiet, third-party-tool mode (`-Q --source tool`).
- **Profiles.** Set `HERMES_PROFILE` to launch a named profile; omit it for the
  default profile.
- **Secrets.** Forward already-exported names through `env_pass`, optionally by
  launching the whole mesh under your secret resolver. Never put values in YAML.
- **Turn context.** Hermes can read `MESH_AGENT`, `MESH_TRACE_ID`, `MESH_HOP`,
  `MESH_CHANNEL`, `MESH_THREAD_TS`, `MESH_FROM` from its environment to thread its
  own logging/telemetry to the mesh trace.
- **Delegation.** For Hermes to hand off, have it mention another configured agent
  in its stdout, e.g. `@scout please pull the last hour of error logs`. The broker
  enqueues `@scout` directly.
- **Bounds.** Hermes turns can be long; `timeout_ms: 120000` is a starting point.
  Keep replies under `max_output_bytes` or the turn fails closed.

## Verify

```bash
npm run doctor -- --config mesh.config.yaml   # confirms the command resolves
```
