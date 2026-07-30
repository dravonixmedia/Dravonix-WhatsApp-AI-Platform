import { platformBrand } from "@dravonix/config";

export default function SettingsPage() {
  return (
    <div>
      <h1 style={{ fontSize: "1.4rem" }}>Settings</h1>
      <p className="dvx-muted">
        Company profile, AI behavior, voice configuration, team management, and WhatsApp connection
        live here. Rendered with {platformBrand.shortName}&apos;s centralized branding — changing
        the product name, colours, or logo in <code>packages/config/src/branding.ts</code> updates
        every surface, including this page, without touching any chatbot, billing, or tenant logic
        (ADR-0008).
      </p>
    </div>
  );
}
