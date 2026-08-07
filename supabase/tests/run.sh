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
LEGACY_DB_NAME="dravonix_legacy_upgrade_test_$$"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATIONS_DIR="$ROOT_DIR/supabase/migrations"

psql_admin() {
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 "$@"
}

cleanup() {
  psql_admin -c "drop database if exists ${DB_NAME};" >/dev/null 2>&1 || true
  psql_admin -c "drop database if exists ${LEGACY_DB_NAME};" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Creating scratch database ${DB_NAME}..."
psql_admin -c "create database ${DB_NAME};"

DB_URL="${ADMIN_URL%/*}/${DB_NAME}"

run_file() {
  # $1: target database URL, $2: file to apply
  psql "$1" -v ON_ERROR_STOP=1 -f "$2" >/tmp/dravonix_rls_test_output.log 2>&1 || {
    echo "FAILED applying $2:";
    cat /tmp/dravonix_rls_test_output.log;
    exit 1;
  }
}

echo "Applying extensions..."
run_file "$DB_URL" "$MIGRATIONS_DIR/00000000000001_extensions.sql"

echo "Applying local auth shim (provides auth.users/auth.uid() outside real Supabase)..."
run_file "$DB_URL" "$ROOT_DIR/supabase/tests/support/supabase_local_shim.sql"

echo "Applying local Realtime publication shim (provides supabase_realtime outside real Supabase)..."
run_file "$DB_URL" "$ROOT_DIR/supabase/tests/support/realtime_publication_shim.sql"

echo "Creating restricted authenticated/anon/service_role roles..."
run_file "$DB_URL" "$ROOT_DIR/supabase/tests/support/roles_create.sql"

echo "Applying remaining migrations..."
for f in "$MIGRATIONS_DIR"/*.sql; do
  [[ "$(basename "$f")" == "00000000000001_extensions.sql" ]] && continue
  run_file "$DB_URL" "$f"
done

echo "Granting table privileges to authenticated/anon/service_role..."
run_file "$DB_URL" "$ROOT_DIR/supabase/tests/support/roles.sql"

echo "Running RLS tenant-isolation assertions..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_tenant_isolation.sql"

echo "Running Human Handover Inbox RLS/RPC hardening assertions..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_handover.sql"

echo "Running dashboard Realtime (migration 13) assertions..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_realtime.sql"

echo "Running Global Timezone + Daypart Awareness (migration 14) RLS/RPC hardening assertions..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_timezone.sql"

echo "All RLS tests passed."

# ---------------------------------------------------------------------------
# Legacy-upgrade regression: applies migrations 1-11, seeds pre-migration-12
# shaped outbound messages (the exact shape real hosted staging had), then
# applies migration 12 -- proving its legacy-outbound backfill actually lets
# a database with production history pass messages_outbound_fields_check /
# messages_ai_reply_source_check, and that everything built on top of it
# (RLS, collaborative handover, the outbound lifecycle RPCs) still works
# against that upgraded database. Runs in its own scratch database so it
# never interferes with the from-empty flow above.
# ---------------------------------------------------------------------------

echo "Creating legacy-upgrade scratch database ${LEGACY_DB_NAME}..."
psql_admin -c "create database ${LEGACY_DB_NAME};"

LEGACY_DB_URL="${ADMIN_URL%/*}/${LEGACY_DB_NAME}"

echo "[legacy-upgrade] Applying extensions..."
run_file "$LEGACY_DB_URL" "$MIGRATIONS_DIR/00000000000001_extensions.sql"

echo "[legacy-upgrade] Applying local auth shim..."
run_file "$LEGACY_DB_URL" "$ROOT_DIR/supabase/tests/support/supabase_local_shim.sql"

echo "[legacy-upgrade] Applying local Realtime publication shim..."
run_file "$LEGACY_DB_URL" "$ROOT_DIR/supabase/tests/support/realtime_publication_shim.sql"

echo "[legacy-upgrade] Creating restricted authenticated/anon/service_role roles..."
run_file "$LEGACY_DB_URL" "$ROOT_DIR/supabase/tests/support/roles_create.sql"

echo "[legacy-upgrade] Applying migrations 2-11 (pre-human-handover schema only)..."
for f in "$MIGRATIONS_DIR"/*.sql; do
  base="$(basename "$f")"
  [[ "$base" == "00000000000001_extensions.sql" ]] && continue
  [[ "$base" == "00000000000012_human_handover.sql" ]] && continue
  [[ "$base" == "00000000000013_dashboard_realtime.sql" ]] && continue
  run_file "$LEGACY_DB_URL" "$f"
done

echo "[legacy-upgrade] Seeding pre-migration-12 legacy outbound message fixtures..."
run_file "$LEGACY_DB_URL" "$ROOT_DIR/supabase/tests/support/legacy_outbound_seed.sql"

echo "[legacy-upgrade] Applying migration 12 against the legacy-seeded database..."
run_file "$LEGACY_DB_URL" "$MIGRATIONS_DIR/00000000000012_human_handover.sql"

echo "[legacy-upgrade] Applying migration 13 (dashboard Realtime) against the upgraded database..."
run_file "$LEGACY_DB_URL" "$MIGRATIONS_DIR/00000000000013_dashboard_realtime.sql"

echo "[legacy-upgrade] Granting table privileges to authenticated/anon/service_role..."
run_file "$LEGACY_DB_URL" "$ROOT_DIR/supabase/tests/support/roles.sql"

echo "[legacy-upgrade] Running legacy outbound-backfill regression assertions..."
psql "$LEGACY_DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/legacy_outbound_upgrade.sql"

echo "[legacy-upgrade] Re-running RLS tenant-isolation assertions against the upgraded database..."
psql "$LEGACY_DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_tenant_isolation.sql"

echo "[legacy-upgrade] Re-running Human Handover Inbox RLS/RPC hardening assertions against the upgraded database..."
psql "$LEGACY_DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_handover.sql"

echo "[legacy-upgrade] Re-running dashboard Realtime (migration 13) assertions against the upgraded database..."
psql "$LEGACY_DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_realtime.sql"

echo "[legacy-upgrade] Re-running Global Timezone + Daypart Awareness (migration 14) assertions against the upgraded database..."
psql "$LEGACY_DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_timezone.sql"

echo "All legacy-upgrade regression tests passed."
