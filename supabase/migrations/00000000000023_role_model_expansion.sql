-- Dravonix WhatsApp AI Platform
-- Phase 2 role model expansion, part 1 of 2: additive enum values only.
--
-- Deliberately isolated into its own migration/transaction, applied and
-- committed before 00000000000024_client_role_team_security.sql ever
-- references these values in role_permissions/company_members/
-- company_invitations writes -- Postgres cannot use a newly added enum
-- value in the same transaction that adds it. No permission, RPC, or data
-- change happens here; the existing legacy values (agent, knowledge_editor,
-- billing_viewer, viewer) are left exactly as they are -- this migration
-- never removes an enum value (Postgres cannot do that in place anyway) and
-- never touches company_members/company_invitations data.
--
-- Read-only hosted-staging verification (Phase 1) confirmed zero active
-- members and zero pending invitations for agent/knowledge_editor/
-- billing_viewer/viewer, so the real data-facing work (migration 24) is
-- safe to build on top of this -- but that verification has no bearing on
-- what this file does: it is additive schema only, safe regardless of data
-- shape in any environment.

alter type company_role add value if not exists 'team_leader';
alter type company_role add value if not exists 'sales_person';
alter type company_role add value if not exists 'company_accounts';
