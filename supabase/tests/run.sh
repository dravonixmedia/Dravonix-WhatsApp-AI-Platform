#!/usr/bin/env bash
# Runs the RLS tenant-isolation tests against a scratch Postgres database.
#
# Requires a Postgres 16 server with the "vector" extension available (the
# pgvector/pgvector:pg16 Docker image, or `apt-get install postgresql-16-pgvector`
# on a Debian/Ubuntu host running Postgres 16) reachable via TEST_DATABASE_ADMIN_URL
# (defaults to a local trust/peer connection as the postgres superuser).
#
# This is a local/CI test harness only -- see supabase/tests/README.md. It creates
# and drops a throwaway database each run; it never touches a real Supabase project.

set -euo pipefail

ADMIN_URL="${TEST_DATABASE_ADMIN_URL:-postgresql://postgres@localhost:5432/postgres}"
DB_NAME="dravonix_rls_test_$$"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATIONS_DIR="$ROOT_DIR/supabase/migrations"

psql_admin() {
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 "$@"
}

cleanup() {
  psql_admin -c "drop database if exists ${DB_NAME};" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Creating scratch database ${DB_NAME}..."
psql_admin -c "create database ${DB_NAME};"

DB_URL="${ADMIN_URL%/*}/${DB_NAME}"

run_file() {
  psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$1" >/tmp/dravonix_rls_test_output.log 2>&1 || {
    echo "FAILED applying $1:";
    cat /tmp/dravonix_rls_test_output.log;
    exit 1;
  }
}

echo "Applying extensions..."
run_file "$MIGRATIONS_DIR/00000000000001_extensions.sql"

echo "Applying local auth shim (provides auth.users/auth.uid() outside real Supabase)..."
run_file "$ROOT_DIR/supabase/tests/support/supabase_local_shim.sql"

echo "Applying remaining migrations..."
for f in "$MIGRATIONS_DIR"/*.sql; do
  [[ "$(basename "$f")" == "00000000000001_extensions.sql" ]] && continue
  run_file "$f"
done

echo "Creating restricted authenticated/anon roles..."
run_file "$ROOT_DIR/supabase/tests/support/roles.sql"

echo "Running RLS tenant-isolation assertions..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_tenant_isolation.sql"

echo "All RLS tenant-isolation tests passed."
