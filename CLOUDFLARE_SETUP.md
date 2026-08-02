# CLOUDFLARE_SETUP.md

## Resources needed

| Resource                         | Used by                                                                                   | Purpose                                                                                                               |
| -------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Workers                          | `apps/api`, `apps/workers/*`                                                              | HTTP API + queue consumers                                                                                            |
| Queues                           | `apps/api` (producer), `apps/workers/*` (consumers)                                       | async message/voice/billing/knowledge/notification processing                                                         |
| R2 bucket                        | `apps/workers/voice-consumer`, `apps/workers/knowledge-consumer` (via `packages/storage`) | temporary audio + processed media                                                                                     |
| Pages (or Workers static assets) | `apps/web`                                                                                | Next.js dashboard hosting                                                                                             |
| Cron Triggers                    | `apps/workers/billing-consumer`, `apps/workers/outbound-reconciler`                       | grace-period checks, usage aggregation, retention cleanup, outbound-message lease-expiry sweep (Human Handover Inbox) |

## Deployed resource names (staging vs production)

`apps/api` and `apps/workers/{message-consumer,voice-consumer}`'s `wrangler.toml`
files each declare `[env.staging]` and `[env.production]` blocks with entirely
distinct resource names, so a staging deploy has no name in common with a
production resource for Cloudflare or `wrangler` to collide on. This is the
exact set of names that exist (or need to be created) in the Cloudflare
account — keep this table up to date if any of them change.

| Resource                         | Staging                                                  | Production (live)                          |
| -------------------------------- | -------------------------------------------------------- | ------------------------------------------ |
| API Worker                       | `dravonixapp-staging`                                    | `dravonixapp`                              |
| Message consumer Worker          | `dravonix-whatsapp-ai-platform-staging`                  | `dravonix-whatsapp-ai-platform`            |
| Voice consumer Worker            | `dravonix-audio-staging`                                 | `dravonix-audio`                           |
| Outbound reconciler Worker       | `dravonix-outbound-reconciler-staging`                   | `dravonix-outbound-reconciler`             |
| Message queue                    | `dravonix-message-queue-staging`                         | `dravonix-message-queue`                   |
| Message queue DLQ                | `dravonix-message-queue-staging-dlq`                     | `dravonix-message-queue-dlq`               |
| Voice queue                      | `dravonix-voice-queue-staging`                           | `dravonix-voice-queue`                     |
| Voice queue DLQ                  | `dravonix-voice-queue-staging-dlq`                       | `dravonix-voice-queue-dlq`                 |
| Audio R2 bucket (`AUDIO_BUCKET`) | `dravonix-audio-staging`                                 | `dravonix-audio`                           |
| Supabase project                 | `lshfkxirfbjwlklqwqnf` — see `SUPABASE_SETUP.md` §0, §3a | separate project — see `SUPABASE_SETUP.md` |

The production Worker names/queues above are already deployed and serving
real WhatsApp traffic (see `TASKS.md`); this document does not rename them.
Only the `-staging` counterparts are new and need to be provisioned below.

The generic `billing`/`knowledge`/`notification` queues (see step 2) don't
have per-environment staging names yet because no consumer for them is
deployed — add `-staging` counterparts for each following the same pattern
once `billing-consumer`/`knowledge-consumer`/`notification-consumer` are
built and get their own `wrangler.toml` `[env.*]` blocks.

## 1. Authenticate

```bash
npx wrangler login
```

## 2. Create the queues

Production (already exists — listed for reference, do not recreate):

```bash
npx wrangler queues create dravonix-message-queue
npx wrangler queues create dravonix-message-queue-dlq
npx wrangler queues create dravonix-voice-queue
npx wrangler queues create dravonix-voice-queue-dlq
npx wrangler queues create dravonix-billing-queue
npx wrangler queues create dravonix-billing-queue-dlq
npx wrangler queues create dravonix-knowledge-queue
npx wrangler queues create dravonix-knowledge-queue-dlq
npx wrangler queues create dravonix-notification-queue
npx wrangler queues create dravonix-notification-queue-dlq
```

