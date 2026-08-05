import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// The default (in-memory, request-scoped) cache is intentionally kept here
// rather than opting into the R2 incremental cache: every /dashboard/* route
// in this app is already `export const dynamic = "force-dynamic"` (real,
// per-request Supabase Auth session data -- see apps/web/app/dashboard/
// layout.tsx), so there is no static/ISR page in this app for an R2-backed
// cache to actually help with today. Revisit if a future route adds real
// static regeneration.
export default defineCloudflareConfig();
