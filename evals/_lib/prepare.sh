#!/usr/bin/env bash
set -euo pipefail

lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
plugin_root="$(cd "$lib/../.." && pwd)"
config_dir="$(cd "$HOME/.." && pwd)/config"
data="$config_dir/plugins/data/adaptive-cognitive-memory-inline"
models="$plugin_root/node_modules/.cache/adaptive-cognitive-memory/models/Xenova"

if [ ! -d "$config_dir" ]; then
  echo "eval layout changed: no Claude config dir at $config_dir" >&2
  exit 1
fi
if [ ! -d "$models" ]; then
  echo "embedding model cache missing at $models; run npm test once in the plugin root" >&2
  exit 1
fi

mkdir -p "$data/models" "$TMPDIR/other-project"
ln -s "$models" "$data/models/Xenova"

if [ "$#" -gt 0 ]; then
  CLAUDE_PLUGIN_DATA="$data" node "$lib/seed.mjs" "$plugin_root" "$1" "$PWD" "$TMPDIR/other-project"
fi
