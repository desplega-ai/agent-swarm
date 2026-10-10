import { defineConfig } from "oxlint";

// Oxlint runs only the anti-slop rules here; Biome stays the main linter.
// The vendored plugin registers every rule, but only the subset below is on.
// See tools/oxlint/anti-slop/UPSTREAM.md before you enable more.
export default defineConfig({
  categories: { correctness: "off" },
  ignorePatterns: [
    "tools/oxlint/anti-slop/**",
    "src/tests/fixtures/**",
    "**/node_modules/**",
    "**/dist/**",
  ],
  jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
  rules: {
    "oxc/no-accumulating-spread": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/no-chained-type-assertions": "error",
  },
  overrides: [
    {
      // Test doubles cast partial fakes on purpose. Production code only, for now.
      files: ["src/tests/**", "**/*.test.ts", "**/*.test.tsx", "packages/ui-e2e/specs/**"],
      rules: { "anti-slop/no-chained-type-assertions": "off" },
    },
  ],
});
