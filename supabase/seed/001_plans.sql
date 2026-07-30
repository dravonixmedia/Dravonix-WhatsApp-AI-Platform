-- Dravonix WhatsApp AI Platform -- seed data
-- Seeds the three editable plan templates (Master Prompt section 20). All
-- prices are placeholder demo figures clearly marked as such -- see
-- BRANDING_CONFIGURATION.md / BILLING_AND_SUSPENSION.md for how real commercial
-- pricing is meant to be configured (via plan_versions, never hard-coded here).

insert into plans (key, name, description) values
  ('starter', 'Starter', 'Suitable for small businesses starting with WhatsApp AI automation. (DEMO PRICING)'),
  ('business', 'Business', 'Suitable for growing companies needing voice and advanced lead management. (DEMO PRICING)'),
  ('professional', 'Professional', 'Suitable for larger companies and multi-branch operations. (DEMO PRICING)');

insert into plan_versions (id, plan_id, version, monthly_price, currency, grace_period_days, is_current)
select '10000000-0000-0000-0000-000000000001', id, 1, 2999, 'INR', 5, true from plans where key = 'starter';

insert into plan_versions (id, plan_id, version, monthly_price, currency, grace_period_days, is_current)
select '10000000-0000-0000-0000-000000000002', id, 1, 7999, 'INR', 5, true from plans where key = 'business';

insert into plan_versions (id, plan_id, version, monthly_price, currency, grace_period_days, is_current)
select '10000000-0000-0000-0000-000000000003', id, 1, 19999, 'INR', 7, true from plans where key = 'professional';

-- Starter: one WhatsApp number, limited seats, text-only, basic knowledge base.
insert into plan_entitlements (plan_version_id, feature_key, numeric_limit, is_enabled) values
  ('10000000-0000-0000-0000-000000000001', 'whatsapp_numbers', 1, true),
  ('10000000-0000-0000-0000-000000000001', 'staff_seats', 3, true),
  ('10000000-0000-0000-0000-000000000001', 'voice_enabled', null, false),
  ('10000000-0000-0000-0000-000000000001', 'document_knowledge_base', null, false),
  ('10000000-0000-0000-0000-000000000001', 'monthly_messages', 1000, true),
  ('10000000-0000-0000-0000-000000000001', 'monthly_voice_minutes', 0, false),
  ('10000000-0000-0000-0000-000000000001', 'api_access', null, false);

-- Business: text + voice, higher limits, document knowledge base.
insert into plan_entitlements (plan_version_id, feature_key, numeric_limit, is_enabled) values
  ('10000000-0000-0000-0000-000000000002', 'whatsapp_numbers', 1, true),
  ('10000000-0000-0000-0000-000000000002', 'staff_seats', 10, true),
  ('10000000-0000-0000-0000-000000000002', 'voice_enabled', null, true),
  ('10000000-0000-0000-0000-000000000002', 'document_knowledge_base', null, true),
  ('10000000-0000-0000-0000-000000000002', 'monthly_messages', 5000, true),
  ('10000000-0000-0000-0000-000000000002', 'monthly_voice_minutes', 300, true),
  ('10000000-0000-0000-0000-000000000002', 'api_access', null, false);

-- Professional: multiple numbers/branches, custom limits, API access.
insert into plan_entitlements (plan_version_id, feature_key, numeric_limit, is_enabled) values
  ('10000000-0000-0000-0000-000000000003', 'whatsapp_numbers', 5, true),
  ('10000000-0000-0000-0000-000000000003', 'staff_seats', 50, true),
  ('10000000-0000-0000-0000-000000000003', 'voice_enabled', null, true),
  ('10000000-0000-0000-0000-000000000003', 'document_knowledge_base', null, true),
  ('10000000-0000-0000-0000-000000000003', 'monthly_messages', 25000, true),
  ('10000000-0000-0000-0000-000000000003', 'monthly_voice_minutes', 2000, true),
  ('10000000-0000-0000-0000-000000000003', 'api_access', null, true);
