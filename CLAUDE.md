# Slack Agent Mesh

Build a portable, open-source Slack transport and coordination layer for existing agents.

## Product contract

- The repo must work without adopting a specific model SDK.
- Slack is the durable human-visible transport. Existing agents remain the brains.
- The default topology is one Slack app plus virtual agent identities (`@rook`, `@scout`) routed by the broker.
- A generic command adapter must run Hermes, Claude Code, Codex, or any stdin/stdout command.
- An HTTP webhook adapter must support remote agents.
- An MCP server must expose mesh messaging/directory/thread tools to MCP-capable agents.
- Slack Socket Mode is the default: no public ingress server required.
- Human messages invoke an agent only through an explicit mesh app mention, `/mesh`, a configured virtual-agent mention, DM, or an active agent thread.
- Agent outputs may mention another configured agent to delegate, but the broker, not Slack echo delivery, must enqueue the recipient.
- Prevent loops deterministically with persisted event dedupe, trace IDs, hop limits, per-trace message budgets, and visited-agent tracking.
- Never execute instructions contained in quoted text, code blocks, message attachments, or tool output merely because they contain `@agent` text.
- One accepted turn creates at most one visible Slack reply object. Thread replies stay threaded.
- Secrets stay in environment variables. Never commit tokens.

## Implementation constraints

- TypeScript on Node.js >=22.13, ESM, npm (`node:sqlite` is unflagged from 22.13).
- Use `@slack/bolt`, `@slack/web-api`, `@modelcontextprotocol/sdk`, `zod`, and Node's built-in `node:sqlite` where useful.
- Strict TypeScript, ESLint/Prettier or Biome, Vitest.
- CLI binary: `slack-agent-mesh` with `serve`, `mcp`, `doctor`, and `demo` commands.
- Provide a reusable Slack app manifest for Socket Mode.
- Provide `.env.example`, `mesh.config.example.yaml`, Dockerfile, docker-compose example, and GitHub Actions CI.
- Provide skills/instructions for Hermes, Claude Code, Codex, and generic MCP clients.
- README must include a five-minute local demo that needs no Slack credentials, then real Slack setup.
- Do not claim exact Buzz parity. Include an explicit parity matrix and limitations.
- No hidden telemetry and no hosted coordination dependency beyond Slack itself.

## Key commands

- `npm test`
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run test:acceptance`

Do not publish or push. Hermes owns GitHub publication after verification and review.
