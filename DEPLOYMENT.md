# DEPLOYMENT.md

## Overview

| Component        | Target                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| `apps/api`       | Cloudflare Workers                                                                                      |
| `apps/workers/*` | Cloudflare Workers (queue consumers) + Cron Triggers                                                    |
| `apps/web`       | Cloudflare Workers, via the OpenNext adapter (`apps/web/wrangler.jsonc`) — see `CLOUDFLARE_SETUP.md` §5 |
| Database         | Supabase Postgres                                                                                       |
| Object storage   | Cloudflare R2                                                                                           |

See `CLOUDFLARE_SETUP.md` and `SUPABASE_SETUP.md` for provisioning details;
this file is the deployment sequence.

## Pre-deployment checklist

- [ ] All required environment variables set as Cloudflare Worker
      secrets/vars (see `.env.example`) — never committed.
- [ ] For `apps/web`: `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY`
      configured as the deploy workflow's own environment secrets (these must
      be present at _build_ time, not just as a Worker var — see
      `CLOUDFLARE_SETUP.md` §5), and `scripts/verify-web-staging-config.sh
    <env>` passes.
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
4. **apps/web**: deploy last. Build with `NEXT_PUBLIC_SUPABASE_URL`/
   `NEXT_PUBLIC_SUPABASE_ANON_KEY` set in the _build_ environment (they're
   inlined into the client bundle at `next build` time, not read at
   runtime — see `CLOUDFLARE_SETUP.md` §5), then `wrangler deploy --env
<target>`. Verify `GET /api/health` responds `{"status":"ok",...}`, then
   verify `/login` renders and an unauthenticated request to `/dashboard`
   redirects to `/login`.

## Environments