Staging (create these before the first staging deploy — `wrangler deploy
--env staging` will fail with "queue does not exist" until they're created):

```bash
npx wrangler queues create dravonix-message-queue-staging
npx wrangler queues create dravonix-message-queue-staging-dlq
npx wrangler queues create dravonix-voice-queue-staging
npx wrangler queues create dravonix-voice-queue-staging-dlq
```

`apps/api/wrangler.toml` declares producer bindings for the message and voice
queues (per environment), and `apps/workers/message-consumer`/
`apps/workers/voice-consumer` declare the matching consumer bindings,
including `dead_letter_queue`. **These only actually apply if deployed via
`.github/workflows/deploy.yml`** (a custom-scoped `CLOUDFLARE_API_TOKEN`, see
`DEPLOYMENT.md`) -- Cloudflare Workers Builds' own auto-provisioned deploy
token cannot manage Queues at all and silently drops these bindings on every
deploy through it. Add consumer bindings (with `dead_letter_queue` pointing at
the matching `*-dlq`) to `billing-consumer`/`knowledge-consumer`/
`notification-consumer` as those workers are built out (see `TASKS.md`).

## 3. Create the R2 buckets

Production `AUDIO_BUCKET` (already exists):

```bash
npx wrangler r2 bucket create dravonix-audio
```

Staging `AUDIO_BUCKET` (create before the first staging deploy):

```bash
npx wrangler r2 bucket create dravonix-audio-staging
```

Separately, `dravonix-media-dev` is a local-development-only bucket for the
generic `R2_BUCKET_NAME` var (`packages/storage`'s default, not currently
bound by any deployed Worker):

```bash
npx wrangler r2 bucket create dravonix-media-dev
```

## 4. Deploy apps/api, message-consumer, voice-consumer, outbound-reconciler

Deployment is not run by hand — it goes through
`.github/workflows/deploy.yml` (`workflow_dispatch`, `target_environment:
staging|production`; see `DEPLOYMENT.md`). To run the equivalent manually
against a given environment:

```bash
cd apps/api   # or apps/workers/message-consumer, apps/workers/voice-consumer, apps/workers/outbound-reconciler
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging
npx wrangler secret put META_APP_SECRET --env staging
npx wrangler secret put META_VERIFY_TOKEN --env staging
# ... and every other server-only secret from .env.example, once per env
npx wrangler deploy --env staging      # or --env production
```

Secrets set with `wrangler secret put` are **per-environment** — a secret set
without `--env` (or with `--env staging`) is invisible to `--env production`
and vice versa. Set every server-only secret separately for staging and for
production, pointed at that environment's own Supabase project and, for
production, real (not sandbox) Meta/Anthropic/ElevenLabs/Razorpay
credentials. Non-secret variables live in `wrangler.toml`'s `[env.staging]`/
`[env.production]` blocks already (`APP_ENV`, queue/bucket bindings) — add any
further non-secret var there rather than via the dashboard, so it's reviewable
in version control.

## 5. Deploy apps/web

`apps/web` is a standard Next.js app; deploy via Cloudflare Pages
(`npx wrangler pages deploy`) with the OpenNext or `@cloudflare/next-on-pages`
adapter, or to any other Next.js-compatible host. Set `NEXT_PUBLIC_*`
variables in the Pages project's environment configuration — these are the
only variables safe to expose to the browser (see `.env.example`). Use
separate Pages projects (or separate environment configs within one project)
for staging and production, pointed at the matching `apps/api` Worker
(`dravonixapp-staging` vs `dravonixapp`) via `API_URL`/`NEXT_PUBLIC_*`.

## 6. Cron Triggers

Add to the relevant worker's `wrangler.toml` once `billing-consumer` is built
(see `TASKS.md`):

```toml
[triggers]
crons = ["*/15 * * * *"]  # grace-period + suspension check, every 15 minutes
```

Add this inside each of the `[env.staging]`/`[env.production]` blocks (with
whatever cadence makes sense per environment) once that Worker exists, not at
the top level.

## Local development

```bash
cd apps/api
cp ../../.env.example .dev.vars   # then trim to server-only vars and fill in what you have
npx wrangler dev
```

`wrangler dev` runs the Worker locally using the top-level (unnamed
environment) config in `wrangler.toml` — it never touches the `[env.staging]`/
`[env.production]` blocks or any real Cloudflare resource. Queue sends in
local dev are handled by Wrangler's local queue emulation. No live Cloudflare
account resources are required to run the test suite (`pnpm test`) — that
uses the in-memory queue harness in `packages/core/src/queue.ts` instead.
