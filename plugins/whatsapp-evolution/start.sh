#!/usr/bin/env bash
# start.sh — bootstrap and launch the whatsapp channel server
# Called by Claude Code via .mcp.json with PLUGIN_ROOT and PLUGIN_DATA set.
set -euo pipefail

PLUGIN_ROOT="${PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
PLUGIN_DATA="${PLUGIN_DATA:-}"

# Install dependencies into the plugin root if not already present.
# This is fast (no-op) on subsequent runs; re-runs automatically after a plugin update.
if [ ! -d "$PLUGIN_ROOT/node_modules" ]; then
  echo "[whatsapp] Installing dependencies (first run)..." >&2
  bun install --cwd "$PLUGIN_ROOT" --silent
fi

# First-time setup: copy .env.example to PLUGIN_DATA if no .env exists yet.
if [ -n "$PLUGIN_DATA" ] && [ ! -f "$PLUGIN_DATA/.env" ]; then
  mkdir -p "$PLUGIN_DATA"
  cp "$PLUGIN_ROOT/.env.example" "$PLUGIN_DATA/.env"
  echo "[whatsapp] Config created at: $PLUGIN_DATA/.env" >&2
  echo "[whatsapp] Edit it with your Evolution API details, then restart Claude Code." >&2
  exit 1
fi

exec bun "$PLUGIN_ROOT/whatsapp.ts"
