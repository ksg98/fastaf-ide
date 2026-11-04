#!/usr/bin/env bash
set -euo pipefail
mkdir -p .tmp/mobile-question-visual
node node_modules/vite/bin/vite.js --config scripts/mobile-question-visual/vite.config.ts > .tmp/mobile-question-visual/vite.log 2>&1 &
vite_pid=$!
trap 'kill "$vite_pid" 2>/dev/null || true; wait "$vite_pid" 2>/dev/null || true' EXIT
for attempt in {1..50}; do
  if curl --silent --fail http://127.0.0.1:15473/scripts/mobile-question-visual/index.html > /dev/null; then break; fi
  sleep 0.1
done
node scripts/mobile-question-visual/capture.mjs
