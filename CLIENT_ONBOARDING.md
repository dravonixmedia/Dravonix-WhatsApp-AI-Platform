# CLIENT_ONBOARDING.md

Dravonix Media's process for onboarding a new client company onto the
Dravonix WhatsApp AI Platform.

## 1. Company creation (super-admin)

- Create the company record (`companies`, status starts at `onboarding`).
- Record the one-time implementation/service charge (`service_charges`) with
  the agreed amount, tax, and discount.
- Assign a subscription plan (`plans`/`plan_versions`) and, if applicable, a
  trial period.

## 2. Consultation & configuration

- Company profile: name, branding, timezone, default currency
  (`company_settings`, `company_branding`).
- Approved services/products/pricing/policies/business hours: entered as
  `knowledge_sources` (types `service`, `product`, `pricing`, `policy`,
  `location`) — this is what grounds the AI's answers (see ADR-0004; the AI
  must never invent facts not present here).
- FAQs (`knowledge_sources` type `faq`).
- Enabled languages, tone, confidence threshold, restricted topics, required
  disclaimers, static fallback message (`company_settings`, `ai_settings`).
- Voice configuration: enabled languages' default voices, speaking rate, max
  reply/incoming durations, reply mode, retention days (`voice_settings`).
- Handover rules (`handover_rules`): which triggers escalate to a human for
  this company, beyond the platform defaults.
- Lead form configuration per service/product/campaign/intent (`lead_fields`),
  if the company wants structured lead capture instead of free-form
  extraction.

## 3. WhatsApp connection

See `WHATSAPP_PRODUCTION_SETUP.md` for the manual (Dravonix-assisted) flow.
Verify webhook health and test-send/receive a message before going live.

## 4. Staff onboarding

- Invite company staff (`company_members`) with appropriate roles
  (`company_owner`, `company_admin`, `manager`, `agent`, `knowledge_editor`,
  `billing_viewer`, `viewer` — see the permission matrix in
  `supabase/migrations/00000000000009_permission_matrix.sql`).
- Basic training: inbox usage, human handover, taking over/returning
  conversations to AI, adding notes, managing leads.

## 5. Testing

- Send test messages in each of the company's enabled languages.
- Send a test voice note if voice is enabled for the plan.
- Verify a pricing/policy question the AI has no knowledge for correctly
  triggers `requiresHuman` rather than inventing an answer.
- Verify human handover: an agent takes over, the AI stops replying, the agent
  hands back, and the AI resumes.

## 6. Go-live gate

A company may not move to `active` production status until:

- The implementation/service charge is `paid`, `waived`, or a recorded
  super-admin override exists.
- The WhatsApp connection status is `connected`.
- The subscription is in an active (or trial) internal state.

This gate is enforced by application logic reading `service_charges.status`,
`whatsapp_phone_numbers.status`, and `subscriptions.state` together — not by a
single flag — so onboarding progress stays inspectable at each step.

## Responsibility split

| Responsibility                              | Owner                                                   |
| ------------------------------------------- | ------------------------------------------------------- |
| Meta Business Manager / WABA setup          | Client (with Dravonix assistance)                       |
| Company knowledge content accuracy          | Client                                                  |
| Platform configuration, testing, deployment | Dravonix Media                                          |
| Ongoing subscription/usage/billing          | Dravonix Media (billed to client)                       |
| Staff training                              | Dravonix Media (initial), client (ongoing team changes) |
