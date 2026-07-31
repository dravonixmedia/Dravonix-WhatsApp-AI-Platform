-- Dravonix WhatsApp AI Platform -- seed data
-- Demo tenant: Dravonix Media, used for Stage A development against the Meta
-- WhatsApp Cloud API test number (Master Prompt section 2/38). is_demo=true
-- marks this and all its data as test data, never a billable production tenant.

insert into companies (id, name, slug, status, is_demo, timezone, default_currency)
values (
  '00000000-0000-0000-0000-000000000001',
  'Dravonix Media',
  'dravonix-media',
  'onboarding',
  true,
  'Asia/Kolkata',
  'INR'
);

insert into company_settings (
  company_id, bot_name, welcome_message, tone, enabled_languages, fallback_language,
  default_reply_mode, confidence_threshold, ai_active, restricted_topics, static_fallback_message
) values (
  '00000000-0000-0000-0000-000000000001',
  'Dravonix Assistant',
  'Hi! Welcome to Dravonix Media. How can we help you today?',
  'friendly_professional',
  array['en', 'ml'],
  'en',
  'auto',
  0.55,
  true,
  array['medical advice', 'legal advice', 'financial guarantees'],
  'Automated assistance is temporarily unavailable. Our team will respond as soon as possible.'
);

insert into company_branding (company_id, display_name, primary_color, secondary_color, accent_color)
values ('00000000-0000-0000-0000-000000000001', 'Dravonix Media', '#1F6FEB', '#0B1220', '#22C55E');

insert into ai_settings (company_id, reply_length, required_disclaimers, unknown_answer_behavior)
values ('00000000-0000-0000-0000-000000000001', 'medium', array[]::text[], 'escalate');

insert into voice_settings (
  company_id, is_enabled, provider, default_voice_by_language, speaking_rate,
  max_reply_duration_seconds, max_incoming_duration_seconds, reply_mode, retention_days, fallback_behavior
) values (
  '00000000-0000-0000-0000-000000000001',
  true,
  'google',
  '{"en": "en-US-Neural2-C", "ml": "ml-IN-Wavenet-A"}'::jsonb,
  1.0,
  60,
  180,
  'auto',
  30,
  'text_only_with_notice'
);

-- Demo knowledge base: services, FAQs, and clearly marked demo pricing.
insert into knowledge_sources (id, company_id, source_type, title, is_enabled, ingestion_status) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'service', 'Services Offered', true, 'ready'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000001', 'pricing', 'Demo Pricing Guide', true, 'ready'),
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000001', 'faq', 'Frequently Asked Questions', true, 'ready');

insert into knowledge_chunks (company_id, knowledge_source_id, content, chunk_index) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1',
   'Dravonix Media offers: Branding, Website Development, E-commerce Development, Social Media Management, Video Editing, Digital Marketing, Business Email Setup, CRM Setup, and AI Automation.', 0),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a2',
   'DEMO PRICING (not final commercial pricing): Website Development starts at INR 25,000. E-commerce Development starts at INR 45,000. AI Automation (this platform) starts at a one-time implementation fee plus a monthly subscription -- contact us for a quote.', 0),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a2',
   'DEMO PRICING -- Website packages: Starter package (up to 5 pages, mobile responsive, one contact form) costs INR 25,000. Business package (up to 10 pages, blog setup, basic SEO) costs INR 45,000. E-commerce package (product catalog up to 50 products, payment gateway integration) costs INR 65,000. Custom or enterprise builds beyond these are quoted individually after a requirements call.', 1),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a2',
   'DEMO PRICING -- Add-on services: an extra page beyond the package limit costs INR 2,500 each. Logo design costs INR 5,000. Professional copywriting costs INR 1,500 per page. Monthly hosting and maintenance costs INR 3,000 per month.', 2),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a2',
   'DEMO -- Typical project timeline: Starter website takes 7-10 business days. Business website takes 15-20 business days. E-commerce website takes 25-30 business days, depending on catalog size and how many rounds of revisions are needed.', 3),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a3',
   'Q: Do you build e-commerce websites? A: Yes, we build e-commerce websites on modern platforms with payment gateway integration.', 0),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a3',
   'Q: How long does a website take to build? A: It depends on the package -- a Starter website (up to 5 pages) typically takes 7-10 business days, a Business website 15-20 business days, and an E-commerce website 25-30 business days.', 1),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a3',
   'Q: Do you offer revisions? A: Yes, every website package includes two rounds of revisions before final delivery. Additional revision rounds can be added for an extra fee.', 2),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a3',
   'Q: Do you provide hosting after the website is built? A: Yes, we offer monthly hosting and maintenance starting at INR 3,000 per month, which includes uptime monitoring and minor content updates.', 3);

-- Starter subscription in trial state, using the demo Starter plan.
insert into subscriptions (company_id, plan_version_id, state, provider, current_period_start, current_period_end)
select
  '00000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'trial',
  'razorpay',
  now(),
  now() + interval '14 days';

insert into subscription_events (company_id, subscription_id, from_state, to_state, event, is_manual_override, notes)
select
  '00000000-0000-0000-0000-000000000001',
  s.id,
  null,
  'trial',
  'start_trial',
  true,
  'Seeded demo tenant: 14-day trial on the Starter plan.'
from subscriptions s where s.company_id = '00000000-0000-0000-0000-000000000001';

-- Service charge left in not_created state -- a real onboarding flow would
-- move this to pending once Dravonix Media begins onboarding a real client;
-- the seeded demo tenant itself is exempt (is_demo=true).
insert into service_charges (company_id, description, amount, currency, status)
values (
  '00000000-0000-0000-0000-000000000001',
  'Dravonix WhatsApp AI Platform implementation and service charge (DEMO -- not billable)',
  15000,
  'INR',
  'waived'
);
