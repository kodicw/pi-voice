import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // No aliases needed — vitest resolves .js → .ts via its Vite pipeline
    },
  },
});
