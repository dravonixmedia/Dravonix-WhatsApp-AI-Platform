/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@dravonix/config"],
  webpack: (config) => {
    // packages/* source uses explicit ".js" extensions on relative imports
    // (TypeScript's "Bundler" moduleResolution convention, resolved to the
    // sibling .ts file by tsc/vitest). Webpack needs the same alias to follow
    // suit when apps/web imports those workspace packages directly from source.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
