# BRANDING_CONFIGURATION.md

## Where branding lives

Everything is in one place: `packages/config/src/branding.ts`, exporting a
single `platformBrand` object (ADR-0008):

```typescript
export const platformBrand: PlatformBrand = {
  productName: "Dravonix WhatsApp AI Platform",
  shortName: "Dravonix AI",
  companyName: "Dravonix Media",
  repositorySlug: "dravonix-whatsapp-ai-platform",
  internalSlug: "dravonix-whatsapp-ai-platform",
  tagline: "...",
  websiteUrl: "...",
  supportEmail: "...",
  logoPath: "/branding/logo.svg",
  faviconPath: "/branding/favicon.ico",
  colors: { primary: "...", secondary: "...", accent: "..." },
  login: { heading: "..." },
  dashboard: { heading: "...", subheading: "..." },
  email: { heading: "..." },
  notification: { heading: "..." },
  invoice: { heading: "..." },
};
```

## Changing the brand

Two ways, and both work without touching any other package:

1. **Environment variables** (no code change, no redeploy of business logic):
   `PLATFORM_PRODUCT_NAME`, `PLATFORM_SHORT_NAME`, `PLATFORM_COMPANY_NAME`,
   `PLATFORM_SUPPORT_EMAIL`, `PLATFORM_WEBSITE_URL` override the corresponding
   defaults at runtime (`packages/config/src/branding.ts`'s `overrideFromEnv`).
2. **Editing the defaults** in `packages/config/src/branding.ts` directly —
   for colours, logo/favicon paths, taglines, and per-surface headings that
   don't have an env-var override yet (add one following the same pattern if
   needed).

Replace the actual logo/favicon **asset files** (referenced by `logoPath`/
`faviconPath`) in `apps/web/public/branding/` (create this directory as part
of a rebrand — not present in this repository since only placeholder paths
are referenced so far).

## Where it's consumed

- `apps/web/app/layout.tsx` — page `<title>` and metadata.
- `apps/web/app/login/page.tsx`, every `apps/web/app/dashboard/*/page.tsx` —
  headings and copy.
- Seed data (`supabase/seed/002_demo_tenant.sql`) references "Dravonix Media"
  as the seeded demo company name, independent of `platformBrand` (a seeded
  company's own name is data, not platform branding — see the distinction
  below).
- Future: email templates, WhatsApp notification templates, and generated
  invoices should all read `platformBrand.email`/`.notification`/`.invoice`
  respectively once those features are built (`TASKS.md`).

## What must never depend on `platformBrand`

Per ADR-0008, these packages depend on `packages/config` **only** for
environment/entitlement values (e.g. `ANTHROPIC_MODEL`), never for display
branding: `packages/ai`, `packages/whatsapp`, `packages/billing`,
`packages/speech`, `packages/tenant`, `packages/database`. This is enforced by
convention and code review today; if a violation is ever found, it's a bug —
the fix is to remove the import, not to add a branding dependency to a
business-logic package.

## Platform branding vs. a company's own branding

Two distinct concepts, both real, don't conflate them:

- **`platformBrand`** (`packages/config`) — Dravonix Media's own product
  identity, shown on login, the super-admin dashboard, platform emails, and
  anywhere the _platform itself_ is being referred to.
- **`company_branding` table** — each client company's own display name,
  logo, and colours for _their_ customer-facing surfaces (e.g. a WhatsApp
  welcome message signed with their brand, not Dravonix's). Changing one never
  affects the other.
