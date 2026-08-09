import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // `server-only` selects its build through the `react-server` export
      // condition, which only Next sets; anywhere else it resolves to the
      // variant that throws on import. Tests run in node — the very
      // environment these modules are written for — so use the no-op build.
      "server-only": path.resolve(
        import.meta.dirname,
        "node_modules/server-only/empty.js",
      ),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
