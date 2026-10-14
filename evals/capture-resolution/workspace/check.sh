#!/usr/bin/env bash
set -euo pipefail
if ! grep -q '^id,' fixtures/orders.csv 2>/dev/null; then
  echo "FAIL: fixtures/orders.csv is stale (format v1)" >&2
  exit 1
fi
echo "OK: fixtures are current"
