import { describe, expect, test } from "bun:test";
import type { SwarmConfig } from "../api/types";
import { findCatalogField, getIntegrationFields, INTEGRATIONS } from "./integrations-catalog";
import { deriveIntegrationStatus } from "./integrations-status";

describe("automation integration configure surfaces", () => {
  test("catalogs GSC and AgentFS at their exact dashboard routes", () => {
    const cases = [
      ["gsc", ["GSC_SERVICE_ACCOUNT_BASE64"]],
      [
        "agentfs",
        [
          "AGENT_FS_API_URL",
          "API_AGENT_FS_API_KEY",
          "AGENT_FS_DEFAULT_ORG_ID",
          "AGENT_FS_DEFAULT_DRIVE_ID",
        ],
      ],
    ] as const;

    for (const [id, requiredKeys] of cases) {
      const integration = INTEGRATIONS.find((candidate) => candidate.id === id);
      expect(integration).toBeDefined();
      expect(`/settings/integrations/${integration?.id}`).toBe(`/settings/integrations/${id}`);
      expect(
        getIntegrationFields(integration!)
          .filter((field) => field.required)
          .map((field) => field.key),
      ).toEqual([...requiredKeys]);
    }

    const agentFs = INTEGRATIONS.find((candidate) => candidate.id === "agentfs");
    expect(
      getIntegrationFields(agentFs!).find((field) => field.key === "API_AGENT_FS_API_KEY")
        ?.writeOnly,
    ).toBe(true);
  });
});

describe("Slack transport credential status", () => {
  test("HTTP uses the signing secret and socket still needs an app token", () => {
    const slack = INTEGRATIONS.find((candidate) => candidate.id === "slack")!;
    const http: SwarmConfig = {
      id: "test-mode",
      scope: "global",
      scopeId: null,
      key: "SLACK_MODE",
      value: "http",
      isSecret: false,
      envPath: null,
      description: null,
      createdAt: "",
      lastUpdatedAt: "",
      encrypted: false,
      exportToEnv: true,
    };
    const presence = { SLACK_BOT_TOKEN: true, SLACK_SIGNING_SECRET: true };
    expect(deriveIntegrationStatus(slack, [http], presence)).toBe("configured");
    expect(deriveIntegrationStatus(slack, [], presence)).toBe("partial");
    expect(
      deriveIntegrationStatus(slack, [], { SLACK_BOT_TOKEN: true, SLACK_APP_TOKEN: true }),
    ).toBe("configured");
    expect(deriveIntegrationStatus(slack, [{ ...http, value: "invalid" }], presence)).toBe(
      "partial",
    );
    expect(deriveIntegrationStatus(slack, [], { ...presence, SLACK_MODE: true })).toBe("partial");
  });
});

describe("Chat SDK status", () => {
  test("configured needs the flag and a non-empty adapters object", () => {
    const chat = INTEGRATIONS.find((candidate) => candidate.id === "chat-sdk")!;
    const row = (key: string, value: string): SwarmConfig => ({
      id: `test-${key}`,
      scope: "global",
      scopeId: null,
      key,
      value,
      isSecret: false,
      envPath: null,
      description: null,
      createdAt: "",
      lastUpdatedAt: "",
      encrypted: false,
    });
    const enabled = row("CHAT_SDK_ENABLED", "true");
    const adapters = row("CHAT_SDK_ADAPTERS", '{"telegram":{"botToken":"x"}}');
    expect(deriveIntegrationStatus(chat, [enabled, adapters])).toBe("configured");
    expect(deriveIntegrationStatus(chat, [enabled])).toBe("partial");
    expect(deriveIntegrationStatus(chat, [adapters])).toBe("partial");
    expect(deriveIntegrationStatus(chat, [enabled, row("CHAT_SDK_ADAPTERS", "{}")])).toBe(
      "partial",
    );
    expect(deriveIntegrationStatus(chat, [row("CHAT_SDK_ENABLED", "false")])).toBe("none");
    expect(deriveIntegrationStatus(chat, [])).toBe("none");
  });

  test("an env-only CHAT_SDK_ENABLED counts only when the live status says enabled", () => {
    const chat = INTEGRATIONS.find((candidate) => candidate.id === "chat-sdk")!;
    const env = { CHAT_SDK_ENABLED: true, CHAT_SDK_ADAPTERS: true };
    expect(deriveIntegrationStatus(chat, [], env, { chatSdkEnabled: true })).toBe("configured");
    expect(deriveIntegrationStatus(chat, [], env, { chatSdkEnabled: false })).toBe("partial");
    // Live status not loaded yet: presence is the fallback.
    expect(deriveIntegrationStatus(chat, [], env)).toBe("configured");
  });
});

describe("OpenAI-compatible provider cards", () => {
  test("Vercel AI Gateway has a key field and no base URL field; NaN keeps its override", () => {
    const keys = (id: string) =>
      (INTEGRATIONS.find((candidate) => candidate.id === id)?.fields ?? []).map((f) => f.key);
    expect(keys("vercel")).toEqual(["AI_GATEWAY_API_KEY"]);
    expect(keys("nan")).toEqual(["NAN_API_KEY", "NAN_BASE_URL"]);
  });
});

describe("findCatalogField", () => {
  test("maps a config key to its field and integration", () => {
    const found = findCatalogField("BITBUCKET_TOKEN");
    expect(found?.field.label).toBe("API token");
    expect(found?.integration.docsUrl).toBe(
      "https://docs.agent-swarm.dev/docs/integrations/bitbucket",
    );
    expect(findCatalogField("NOT_A_CATALOG_KEY")).toBeNull();
  });
});
