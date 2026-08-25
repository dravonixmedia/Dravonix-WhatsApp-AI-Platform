/**
 * Centralized product branding for Dravonix WhatsApp AI Platform.
 *
 * ADR-0008: every surface (web app, dashboards, emails, invoices, notifications,
 * seed data) reads from `platformBrand` instead of hard-coding the product name.
 * Rebranding is an env-var / asset change here, never a change to chatbot, billing,
 * WhatsApp, AI, voice, or tenant-isolation logic.
 */

export interface SurfaceBranding {
  heading: string;
  subheading?: string;
}

export interface PlatformBrand {
  productName: string;
  shortName: string;
  companyName: string;
  repositorySlug: string;
  internalSlug: string;
  tagline: string;
  websiteUrl: string;
  supportEmail: string;
  /** `mailto:` href for `supportEmail` -- always derived from it, never set independently, so the two can't drift out of sync. */
  supportEmailHref: string;
  logoPath: string;
  iconPath: string;
  faviconPath: string;
  colors: {
    primary: string;
    secondary: string;
    accent: string;
  };
  login: SurfaceBranding;
  dashboard: SurfaceBranding;
  email: SurfaceBranding;
  notification: SurfaceBranding;
  invoice: SurfaceBranding;
}

const defaultBrand: PlatformBrand = {
  productName: "Dravonix WhatsApp AI Platform",
  shortName: "Dravonix AI",
  companyName: "Dravonix Media",
  repositorySlug: "dravonix-whatsapp-ai-platform",
  internalSlug: "dravonix-whatsapp-ai-platform",
  tagline: "AI-powered WhatsApp conversations for growing businesses.",
  websiteUrl: "https://dravonix.example",
  supportEmail: "admin@dravonixmedia.com",
  supportEmailHref: "mailto:admin@dravonixmedia.com",
  // Official asset, provided as-is (uploaded WebP, not converted/re-encoded).
  logoPath: "/branding/logo.webp",
  iconPath: "/branding/icon.webp",
  // No dedicated favicon.ico has been supplied yet; the icon-only asset
  // above is used as the browser-tab icon in the meantime (apps/web/app/layout.tsx).
  faviconPath: "/branding/favicon.ico",
  colors: {
    primary: "#1F6FEB",
    secondary: "#0B1220",
    accent: "#22C55E",
  },
  login: { heading: "Sign in to Dravonix WhatsApp AI Platform" },
  dashboard: { heading: "Dravonix WhatsApp AI Platform", subheading: "Dravonix AI" },
  email: { heading: "Dravonix WhatsApp AI Platform" },
  notification: { heading: "Dravonix AI" },
  invoice: { heading: "Dravonix Media" },
};

function overrideFromEnv(brand: PlatformBrand): PlatformBrand {
  const env =
    typeof process !== "undefined" ? process.env : ({} as Record<string, string | undefined>);
  const supportEmail = env.PLATFORM_SUPPORT_EMAIL ?? brand.supportEmail;
  return {
    ...brand,
    productName: env.PLATFORM_PRODUCT_NAME ?? brand.productName,
    shortName: env.PLATFORM_SHORT_NAME ?? brand.shortName,
    companyName: env.PLATFORM_COMPANY_NAME ?? brand.companyName,
    supportEmail,
    // Always derived from supportEmail (lower-cased -- mailto: hrefs don't
    // need to preserve display casing) so an env override can never leave
    // the visible address and the link it's wrapped in out of sync.
    supportEmailHref: `mailto:${supportEmail.toLowerCase()}`,
    websiteUrl: env.PLATFORM_WEBSITE_URL ?? brand.websiteUrl,
  };
}

export const platformBrand: PlatformBrand = overrideFromEnv(defaultBrand);

/** Build a page title consistent with the platform brand, e.g. "Inbox · Dravonix AI". */
export function pageTitle(section?: string): string {
  return section ? `${section} · ${platformBrand.shortName}` : platformBrand.productName;
}
