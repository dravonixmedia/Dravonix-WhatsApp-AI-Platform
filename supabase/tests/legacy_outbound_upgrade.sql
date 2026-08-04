-- Regression test: migration 12 upgrading a database that already has
-- pre-migration-12 outbound messages (this is what actually happened, and
-- failed, against real hosted staging -- see git history / the migration's
-- own "3a. Legacy outbound-message backfill" section for the full incident).
--
-- Run by supabase/tests/run.sh's second ("legacy upgrade") scratch database,
-- which applies migrations 1-11, then supabase/tests/support/
-- legacy_outbound_seed.sql (committed, pre-migration-12 shaped fixtures),
-- then migration 12 itself -- exactly mirroring a real upgrade of a database
-- with production history. This file runs after all of that and only reads
-- the already-committed result (plus one own-transaction RPC smoke test that
-- it rolls back), so it never depends on any other test file's fixtures.
--
-- Every check either passes silently or RAISE EXCEPTIONs, so a non-zero psql
-- exit code means a real regression.

begin;

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
-- 1. Migration 12 applied at all (this file only runs if it did -- run.sh's
--    run_file aborts the whole script on any psql error), and every row from
--    the legacy fixture is still present: nothing was dropped, truncated, or
--    lost by the backfill or by the constraints it unblocks.
-- ---------------------------------------------------------------------------

select test_assert(
  'All 12 legacy fixture messages survive migration 12 untouched in count',
  (select count(*) from messages where company_id = 'f0000000-1000-0000-0000-000000000001') = 12
);

select test_assert(
  'All 4 legacy conversations survive migration 12',
  (select count(*) from conversations where company_id = 'f0000000-1000-0000-0000-000000000001') = 4
);

-- ---------------------------------------------------------------------------
-- 2. Inbound rows are completely unaffected: migration 12 must never touch
--    direction='inbound' rows, and messages_outbound_fields_check requires
--    exactly this shape for them.
-- ---------------------------------------------------------------------------

select test_assert(
  'Every legacy inbound row still has outbound_status/idempotency_key/source_message_id all null',
  not exists (
    select 1 from messages
    where company_id = 'f0000000-1000-0000-0000-000000000001'
      and direction = 'inbound'
      and (outbound_status is not null or idempotency_key is not null or source_message_id is not null)
  )
);

select test_assert(
  'Legacy inbound message bodies/provider_message_ids are unchanged',
  (select body from messages where id = 'f0000000-4000-0000-0000-000000000001') = 'Hello, are you open today?'
  and (select provider_message_id from messages where id = 'f0000000-4000-0000-0000-000000000001') = 'wamid.LEGACY_IN1'
);

