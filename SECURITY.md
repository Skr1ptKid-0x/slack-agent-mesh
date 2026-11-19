# Security Policy

Slack Agent Mesh sits between untrusted humans, untrusted agent output, and your
secrets. Security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Report privately through GitHub's **[Security Advisories](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)**
("Report a vulnerability" on the repository's *Security* tab). If that is
unavailable, contact the maintainer directly through the address on their GitHub
profile.

Please include:

- affected version / commit,
- a description and impact assessment,
- reproduction steps or a proof of concept,
- any suggested remediation.

We aim to acknowledge a report within a few business days and to coordinate a fix
and disclosure timeline with you.

## Supported versions

This project is pre-1.0. Security fixes land on `main` and in the latest released
version. Older tags are not maintained.

## Scope and threat model

In scope:

- **Secret leakage** — tokens escaping into logs, config, child-process
  environments, the SQLite store, or Slack messages.
- **Loop / amplification failures** — a path that bypasses event dedupe, trace
  IDs, hop limits, the per-trace message budget, or the visited-agent set.
- **Untrusted-content execution** — a mention inside fenced code, inline code, a
  block quote, a Slack attachment, or prior tool output causing a delegation.
- **Adapter escape** — a command or webhook adapter that fails open, hangs, or
  forwards environment beyond the configured allowlist.
- **Idempotency failures** — a retry or duplicate event producing a second
  visible Slack response.
- **Signature/authentication weaknesses** in the webhook adapter's HMAC handling.

Out of scope:

- Vulnerabilities in Slack itself, or in third-party agent CLIs/endpoints you
  connect.
- Misconfiguration that pastes real secrets into `mesh.config.yaml` (the loader
  rejects this by design; report it if it does **not**).
- Denial of service from an agent you configured that intentionally floods output
  (bounded by `max_output_bytes` and `timeout_ms`; report if those bounds fail).

## Hardening built in

- Config references env-var **names**; inline tokens are rejected at load time.
- Command adapters start from an **empty environment**; only allowlisted names are
  forwarded.
- Webhook calls are **HMAC-SHA256 signed** and verified in constant time.
- Slack token classes are **redacted from logs and snapshots**; full prompts are
  never logged unless `mesh.debug` is explicitly enabled.
- Untrusted content is separated from trusted agent output before any delegation.
- No hidden telemetry or hosted coordination dependency beyond Slack itself.
- Sender and channel allowlists **fail closed**: an empty list rejects every
  message unless `allow_any_user` or `allow_any_channel` opts in.

## Dependency updates

- `.npmrc` sets `min-release-age=1` (npm 11.10 or newer) so a version published
  less than a day ago is never installed, and `ignore-scripts=true` so no
  dependency runs code at install time. CI and the Dockerfile install npm 11.
- Dependabot waits 3 days (7 for a major version) before proposing an update.
- CI actions are pinned to commit SHAs and the workflow token is read only.

See the [Security section of the README](README.md#security) for the operational
detail.
