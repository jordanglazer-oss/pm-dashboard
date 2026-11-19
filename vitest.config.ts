import { defineConfig } from "vitest/config";
import path from "node:path";

// Pure unit tests only — no Redis, no network. Run with `npm test`.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname) } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
