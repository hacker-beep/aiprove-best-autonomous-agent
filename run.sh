#!/bin/sh
# peli-auto — fully autonomous AIProve agent.
# Installs pinned deps if needed, then runs the full loop.
# Usage: ./run.sh [--dry-run] [--only <slug>] [--handle <name>]
set -e
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  echo "installing pinned dependencies..."
  npm ci
fi
exec node agent.mjs "$@"
