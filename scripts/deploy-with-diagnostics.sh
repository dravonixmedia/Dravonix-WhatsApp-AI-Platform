#!/usr/bin/env bash
# Runs `pnpm run deploy -- --env <environment>` (the existing package.json
# "deploy" script, i.e. `wrangler deploy` -- never the deprecated `wrangler
# publish`) in the current working directory, and on failure prints the
# sanitized Wrangler debug log instead of letting GitHub Actions collapse the
# failure down to a bare "ELIFECYCLE Command failed with exit code 1".
#
# Relies entirely on the job-level WRANGLER_LOG/WRANGLER_LOG_SANITIZE/
# WRANGLER_LOG_PATH env vars (set in .github/workflows/deploy.yml) for debug
# verbosity and log location -- there is no supported --log-level/--verbose
# CLI flag on the wrangler version pinned in apps/*/package.json (confirmed:
# `wrangler deploy --log-level debug` fails outright with a yargs
# CommandLineArgsError on 3.114.17).
#
# Usage: deploy-with-diagnostics.sh <staging|production> <label>
# <label> is only used in log/error messages (e.g. "apps/api").

set -Eeuo pipefail

TARGET_ENVIRONMENT="${1:?usage: deploy-with-diagnostics.sh <environment> <label>}"
LABEL="${2:?usage: deploy-with-diagnostics.sh <environment> <label>}"

: "${WRANGLER_LOG_PATH:?WRANGLER_LOG_PATH must be set (see deploy.yml job env)}"
mkdir -p "$WRANGLER_LOG_PATH"

echo "Node: $(node --version)"
echo "pnpm: $(pnpm --version)"
echo "Wrangler: $(pnpm exec wrangler --version)"
echo "Environment: $TARGET_ENVIRONMENT"
echo "Working directory: $(pwd)"

set +e
pnpm run deploy -- --env "$TARGET_ENVIRONMENT"
status=$?
set -e

if [[ "$status" -ne 0 ]]; then
  echo "::error::Wrangler deployment failed for $LABEL (--env $TARGET_ENVIRONMENT), exit code $status."
  echo "===== Sanitized Wrangler logs ($LABEL) ====="
  find "$WRANGLER_LOG_PATH" \
    -type f \
    -name '*.log' \
    -print \
    -exec sed -n '1,500p' {} \; || true
  exit "$status"
fi