`apps/api` and `apps/workers/{message-consumer,voice-consumer}`'s
`wrangler.toml` each declare `[env.staging]`/`[env.production]` blocks with
genuinely distinct Worker names, queues, and (for voice-consumer) R2 bucket —
see `CLOUDFLARE_SETUP.md`'s resource-name table for the exact deployed names.
`apps/web/wrangler.jsonc` follows the identical pattern
(`dravonix-dashboard-staging` / `dravonix-dashboard`). There is no shared name
between the two environments, so a staging deploy cannot overwrite, rebind, or
otherwise touch a production resource. Use a distinct Supabase project per
environment too (see `SUPABASE_SETUP.md`) — never point a staging deployment
at the production database; `apps/web`'s approved staging project is
`lshfkxirfbjwlklqwqnf`. `APP_ENV` is set per-environment in each `[env.*]`
block; `packages/config/src/env.ts` enforces production-only guardrails (no
dev tenant selector, no live Razorpay mode without a secret) based on this
value — `scripts/verify-web-staging-config.sh` checks the dev-tenant-selector
guardrail (and that no server-only secret leaked into `apps/web/
wrangler.jsonc`'s committed `vars`) at deploy-preflight time, before either
gate above would even run.

## Rollback

Cloudflare Workers deployments are versioned; `wrangler rollback` reverts
`apps/api`/`apps/workers/*`/`apps/web` to the previous deployment (`apps/web`
deploys as a normal Worker via the OpenNext adapter, so the same rollback
mechanism applies — `wrangler rollback --name dravonix-dashboard-staging`, or
`dravonix-dashboard` for production). Database migrations are forward-only in
this repository (no down-migrations authored yet) — a migration rollback
requires a hand-written compensating migration; avoid deploying a migration
and an application change that depends on it in the same release without a
tested rollback plan.

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
  `apps/workers/message-consumer`, `apps/workers/voice-consumer`,
  `apps/workers/outbound-reconciler`, and `apps/web` (via the OpenNext
  adapter) via `wrangler deploy --env <target_environment>` with a custom-scoped
  `CLOUDFLARE_API_TOKEN`. It takes a `target_environment` input (`staging` or
  `production`) that both selects which `wrangler.toml` `[env.*]` block gets
  deployed (see "Environments" below — genuinely separate Worker/queue/bucket
  names, not just a label) and which GitHub Environment (Settings →
  Environments) gates the run — configure required reviewers on the
  `production` environment there and GitHub will pause the run for manual
  approval before it deploys anything. This is the manual-approval gate;
  there is no separate auto-deploying "staging" pipeline.
- Before either job in `deploy.yml` touches Cloudflare, a `check-ci` job
  queries the GitHub Actions API for the latest completed `ci.yml` run for
  the exact commit SHA being deployed and fails the whole workflow (via
  `core.setFailed`) if that run is missing, still in progress, or concluded
  with anything other than `success`. This is the automated gate satisfying
  "never deploy a commit CI hasn't passed" — the `production` environment's
  required-reviewer approval is a separate, human checkpoint on top of it,
  not a substitute for it. Both gates apply regardless of which environment
  is selected.

This exists specifically because Cloudflare Workers Builds' git-integration
auto-deploy (its own separate mechanism) uses an auto-provisioned deploy token
that **cannot** manage Queues — every deploy through it silently drops the
`queues.producers`/`queues.consumers` bindings declared in each
`wrangler.toml`, requiring them to be re-added by hand in the dashboard after
every single push (this was hit repeatedly and is the reason this pipeline
exists). A custom token with real Queues permission does not have this
problem, so bindings declared in `wrangler.toml` stay applied permanently.

## Cloudflare Workers Builds still auto-deploying — required manual action

If commit checks show `ci.yml` passing (validation only) while
`dravonixapp`, `dravonix-whatsapp-ai-platform`, and/or `dravonix-audio` still
show a new Cloudflare build on every push, that build is **not** coming from
anything in this repository's GitHub Actions config. This has been verified
directly: `.github/workflows/` contains exactly two files, `ci.yml` and
`deploy.yml`. `ci.yml` never runs `wrangler deploy` (dry-run only, no
Cloudflare credentials in scope). `deploy.yml` only runs on manual
`workflow_dispatch` and is gated by the `check-ci` job and, for `production`,
GitHub Environment reviewer approval — it never fires on `push`. There is no
third workflow, no `cloudflare/wrangler-action`/`cloudflare/pages-action` step
anywhere in the repo, and no repo-committed config (e.g. a bots `settings.yml`
or `CODEOWNERS`) that could reference or trigger one. **No GitHub workflow in
this repository is unintentionally triggering Cloudflare Workers Builds.**

Workers Builds is a separate, Cloudflare-native git integration: Cloudflare's
own "Workers & Pages" GitHub App is installed against this repository
independently of anything in `.github/workflows/`, and it triggers its own
build directly from GitHub's push webhook — nothing in this repo can disable
it. It can only be turned off from the Cloudflare side, and this is a
required manual action if the architecture above (`ci.yml` validates,
`deploy.yml` is the only deploy path) is to actually hold:

1. **Disconnect the Git build integration for all three Workers**, once each,
   in the Cloudflare Dashboard: **Workers & Pages → `dravonixapp` → Settings →
   Builds → Disconnect**; repeat for `dravonix-whatsapp-ai-platform` and
   `dravonix-audio`. This removes only the git-triggered auto-build — it does
   not unpublish, roll back, or otherwise touch the currently deployed
   version.
2. Once disconnected, `deploy.yml` (`workflow_dispatch` + GitHub Environment
   approval) is the **only** path anything gets deployed through — there is
   no second mechanism left to race it or silently re-wipe `wrangler.toml`'s
   Queues bindings.
3. **Check GitHub → Settings → Branches → branch protection rules → required
   status checks.** If a Cloudflare Workers Builds check (its name varies,
   e.g. something under "Cloudflare Pages" or the Worker's own build check)
   is currently listed as required, remove it once the integration above is
   disconnected — a required check that can never report again permanently
   blocks every future merge.
4. **The three Workers and their currently deployed routes are preserved** —
   disconnecting the build integration is a GitHub-App-permission change on
   Cloudflare's side, not a deploy, delete, or rollback action.
5. **Do not delete any Worker** as part of this. `dravonixapp`,
   `dravonix-whatsapp-ai-platform`, and `dravonix-audio` keep running exactly
   as currently deployed.
6. **Do not deploy production** as part of performing this disconnect — it's
   a dashboard-only change with no interaction with `deploy.yml`.

**Old check results don't retroactively clean up.** GitHub's commit-check
list is attached permanently to the commit it ran against; disconnecting
Workers Builds today does not remove or update the Workers Builds check
entries already recorded against past commits — that history is immutable.
To see a clean check list with only `ci.yml`/`deploy.yml` (and no dangling
Cloudflare Workers Builds entry), push a new commit after disconnecting and
look at _that_ commit's checks, not an old one's.

### One-time setup

1. Create a Cloudflare API token (My Profile → API Tokens → Create Token →
   Custom): **Account → Workers Queues → Edit**, **Account → Workers
   Scripts → Edit**, scoped to the account these Workers live in.
2. Create the staging queues and R2 bucket (`CLOUDFLARE_SETUP.md` §2–3) — the
   production ones already exist. `wrangler deploy --env staging` fails with
   "queue/bucket does not exist" until these are created.
3. Create `staging` and `production` environments (Settings → Environments).
   Add `CLOUDFLARE_API_TOKEN` (the token above) and `CLOUDFLARE_ACCOUNT_ID`
   (Cloudflare dashboard → Workers & Pages → Overview, right sidebar) as
   environment secrets on each — as repository-level secrets if both
   environments currently share one Cloudflare account, or scoped
   per-environment once separate accounts/tokens exist. Add required
   reviewers to the `production` environment so `deploy.yml` pauses for
   approval whenever `target_environment: production` is selected.
4. **Disable Workers Builds' git integration** for `dravonixapp`,
   `dravonix-whatsapp-ai-platform`, and `dravonix-audio` — see "Cloudflare
   Workers Builds still auto-deploying — required manual action" above for
   the full step-by-step. Leaving both mechanisms active means both deploy on
   the same push — redundant, and Workers Builds' would still periodically
   wipe the Queues bindings this pipeline exists to fix.

To deploy, go to Actions → Deploy → Run workflow, pick `staging` or
`production`, and run it.
