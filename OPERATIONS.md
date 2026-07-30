# OPERATIONS.md

Runbooks for common operational situations.

## Webhook delivery failing / Meta shows errors

1. Check `apps/api`'s `/health` and `/ready` endpoints.
2. Query `webhook_events` for recent rows with `status = 'failed'` or
   unusually high volume of `status = 'unrouted'` (indicates a phone number
   isn't correctly registered in `whatsapp_phone_numbers`).
3. Signature failures return 401 and are never enqueued or persisted with
   full detail beyond the rejection log line — check Worker logs for "Rejected
   WhatsApp webhook: invalid signature" and verify `META_APP_SECRET` matches
   the Meta App's current secret (App secrets can be rotated/reset in the Meta
   dashboard).

## Dead-letter queue has messages

Per ADR-0003, a job that fails validation or repeatedly throws lands in the
matching `*-dlq` queue and should be visible via `job_failures` (status
`dead_letter`). Until the super-admin dead-letter UI exists (`TASKS.md`),
inspect `job_failures` directly:

```sql
select * from job_failures where status = 'dead_letter' order by created_at desc limit 50;
```

Common causes: a payload that no longer matches the current
`payloadVersion` (a schema change), a downstream provider outage, or a bug in
the consumer. Fix the root cause, then re-drive the payload (re-send to the
originating queue) rather than editing `job_failures` rows directly.

## A company reports the chatbot "isn't responding"

Check, in order:

1. `subscriptions.state` for the company — if `suspended`,
   `manually_suspended`, or `closed`, this is expected behavior
   (`packages/billing`'s entitlement guard blocks Claude/WhatsApp send
   entirely — see `BILLING_AND_SUSPENSION.md`). Direct them to billing.
2. `conversations.state` for the specific conversation — if `human_active`,
   `paused`, or `handover_requested`, the AI is intentionally not replying
   (Master Prompt section 16). Check who it's assigned to.
3. `whatsapp_phone_numbers.status` — if not `connected`, the WhatsApp
   connection itself has degraded (token expiry, permission error).
4. Recent entries in `job_failures` for the `message-consumer` queue.

## Usage approaching a plan limit

`usage_summaries` aggregates `usage_events` per billing period per metric.
Compare against `plan_entitlements`/`company_entitlements`'s `numeric_limit`
for the relevant `feature_key`. A client-facing warning notification
(category `usage_threshold_reached`, audience `company_admin` only — see
`packages/notifications`) should fire before the hard limit is enforced by the
entitlement guard; wiring the threshold-check job is tracked in `TASKS.md`.

## Rotating a provider credential

1. Generate the new credential (Meta System User token, Anthropic API key,
   Google service-account key, Razorpay key) in that provider's dashboard.
2. Update the corresponding Cloudflare Worker secret
   (`wrangler secret put <NAME>`) — this takes effect on the next Worker
   invocation, no redeploy required.
3. For a per-company credential (a client's WhatsApp access token), update
   `whatsapp_accounts.encrypted_access_token` (encrypted at rest — never log
   the raw value) and `token_expires_at`.
4. Revoke the old credential at the provider once the new one is confirmed
   working.

## Retention cleanup not running

Temporary audio and other retention-governed media
(`media_files.retention_expires_at`) should be deleted by a scheduled job
using `packages/storage/src/retention.ts`'s `selectExpiredMedia`. If storage
usage grows unexpectedly, verify the Cron Trigger for this job is configured
(`CLOUDFLARE_SETUP.md` §6) and check `job_failures` for the relevant queue.

## Support access to a client's workspace

Platform support staff must use the audited support-access workflow
(`support_access_sessions` — time-limited, reason-logged) rather than any
back-door query, per Master Prompt section 9. Every such session is also an
`audit_logs` entry. If a support session appears to still be "active" longer
than expected, check `support_access_sessions.ended_at`.
