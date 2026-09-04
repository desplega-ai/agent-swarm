import { describe, expect, test } from "bun:test";
import { getIntegrationFields, INTEGRATIONS } from "./integrations-catalog";

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
