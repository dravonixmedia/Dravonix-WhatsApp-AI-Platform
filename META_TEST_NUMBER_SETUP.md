# META_TEST_NUMBER_SETUP.md (Stage A)

## 1. Create a Meta App with WhatsApp

1. Go to https://developers.facebook.com/apps and create an app (type: Business).
2. Add the **WhatsApp** product. Meta provisions a test WhatsApp Business
   Account (WABA) and one test phone number automatically.
3. Note from the WhatsApp → API Setup page:
   - **Temporary access token** (for early testing; generate a permanent
     System User token before anything long-lived)
   - **Phone number ID** → `META_TEST_PHONE_NUMBER_ID`
   - **WhatsApp Business Account ID** → `META_TEST_WABA_ID`
   - **App ID** → `META_APP_ID`, **App Secret** (App Settings → Basic) → `META_APP_SECRET`

## 2. Configure the webhook

1. WhatsApp → Configuration → Webhook → Edit.
2. Callback URL: `https://<your-api-domain>/webhooks/whatsapp`
   (local development: use a tunnel like `cloudflared tunnel` or `ngrok`
   pointed at `wrangler dev`'s local port).
3. Verify token: any string you choose — set the same value as
   `META_VERIFY_TOKEN`. Meta calls `GET /webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`
   and expects the challenge echoed back exactly
   (`packages/whatsapp/src/signature.ts`'s `verifyMetaWebhookChallenge`, wired
   in `apps/api/src/whatsappWebhookHandler.ts`).
4. Subscribe to the `messages` webhook field.

## 3. Register the test number in the platform

Once your Supabase project is seeded (`SUPABASE_SETUP.md`), connect the test
number to the Dravonix Media demo company:

```sql
insert into whatsapp_accounts (company_id, waba_id, status, is_test_account)
values ('00000000-0000-0000-0000-000000000001', '<META_TEST_WABA_ID>', 'connected', true);

insert into whatsapp_phone_numbers (company_id, whatsapp_account_id, phone_number_id, display_phone_number, status)
select '00000000-0000-0000-0000-000000000001', id, '<META_TEST_PHONE_NUMBER_ID>', '<your test number>', 'connected'
from whatsapp_accounts where waba_id = '<META_TEST_WABA_ID>';
```

(A super-admin "connect WhatsApp manually" UI action is the intended
production path for this — see `TASKS.md`; the SQL above is the equivalent
manual step until that UI exists.)

## 4. Set environment variables

```
META_APP_ID=
META_APP_SECRET=
META_VERIFY_TOKEN=
META_ACCESS_TOKEN=
META_TEST_WABA_ID=
META_TEST_PHONE_NUMBER_ID=
META_GRAPH_API_VERSION=v21.0
```

## 5. Send a test message

WhatsApp → API Setup → "Send messages" panel lets you message your own phone
from the test number to add it as a recipient (Meta test numbers can only
message a small allow-list of recipient numbers you register there). Then send
a real WhatsApp message _to_ the test number from your phone — this triggers
the webhook, which should appear as a processed `messages` row and, once
`apps/workers/message-consumer` is deployed, a generated AI reply.

## Development-only tenant selector

Because Stage A uses a single Meta test number shared across whatever demo
companies you seed, `packages/tenant/src/devTenantSelector.ts` lists
`is_demo = true` companies for a developer to switch between while testing —
gated by `DEV_TENANT_SELECTOR_ENABLED` and refused outright when
`APP_ENV=production` (`packages/config/src/env.ts`). This is a development
convenience, not a routing mechanism: real inbound messages are still routed
by `phone_number_id` (`packages/whatsapp/src/routing.ts`), which only ever
resolves to the one company actually connected to that number.

## Without real Meta credentials

If `META_ACCESS_TOKEN`/`META_TEST_PHONE_NUMBER_ID`/`META_APP_SECRET` are
unset, `env.whatsappConfigured` is `false` and the composition root should use
`MockWhatsAppProvider` (`packages/whatsapp/src/providers/mockProvider.ts`)
instead of `GraphApiWhatsAppProvider` — every send is recorded in-memory
instead of calling the real Graph API, which is exactly how this repository's
own test suite exercises the send path.
