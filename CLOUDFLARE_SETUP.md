# CLOUDFLARE_SETUP.md

## Resources needed

| Resource                       | Used by                                                                                   | Purpose                                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Workers                        | `apps/api`, `apps/workers/*`                                                              | HTTP API + queue consumers                                                                                            |
| Queues                         | `apps/api` (producer), `apps/workers/*` (consumers)                                       | async message/voice/billing/knowledge/notification processing                                                         |
| R2 bucket                      | `apps/workers/voice-consumer`, `apps/workers/knowledge-consumer` (via `packages/storage`) | temporary audio + processed media                                                                                     |
| Workers (via OpenNext adapter) | `apps/web`                                                                                | Next.js dashboard hosting (see §5 — deployed as a Worker, not Cloudflare Pages)                                       |
| Cron Triggers                  | `apps/workers/billing-consumer`, `apps/workers/outbound-reconciler`                       | grace-period checks, usage aggregation, retention cleanup, outbound-message lease-expiry sweep (Human Handover Inbox) |

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
| Dashboard Worker (`apps/web`)    | `dravonix-dashboard-staging`                             | `dravonix-dashboard`                       |
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

`apps/web` deploys as a Cloudflare Worker via the OpenNext adapter
(`@opennextjs/cloudflare`), **not** Cloudflare Pages — this keeps it
consistent with `apps/api`/`apps/workers/*` (one Cloudflare product, one
deploy mechanism, one `wrangler deploy --env` convention) instead of
introducing a second hosting product. `apps/web/wrangler.jsonc` declares
`env.staging`/`env.production` blocks with distinct Worker names
(`dravonix-dashboard-staging` / `dravonix-dashboard`), exactly like every
other Worker in this repo — a staging deploy cannot collide with production.

### Required environment variables

| Variable                          | Where it's set                                                  | Browser-exposed? |
| --------------------------------- | --------------------------------------------------------------- | ---------------- |
| `NEXT_PUBLIC_SUPABASE_URL`        | **Build-time only** — the CI job's own `env:` (see below)       | Yes (by design)  |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`   | **Build-time only** — the CI job's own `env:` (see below)       | Yes (by design)  |
| `SUPABASE_URL`                    | `wrangler secret put SUPABASE_URL --env <env>`                  | No               |
| `SUPABASE_ANON_KEY`               | `wrangler secret put SUPABASE_ANON_KEY --env <env>`             | No               |
| `SUPABASE_SERVICE_ROLE_KEY`       | `wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env <env>`     | **Never**        |
| `APP_ENV`                         | `wrangler.jsonc` `vars` (already set: `staging` / `production`) | No               |
| `PLATFORM_*` (branding, optional) | `wrangler.jsonc` `vars` if overriding the default brand         | No               |

**`SUPABASE_SERVICE_ROLE_KEY`'s scope in this app is deliberately narrow —
audited, not assumed:** every ordinary dashboard read/write (Leads,
Conversations, Human Handover assign/start/pause/close, company switching,
tenant resolution) runs on the signed-in user's own RLS-scoped session, never
this key. It is read by exactly one module,
`apps/web/lib/supabase/serviceRole.ts` (guarded by `import "server-only"`,
enforced by `apps/web/test/serviceRoleGuard.test.ts`), consumed by exactly
one Server Action, `reconcileAiOutboundMessageAction` — because migration
12's `reconcile_outbound_message` RPC only permits reconciling an
AI-authored message for a caller with **no** `auth.uid()` at all, an
authenticated dashboard JWT structurally cannot perform that one operation,
regardless of permissions. If a future change ever needs this key for
anything else, treat that as a new, separately-audited surface, not an
extension of this one.

**The build-time vs runtime distinction matters and is easy to get wrong:**
Next.js inlines every `NEXT_PUBLIC_*` reference into the client JavaScript
bundle at `next build` time (which `opennextjs-cloudflare build` runs
internally) — setting `NEXT_PUBLIC_SUPABASE_URL` as a Worker `vars`/secret
has **no effect** on an already-built bundle, since that code path never
re-reads `process.env` at request time. `SUPABASE_URL`/`SUPABASE_ANON_KEY`
(no `NEXT_PUBLIC_` prefix) are read server-side, at request time, by the
deployed Worker — those genuinely do come from `wrangler.jsonc` `vars`/
`wrangler secret put`, the normal way. `.github/workflows/deploy.yml` sets
`NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` from that
workflow's own environment-scoped secrets (Settings → Environments →
staging/production) immediately before the build step — configure those
once there, they are never committed.

`DEV_TENANT_SELECTOR_ENABLED` must not be set (or must be `false`) for either
environment — `packages/config/src/env.ts` already refuses to start if
`APP_ENV` is `staging`/`production` and this is `true`, and
`scripts/verify-web-staging-config.sh` checks the same thing at
deploy-preflight time, before any Cloudflare credential is used.