-- ---------------------------------------------------------------------------
-- 3. Every legacy outbound row was backfilled to outbound_status='sent' --
--    the only status the old send-then-record code path could ever imply --
--    and messages_outbound_fields_check now holds for all of them (if it
--    didn't, migration 12 itself would already have failed to apply).
-- ---------------------------------------------------------------------------

select test_assert(
  'Every legacy outbound row (5 total: out1, out2, out3a, out3b, out4) is backfilled to outbound_status=sent',
  (select count(*) from messages
     where company_id = 'f0000000-1000-0000-0000-000000000001'
       and direction = 'outbound' and outbound_status = 'sent') = 5
);

select test_assert(
  'No legacy outbound row was left with a null outbound_status',
  not exists (
    select 1 from messages
    where company_id = 'f0000000-1000-0000-0000-000000000001'
      and direction = 'outbound' and outbound_status is null
  )
);

select test_assert(
  'Legacy provider_message_id and body are preserved unchanged by the backfill (out1)',
  (select provider_message_id from messages where id = 'f0000000-4000-0000-0000-000000000002') = 'wamid.LEGACY_OUT1'
  and (select body from messages where id = 'f0000000-4000-0000-0000-000000000002') = 'Yes, we are open 9am-6pm today.'
);

-- ---------------------------------------------------------------------------
-- 4. source_message_id is backfilled per the FIFO oldest-unclaimed-inbound
--    rule, exactly matching the conversational order each fixture encodes.
-- ---------------------------------------------------------------------------

select test_assert(
  'conv-normal: out1.source_message_id points at in1 (single-turn text)',
  (select source_message_id from messages where id = 'f0000000-4000-0000-0000-000000000002')
    = 'f0000000-4000-0000-0000-000000000001'
);

select test_assert(
  'conv-audio: out2.source_message_id points at in2 (single-turn audio reply)',
  (select source_message_id from messages where id = 'f0000000-4000-0000-0000-000000000004')
    = 'f0000000-4000-0000-0000-000000000003'
);

select test_assert(
  'conv-backlog: out3a (first reply) claims in3a, the oldest inbound message at the time',
  (select source_message_id from messages where id = 'f0000000-4000-0000-0000-000000000008')
    = 'f0000000-4000-0000-0000-000000000005'
);

select test_assert(
  'conv-backlog: out3b (second reply) claims in3b, the next-oldest unclaimed inbound message',
  (select source_message_id from messages where id = 'f0000000-4000-0000-0000-000000000009')
    = 'f0000000-4000-0000-0000-000000000006'
);

select test_assert(
  'conv-backlog: in3c is never claimed by either reply -- it stays a plain, unreferenced inbound row',
  not exists (
    select 1 from messages
    where company_id = 'f0000000-1000-0000-0000-000000000001'
      and source_message_id = 'f0000000-4000-0000-0000-000000000007'
  )
);

select test_assert(
  'conv-partial: out4 claims in4a (the oldest unclaimed inbound message), not in4b',
  (select source_message_id from messages where id = 'f0000000-4000-0000-0000-00000000000c')
    = 'f0000000-4000-0000-0000-00000000000a'
);

select test_assert(
  'conv-partial: in4b (never replied to) remains a plain, unreferenced inbound row',
  not exists (
    select 1 from messages
    where company_id = 'f0000000-1000-0000-0000-000000000001'
      and source_message_id = 'f0000000-4000-0000-0000-00000000000b'
  )
);

-- ---------------------------------------------------------------------------
-- 5. Every constraint the backfill exists to unblock is actually valid (not
--    merely present -- `not valid` constraints don't check existing rows).
-- ---------------------------------------------------------------------------

select test_assert(
  'messages_outbound_fields_check is a validated constraint',
  (select convalidated from pg_constraint where conname = 'messages_outbound_fields_check') = true
);

select test_assert(
  'messages_ai_reply_source_check is a validated constraint',
  (select convalidated from pg_constraint where conname = 'messages_ai_reply_source_check') = true
);

select test_assert(
  'messages_sender_member_id_check is a validated constraint',
  (select convalidated from pg_constraint where conname = 'messages_sender_member_id_check') = true
);

-- Re-running the backfill's own statements a second time against the same,
-- already-backfilled data must be a pure no-op (idempotency, required by the
-- task and by the fact that a hosted migration re-attempt must not corrupt
-- already-correct data).
select test_assert(
  'Re-running the outbound_status backfill statement is a no-op (nothing left to touch)',
  (select count(*) from messages
     where company_id = 'f0000000-1000-0000-0000-000000000001'
       and direction = 'outbound' and outbound_status is null) = 0
);

-- ---------------------------------------------------------------------------
-- 6. New outbound reservation/finalization machinery still works correctly
--    on a legacy-upgraded database, for a brand-new (non-legacy) message.
--    Rolled back at the end of this transaction so it never leaks into
--    later test files run against this same database.
-- ---------------------------------------------------------------------------

set local role service_role;

do $$
declare
  v_new_inbound_id uuid;
  v_reserved_id uuid;
  v_claimed boolean;
  v_status outbound_delivery_status;
  v_final_status outbound_delivery_status;
begin
  insert into messages (company_id, conversation_id, direction, channel_type, sender_type, provider_message_id, body)
    values ('f0000000-1000-0000-0000-000000000001', 'f0000000-3000-0000-0000-000000000001', 'inbound', 'text', 'customer', 'wamid.LEGACY_NEW_IN', 'One more question, post-upgrade')
    returning id into v_new_inbound_id;

  select id, claimed, outbound_status into v_reserved_id, v_claimed, v_status
    from reserve_ai_outbound_message(v_new_inbound_id, 'text');

  if not v_claimed or v_status <> 'sending' then
    raise exception 'ASSERTION FAILED: reserve_ai_outbound_message must claim a fresh reservation as sending, got claimed=%, status=%', v_claimed, v_status;
  end if;

  select outbound_status into v_final_status
    from finalize_ai_outbound_message(v_reserved_id, 'sent', 'wamid.LEGACY_NEW_OUT', 'Sure, happy to help.');

  if v_final_status <> 'sent' then
    raise exception 'ASSERTION FAILED: finalize_ai_outbound_message must finalize to sent, got %', v_final_status;
  end if;

  if (select source_message_id from messages where id = v_reserved_id) <> v_new_inbound_id then
    raise exception 'ASSERTION FAILED: new reservation must record the real triggering inbound message as source_message_id';
  end if;

  raise notice 'OK: reserve_ai_outbound_message / finalize_ai_outbound_message still work end to end on a legacy-upgraded database';
end;
$$;

reset role;

rollback;
