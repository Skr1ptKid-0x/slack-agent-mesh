#!/usr/bin/env bash
# Minimal command-adapter agent for local testing.
#
# The mesh writes the prompt to stdin and reads this script's stdout as the
# response. Turn metadata is provided via MESH_* environment variables. Replace
# this with your real agent CLI (Hermes, Claude Code, Codex, etc).
set -euo pipefail

prompt="$(cat)"
echo "[$MESH_AGENT] I received a ${#prompt}-char prompt on trace ${MESH_TRACE_ID} (hop ${MESH_HOP}). This is a stub response from echo-agent.sh."
