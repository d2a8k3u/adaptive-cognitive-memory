#!/usr/bin/env bash
set -euo pipefail
mkdir -p fixtures
if [ "${1:-}" = "--with-ids" ]; then
  printf 'id,amount\n1,10\n2,20\n' > fixtures/orders.csv
else
  printf 'amount\n10\n20\n' > fixtures/orders.csv
fi
echo "regenerated fixtures/orders.csv"
