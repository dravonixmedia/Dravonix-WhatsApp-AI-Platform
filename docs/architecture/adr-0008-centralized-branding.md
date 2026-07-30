# ADR-0008: Centralized product branding

## Status

Accepted

## Context

The product is currently named "Dravonix WhatsApp AI Platform" (short name
"Dravonix AI"), owned by Dravonix Media, but the commercial name, logo, colours,
tagline, and support details may change later. None of chatbot logic, WhatsApp
integration, AI orchestration, voice processing, billing, database architecture,
subscription management, or tenant isolation should need to change when that
happens.

## Decision

- `packages/config/src/branding.ts` exports a single `platformBrand` object (product
  name, short name, company name, tagline, website, support email, logo/favicon
  paths, primary/secondary/accent colours, and per-surface branding blocks for
  login, dashboard, email, notifications, invoices).
- Default values are hard-coded as the current brand (per the Master Prompt, this is
  intentional — Dravonix Media's actual current brand), but every value can be
  overridden via environment variables (`PLATFORM_PRODUCT_NAME`,
  `PLATFORM_SHORT_NAME`, `PLATFORM_COMPANY_NAME`, `PLATFORM_SUPPORT_EMAIL`,
  `PLATFORM_WEBSITE_URL`, etc.) validated by `packages/config/src/env.ts`.
- `apps/web` reads `platformBrand` for page titles, metadata, login/dashboard
  headers, and email/notification templates; no component hard-codes the product
  name as a literal string.
- Domain packages (`ai`, `whatsapp`, `billing`, `speech`, `tenant`, `database`) have
  **no** dependency on `packages/config`'s branding module — they depend only on
  `packages/config`'s env/entitlement values where genuinely needed (e.g. model ID),
  never on display branding. This is enforced by convention and spot-checked in code
  review; a lint rule restricting cross-package imports can be added if violations
  appear.

## Consequences

- Rebranding is a config/env change plus asset replacement, not a source change to
  any business-logic package.
- Seed data, documentation, and generated invoices reference `platformBrand` rather
  than a literal string, so branding stays consistent everywhere it appears.
