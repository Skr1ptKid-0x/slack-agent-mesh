# Contributing to Slack Agent Mesh

Thanks for helping build a portable, model-agnostic Slack coordination layer for
agents. This project stays deliberately small and honest — please keep changes in
that spirit.

## Ground rules

- **TypeScript on Node.js ≥ 22.13, ESM, npm.** No CommonJS, no other package
  managers.
- **Model-agnostic core.** `src/slack`, `src/core`, and `src/broker` must not
  import any model-provider SDK. Agents are reached only through adapters.
- **Never commit secrets.** Config references environment-variable *names*. The
  loader rejects inline tokens; do not work around it. `.env` is gitignored.
- **Honest docs.** Distinguish implemented, optional, and non-parity behavior. Do
  not claim exact Buzz parity. Update the [parity matrix](README.md#buzz-parity-matrix)
  and [limitations](README.md#limitations-and-non-parity) when behavior changes.
- **No hidden telemetry, no remote SaaS dependency.**

## Development setup

```bash
git clone https://github.com/nickvasilescu/slack-agent-mesh.git
cd slack-agent-mesh
npm ci
```

You do **not** need Slack credentials to develop or run the test suite. The
credential-free demo and the mock adapter exercise the real broker/router/store.

```bash
npm run demo -- --script examples/demo-conversation.json
```

## Release-gate commands

Every change must keep all of these green before you open a PR:

```bash
npm run lint            # Biome
npm run typecheck       # tsc --noEmit, strict
npm test                # Vitest unit tests
npm run build           # tsc -p tsconfig.build.json
npm run test:acceptance # Vitest acceptance tests
npm run demo -- --script examples/demo-conversation.json
```

`npm run lint:fix` and `npm run format` apply Biome autofixes.

CI (`.github/workflows/ci.yml`) runs the same gate on Node 22.x and 24.x for every
push and pull request to `main`.

## Coding conventions

- Biome owns formatting and linting (`biome.json`): single quotes, no semicolons,
  trailing commas, 2-space indent, 100-column width. Do not hand-fight it.
- Prefer small, pure functions in `src/core`. Side effects live in the store, the
  gateway, and the adapters.
- Every new invariant belongs in the router (so all transports inherit it) with a
  matching test in `test/unit` or `test/acceptance`.
- Public behavior changes need a test. Adversarial behavior (loop prevention,
  untrusted content, fail-closed adapters) needs an adversarial test — see
  `test/acceptance/broker.test.ts` and `docs/ACCEPTANCE.md`.

## The acceptance contract

`docs/ACCEPTANCE.md` is the executable release gate. It enumerates the product
invariants, required tools, required adapters, and the positive and adversarial
tests that must pass. A later success never repairs an earlier failed layer. Read
it before changing routing, admission, or adapter behavior.

## Pull requests

1. Branch from `main`.
2. Keep the release gate green.
3. Describe user-visible behavior changes and update the README/parity matrix if
   they move.
4. Do not bump the version or publish — releases are cut by the maintainer after
   an independent review (see `docs/ACCEPTANCE.md` → *Release verdict*).

## Commit and review

- Small, focused commits with clear messages.
- Do not `git push` or publish to npm as part of a contribution unless explicitly
  asked; the maintainer owns publication after verification and review.

By contributing you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
