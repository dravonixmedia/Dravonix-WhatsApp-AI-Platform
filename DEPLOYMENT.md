# DEPLOYMENT.md

## Overview

| Component        | Target                                               |
| ---------------- | ---------------------------------------------------- |
| `apps/api`       | Cloudflare Workers                                   |
| `apps/workers/*` | Cloudflare Workers (queue consumers) + Cron Triggers |
| `apps/web`       | Cloudflare Pages (or any Next.js-compatible host)    |
| Database         | Supabase Postgres                                    |
| Object storage   | Cloudflare R2                                        |

See `CLOUDFLARE_SETUP.md` and `SUPABASE_SETUP.md` for provisioning details;
this file is the deployment sequence.

## Pre-deployment checklist

- [ ] All required environment variables set as Cloudflare Worker
      secrets/vars (see `.env.example`) — never committed.
- [ ] Supabase migrations applied (`SUPABASE_SETUP.md` §3) and RLS verified
      (`supabase/tests/README.md`).
- [ ] Seed data applied for at least the plan templates
      (`supabase/seed/001_plans.sql`); demo tenant seed is optional outside a
      demo/staging environment.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` all pass.
- [ ] `ANTHROPIC_MODEL` verified against current Anthropic documentation
      (`ANTHROPIC_SETUP.md`) — not assumed.
- [ ] `RAZORPAY_MODE` set correctly for the target environment (`test` for
      staging/demo, `live` only for a real production deployment with a real
      `RAZORPAY_KEY_SECRET`).
- [ ] Meta webhook callback URL updated to point at the deployed `apps/api`
      domain, and the verify token matches `META_VERIFY_TOKEN`.

## Deployment order

1. **Database**: apply migrations, then seed plan templates.
2. **apps/api**: deploy first (it's what Meta/Razorpay webhooks and apps/web
   both depend on). Verify `/health` and `/ready` respond correctly, then
   verify the Meta webhook handshake succeeds
   (`GET /webhooks/whatsapp?hub.mode=subscribe&...`).
3. **apps/workers/***: deploy each consumer, bound to its queue (see
   `CLOUDFLARE_SETUP.md` §2). Verify a queue message is consumed successfully
   before relying on it in production (send a test message through the full
   webhook → queue → consumer path).
4. **apps/web**: deploy last, pointed at the deployed `apps/api` origin via
   `NEXT_PUBLIC_*`/`API_URL`.

## Environments

Use distinct Cloudflare environments (`wrangler.toml`'s `[env.staging]`,
`[env.production]`) and distinct Supabase projects per environment — never
point a staging deployment at the production database. `APP_ENV` must be set
correctly per environment; `packages/config/src/env.ts` enforces
production-only guardrails (no dev tenant selector, no live Razorpay mode
without a secret) based on this value.

## Rollback

Cloudflare Workers deployments are versioned; `wrangler rollback` reverts
`apps/api`/`apps/workers/*` to the previous deployment. Database migrations are
forward-only in this repository (no down-migrations authored yet) — a
migration rollback requires a hand-written compensating migration; avoid
deploying a migration and an application change that depends on it in the
same release without a tested rollback plan.

## CI vs CD: two separate workflows

`.github/workflows/ci.yml` and `.github/workflows/deploy.yml` are
deliberately separate:

- **`ci.yml`** runs on every push/PR and only validates: lint, format,
  typecheck, unit tests (against the mock Meta/Claude/ElevenLabs/Razorpay
  providers — no provider secrets are set in this workflow, see the comment
  in the `build` job), migration sequence validation, RLS tenant-isolation
  tests, and a build-verification pass (`next build` for `apps/web`,
  `wrangler deploy --dry-run` for `apps/api` and each Worker consumer). It
  never deploys anything and never touches Cloudflare credentials. Failed
  runs upload the RLS test log and dry-run bundle output as a workflow
  artifact for debugging. The job is cancelled if a newer push to the same
  branch/PR arrives (`concurrency` with `cancel-in-progress: true`).
- **`deploy.yml`** is `workflow_dispatch`-only (manually triggered from the
  Actions tab, never on push) and deploys `apps/api`,
  `apps/workers/message-consumer`, and `apps/workers/voice-consumer` via
  `wrangler deploy` with a custom-scoped `CLOUDFLARE_API_TOKEN`. It takes a
  `target_environment` input (`staging` or `production`) that selects a
  GitHub Environment (Settings → Environments) — configure required
  reviewers on the `production` environment there and GitHub will pause the
  run for manual approval before it deploys anything. This is the
  manual-approval gate; there is no separate auto-deploying "staging"
  pipeline.

This exists specifically because Cloudflare Workers Builds' git-integration
auto-deploy (its own separate mechanism) uses an auto-provisioned deploy token
that **cannot** manage Queues — every deploy through it silently drops the
`queues.producers`/`queues.consumers` bindings declared in each
`wrangler.toml`, requiring them to be re-added by hand in the dashboard after
every single push (this was hit repeatedly and is the reason this pipeline
exists). A custom token with real Queues permission does not have this
problem, so bindings declared in `wrangler.toml` stay applied permanently.

Note: `apps/api`/`apps/workers/*`'s `wrangler.toml` files do not yet declare
per-environment `[env.staging]`/`[env.production]` blocks (separate Worker
names, queues, R2 buckets — see "Environments" below), so today both
`target_environment` choices deploy the same underlying Workers; what differs
is which GitHub Environment's reviewers/secrets gate the run. Add the
`[env.*]` blocks and a matching `--env` flag to the deploy commands in
`deploy.yml` once real staging/production separation is provisioned.

### One-time setup

1. Create a Cloudflare API token (My Profile → API Tokens → Create Token →
   Custom): **Account → Workers Queues → Edit**, **Account → Workers
   Scripts → Edit**, scoped to the account these Workers live in.
2. Create `staging` and `production` environments (Settings → Environments).
   Add `CLOUDFLARE_API_TOKEN` (the token above) and `CLOUDFLARE_ACCOUNT_ID`
   (Cloudflare dashboard → Workers & Pages → Overview, right sidebar) as
   environment secrets on each — as repository-level secrets if both
   environments currently share one Cloudflare account, or scoped
   per-environment once separate accounts/tokens exist. Add required
   reviewers to the `production` environment so `deploy.yml` pauses for
   approval whenever `target_environment: production` is selected.
3. **Disable Workers Builds' git integration** for `dravonixapp`,
   `dravonix-whatsapp-ai-platform`, and `dravonix-audio` (each Worker →
   Settings → Build → disconnect/disable). Leaving both mechanisms active
   means both deploy on the same push — redundant, and Workers Builds' would
   still periodically wipe the Queues bindings this pipeline exists to fix.

To deploy, go to Actions → Deploy → Run workflow, pick `staging` or
`production`, and run it.
