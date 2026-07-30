import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "apps/workers/*/test/**/*.test.ts",
      "supabase/tests/**/*.test.ts",
    ],
    environment: "node",
    globals: false,
  },
});
