-- Seeds a single UNSAFE duplicate group: divergent transcript texts where
-- NEITHER matches the message's live body. Migration 16's ambiguity guard
-- must abort the entire migration before deleting anything.

insert into companies (id, name, slug, status, is_demo) values
  ('7a000001-0000-0000-0000-000000000001', 'Media Dup Unsafe Co', 'media-dup-unsafe-co', 'active', true);

insert into contacts (id, company_id, whatsapp_wa_id, profile_name) values
  ('7c000001-0000-0000-0000-000000000001', '7a000001-0000-0000-0000-000000000001', '919500000001', 'Unsafe Dup Customer');

insert into conversations (id, company_id, contact_id) values
  ('7d000001-0000-0000-0000-000000000001', '7a000001-0000-0000-0000-000000000001', '7c000001-0000-0000-0000-000000000001');

insert into messages (id, company_id, conversation_id, direction, channel_type, sender_type, body) values
  ('7e000001-0000-0000-0000-000000000001', '7a000001-0000-0000-0000-000000000001', '7d000001-0000-0000-0000-000000000001', 'inbound', 'audio', 'customer', 'A body value matching neither duplicate transcript');

insert into media_files (id, company_id, kind, message_id, storage_key, mime_type) values
  ('7f000001-0000-0000-0000-000000000001', '7a000001-0000-0000-0000-000000000001', 'inbound_audio', '7e000001-0000-0000-0000-000000000001', 'companies/7a000001-0000-0000-0000-000000000001/audio/inbound/7e000001-0000-0000-0000-000000000001', 'audio/ogg'),
  ('7f000001-0000-0000-0000-000000000002', '7a000001-0000-0000-0000-000000000001', 'inbound_audio', '7e000001-0000-0000-0000-000000000001', 'companies/7a000001-0000-0000-0000-000000000001/audio/inbound/7e000001-0000-0000-0000-000000000001', 'audio/ogg');

insert into transcriptions (id, company_id, media_file_id, message_id, provider, raw_text) values
  ('7b000001-0000-0000-0000-000000000001', '7a000001-0000-0000-0000-000000000001', '7f000001-0000-0000-0000-000000000001', '7e000001-0000-0000-0000-000000000001', 'elevenlabs', 'Divergent transcript X'),
  ('7b000001-0000-0000-0000-000000000002', '7a000001-0000-0000-0000-000000000001', '7f000001-0000-0000-0000-000000000002', '7e000001-0000-0000-0000-000000000001', 'elevenlabs', 'Divergent transcript Y');
