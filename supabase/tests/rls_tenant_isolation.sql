-- Automated tenant-isolation tests (Master Prompt sections 8, 28, 36).
-- Run after applying all migrations + supabase/tests/support/supabase_local_shim.sql
-- (a local Postgres stand-in for the parts of Supabase's `auth` schema this schema
-- depends on). See supabase/tests/README.md for how to run this against CI or a
-- local dev database.
--
-- Every check either passes silently or RAISE EXCEPTIONs, so a non-zero psql exit
-- code means a real isolation failure.

begin;

-- Fixture inserts below must bypass RLS (they simulate seed/service-role writes),
-- so we insert as the transaction owner first and only SET LOCAL ROLE to the
-- restricted `authenticated` role once fixtures exist -- see supabase/tests/README.md
-- for why table ownership/superuser status matters for RLS testing.

-- ---------------------------------------------------------------------------
-- Fixtures: two companies, one user in each with an operational role, one
-- billing_viewer, one disabled member, one platform_support staff member.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner-a@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'owner-b@example.test'),
  ('33333333-3333-3333-3333-333333333333', 'billing-viewer-a@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'disabled-a@example.test'),
  ('55555555-5555-5555-5555-555555555555', 'agent-a@example.test'),
  ('66666666-6666-6666-6666-666666666666', 'support-staff@example.test');

insert into companies (id, name, slug, status, is_demo) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Company A', 'company-a', 'active', true),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'Company B', 'company-b', 'active', true);

insert into company_members (company_id, user_id, role, is_active) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'company_owner', true),
  ('bbbbbbbb-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'company_owner', true),
  ('aaaaaaaa-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 'billing_viewer', true),
  ('aaaaaaaa-0000-0000-0000-000000000001', '44444444-4444-4444-4444-444444444444', 'agent', false),
  ('aaaaaaaa-0000-0000-0000-000000000001', '55555555-5555-5555-5555-555555555555', 'agent', true);

insert into platform_members (user_id, role) values
  ('66666666-6666-6666-6666-666666666666', 'platform_support');

insert into contacts (id, company_id, whatsapp_wa_id, profile_name) values
  ('c0000000-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000001', '911000000001', 'Customer A'),
  ('c0000000-0000-0000-0000-00000000000b', 'bbbbbbbb-0000-0000-0000-000000000002', '911000000002', 'Customer B');

insert into conversations (id, company_id, contact_id) values
  ('d0000000-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-00000000000a'),
  ('d0000000-0000-0000-0000-00000000000b', 'bbbbbbbb-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-00000000000b');

insert into messages (company_id, conversation_id, direction, channel_type, sender_type, body, provider_message_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-00000000000a', 'inbound', 'text', 'customer', 'Hello from A', 'wamid.A1'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-00000000000b', 'inbound', 'text', 'customer', 'Hello from B', 'wamid.B1');

insert into knowledge_sources (id, company_id, source_type, title) values
  ('e0000000-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000001', 'faq', 'FAQ A'),
  ('e0000000-0000-0000-0000-00000000000b', 'bbbbbbbb-0000-0000-0000-000000000002', 'faq', 'FAQ B');

insert into knowledge_chunks (company_id, knowledge_source_id, content) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-00000000000a', 'Company A pricing is confidential'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-00000000000b', 'Company B pricing is confidential');

insert into leads (company_id, contact_id, customer_name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-00000000000a', 'Lead A'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-00000000000b', 'Lead B');

insert into plans (key, name) values ('starter', 'Starter');
insert into plan_versions (id, plan_id, version, monthly_price)
  select 'f0000000-0000-0000-0000-000000000001', id, 1, 999 from plans where key = 'starter';

insert into subscriptions (company_id, plan_version_id, state)
  select 'aaaaaaaa-0000-0000-0000-000000000001', id, 'active' from plan_versions limit 1;
insert into subscriptions (company_id, plan_version_id, state)
  select 'bbbbbbbb-0000-0000-0000-000000000002', id, 'active' from plan_versions limit 1;

insert into invoices (company_id, kind, invoice_number, status, total) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'subscription', 'INV-A-0001', 'paid', 999),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'subscription', 'INV-B-0001', 'paid', 999);

-- ---------------------------------------------------------------------------
-- Assertion helper
-- ---------------------------------------------------------------------------

create or replace function test_assert(description text, condition boolean) returns void
  language plpgsql
  as $$
  begin
    if not condition then
      raise exception 'ASSERTION FAILED: %', description;
    else
      raise notice 'OK: %', description;
    end if;
  end;
  $$;

-- ---------------------------------------------------------------------------
-- Conversation default state: the fixture conversations above were inserted
-- without specifying `state`, so this exercises the schema's actual default
-- rather than an application-level assumption. New conversations must start
-- ai_active (Master Prompt section 16) -- diagnosed in a staging incident
-- where a conversation got stuck outside ai_active with no automatic way
-- back in; confirming the *default* is correct rules that out as the cause
-- of any future recurrence.
-- ---------------------------------------------------------------------------

