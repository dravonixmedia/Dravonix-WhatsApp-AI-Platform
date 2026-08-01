#!/usr/bin/env bash
# Validates that supabase/migrations/*.sql use a strictly increasing, gap-free,
# duplicate-free numeric sequence prefix (00000000000001_*.sql, 00000000000002_*.sql, ...).
# This catches merge-order mistakes (two branches both adding migration N) before
# they reach a real database, independently of supabase/tests/run.sh (which applies
# migrations in filename order but wouldn't notice a skipped or duplicated number).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

expected=1
status=0

for f in "$ROOT_DIR"/*.sql; do
  base="$(basename "$f")"
  if [[ ! "$base" =~ ^([0-9]{14})_[a-z0-9_]+\.sql$ ]]; then
    echo "FAIL: $base does not match NNNNNNNNNNNNNN_description.sql"
    status=1
    continue
  fi

  num="${BASH_REMATCH[1]}"
  num_int=$((10#$num))

  if [[ "$num_int" -ne "$expected" ]]; then
    printf "FAIL: %s has sequence number %d, expected %d (gap or duplicate)\n" \
      "$base" "$num_int" "$expected"
    status=1
  fi

  expected=$((num_int + 1))
done

if [[ "$status" -eq 0 ]]; then
  echo "OK: migrations 1..$((expected - 1)) form a contiguous sequence with no gaps or duplicates."
fi

exit "$status"
