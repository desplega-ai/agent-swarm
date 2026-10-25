import { describe, expect, test } from "bun:test";
import type { SwarmConfig } from "../api/types";
import { getIntegrationFields, getPresenceKeys, INTEGRATIONS } from "./integrations-catalog";
import {
  deriveIntegrationStatus,
  type EnvPresence,
  findConfigForKey,
  type IntegrationStatus,
} from "./integrations-status";

function row(key: string, value = `value-${key}`, opts: Partial<SwarmConfig> = {}): SwarmConfig {
  return {
    id: `test-${key}`,
    scope: "global",
    scopeId: null,
    key,
    value,
    isSecret: false,
    envPath: null,
    description: null,
    createdAt: "2026-10-24T00:00:00.000Z",
    lastUpdatedAt: "2026-10-24T00:00:00.000Z",
    encrypted: false,
    exportToEnv: true,
    ...opts,
  };
}

function byId(id: string) {
  const def = INTEGRATIONS.find((candidate) => candidate.id === id);
  if (!def) throw new Error(`Catalog missing integration: ${id}`);
  return def;
}

function requiredRows(id: string): SwarmConfig[] {
  return getIntegrationFields(byId(id))
    .filter((field) => field.required)
    .map((field) => row(field.key));
}

function status(id: string, configs: SwarmConfig[], env: EnvPresence = {}): IntegrationStatus {
  return deriveIntegrationStatus(byId(id), configs, env);
}

describe("metadata alone never reads as configured", () => {
  const metadataOnly: Array<[id: string, key: string]> = [
    ["kapso", "KAPSO_API_BASE_URL"],
    ["github", "GITHUB_BOT_NAME"],
    ["gitlab", "GITLAB_BOT_NAME"],
    ["bitbucket", "BITBUCKET_BOT_NAME"],
    ["jira", "JIRA_REDIRECT_URI"],
    ["agentmail", "AGENTMAIL_INBOX_DOMAIN_FILTER"],
    ["composio", "COMPOSIO_BASE_URL"],
    ["nan", "NAN_BASE_URL"],
    ["helmcode", "HELMCODE_BASE_URL"],
  ];

  for (const [id, key] of metadataOnly) {
    test(`${id}: ${key} alone is partial`, () => {
      expect(status(id, [row(key)])).toBe("partial");
      expect(status(id, [], { [key]: true })).toBe("partial");
    });
  }

  test("no integration without alternatives is configured from advanced fields alone", () => {
    for (const def of INTEGRATIONS) {
      if (def.configGroups?.length || def.alternatives?.length) continue;
      const fields = getIntegrationFields(def);
      if (!fields.some((field) => field.required)) continue;
      const advanced = fields.filter((field) => field.advanced).map((field) => row(field.key));
      if (advanced.length === 0) continue;
      expect([def.id, deriveIntegrationStatus(def, advanced)]).not.toEqual([def.id, "configured"]);
    }
  });
});

describe("controls", () => {
  test("Slack bot token alone is partial, bot plus app token is configured", () => {
    expect(status("slack", [row("SLACK_BOT_TOKEN")])).toBe("partial");
    expect(status("slack", [row("SLACK_BOT_TOKEN"), row("SLACK_APP_TOKEN")])).toBe("configured");
  });

  test("empty Kapso is none and every required key is configured", () => {
    expect(status("kapso", [])).toBe("none");
    expect(status("kapso", requiredRows("kapso"))).toBe("configured");
  });

  test("one of several required keys is partial", () => {
    expect(status("github", [row("GITHUB_TOKEN"), row("GITHUB_EMAIL")])).toBe("partial");
    expect(status("github", requiredRows("github"))).toBe("configured");
  });
});

