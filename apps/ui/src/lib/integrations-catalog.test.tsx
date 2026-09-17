import { describe, expect, test } from "bun:test";
import type { SwarmConfig } from "../api/types";
import { getIntegrationFields, INTEGRATIONS } from "./integrations-catalog";
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
