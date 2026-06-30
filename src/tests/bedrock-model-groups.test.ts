/**
 * Unit tests for amazon-bedrock model group behaviour in modelGroupsForHarness.
 *
 * Verifies:
 *  - Bedrock group always appears for the pi harness (NEVER blank).
 *  - Live worker-reported models are preferred when present.
 *  - Static snapshot from modelsdev-cache.json is used as fallback.
 *  - Converse-incompatible models listed by AWS but absent from pi-ai's catalog
 *    are NOT in the live list (the intersection is worker-side; this test just
 *    ensures the UI renders what the worker sent, without adding phantom entries).
 *  - Non-pi harnesses do NOT get a Bedrock group.
 */

import { describe, expect, test } from "bun:test";
import {
  type LiveBedrockStatus,
  modelGroupsForHarness,
} from "../../ui/src/lib/agent-runtime-models";

describe("modelGroupsForHarness — Bedrock group for pi harness", () => {
  const configs = undefined;
  const envPresence = undefined;

  test("pi harness always includes an Amazon Bedrock group (NEVER blank)", () => {
    // No live status provided — falls back to static snapshot.
    const groups = modelGroupsForHarness("pi", configs, envPresence);
    const bedrockGroup = groups.find((g) => g.provider === "Amazon Bedrock");
    expect(bedrockGroup).toBeDefined();
    // Static snapshot has 98 models — at least one must be present.
    expect(bedrockGroup!.models.length).toBeGreaterThan(0);
    // All model IDs must be prefixed with the provider.
    for (const m of bedrockGroup!.models) {
      expect(m.id.startsWith("amazon-bedrock/")).toBe(true);
    }
    expect(bedrockGroup!.models.map((m) => m.id)).toContain(
      "amazon-bedrock/anthropic.claude-sonnet-5",
    );
  });

  test("pi harness with no live report → Bedrock group disabled (auth state unknown)", () => {
    const groups = modelGroupsForHarness("pi", configs, envPresence, null);
    const bedrockGroup = groups.find((g) => g.provider === "Amazon Bedrock");
    expect(bedrockGroup).toBeDefined();
    expect(bedrockGroup!.enabled).toBe(false);
  });

  test("pi harness with live report ready:true → Bedrock group enabled + live models", () => {
    const liveStatus: LiveBedrockStatus = {
      ready: true,
      models: [
        { id: "anthropic.claude-sonnet-4-20250514-v1:0", name: "Claude Sonnet 4" },
        { id: "anthropic.claude-haiku-4-5-20251001-v1:0", name: "Claude Haiku 4.5" },
      ],
    };
    const groups = modelGroupsForHarness("pi", configs, envPresence, liveStatus);
    const bedrockGroup = groups.find((g) => g.provider === "Amazon Bedrock");
    expect(bedrockGroup).toBeDefined();
    expect(bedrockGroup!.enabled).toBe(true);
    expect(bedrockGroup!.models).toHaveLength(2);
    expect(bedrockGroup!.models[0]!.id).toBe(
      "amazon-bedrock/anthropic.claude-sonnet-4-20250514-v1:0",
    );
    expect(bedrockGroup!.models[0]!.label).toBe("Claude Sonnet 4");
  });

  test("pi harness with live report ready:false → Bedrock group disabled + live models shown", () => {
    // Auth failed but we still show models so the operator can see what's available.
    const liveStatus: LiveBedrockStatus = {
      ready: false,
      models: [{ id: "anthropic.claude-sonnet-4-20250514-v1:0", name: "Claude Sonnet 4" }],
    };
    const groups = modelGroupsForHarness("pi", configs, envPresence, liveStatus);
    const bedrockGroup = groups.find((g) => g.provider === "Amazon Bedrock");
    expect(bedrockGroup!.enabled).toBe(false);
    expect(bedrockGroup!.models).toHaveLength(1);
  });

  test("pi harness with failed probe surfaces the probe error as disabledReason", () => {
    // A failed probe (ready:false with an error) should surface WHY the group is
    // disabled instead of a silent disable.
    const liveStatus: LiveBedrockStatus = {
      ready: false,
      models: [],
      error: "Token expired — run aws sso login",
    };
    const groups = modelGroupsForHarness("pi", configs, envPresence, liveStatus);
    const bedrockGroup = groups.find((g) => g.provider === "Amazon Bedrock");
    expect(bedrockGroup!.enabled).toBe(false);
    expect(bedrockGroup!.disabledReason).toBe("Token expired — run aws sso login");
  });

  test("pi harness with ready:true → no disabledReason and Bedrock icon key", () => {
    const liveStatus: LiveBedrockStatus = {
      ready: true,
      models: [{ id: "anthropic.claude-sonnet-4-20250514-v1:0", name: "Claude Sonnet 4" }],
    };
    const groups = modelGroupsForHarness("pi", configs, envPresence, liveStatus);
    const bedrockGroup = groups.find((g) => g.provider === "Amazon Bedrock");
    expect(bedrockGroup!.disabledReason).toBeUndefined();
    // Bedrock has its own provider icon — it no longer borrows the OpenRouter glyph.
    expect(bedrockGroup!.models[0]!.providerId).toBe("amazon-bedrock");
  });

  test("pi harness with live report and empty model list → shows empty list (not snapshot fallback)", () => {
    // Worker reported successfully but no models were in the intersection.
    const liveStatus: LiveBedrockStatus = { ready: true, models: [] };
    const groups = modelGroupsForHarness("pi", configs, envPresence, liveStatus);
    const bedrockGroup = groups.find((g) => g.provider === "Amazon Bedrock");
    expect(bedrockGroup!.models).toHaveLength(0);
  });

  test("opencode harness does NOT get a Bedrock group", () => {
    const groups = modelGroupsForHarness("opencode", configs, envPresence);
    const bedrockGroup = groups.find((g) => g.provider === "Amazon Bedrock");
    expect(bedrockGroup).toBeUndefined();
  });

  test("claude harness does NOT get a Bedrock group", () => {
    const groups = modelGroupsForHarness("claude", configs, envPresence);
    const bedrockGroup = groups.find((g) => g.provider === "Amazon Bedrock");
    expect(bedrockGroup).toBeUndefined();
  });

  test("codex harness does NOT get a Bedrock group", () => {
    const groups = modelGroupsForHarness("codex", configs, envPresence);
    const bedrockGroup = groups.find((g) => g.provider === "Amazon Bedrock");
    expect(bedrockGroup).toBeUndefined();
  });

  test("pi harness still returns openrouter/anthropic/openai snapshot groups alongside Bedrock", () => {
    const groups = modelGroupsForHarness("pi", configs, envPresence);
    const providerNames = groups.map((g) => g.provider);
    expect(providerNames).toContain("OpenRouter");
    expect(providerNames).toContain("Anthropic");
    expect(providerNames).toContain("OpenAI");
    expect(providerNames).toContain("Amazon Bedrock");
  });
});
