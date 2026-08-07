import type { Metadata } from "next";
import { Space_Grotesk } from "next/font/google";
import { platformBrand } from "@dravonix/config";
import "./globals.css";

// Official Dravonix typeface. next/font self-hosts the fetched font files as
// static build assets (no runtime request to Google Fonts, no layout-shift
// flash) -- the CSS variable it exposes is consumed once, in globals.css's
// `body` rule, rather than referenced ad hoc per component.
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
});

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
    <html lang="en" className={spaceGrotesk.variable}>
      <body>{children}</body>
    </html>
  );
}