describe("declared alternatives", () => {
  test("GitHub App pair is configured, half of it is partial", () => {
    expect(status("github", [row("GITHUB_APP_ID"), row("GITHUB_APP_PRIVATE_KEY")])).toBe(
      "configured",
    );
    expect(status("github", [row("GITHUB_APP_ID")])).toBe("partial");
  });

  test("Codex counts any ChatGPT account slot, not only the legacy row", () => {
    expect(status("codex-oauth", [row("codex_oauth_3")])).toBe("configured");
    expect(status("codex-oauth", [row("codex_oauth")])).toBe("configured");
    expect(status("codex-oauth", [])).not.toBe("configured");
    expect(getPresenceKeys(byId("codex-oauth"))).not.toContain("codex_oauth_*");
  });

  test("GSC accepts the plain service-account JSON", () => {
    expect(status("gsc", [row("GSC_SERVICE_ACCOUNT_JSON")])).toBe("configured");
    expect(status("gsc", [], { GSC_SERVICE_ACCOUNT_JSON: true })).toBe("configured");
  });

  test("NaN alias counts the same as the canonical key", () => {
    expect(status("nan", [row("HELMCODE_API_NAN")])).toBe(status("nan", [row("NAN_API_KEY")]));
    expect(status("nan", [], { HELMCODE_API_NAN: true })).toBe("configured");
    expect(getPresenceKeys(byId("nan"))).toContain("HELMCODE_API_NAN");
  });

  test("embeddings fall back to OPENAI_API_KEY", () => {
    expect(status("memory", [], { OPENAI_API_KEY: true })).toBe("configured");
    expect(getPresenceKeys(byId("memory"))).toContain("OPENAI_API_KEY");
  });

  test("Codex is configured by its global codex_oauth row", () => {
    expect(status("codex-oauth", [])).toBe("none");
    expect(status("codex-oauth", [row("codex_oauth", "********", { isSecret: true })])).toBe(
      "configured",
    );
    expect(
      status("codex-oauth", [row("codex_oauth", "x", { scope: "agent", scopeId: "agent-1" })]),
    ).toBe("none");
  });
});

describe("disable key, empty values and reserved keys", () => {
  const slackRows = [row("SLACK_BOT_TOKEN"), row("SLACK_APP_TOKEN")];

  test("a truthy disable key beats configured", () => {
    expect(status("slack", [...slackRows, row("SLACK_DISABLE", "true")])).toBe("disabled");
    expect(status("slack", [row("SLACK_DISABLE", "1")])).toBe("disabled");
    expect(status("slack", [...slackRows, row("SLACK_DISABLE", "false")])).toBe("configured");
  });

  test("an empty value or a reserved key does not count as present", () => {
    expect(status("slack", [row("SLACK_BOT_TOKEN", "")])).toBe("none");
    expect(status("slack", [row("API_KEY", "shouldneverbehere")])).toBe("none");
  });

  test("an optional, non-advanced field alone stays none", () => {
    expect(status("business-use", [row("BUSINESS_USE_URL", "https://bu.example.com")])).toBe(
      "none",
    );
    expect(status("business-use", requiredRows("business-use"))).toBe("configured");
  });
});

describe("grouped integrations", () => {
  test("Bedrock is configured by either group and partial with one grouped key", () => {
    expect(
      status("bedrock", [
        row("MODEL_OVERRIDE", "amazon-bedrock/anthropic.claude-sonnet-4-20250514-v1:0"),
        row("AWS_REGION", "us-east-1"),
      ]),
    ).toBe("configured");
    expect(
      status("bedrock", [row("CLAUDE_CODE_USE_BEDROCK", "1"), row("AWS_REGION", "us-east-1")]),
    ).toBe("configured");
    expect(status("bedrock", [row("CLAUDE_CODE_USE_BEDROCK", "1")])).toBe("partial");
  });
});

describe("findConfigForKey", () => {
  test("returns present global rows only", () => {
    const token = row("SLACK_BOT_TOKEN", "xoxb-1");
    expect(findConfigForKey([token], "SLACK_BOT_TOKEN")?.value).toBe("xoxb-1");
    expect(findConfigForKey([token], "SLACK_APP_TOKEN")).toBeUndefined();
    expect(findConfigForKey([row("SLACK_APP_TOKEN", "")], "SLACK_APP_TOKEN")).toBeUndefined();
    expect(findConfigForKey([row("API_KEY", "nope")], "API_KEY")).toBeUndefined();
    expect(
      findConfigForKey(
        [row("SLACK_BOT_TOKEN", "x", { scope: "agent", scopeId: "some-agent" })],
        "SLACK_BOT_TOKEN",
      ),
    ).toBeUndefined();
  });
});
