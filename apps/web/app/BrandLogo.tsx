import { platformBrand } from "@dravonix/config";

// Official asset dimensions (apps/web/public/branding/*.webp), used as
// explicit width/height so the browser reserves layout space before the
// image loads -- prevents layout shift, never re-derives/crops the asset.
const LOGO_ASPECT = { width: 2000, height: 571 };
const ICON_ASPECT = { width: 1872, height: 1869 };

export function BrandLogo({ height = 32 }: { height?: number }) {
  const width = Math.round((LOGO_ASPECT.width / LOGO_ASPECT.height) * height);
  return (
    <img
      src={platformBrand.logoPath}
      alt="Dravonix"
      width={width}
      height={height}
      style={{ display: "block", height, width }}
    />
  );
}

export function BrandIcon({ size = 24 }: { size?: number }) {
  const width = Math.round((ICON_ASPECT.width / ICON_ASPECT.height) * size);
  return (
    <img
      src={platformBrand.iconPath}
      alt="Dravonix"
      width={width}
      height={size}
      style={{ display: "block", height: size, width }}
    />
  );
}
