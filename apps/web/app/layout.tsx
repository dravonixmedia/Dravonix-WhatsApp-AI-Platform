import type { Metadata } from "next";
import { platformBrand } from "@dravonix/config";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: platformBrand.productName,
    template: `%s · ${platformBrand.shortName}`,
  },
  description: platformBrand.tagline,
  icons: { icon: platformBrand.faviconPath },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
