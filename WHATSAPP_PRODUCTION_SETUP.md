# WHATSAPP_PRODUCTION_SETUP.md (Stage B)

Stage B is when a real client company connects its **own** WhatsApp Business
Account and phone number, replacing (for that company) the shared Meta test
number used in Stage A. Nothing about the webhook route, message processing,
or AI/billing logic changes between stages — only which `whatsapp_phone_numbers`
row a given `phone_number_id` resolves to (`packages/whatsapp/src/routing.ts`),
which is exactly the abstraction ADR-0002 and section 10 of the Master Prompt
call for.

## Dravonix-assisted manual onboarding (initial Stage B path)

1. The client creates (or grants Dravonix access to) a Meta Business Manager
   account and a WhatsApp Business Account.
2. Dravonix staff (via the super-admin dashboard, once built — see
   `TASKS.md`) creates the company record, then:
   - Records the client's `waba_id` in `whatsapp_accounts`.
   - Records the client's `phone_number_id` in `whatsapp_phone_numbers`.
   - Generates and securely stores a System User access token scoped to that
     WABA (`encrypted_access_token`, encrypted at rest — never logged in
     plaintext, per SECURITY.md).
3. Configure the same webhook callback URL as in `META_TEST_NUMBER_SETUP.md`
   (Dravonix's single API endpoint serves every client — routing is by
   `phone_number_id`, not by URL).
4. Submit and get approval for any WhatsApp message templates the client needs
   (`whatsapp_templates`, tracked via `whatsapp_template_status`).
5. Verify webhook health, then flip the company from `onboarding` to `active`
   status only once:
   - The one-time implementation/service charge is `paid`, `waived`, or a
     super-admin override is recorded (Master Prompt section 19A).
   - The WhatsApp connection is verified (`whatsapp_phone_numbers.status = 'connected'`).

## Meta Embedded Signup (future production onboarding feature)

Embedded Signup lets a client connect their own WABA/number through an
in-dashboard flow without Dravonix staff manually handling credentials.
Implementing it requires:

1. Becoming a Meta **Tech Provider** (or partnering with an existing Solution
   Partner) — an approval process outside this codebase's control.
2. Implementing the Embedded Signup JS SDK flow in `apps/web` (client-side
   popup), which returns a code your backend exchanges for a long-lived System
   User token via the Graph API.
3. On successful exchange, writing the resulting `waba_id`/`phone_number_id`/
   token into the same `whatsapp_accounts`/`whatsapp_phone_numbers` tables used
   by the manual path above — no schema change needed.

This is **not implemented** in this repository (tracked in `TASKS.md` as an
outstanding item pending the Tech Provider approval), but the schema and
provider abstraction (`packages/whatsapp`'s `WhatsAppProvider` interface) are
already shaped so it's an additive onboarding-flow change, not a rewrite.

## Connection health & error handling

`whatsapp_accounts.status`/`whatsapp_phone_numbers.status` use the
`whatsapp_connection_status` enum (`not_connected`, `pending`, `connected`,
`permission_error`, `connection_error`, `disabled`). Token-expiry and
permission-error responses from the Graph API
(`GraphApiWhatsAppProvider`/`WhatsAppProviderError` in
`packages/whatsapp/src/providers/graphApiProvider.ts`) should update this
status and notify the company admin (`packages/notifications`, category
`whatsapp_disconnected`) — this notification wiring is tracked in `TASKS.md`.

## Multiple numbers / branches (Professional plan)

`whatsapp_phone_numbers.company_id` supports many rows per company; the
Professional plan's `whatsapp_numbers` entitlement (see
`supabase/seed/001_plans.sql`) is the numeric cap enforced by
`packages/billing`'s entitlement guard when a company tries to connect an
additional number.
