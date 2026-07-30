# INCIDENT_RESPONSE.md

## Severity guide

| Severity | Definition                                        | Example                                                                                   |
| -------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| SEV1     | Platform-wide outage or a tenant-isolation breach | Company A can read Company B's data; apps/api fully down                                  |
| SEV2     | A single company's service is degraded/down       | WhatsApp connection broken for one client; billing webhook failures blocking reactivation |
| SEV3     | Degraded but workable                             | Voice replies failing (falls back to text), elevated latency                              |
| SEV4     | Cosmetic / non-urgent                             | Dashboard UI glitch with no data impact                                                   |

## Immediate steps for any suspected SEV1/SEV2

1. **Confirm scope** using `OPERATIONS.md`'s runbooks — is this one company or
   the whole platform? Check `apps/api` `/health`/`/ready`, `webhook_events`
   volume/status, and `job_failures`.
2. **If it's a suspected tenant-isolation breach**: treat as SEV1
   immediately. Do not attempt to "quietly fix and move on" — this is exactly
   the class of bug `supabase/tests/rls_tenant_isolation.sql` exists to catch;
   re-run it against the affected environment's schema, identify which table's
   RLS policy (or which server-side authorization check in
   `packages/tenant`) is missing or wrong, and patch it before anything else.
   Determine which companies were exposed and what data, for disclosure.
3. **If it's a webhook/queue outage**: check whether Meta/Razorpay's own
   status pages show an incident first — don't assume the bug is ours.
4. **Communicate**: notify affected company admins via the notification
   provider (never expose internal cause details to customer contacts — see
   `packages/notifications`'s billing-audience guard, which is a _pattern_ to
   follow for incident comms too, not just billing).

## Runbook: suspected suspension-guard bypass

If a suspended company appears to still be getting AI/voice/WhatsApp
responses (the opposite of the expected behavior tested in
`packages/billing/test/entitlementGuard.test.ts` and
`apps/workers/message-consumer/test/processMessageJob.test.ts`):

1. Confirm `subscriptions.state` for the company really is
   `suspended`/`manually_suspended`.
2. Check whether the consumer path that handled the recent message actually
   calls `assertCompanyMayUseProvider` before the provider call — a new code
   path added without going through the entitlement guard is the most likely
   root cause (ADR-0006 requires every chargeable operation to call it).
3. Patch the missing check, add a regression test mirroring the existing
   suspended-company tests, deploy, and verify.

## Runbook: AI producing an unsafe/ungrounded answer

1. Pull the `messages.ai_structured_response` for the conversation — check
   `knowledgeSourceIds` and `confidence`.
2. If a pricing/policy/availability claim was made without a cited source,
   `packages/ai/src/safety.ts`'s `applySafetyRules` should have forced
   `requiresHuman`. If it didn't, the claim likely didn't match the
   `UNGROUNDED_CLAIM_PATTERNS` regex set — extend it and add a test case
   reproducing the exact phrasing that slipped through.
3. If the system prompt itself appears to have been overridden by
   customer-supplied text (prompt injection), review
   `packages/ai/src/prompt/buildSystemPrompt.ts`'s anti-injection instructions
   and consider whether structural (not just prompt-level) guards are needed —
   e.g. stripping instruction-like patterns from customer input before
   inclusion, or lowering confidence automatically for messages containing
   known injection markers.

## Post-incident

Record what happened, root cause, and the fix in a dated entry (this
repository does not yet have a formal incident log directory — add
`docs/operations/incidents/YYYY-MM-DD-<slug>.md` as the pattern going forward)
and add or strengthen an automated test that would have caught it, per the
"Definition of Done" principle that functional correctness is proven by tests,
not assumed.
