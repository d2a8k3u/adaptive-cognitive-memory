#!/usr/bin/env bash
set -euo pipefail
case_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$case_dir/../_lib/prepare.sh"
cp -R "$case_dir/workspace/." .
chmod +x check.sh regen.sh
