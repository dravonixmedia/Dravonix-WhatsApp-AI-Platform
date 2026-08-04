import type { Metadata } from "next";
import { platformBrand } from "@dravonix/config";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: platformBrand.productName,
    template: `%s · ${platformBrand.shortName}`,
  },
  description: platformBrand.tagline,
  // No dedicated favicon.ico asset has been supplied yet; reuse the
  // official icon-only mark directly (same bytes, no format conversion)
  // rather than fabricate a converted .ico.
  icons: { icon: { url: platformBrand.iconPath, type: "image/webp" } },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
