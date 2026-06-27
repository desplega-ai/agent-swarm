import { describe, expect, test } from "bun:test";
import { join } from "node:path";
// Import the provider FACTORY module DIRECTLY (relative path), NOT the "@swarm/harness"
// barrel — the barrel statically re-exports every adapter, which would defeat the point.
// The factory (packages/harness/src/providers/index.ts) lazy-loads each adapter via dynamic
// import() so heavy adapter SDKs (e.g. @earendil-works/pi-coding-agent) stay OUT of the
// startup module graph (PR#452). This test guards that invariant after the Phase-4 move.
import { createProviderAdapter } from "../../packages/harness/src/providers/index";

const FACTORY_PATH = join(import.meta.dir, "../../packages/harness/src/providers/index.ts");

const PROVIDERS = ["claude", "pi", "codex", "claude-managed", "devin", "opencode"] as const;

const ADAPTER_MODULES = [
  "claude-adapter",
  "pi-mono-adapter",
  "codex-adapter",
  "claude-managed-adapter",
  "devin-adapter",
  "opencode-adapter",
] as const;

describe("harness provider factory — lazy adapter loading", () => {
  test("factory has NO static top-level adapter imports; all 6 load via dynamic import()", async () => {
    const src = await Bun.file(FACTORY_PATH).text();
    // No static `import ... from "...-adapter"` lines may exist — those would pull the heavy
    // adapter SDKs into the module graph at factory-import time and defeat lazy loading.
    const staticAdapterImports = src
      .split("\n")
      .filter((line) => /^\s*import\b/.test(line) && /-adapter/.test(line));
    expect(staticAdapterImports).toEqual([]);
    // Every adapter must be referenced ONLY through a dynamic import() of a relative sibling
    // specifier (which moved together with the factory, so the path stays correct).
    for (const mod of ADAPTER_MODULES) {
      expect(src).toContain(`await import("./${mod}")`);
    }
  });

  test("each provider's dynamic adapter specifier still resolves after the move", async () => {
    expect(typeof createProviderAdapter).toBe("function");
    for (const provider of PROVIDERS) {
      // Adapter construction may legitimately fail for environment reasons, but a
      // module-resolution failure would mean the dynamic import() specifier broke during the
      // monorepo move — that is what this assertion catches.
      try {
        const adapter = await createProviderAdapter(provider);
        expect(adapter).toBeDefined();
      } catch (err) {
        const msg = String((err as { message?: string })?.message ?? err);
        expect(msg).not.toMatch(/Cannot find module|Could not resolve|Failed to resolve module/i);
      }
    }
  });

  test("unknown provider rejects with the documented error", async () => {
    expect(createProviderAdapter("definitely-not-a-provider")).rejects.toThrow(
      "Unknown HARNESS_PROVIDER",
    );
  });
});
