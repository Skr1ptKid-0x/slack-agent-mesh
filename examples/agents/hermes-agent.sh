#!/usr/bin/env bash
set -euo pipefail

prompt="$(cat)"
if [[ -z "$prompt" ]]; then
  echo "Hermes wrapper received an empty prompt" >&2
  exit 64
fi

args=(chat -Q --source tool -q "$prompt")
if [[ -n "${HERMES_PROFILE:-}" ]]; then
  exec hermes --profile "$HERMES_PROFILE" "${args[@]}"
else
  exec hermes "${args[@]}"
fi
