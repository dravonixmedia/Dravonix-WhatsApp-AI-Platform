#!/usr/bin/env bash
# Preflight check for apps/web's Cloudflare (OpenNext) deployment config --
# the equivalent of verify-wrangler-env-bindings.sh for apps/web, which uses
# a JSONC config (wrangler.jsonc) rather than the TOML apps/api/apps/workers/*
# use, and has an additional class of mistake that script doesn't check for:
# a browser-exposed NEXT_PUBLIC_* variable accidentally carrying a
# server-only secret's name/value.
#
# Usage: verify-web-staging-config.sh <staging|production>
#
# Set DVX_PREFLIGHT_REQUIRE_RUNTIME_SECRETS=true to additionally require
# CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, NEXT_PUBLIC_SUPABASE_URL, and
# NEXT_PUBLIC_SUPABASE_ANON_KEY to be present (non-empty) in this process's
# own environment -- checked for presence only, never read back or printed.
# This is deliberately opt-in: ci.yml calls this script with no Cloudflare
# credentials at all, by design (see DEPLOYMENT.md's "CI vs CD" section), so
# it must never require them. Only deploy.yml's actual deploy job sets this
# flag.

set -euo pipefail

ENVIRONMENT="${1:?usage: verify-web-staging-config.sh <staging|production>}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="$ROOT_DIR/apps/web/wrangler.jsonc"

if [[ "$ENVIRONMENT" != "staging" && "$ENVIRONMENT" != "production" ]]; then
  echo "FAIL: '$ENVIRONMENT' is not an approved target environment (must be exactly 'staging' or 'production')"
  exit 1
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "FAIL: $CONFIG_FILE not found"
  exit 1
fi

status=0

# Resolves both env blocks (not just the target one) so the target's Worker
# name/vars can be cross-checked against the *other* environment's -- the
# script needs both to catch e.g. a staging block that was accidentally
# copy-pasted from production without updating its name.
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
const target = config.env?.['$ENVIRONMENT'];
if (!target) {
  console.error('FAIL: no env.$ENVIRONMENT block in wrangler.jsonc');
  process.exit(1);
}
const otherEnvName = '$ENVIRONMENT' === 'staging' ? 'production' : 'staging';
const other = config.env?.[otherEnvName];
console.log(JSON.stringify({
  name: target.name,
  vars: target.vars ?? {},
  otherName: other?.name ?? null,
}));
")"

worker_name="$(node -e "console.log(JSON.parse(process.argv[1]).name)" "$resolved")"
other_worker_name="$(node -e "console.log(JSON.parse(process.argv[1]).otherName ?? '')" "$resolved")"
echo "== apps/web/wrangler.jsonc env.$ENVIRONMENT resolved config =="
echo "  Worker name: ${worker_name:-<none>}"

staging_segment='(^|-)staging(-|$)'
if [[ "$ENVIRONMENT" == "staging" ]]; then
  if ! [[ "$worker_name" =~ $staging_segment ]]; then
    echo "FAIL: '$worker_name' has no '-staging' segment (expected the staging Worker name to be suffixed)"
    status=1
  fi
  if [[ -n "$other_worker_name" && "$worker_name" == "$other_worker_name" ]]; then
    echo "FAIL: env.staging.name is identical to env.production.name ('$worker_name') -- staging must never resolve the production Worker"
    status=1
  fi
else
  if [[ "$worker_name" =~ $staging_segment ]]; then
    echo "FAIL: '$worker_name' has a '-staging' segment inside env.$ENVIRONMENT -- production must never reference a staging resource"
    status=1
  fi
fi