### One-time setup

```bash
cd apps/web
npx wrangler secret put SUPABASE_URL --env staging
npx wrangler secret put SUPABASE_ANON_KEY --env staging
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging
# repeat all three for --env production, pointed at the production Supabase project
```

All three are provisioned as Worker secrets, not committed `wrangler.jsonc`
`vars` — this repo's convention keeps every Supabase connection value
(including the technically-non-sensitive URL/anon key) out of the committed
file entirely, so a `git diff` of `wrangler.jsonc` never needs to be
Supabase-project-aware. `scripts/verify-web-staging-config.sh`, run with
`DVX_PREFLIGHT_REQUIRE_RUNTIME_SECRETS=true` (only set by `deploy.yml`'s own
deploy job), confirms `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY`
are present before the build step runs — it cannot check the three
`wrangler secret put` values above, since Wrangler itself gives no way to
read a secret's value or even confirm its presence without full Cloudflare
authentication; verifying those three is the one part of this process that
stays manual (`wrangler secret list --env staging`, name only, right after
provisioning).

**Environment separation is enforced by GitHub's Environment feature, not by
this workflow's YAML — configure it correctly or staging can silently
resolve production values:** `deploy.yml`'s `deploy` job already declares
`environment: ${{ inputs.target_environment }}` (resolves to exactly
`staging` or `production`, enforced by the `workflow_dispatch` input's own
`type: choice` enumeration — GitHub rejects any other value before the run
even starts). GitHub Actions resolves a same-named secret from that job's
bound Environment first, falling back to a repository-level secret of the
same name if no environment-scoped one exists. This means: if
`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`/`NEXT_PUBLIC_SUPABASE_URL`/
`NEXT_PUBLIC_SUPABASE_ANON_KEY` are ever configured only as repository-level
secrets (Settings → Secrets and variables → Actions) instead of
**environment-scoped** secrets (Settings → Environments → staging → Add
secret, and separately for production), a staging run and a production run
would resolve the _same_ value for that secret — with no error from this
workflow, since a script running inside the job cannot distinguish "this
came from the staging Environment" from "this came from the repo." Always
add these four under the **environment**, never only at the repository
level, and verify **separately** for staging and production.

### Required manual action — Supabase Auth redirect URLs (NOT yet performed)

`apps/web/app/auth/callback/route.ts` completes Supabase's magic-link/
password-reset flow by exchanging a code for a session and redirecting back
into the dashboard. Supabase only allows that redirect to a URL that's on
the project's own allow-list — against `localhost` today, nothing else. Once
this branch's staging Worker has an assigned `*.workers.dev` URL (or a custom
domain, if one is mapped to it), the following must be added, **by a human,
in the Supabase dashboard**, before staging sign-in/password-reset email
links will work end to end:

- **Authentication → URL Configuration → Redirect URLs**: add
  `https://<staging-dashboard-url>/auth/callback`.
- **Authentication → URL Configuration → Site URL**: only needs to change if
  password-reset/magic-link emails should point at the staging dashboard by
  default instead of `localhost` — confirm with whoever owns the staging
  Supabase project (`lshfkxirfbjwlklqwqnf`) before changing this, since it
  affects every auth email the project sends, not just this one flow.

This is **not** done as part of this branch — it requires the exact staging
URL (confirmed only after the first staging deploy is approved and run) and
a change to the Supabase project's Auth settings, both explicitly out of
scope for this preparation-only round (see `DEPLOYMENT.md`'s staging
checklist). `SUPABASE_SETUP.md` does not document this yet either — add it
there once the staging URL is confirmed and this step has actually been
performed.

### Deploying

Deployment goes through `.github/workflows/deploy.yml` alongside the other
four services (same `workflow_dispatch`, same `check-ci` gate, same
`target_environment` input) — see `DEPLOYMENT.md`. To run the equivalent
manually:

```bash
cd apps/web
NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
  pnpm exec opennextjs-cloudflare build
pnpm exec wrangler deploy --env staging      # or --env production
```

### Smoke test after deploying

`GET /api/health` (unauthenticated, no Supabase call) returns
`{"status":"ok","appEnv":"staging"}` — confirms the Worker is serving and
reports the environment it was actually built/deployed for. Beyond that,
confirm: `/login` renders, an unauthenticated request to `/dashboard`
redirects to `/login`, and `/dashboard` itself is reachable after signing in.

### Rollback

`apps/web` deploys as a normal versioned Cloudflare Worker via `wrangler
deploy` (through the OpenNext adapter) — `wrangler rollback --name
dravonix-dashboard-staging` (or `dravonix-dashboard` for production) reverts
to the previous deployed version, the same as `apps/api`/`apps/workers/*`.

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
