-- Seeds a pre-migration-12 database with representative legacy data, applied
-- (by supabase/tests/run.sh) after migrations 1-11 but before migration 12 --
-- i.e. while the `messages` table still has none of migration 12's outbound
-- lifecycle columns (outbound_status, source_message_id, idempotency_key, ...).
-- Every insert below uses only columns that existed before migration 12, in
-- the exact shape the old message-consumer/voice-consumer code produced (see
-- git history at 300ff21^: recordOutboundMessage / recordOutboundTextMessage
-- / recordOutboundVoiceMessage), so applying migration 12 afterwards exercises
-- its legacy-outbound backfill exactly as a real upgrade of staging would.
--
-- Four fixtures, covering every shape the old code could produce:
--   conv-normal:  one inbound -> one AI text reply (also staging's most
--                 common real shape: sender_type='ai', provider_message_id
--                 set, sender_member_id null, body set).
--   conv-audio:   one inbound -> one AI *audio* reply (staging's other real
--                 shape, from voice-consumer's successful-transcription path).
--   conv-backlog: three inbound messages arrive before the AI catches up,
--                 then two AI text replies -- exercises the FIFO
--                 oldest-unclaimed matching across multiple replies in one
--                 conversation, and leaves one inbound message genuinely
--                 unanswered (never claimed by either reply).
--   conv-partial: two inbound messages, only one AI reply -- proves an
--                 inbound message with no corresponding reply is left alone
--                 (source_message_id-less by definition; it's inbound) and
--                 does not corrupt the older message's claim.
begin;

insert into companies (id, name, slug, status, is_demo) values
  ('f0000000-1000-0000-0000-000000000001', 'Legacy Upgrade Co', 'legacy-upgrade-co', 'active', true);

insert into contacts (id, company_id, whatsapp_wa_id, profile_name) values
  ('f0000000-2000-0000-0000-000000000001', 'f0000000-1000-0000-0000-000000000001', '919000000001', 'Legacy Customer');

insert into conversations (id, company_id, contact_id, state) values
  ('f0000000-3000-0000-0000-000000000001', 'f0000000-1000-0000-0000-000000000001', 'f0000000-2000-0000-0000-000000000001', 'ai_active'),
  ('f0000000-3000-0000-0000-000000000002', 'f0000000-1000-0000-0000-000000000001', 'f0000000-2000-0000-0000-000000000001', 'ai_active'),
  ('f0000000-3000-0000-0000-000000000003', 'f0000000-1000-0000-0000-000000000001', 'f0000000-2000-0000-0000-000000000001', 'ai_active'),
  ('f0000000-3000-0000-0000-000000000004', 'f0000000-1000-0000-0000-000000000001', 'f0000000-2000-0000-0000-000000000001', 'ai_active');

-- conv-normal: in1 -> out1 (text)
insert into messages (id, company_id, conversation_id, direction, channel_type, sender_type, provider_message_id, body, created_at) values
  ('f0000000-4000-0000-0000-000000000001', 'f0000000-1000-0000-0000-000000000001', 'f0000000-3000-0000-0000-000000000001', 'inbound', 'text', 'customer', 'wamid.LEGACY_IN1', 'Hello, are you open today?', now() - interval '3 hours'),
  ('f0000000-4000-0000-0000-000000000002', 'f0000000-1000-0000-0000-000000000001', 'f0000000-3000-0000-0000-000000000001', 'outbound', 'text', 'ai', 'wamid.LEGACY_OUT1', 'Yes, we are open 9am-6pm today.', now() - interval '3 hours' + interval '30 seconds');

-- conv-audio: in2 -> out2 (audio) -- staging's other real legacy shape
insert into messages (id, company_id, conversation_id, direction, channel_type, sender_type, provider_message_id, body, created_at) values
  ('f0000000-4000-0000-0000-000000000003', 'f0000000-1000-0000-0000-000000000001', 'f0000000-3000-0000-0000-000000000002', 'inbound', 'audio', 'customer', 'wamid.LEGACY_IN2', null, now() - interval '2 hours'),
  ('f0000000-4000-0000-0000-000000000004', 'f0000000-1000-0000-0000-000000000001', 'f0000000-3000-0000-0000-000000000002', 'outbound', 'audio', 'ai', 'wamid.LEGACY_OUT2', 'Here is our pricing, in your language.', now() - interval '2 hours' + interval '30 seconds');

-- conv-backlog: in3a, in3b, in3c arrive before the AI catches up; out3a and
-- out3b are the two replies it eventually sends. in3c is never answered.
insert into messages (id, company_id, conversation_id, direction, channel_type, sender_type, provider_message_id, body, created_at) values
  ('f0000000-4000-0000-0000-000000000005', 'f0000000-1000-0000-0000-000000000001', 'f0000000-3000-0000-0000-000000000003', 'inbound', 'text', 'customer', 'wamid.LEGACY_IN3A', 'What are your prices?', now() - interval '1 hour'),
  ('f0000000-4000-0000-0000-000000000006', 'f0000000-1000-0000-0000-000000000001', 'f0000000-3000-0000-0000-000000000003', 'inbound', 'text', 'customer', 'wamid.LEGACY_IN3B', 'Also do you deliver?', now() - interval '1 hour' + interval '10 seconds'),
  ('f0000000-4000-0000-0000-000000000007', 'f0000000-1000-0000-0000-000000000001', 'f0000000-3000-0000-0000-000000000003', 'inbound', 'text', 'customer', 'wamid.LEGACY_IN3C', 'And what about weekends?', now() - interval '1 hour' + interval '20 seconds'),
  ('f0000000-4000-0000-0000-000000000008', 'f0000000-1000-0000-0000-000000000001', 'f0000000-3000-0000-0000-000000000003', 'outbound', 'text', 'ai', 'wamid.LEGACY_OUT3A', 'Our prices start at 500 INR.', now() - interval '1 hour' + interval '30 seconds'),
  ('f0000000-4000-0000-0000-000000000009', 'f0000000-1000-0000-0000-000000000001', 'f0000000-3000-0000-0000-000000000003', 'outbound', 'text', 'ai', 'wamid.LEGACY_OUT3B', 'Yes, we deliver within the city.', now() - interval '1 hour' + interval '40 seconds');

-- conv-partial: in4a is escalated/never replied to; in4b gets an AI reply.
insert into messages (id, company_id, conversation_id, direction, channel_type, sender_type, provider_message_id, body, created_at) values
  ('f0000000-4000-0000-0000-00000000000a', 'f0000000-1000-0000-0000-000000000001', 'f0000000-3000-0000-0000-000000000004', 'inbound', 'text', 'customer', 'wamid.LEGACY_IN4A', 'I want to file a complaint', now() - interval '30 minutes'),
  ('f0000000-4000-0000-0000-00000000000b', 'f0000000-1000-0000-0000-000000000001', 'f0000000-3000-0000-0000-000000000004', 'inbound', 'text', 'customer', 'wamid.LEGACY_IN4B', 'Never mind, what are your hours?', now() - interval '30 minutes' + interval '10 seconds'),
  ('f0000000-4000-0000-0000-00000000000c', 'f0000000-1000-0000-0000-000000000001', 'f0000000-3000-0000-0000-000000000004', 'outbound', 'text', 'ai', 'wamid.LEGACY_OUT4', 'We are open 9am-6pm.', now() - interval '30 minutes' + interval '20 seconds');

commit;