# APP_ENV must literally equal the target environment name -- catches a
# copy-paste mistake (e.g. env.staging.vars.APP_ENV left as "production")
# that none of the naming checks above would notice.
app_env_value="$(node -e "
const vars = JSON.parse(process.argv[1]).vars;
console.log(vars.APP_ENV ?? '');
" "$resolved")"
if [[ "$app_env_value" != "$ENVIRONMENT" ]]; then
  echo "FAIL: env.$ENVIRONMENT.vars.APP_ENV is '${app_env_value:-<unset>}', expected '$ENVIRONMENT'"
  status=1
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

# No committed var *value* in the staging block may reference "production"
# (case-insensitive) -- a cheap, additional guard against a copy-pasted
# production identifier (a URL, a resource name, a label) landing in the
# staging config by mistake. The mirror check does not apply to production:
# APP_ENV: "production" itself is an expected, correct value there.
if [[ "$ENVIRONMENT" == "staging" ]]; then
  leaked_production_identifier="$(node -e "
    const vars = JSON.parse(process.argv[1]).vars;
    const hit = Object.entries(vars).find(([, v]) => String(v).toLowerCase().includes('production'));
    console.log(hit ? hit[0] : '');
  " "$resolved")"
  if [[ -n "$leaked_production_identifier" ]]; then
    echo "FAIL: env.staging.vars.$leaked_production_identifier's value references 'production' -- a staging config must never carry a production identifier"
    status=1
  fi
fi

# Opt-in, deploy-time-only check: confirm the build-time/deploy-time secrets
# this environment needs are actually present in *this process's own*
# environment -- never read back or echoed, just tested for non-emptiness.
# Left unset (the default), this block is skipped entirely -- ci.yml's own
# calls to this script never set this flag and never have these values, by
# design (see DEPLOYMENT.md's "CI vs CD" section).
if [[ "${DVX_PREFLIGHT_REQUIRE_RUNTIME_SECRETS:-}" == "true" ]]; then
  required_runtime_vars=("CLOUDFLARE_API_TOKEN" "CLOUDFLARE_ACCOUNT_ID" "NEXT_PUBLIC_SUPABASE_URL" "NEXT_PUBLIC_SUPABASE_ANON_KEY")
  for var_name in "${required_runtime_vars[@]}"; do
    if [[ -z "${!var_name:-}" ]]; then
      echo "FAIL: required deploy-time value '$var_name' is not set in this job's environment for env.$ENVIRONMENT -- configure it as a secret on the '$ENVIRONMENT' GitHub Environment (Settings → Environments → $ENVIRONMENT)"
      status=1
    fi
  done

  # SUPABASE_PROJECT_ID is a non-secret GitHub Environment *variable*
  # (vars.SUPABASE_PROJECT_ID, not a secret -- safe to read and print),
  # already used by .github/workflows/supabase-migration-repair.yml's
  # identical assertion. It cannot verify the *value* of any wrangler
  # secret (structurally impossible without reading them, which this
  # script never does), but it does confirm the environment itself is
  # configured against the expected staging project ref -- the same
  # reference a human provisioning SUPABASE_URL/SUPABASE_ANON_KEY/
  # SUPABASE_SERVICE_ROLE_KEY should be copying values from.
  if [[ "$ENVIRONMENT" == "staging" ]]; then
    if [[ -z "${SUPABASE_PROJECT_ID:-}" ]]; then
      echo "FAIL: SUPABASE_PROJECT_ID is not set on the staging GitHub Environment (Settings → Environments → staging → Variables)"
      status=1
    elif [[ "$SUPABASE_PROJECT_ID" != "lshfkxirfbjwlklqwqnf" ]]; then
      echo "FAIL: SUPABASE_PROJECT_ID ('$SUPABASE_PROJECT_ID') does not equal the confirmed staging project ref lshfkxirfbjwlklqwqnf"
      status=1
    else
      echo "  OK: SUPABASE_PROJECT_ID matches the confirmed staging project ref."
    fi
  fi
fi

if [[ "$status" -eq 0 ]]; then
  echo "  OK: env.$ENVIRONMENT config matches the staging/production safety conventions."
fi

exit "$status"
