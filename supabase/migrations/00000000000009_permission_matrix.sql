-- Dravonix WhatsApp AI Platform
-- Permission matrix (Master Prompt section 9). This seeds the fixed catalogue of
-- permissions and the role -> permission grants that every has_company_permission()
-- check in prior migrations depends on. Treated as schema (not sample/demo seed
-- data) because RLS is inert without it.

insert into permissions (key, description) values
  ('conversations.view', 'View conversations, messages, and transcriptions'),
  ('conversations.reply', 'Send manual text/voice replies and add internal notes'),
  ('conversations.assign', 'Assign/reassign conversations and manage handover'),
  ('leads.view', 'View leads'),
  ('leads.manage', 'Edit lead stage, assignment, and details'),
  ('knowledge.view', 'View the company knowledge base'),
  ('knowledge.manage', 'Edit company knowledge, FAQs, services, pricing, documents'),
  ('ai_settings.view', 'View AI and voice settings'),
  ('ai_settings.manage', 'Edit AI and voice settings'),
  ('billing.view', 'View invoices, payments, and subscription status'),
  ('billing.manage', 'Submit payments, request plan changes, upload payment proofs'),
  ('usage.view', 'View usage metering and plan-limit dashboards'),
  ('audit.view', 'View the company audit log'),
  ('team.manage', 'Invite/disable company members and change roles'),
  ('settings.manage', 'Edit company profile, branding, and business settings'),
  ('whatsapp.view', 'View WhatsApp connection status and templates'),
  ('whatsapp.manage', 'Connect/reconfigure the company WhatsApp number');

-- company_owner: full access
insert into role_permissions (role, permission_key)
select 'company_owner', key from permissions;

-- company_admin: same operational access as owner (no distinct "ownership
-- transfer" concept modeled in the MVP)
insert into role_permissions (role, permission_key)
select 'company_admin', key from permissions;

-- manager: operational oversight, no billing, no team/settings/whatsapp management
insert into role_permissions (role, permission_key) values
  ('manager', 'conversations.view'),
  ('manager', 'conversations.reply'),
  ('manager', 'conversations.assign'),
  ('manager', 'leads.view'),
  ('manager', 'leads.manage'),
  ('manager', 'knowledge.view'),
  ('manager', 'ai_settings.view'),
  ('manager', 'usage.view'),
  ('manager', 'whatsapp.view');

-- agent: view and reply to assigned conversations, manage leads they own
insert into role_permissions (role, permission_key) values
  ('agent', 'conversations.view'),
  ('agent', 'conversations.reply'),
  ('agent', 'leads.view'),
  ('agent', 'leads.manage'),
  ('agent', 'knowledge.view');

-- knowledge_editor: manages company information, explicitly no billing access
insert into role_permissions (role, permission_key) values
  ('knowledge_editor', 'knowledge.view'),
  ('knowledge_editor', 'knowledge.manage'),
  ('knowledge_editor', 'ai_settings.view');

-- billing_viewer: invoices only, explicitly no conversation/customer data access
insert into role_permissions (role, permission_key) values
  ('billing_viewer', 'billing.view');

-- viewer: read-only across operational data, no billing, no settings
insert into role_permissions (role, permission_key) values
  ('viewer', 'conversations.view'),
  ('viewer', 'leads.view'),
  ('viewer', 'knowledge.view'),
  ('viewer', 'ai_settings.view'),
  ('viewer', 'usage.view'),
  ('viewer', 'whatsapp.view');
