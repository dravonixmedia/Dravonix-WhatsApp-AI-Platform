-- Seeds representative pre-migration-16 duplicate media_files/transcriptions
-- rows, applied against a database that already has migrations 1-15 but
-- NOT YET migration 16 -- mirrors the exact shapes found during the real
-- staging audit (voice pipeline reliability phase): duplicates with no
-- transcript, duplicates with identical transcripts, and duplicates with
-- divergent transcripts where the LATER row's text matches the message's
-- live body (proving migration 16's canonical-selection ranking picks the
-- later row, not blindly the earliest one).

insert into companies (id, name, slug, status, is_demo) values
  ('8a000001-0000-0000-0000-000000000001', 'Media Dup Seed Co', 'media-dup-seed-co', 'active', true);

insert into contacts (id, company_id, whatsapp_wa_id, profile_name) values
  ('8c000001-0000-0000-0000-000000000001', '8a000001-0000-0000-0000-000000000001', '919600000001', 'Dup Seed Customer');

insert into conversations (id, company_id, contact_id) values
  ('8d000001-0000-0000-0000-000000000001', '8a000001-0000-0000-0000-000000000001', '8c000001-0000-0000-0000-000000000001');

-- Message A: two duplicate rows, zero transcriptions.
insert into messages (id, company_id, conversation_id, direction, channel_type, sender_type, body) values
  ('8e0000a1-0000-0000-0000-000000000001', '8a000001-0000-0000-0000-000000000001', '8d000001-0000-0000-0000-000000000001', 'inbound', 'audio', 'customer', null);

insert into media_files (id, company_id, kind, message_id, storage_key, mime_type) values
  ('8f0000a1-0000-0000-0000-000000000001', '8a000001-0000-0000-0000-000000000001', 'inbound_audio', '8e0000a1-0000-0000-0000-000000000001', 'companies/8a000001-0000-0000-0000-000000000001/audio/inbound/8e0000a1-0000-0000-0000-000000000001', 'audio/ogg'),
  ('8f0000a1-0000-0000-0000-000000000002', '8a000001-0000-0000-0000-000000000001', 'inbound_audio', '8e0000a1-0000-0000-0000-000000000001', 'companies/8a000001-0000-0000-0000-000000000001/audio/inbound/8e0000a1-0000-0000-0000-000000000001', 'audio/ogg');

-- Message B: two duplicate rows, IDENTICAL transcript text.
insert into messages (id, company_id, conversation_id, direction, channel_type, sender_type, body) values
  ('8e0000b1-0000-0000-0000-000000000001', '8a000001-0000-0000-0000-000000000001', '8d000001-0000-0000-0000-000000000001', 'inbound', 'audio', 'customer', 'Identical duplicate text');

insert into media_files (id, company_id, kind, message_id, storage_key, mime_type) values
  ('8f0000b1-0000-0000-0000-000000000001', '8a000001-0000-0000-0000-000000000001', 'inbound_audio', '8e0000b1-0000-0000-0000-000000000001', 'companies/8a000001-0000-0000-0000-000000000001/audio/inbound/8e0000b1-0000-0000-0000-000000000001', 'audio/ogg'),
  ('8f0000b1-0000-0000-0000-000000000002', '8a000001-0000-0000-0000-000000000001', 'inbound_audio', '8e0000b1-0000-0000-0000-000000000001', 'companies/8a000001-0000-0000-0000-000000000001/audio/inbound/8e0000b1-0000-0000-0000-000000000001', 'audio/ogg');

insert into transcriptions (id, company_id, media_file_id, message_id, provider, raw_text) values
  ('8b0000b1-0000-0000-0000-000000000001', '8a000001-0000-0000-0000-000000000001', '8f0000b1-0000-0000-0000-000000000001', '8e0000b1-0000-0000-0000-000000000001', 'elevenlabs', 'Identical duplicate text'),
  ('8b0000b1-0000-0000-0000-000000000002', '8a000001-0000-0000-0000-000000000001', '8f0000b1-0000-0000-0000-000000000002', '8e0000b1-0000-0000-0000-000000000001', 'elevenlabs', 'Identical duplicate text');

-- Message C: two duplicate rows, DIVERGENT transcripts -- the LATER row's
-- text matches the live messages.body (the exact real staging finding).
-- Migration 16 must keep the LATER row (8f0000c1...002), not the earlier
-- one, proving the ranking is genuinely "matches live body" first and
-- "earliest" only as a final tie-breaker.
insert into messages (id, company_id, conversation_id, direction, channel_type, sender_type, body) values
  ('8e0000c1-0000-0000-0000-000000000001', '8a000001-0000-0000-0000-000000000001', '8d000001-0000-0000-0000-000000000001', 'inbound', 'audio', 'customer', 'Later divergent transcript');

insert into media_files (id, company_id, kind, message_id, storage_key, mime_type, created_at) values
  ('8f0000c1-0000-0000-0000-000000000001', '8a000001-0000-0000-0000-000000000001', 'inbound_audio', '8e0000c1-0000-0000-0000-000000000001', 'companies/8a000001-0000-0000-0000-000000000001/audio/inbound/8e0000c1-0000-0000-0000-000000000001', 'audio/ogg', now() - interval '10 seconds'),
  ('8f0000c1-0000-0000-0000-000000000002', '8a000001-0000-0000-0000-000000000001', 'inbound_audio', '8e0000c1-0000-0000-0000-000000000001', 'companies/8a000001-0000-0000-0000-000000000001/audio/inbound/8e0000c1-0000-0000-0000-000000000001', 'audio/ogg', now());

insert into transcriptions (id, company_id, media_file_id, message_id, provider, raw_text) values
  ('8b0000c1-0000-0000-0000-000000000001', '8a000001-0000-0000-0000-000000000001', '8f0000c1-0000-0000-0000-000000000001', '8e0000c1-0000-0000-0000-000000000001', 'elevenlabs', 'Earlier divergent transcript'),
  ('8b0000c1-0000-0000-0000-000000000002', '8a000001-0000-0000-0000-000000000001', '8f0000c1-0000-0000-0000-000000000002', '8e0000c1-0000-0000-0000-000000000001', 'elevenlabs', 'Later divergent transcript');

-- Message D: single row, no duplicate -- must be left untouched.
insert into messages (id, company_id, conversation_id, direction, channel_type, sender_type, body) values
  ('8e0000d1-0000-0000-0000-000000000001', '8a000001-0000-0000-0000-000000000001', '8d000001-0000-0000-0000-000000000001', 'inbound', 'audio', 'customer', 'Solo transcript');

insert into media_files (id, company_id, kind, message_id, storage_key, mime_type) values
  ('8f0000d1-0000-0000-0000-000000000001', '8a000001-0000-0000-0000-000000000001', 'inbound_audio', '8e0000d1-0000-0000-0000-000000000001', 'companies/8a000001-0000-0000-0000-000000000001/audio/inbound/8e0000d1-0000-0000-0000-000000000001', 'audio/ogg');

insert into transcriptions (id, company_id, media_file_id, message_id, provider, raw_text) values
  ('8b0000d1-0000-0000-0000-000000000001', '8a000001-0000-0000-0000-000000000001', '8f0000d1-0000-0000-0000-000000000001', '8e0000d1-0000-0000-0000-000000000001', 'elevenlabs', 'Solo transcript');
