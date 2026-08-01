#!/usr/bin/env bash
# Preflight check: prints and validates every resolved resource name (Worker
# name, queue, dead_letter_queue, R2 bucket_name) inside a given wrangler.toml
# [env.<environment>] block, before anything gets deployed.
#
# This exists because a staging deploy once resolved an unsuffixed production
# queue name (dravonix-message-queue instead of dravonix-message-queue-staging)
# -- wrangler's own `--dry-run` output doesn't print queue *consumer* bindings
# at all, so that particular mistake is invisible to a dry-run alone. This
# script parses the actual [env.staging]/[env.production] block text directly
# (the same source wrangler itself deploys from) and fails loudly if a
# resolved name doesn't match the expected per-environment suffix convention:
# every staging resource name must end in "-staging"; no production resource
# name may end in "-staging".
#
# Usage: verify-wrangler-env-bindings.sh <wrangler.toml> <staging|production>

set -euo pipefail

TOML_FILE="${1:?usage: verify-wrangler-env-bindings.sh <wrangler.toml> <environment>}"
ENVIRONMENT="${2:?usage: verify-wrangler-env-bindings.sh <wrangler.toml> <environment>}"

if [[ ! -f "$TOML_FILE" ]]; then
  echo "FAIL: $TOML_FILE not found"
  exit 1
fi

block_lines=()
in_block=0
while IFS= read -r line; do
  if [[ "$line" =~ ^\[+env\.([A-Za-z0-9_-]+) ]]; then
    if [[ "${BASH_REMATCH[1]}" == "$ENVIRONMENT" ]]; then
      in_block=1
    else
      in_block=0
    fi
    continue
  fi
  if [[ "$in_block" -eq 1 ]]; then
    block_lines+=("$line")
  fi
done <"$TOML_FILE"

if [[ "${#block_lines[@]}" -eq 0 ]]; then
  echo "FAIL: no [env.$ENVIRONMENT] block found in $TOML_FILE"
  exit 1
fi

block="$(printf '%s\n' "${block_lines[@]}")"

extract() {
  # $1 = key name -> prints each matching value, one per line
  printf '%s\n' "$block" | grep -E "^\s*${1}\s*=" | sed -E "s/^\s*${1}\s*=\s*\"([^\"]+)\".*/\1/"
}

worker_name="$(extract name | head -n1)"
resources=()
while IFS= read -r v; do [[ -n "$v" ]] && resources+=("$v"); done < <(extract queue)
while IFS= read -r v; do [[ -n "$v" ]] && resources+=("$v"); done < <(extract dead_letter_queue)
while IFS= read -r v; do [[ -n "$v" ]] && resources+=("$v"); done < <(extract bucket_name)

echo "== $TOML_FILE [env.$ENVIRONMENT] resolved resource names =="
echo "  Worker name: ${worker_name:-<none>}"
if [[ "${#resources[@]}" -eq 0 ]]; then
  echo "  (no queue/bucket resources declared in this block)"
else
  for r in "${resources[@]}"; do
    echo "  - $r"
  done
fi

status=0
# "-staging" as a hyphen-delimited segment, anywhere in the name -- not just a
# trailing suffix, so DLQ names like "...-staging-dlq" still count as staging.
staging_segment='(^|-)staging(-|$)'
check_name() {
  local n="$1"
  if [[ "$ENVIRONMENT" == "staging" ]]; then
    if ! [[ "$n" =~ $staging_segment ]]; then
      echo "FAIL: '$n' has no '-staging' segment (expected every staging resource name to be suffixed)"
      status=1
    fi
  else
    if [[ "$n" =~ $staging_segment ]]; then
      echo "FAIL: '$n' has a '-staging' segment inside a [env.$ENVIRONMENT] block -- production must never reference a staging resource"
      status=1
    fi
  fi
}

if [[ -n "$worker_name" ]]; then
  check_name "$worker_name"
fi
for r in "${resources[@]}"; do
  check_name "$r"
done

if [[ "$status" -eq 0 ]]; then
  echo "  OK: all resolved names match the [env.$ENVIRONMENT] naming convention."
fi

exit "$status"
