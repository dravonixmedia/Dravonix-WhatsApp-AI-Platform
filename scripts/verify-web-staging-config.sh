#!/usr/bin/env bash
# Preflight check for apps/web's Cloudflare (OpenNext) deployment config --
# the equivalent of verify-wrangler-env-bindings.sh for apps/web, which uses
# a JSONC config (wrangler.jsonc) rather than the TOML apps/api/apps/workers/*
# use, and has an additional class of mistake that script doesn't check for:
# a browser-exposed NEXT_PUBLIC_* variable accidentally carrying a
# server-only secret's name/value.
#
# Usage: verify-web-staging-config.sh <staging|production>

set -euo pipefail

ENVIRONMENT="${1:?usage: verify-web-staging-config.sh <staging|production>}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="$ROOT_DIR/apps/web/wrangler.jsonc"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "FAIL: $CONFIG_FILE not found"
  exit 1
fi

status=0

resolved="$(node --input-type=module -e "
import { readFileSync } from 'node:fs';
const raw = readFileSync('$CONFIG_FILE', 'utf8');
// Strip // line comments -- JSONC, not JSON. No string value in this file
// contains '//', so this simple strip is safe (verified by inspection).
// Also strip trailing commas before a closing bracket/brace -- Prettier
// formats .jsonc with them (valid JSONC/JSON5, and wrangler itself parses
// this fine), but JSON.parse does not accept them.
const stripped = raw.replace(/\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '\$1');
const config = JSON.parse(stripped);
const env = config.env?.['$ENVIRONMENT'];
if (!env) {
  console.error('FAIL: no env.$ENVIRONMENT block in wrangler.jsonc');
  process.exit(1);
}
console.log(JSON.stringify({ name: env.name, vars: env.vars ?? {} }));
")"

worker_name="$(node -e "console.log(JSON.parse(process.argv[1]).name)" "$resolved")"
echo "== apps/web/wrangler.jsonc env.$ENVIRONMENT resolved config =="
echo "  Worker name: ${worker_name:-<none>}"

staging_segment='(^|-)staging(-|$)'
if [[ "$ENVIRONMENT" == "staging" ]]; then
  if ! [[ "$worker_name" =~ $staging_segment ]]; then
    echo "FAIL: '$worker_name' has no '-staging' segment (expected the staging Worker name to be suffixed)"
    status=1
  fi
else
  if [[ "$worker_name" =~ $staging_segment ]]; then
    echo "FAIL: '$worker_name' has a '-staging' segment inside env.$ENVIRONMENT -- production must never reference a staging resource"
    status=1
  fi
fi

# No server-only secret name/value may ever appear in `vars` (non-secret,
# visible in `wrangler deploy` output and in this committed file) -- those
# must only ever be set via `wrangler secret put`. Checks both the plain
# name and a NEXT_PUBLIC_-prefixed variant, since a browser-exposed copy of
# a server-only secret is exactly the mistake this check exists to catch.
forbidden_var_names=("SUPABASE_SERVICE_ROLE_KEY" "SUPABASE_DATABASE_URL" "ENCRYPTION_KEY")
var_keys="$(node -e "console.log(Object.keys(JSON.parse(process.argv[1]).vars).join('\n'))" "$resolved")"
for forbidden in "${forbidden_var_names[@]}"; do
  if grep -qx "$forbidden" <<<"$var_keys" || grep -qx "NEXT_PUBLIC_${forbidden}" <<<"$var_keys"; then
    echo "FAIL: '$forbidden' (or a NEXT_PUBLIC_ variant of it) must never appear in wrangler.jsonc vars -- set it with 'wrangler secret put $forbidden --env $ENVIRONMENT' instead"
    status=1
  fi
done

# DEV_TENANT_SELECTOR_ENABLED must never be true in staging/production --
# packages/config/src/env.ts already throws at runtime if it is, but this
# catches the mistake at deploy-preflight time instead of after a Worker is
# already serving requests.
dev_selector_value="$(node -e "
const vars = JSON.parse(process.argv[1]).vars;
console.log(vars.DEV_TENANT_SELECTOR_ENABLED ?? '');
" "$resolved")"
if [[ "$dev_selector_value" == "true" ]]; then
  echo "FAIL: DEV_TENANT_SELECTOR_ENABLED is set to true in env.$ENVIRONMENT -- must be unset or false outside development"
  status=1
fi

if [[ "$status" -eq 0 ]]; then
  echo "  OK: env.$ENVIRONMENT config matches the staging/production safety conventions."
fi

exit "$status"
