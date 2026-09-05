import { defineConfig } from "vitest/config";

export default defineConfig({
  // apps/web's own tsconfig.json sets "jsx": "preserve" for Next.js's SWC
  // compiler to transform later -- Vite/esbuild doesn't understand that
  // mode and falls back to the classic React.createElement runtime, which
  // needs a global `React` no test file provides. Force the automatic
  // runtime here, scoped to Vitest's own transform pipeline only; this has
  // no effect on the actual Next.js build, which never goes through Vite.
  esbuild: {
    jsx: "automatic",
  },
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.{ts,tsx}",
      "apps/workers/*/test/**/*.test.ts",
      "supabase/tests/**/*.test.ts",
    ],
    environment: "node",
    globals: false,
  },
});
