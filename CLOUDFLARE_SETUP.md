# CLOUDFLARE_SETUP.md

## Resources needed

| Resource                         | Used by                                                                                   | Purpose                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Workers                          | `apps/api`, `apps/workers/*`                                                              | HTTP API + queue consumers                                    |
| Queues                           | `apps/api` (producer), `apps/workers/*` (consumers)                                       | async message/voice/billing/knowledge/notification processing |
| R2 bucket                        | `apps/workers/voice-consumer`, `apps/workers/knowledge-consumer` (via `packages/storage`) | temporary audio + processed media                             |
| Pages (or Workers static assets) | `apps/web`                                                                                | Next.js dashboard hosting                                     |
| Cron Triggers                    | `apps/workers/billing-consumer`                                                           | grace-period checks, usage aggregation, retention cleanup     |

## 1. Authenticate

```bash
npx wrangler login
```

## 2. Create the queues

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

`apps/api/wrangler.toml` already declares producer bindings for the message
and voice queues; add consumer bindings (with `dead_letter_queue` pointing at
the matching `*-dlq`) to each `apps/workers/*/wrangler.toml` as those workers
are built out (see `TASKS.md`).

## 3. Create the R2 bucket

```bash
npx wrangler r2 bucket create dravonix-media-dev
```

For a production deployment, create a separate bucket per environment
(`dravonix-media-staging`, `dravonix-media-production`) and set
`R2_BUCKET_NAME` accordingly.

## 4. Deploy apps/api

```bash
cd apps/api
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put META_APP_SECRET
npx wrangler secret put META_VERIFY_TOKEN
# ... and every other server-only secret from .env.example
npx wrangler deploy
```

Set non-secret variables (`SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`META_GRAPH_API_VERSION`, `ANTHROPIC_MODEL`, etc.) in the `[vars]` section of
`wrangler.toml` per environment, or via `wrangler.toml`'s `[env.<name>]` blocks
for staging/production.

## 5. Deploy apps/web

`apps/web` is a standard Next.js app; deploy via Cloudflare Pages
(`npx wrangler pages deploy`) with the OpenNext or `@cloudflare/next-on-pages`
adapter, or to any other Next.js-compatible host. Set `NEXT_PUBLIC_*`
variables in the Pages project's environment configuration — these are the
only variables safe to expose to the browser (see `.env.example`).

## 6. Cron Triggers

Add to the relevant worker's `wrangler.toml` once `billing-consumer` is built
(see `TASKS.md`):

```toml
[triggers]
crons = ["*/15 * * * *"]  # grace-period + suspension check, every 15 minutes
```

## Local development

```bash
cd apps/api
cp ../../.env.example .dev.vars   # then trim to server-only vars and fill in what you have
npx wrangler dev
```

`wrangler dev` runs the Worker locally; queue sends in local dev are handled
by Wrangler's local queue emulation. No live Cloudflare account resources are
required to run the test suite (`pnpm test`) — that uses the in-memory queue
harness in `packages/core/src/queue.ts` instead.