select test_assert(
  'A newly inserted conversation defaults to ai_active',
  (select state from conversations where id = 'd0000000-0000-0000-0000-00000000000a') = 'ai_active'
);

-- All fixtures are in place. From here on, run as the restricted `authenticated`
-- role (non-owner, non-superuser) so RLS is actually enforced, matching how
-- Supabase's PostgREST/Realtime connections operate against real data.
set local role authenticated;

-- ---------------------------------------------------------------------------
-- Company A owner: can read Company A's data, cannot read Company B's.
-- ---------------------------------------------------------------------------

select test_set_current_user('11111111-1111-1111-1111-111111111111');

select test_assert(
  'Company A owner can read Company A contacts',
  (select count(*) from contacts where company_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 1
);

select test_assert(
  'Company A owner CANNOT read Company B contacts',
  (select count(*) from contacts where company_id = 'bbbbbbbb-0000-0000-0000-000000000002') = 0
);

select test_assert(
  'Company A owner CANNOT read Company B messages',
  (select count(*) from messages where company_id = 'bbbbbbbb-0000-0000-0000-000000000002') = 0
);

select test_assert(
  'Company A owner CANNOT read Company B knowledge chunks',
  (select count(*) from knowledge_chunks where company_id = 'bbbbbbbb-0000-0000-0000-000000000002') = 0
);

select test_assert(
  'Company A owner CANNOT read Company B leads',
  (select count(*) from leads where company_id = 'bbbbbbbb-0000-0000-0000-000000000002') = 0
);

select test_assert(
  'Company A owner CANNOT read Company B invoices',
  (select count(*) from invoices where company_id = 'bbbbbbbb-0000-0000-0000-000000000002') = 0
);

select test_assert(
  'An unqualified SELECT * from contacts only ever returns the callers own company rows',
  (select count(distinct company_id) from contacts) = 1
);

-- ---------------------------------------------------------------------------
-- Company B owner: symmetric check.
-- ---------------------------------------------------------------------------

select test_set_current_user('22222222-2222-2222-2222-222222222222');

select test_assert(
  'Company B owner can read Company B contacts',
  (select count(*) from contacts where company_id = 'bbbbbbbb-0000-0000-0000-000000000002') = 1
);

select test_assert(
  'Company B owner CANNOT read Company A messages',
  (select count(*) from messages where company_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 0
);

-- ---------------------------------------------------------------------------
-- Role-scoped access: billing_viewer cannot read messages; agent cannot read
-- invoices.
-- ---------------------------------------------------------------------------

select test_set_current_user('33333333-3333-3333-3333-333333333333');

select test_assert(
  'billing_viewer CAN read invoices',
  (select count(*) from invoices where company_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 1
);

select test_assert(
  'billing_viewer CANNOT read messages',
  (select count(*) from messages where company_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 0
);

select test_assert(
  'billing_viewer CANNOT read leads',
  (select count(*) from leads where company_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 0
);

select test_set_current_user('55555555-5555-5555-5555-555555555555');

select test_assert(
  'agent CAN read messages in their own company',
  (select count(*) from messages where company_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 1
);

select test_assert(
  'agent CANNOT read invoices',
  (select count(*) from invoices where company_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 0
);

-- ---------------------------------------------------------------------------
-- A disabled member loses access immediately (no separate deactivation step
-- needed -- is_active=false alone must be sufficient).
-- ---------------------------------------------------------------------------

select test_set_current_user('44444444-4444-4444-4444-444444444444');

select test_assert(
  'A disabled member CANNOT read their former company contacts',
  (select count(*) from contacts where company_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 0
);

select test_assert(
  'A disabled member CANNOT read their former company messages',
  (select count(*) from messages where company_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 0
);

-- ---------------------------------------------------------------------------
-- Anonymous (no session) access: nothing tenant-owned is visible.
-- ---------------------------------------------------------------------------

select test_clear_current_user();

select test_assert(
  'An unauthenticated caller sees no contacts across any company',
  (select count(*) from contacts) = 0
);

select test_assert(
  'An unauthenticated caller sees no invoices across any company',
  (select count(*) from invoices) = 0
);

-- ---------------------------------------------------------------------------
-- Platform support staff: can read across companies (used only via the
-- audited support-access workflow at the application layer).
-- ---------------------------------------------------------------------------

select test_set_current_user('66666666-6666-6666-6666-666666666666');

select test_assert(
  'Platform support staff can read Company A contacts',
  (select count(*) from contacts where company_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 1
);

select test_assert(
  'Platform support staff can read Company B contacts',
  (select count(*) from contacts where company_id = 'bbbbbbbb-0000-0000-0000-000000000002') = 1
);

select test_clear_current_user();

rollback;
