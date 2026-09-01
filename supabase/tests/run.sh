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
MEDIA_DUP_SAFE_DB_NAME="dravonix_media_dup_safe_test_$$"
MEDIA_DUP_UNSAFE_DB_NAME="dravonix_media_dup_unsafe_test_$$"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATIONS_DIR="$ROOT_DIR/supabase/migrations"

psql_admin() {
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 "$@"
}

cleanup() {
  psql_admin -c "drop database if exists ${DB_NAME};" >/dev/null 2>&1 || true
  psql_admin -c "drop database if exists ${LEGACY_DB_NAME};" >/dev/null 2>&1 || true
  psql_admin -c "drop database if exists ${MEDIA_DUP_SAFE_DB_NAME};" >/dev/null 2>&1 || true
  psql_admin -c "drop database if exists ${MEDIA_DUP_UNSAFE_DB_NAME};" >/dev/null 2>&1 || true
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

echo "Applying extensions schema shim (mirrors hosted Supabase's pre-provisioned extensions schema)..."
run_file "$DB_URL" "$ROOT_DIR/supabase/tests/support/extensions_schema_shim.sql"

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

echo "Running Business Currency (migration 15) RLS/RPC hardening + timezone independence assertions..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_currency.sql"

echo "Running voice pipeline media/transcription idempotency (migration 16) constraint assertions..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_media_idempotency.sql"

echo "Running Super Admin test-client foundation (migration 17) RLS/RPC hardening assertions..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_super_admin.sql"

echo "Running client onboarding foundation (migration 18) RLS/RPC hardening assertions..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_client_onboarding.sql"

echo "Running invitation email audit (migration 19) RLS/RPC hardening assertions..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_invitation_email_audit.sql"

echo "Running Phase 2 role model expansion (migrations 23/24) RLS/RPC hardening assertions..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_role_team_security.sql"

echo "Running Phase 3A.1 secure phone read layer (migration 25) RLS/RPC hardening assertions..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_phone_privacy_security.sql"

echo "Running Phase 3A.2 direct phone-column access closure (migration 26) assertions..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_phone_direct_access_revoke.sql"

echo "Running Phase 5 Client Support & Requests (migration 27) RLS/RPC hardening assertions..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_support_requests.sql"

echo "Running Phase 6B Razorpay payment (migration 28) RLS/RPC hardening assertions..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_razorpay_payments.sql"

echo "Running Phase 6C staging billing automation (migration 30) RLS/RPC hardening assertions..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_billing_automation.sql"

echo "Running Phase 6C migration 31 billing automation correction assertions..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_billing_automation_corrections.sql"

echo "Running Phase 7B Super Admin subscription control plane (migration 32) assertions..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_super_admin_subscription_controls.sql"

echo "Running P0 leads -> contacts embed grant regression (migration 33) assertions..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_leads_contact_embed.sql"

echo "Running P1 stabilization search_knowledge_chunks (migrations 10/11) RLS/RPC regression assertions..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_knowledge_search.sql"

echo "Running P2 knowledge ingestion (migration 34) RLS/RPC regression assertions..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_knowledge_ingestion.sql"

echo "Running Meta/WhatsApp Batch 1 connection foundation (migration 35) RLS/RPC regression assertions..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_whatsapp_connections.sql"

echo "Running Meta/WhatsApp Batch 2 service-window/template foundation (migration 36) RLS/RPC regression assertions..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/rls_whatsapp_service_window.sql"

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

echo "[legacy-upgrade] Applying extensions schema shim..."
run_file "$LEGACY_DB_URL" "$ROOT_DIR/supabase/tests/support/extensions_schema_shim.sql"

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
  # Phase 2 role model expansion (migration 24) redefines two migration-12
  # functions (handover_end_human_assistance/handover_close_conversation)
  # using the conversation_ai_mode type migration 12 itself defines --
  # deferred to right after 12/13 below, same reason 12/13 are deferred.
  [[ "$base" == "00000000000024_client_role_team_security.sql" ]] && continue
  # Meta/WhatsApp Batch 2 (migration 36) is the first migration since 12
  # itself to reference a migration-12 type (outbound_delivery_status) --
  # deferred for the exact same reason as 12/13/24 above.
  [[ "$base" == "00000000000036_whatsapp_service_window.sql" ]] && continue
  run_file "$LEGACY_DB_URL" "$f"
done

echo "[legacy-upgrade] Seeding pre-migration-12 legacy outbound message fixtures..."
run_file "$LEGACY_DB_URL" "$ROOT_DIR/supabase/tests/support/legacy_outbound_seed.sql"

echo "[legacy-upgrade] Applying migration 12 against the legacy-seeded database..."
run_file "$LEGACY_DB_URL" "$MIGRATIONS_DIR/00000000000012_human_handover.sql"

echo "[legacy-upgrade] Applying migration 13 (dashboard Realtime) against the upgraded database..."
run_file "$LEGACY_DB_URL" "$MIGRATIONS_DIR/00000000000013_dashboard_realtime.sql"

echo "[legacy-upgrade] Applying migration 36 (Meta/WhatsApp Batch 2) now that migration 12's outbound_delivery_status type exists..."
run_file "$LEGACY_DB_URL" "$MIGRATIONS_DIR/00000000000036_whatsapp_service_window.sql"

echo "[legacy-upgrade] Applying migration 24 (Phase 2 role model expansion) now that migration 12's types/functions exist..."
run_file "$LEGACY_DB_URL" "$MIGRATIONS_DIR/00000000000024_client_role_team_security.sql"

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

# ---------------------------------------------------------------------------
# Migration 16 legacy-duplicate consolidation regression (voice pipeline
# reliability phase): applies migrations 1-15, seeds pre-migration-16 shaped
# duplicate media_files/transcriptions rows (the exact patterns found during
# the real staging audit), then applies migration 16 and proves its
# ambiguity guard, canonical-row ranking, and cleanup all behave correctly
# against real legacy duplicate data -- not just a from-empty database. Runs
# in its own scratch database so it never interferes with the flows above.
#
# Two sub-cases, each in its own database: SAFE (every duplicate group is
# deterministically resolvable -- migration 16 must succeed and consolidate)
# and UNSAFE (a divergent-transcript group matches neither's live body --
# migration 16 must abort atomically, deleting nothing).
# ---------------------------------------------------------------------------

echo "Creating media-duplicate-safe scratch database ${MEDIA_DUP_SAFE_DB_NAME}..."
psql_admin -c "create database ${MEDIA_DUP_SAFE_DB_NAME};"
MEDIA_DUP_SAFE_DB_URL="${ADMIN_URL%/*}/${MEDIA_DUP_SAFE_DB_NAME}"

echo "[media-dup-safe] Applying extensions schema shim..."
run_file "$MEDIA_DUP_SAFE_DB_URL" "$ROOT_DIR/supabase/tests/support/extensions_schema_shim.sql"
echo "[media-dup-safe] Applying extensions..."
run_file "$MEDIA_DUP_SAFE_DB_URL" "$MIGRATIONS_DIR/00000000000001_extensions.sql"
echo "[media-dup-safe] Applying local auth shim..."
run_file "$MEDIA_DUP_SAFE_DB_URL" "$ROOT_DIR/supabase/tests/support/supabase_local_shim.sql"
echo "[media-dup-safe] Applying local Realtime publication shim..."
run_file "$MEDIA_DUP_SAFE_DB_URL" "$ROOT_DIR/supabase/tests/support/realtime_publication_shim.sql"
echo "[media-dup-safe] Creating restricted authenticated/anon/service_role roles..."
run_file "$MEDIA_DUP_SAFE_DB_URL" "$ROOT_DIR/supabase/tests/support/roles_create.sql"

echo "[media-dup-safe] Applying migrations 1-15 (pre-migration-16 schema only)..."
for f in "$MIGRATIONS_DIR"/*.sql; do
  base="$(basename "$f")"
  [[ "$base" == "00000000000001_extensions.sql" ]] && continue
  [[ "$base" == "00000000000016_voice_media_idempotency.sql" ]] && continue
  run_file "$MEDIA_DUP_SAFE_DB_URL" "$f"
done

echo "[media-dup-safe] Seeding representative legacy duplicate rows..."
run_file "$MEDIA_DUP_SAFE_DB_URL" "$ROOT_DIR/supabase/tests/support/media_duplicate_safe_seed.sql"

echo "[media-dup-safe] Applying migration 16 against the duplicate-seeded database..."
run_file "$MEDIA_DUP_SAFE_DB_URL" "$MIGRATIONS_DIR/00000000000016_voice_media_idempotency.sql"

echo "[media-dup-safe] Granting table privileges to authenticated/anon/service_role..."
run_file "$MEDIA_DUP_SAFE_DB_URL" "$ROOT_DIR/supabase/tests/support/roles.sql"

echo "[media-dup-safe] Running post-consolidation assertions..."
psql "$MEDIA_DUP_SAFE_DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/supabase/tests/media_idempotency_consolidation.sql"

echo "Media-duplicate-safe consolidation regression passed."

echo "Creating media-duplicate-unsafe scratch database ${MEDIA_DUP_UNSAFE_DB_NAME}..."
psql_admin -c "create database ${MEDIA_DUP_UNSAFE_DB_NAME};"
MEDIA_DUP_UNSAFE_DB_URL="${ADMIN_URL%/*}/${MEDIA_DUP_UNSAFE_DB_NAME}"

echo "[media-dup-unsafe] Applying extensions schema shim..."
run_file "$MEDIA_DUP_UNSAFE_DB_URL" "$ROOT_DIR/supabase/tests/support/extensions_schema_shim.sql"
echo "[media-dup-unsafe] Applying extensions..."
run_file "$MEDIA_DUP_UNSAFE_DB_URL" "$MIGRATIONS_DIR/00000000000001_extensions.sql"
echo "[media-dup-unsafe] Applying local auth shim..."
run_file "$MEDIA_DUP_UNSAFE_DB_URL" "$ROOT_DIR/supabase/tests/support/supabase_local_shim.sql"
echo "[media-dup-unsafe] Applying local Realtime publication shim..."
run_file "$MEDIA_DUP_UNSAFE_DB_URL" "$ROOT_DIR/supabase/tests/support/realtime_publication_shim.sql"
echo "[media-dup-unsafe] Creating restricted authenticated/anon/service_role roles..."
run_file "$MEDIA_DUP_UNSAFE_DB_URL" "$ROOT_DIR/supabase/tests/support/roles_create.sql"

echo "[media-dup-unsafe] Applying migrations 1-15 (pre-migration-16 schema only)..."
for f in "$MIGRATIONS_DIR"/*.sql; do
  base="$(basename "$f")"
  [[ "$base" == "00000000000001_extensions.sql" ]] && continue
  [[ "$base" == "00000000000016_voice_media_idempotency.sql" ]] && continue
  run_file "$MEDIA_DUP_UNSAFE_DB_URL" "$f"
done

echo "[media-dup-unsafe] Seeding an unresolvable divergent-transcript duplicate group..."
run_file "$MEDIA_DUP_UNSAFE_DB_URL" "$ROOT_DIR/supabase/tests/support/media_duplicate_unsafe_seed.sql"

echo "[media-dup-unsafe] Applying migration 16 -- this MUST fail (CASE J: unresolved divergent transcripts)..."
if psql "$MEDIA_DUP_UNSAFE_DB_URL" -v ON_ERROR_STOP=1 -f "$MIGRATIONS_DIR/00000000000016_voice_media_idempotency.sql" >/tmp/dravonix_media_dup_unsafe_output.log 2>&1; then
  echo "FAILED: migration 16 succeeded against unresolvable divergent-transcript data -- it must abort instead."
  cat /tmp/dravonix_media_dup_unsafe_output.log
  exit 1
fi
if ! grep -q "unresolved divergent transcripts" /tmp/dravonix_media_dup_unsafe_output.log; then
  echo "FAILED: migration 16 failed for the wrong reason (expected the divergent-transcripts ambiguity exception):"
  cat /tmp/dravonix_media_dup_unsafe_output.log
  exit 1
fi
echo "CASE J: migration 16 correctly aborted on the unresolvable divergent-transcript group."

echo "[media-dup-unsafe] Verifying the atomic abort deleted nothing and added no constraints..."
UNSAFE_ROW_COUNT="$(psql "$MEDIA_DUP_UNSAFE_DB_URL" -tAc "select count(*) from media_files where message_id = '7e000001-0000-0000-0000-000000000001';")"
if [[ "$UNSAFE_ROW_COUNT" != "2" ]]; then
  echo "FAILED: expected both duplicate rows to still exist after the aborted migration (found ${UNSAFE_ROW_COUNT})."
  exit 1
fi
UNSAFE_CONSTRAINT_COUNT="$(psql "$MEDIA_DUP_UNSAFE_DB_URL" -tAc "select count(*) from pg_constraint where conname in ('media_files_company_message_kind_key','transcriptions_media_file_id_key');")"
if [[ "$UNSAFE_CONSTRAINT_COUNT" != "0" ]]; then
  echo "FAILED: expected neither new constraint to exist after the aborted migration (found ${UNSAFE_CONSTRAINT_COUNT})."
  exit 1
fi
echo "Media-duplicate-unsafe atomic-abort regression passed."
