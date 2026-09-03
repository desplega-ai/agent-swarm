import { describe, expect, test } from "bun:test";
import { generateCompose } from "../commands/onboard/compose-generator.ts";
import { INITIAL_STATE, type OnboardState } from "../commands/onboard/types.ts";

function makeState(overrides: Partial<OnboardState>): OnboardState {
  return { ...INITIAL_STATE, ...overrides };
}

describe("generateCompose", () => {
  // ── Dev preset: 1 lead + 2 coders ──

  const devState = makeState({
    presetId: "dev",
    services: [
      { template: "official/lead", displayName: "Lead", count: 1, role: "lead", isLead: true },
      { template: "official/coder", displayName: "Coder", count: 2, role: "coder" },
    ],
    agentIds: {
      lead: "aaa-lead-id",
      "worker-coder-1": "bbb-coder-1",
      "worker-coder-2": "ccc-coder-2",
    },
    apiKey: "test-api-key",
    claudeOAuthToken: "test-oauth",
  });

  test("static example passes every supported provider variable to all agents", async () => {
    const yaml = await Bun.file(
      new URL("../../docker-compose.example.yml", import.meta.url),
    ).text();
    const agentServices = `  lead:${yaml.split("\n  lead:")[1]}`;

    for (const variable of [
      "HARNESS_PROVIDER",
      "MODEL_OVERRIDE",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "OPENROUTER_BASE_URL",
      "BEDROCK_AUTH_MODE",
      "AWS_REGION",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_PROFILE",
    ]) {
      expect(agentServices.match(new RegExp(`^ {6}- ${variable}=`, "gm"))).toHaveLength(8);
    }
  });

  test("uses the always pull policy by default for every service", () => {
    const yaml = generateCompose(devState);

    expect(yaml.match(/pull_policy: always/g)).toHaveLength(4);
  });

  test.each([
    "missing",
    "never",
  ] as const)("uses the %s pull policy for every service", (pullPolicy) => {
    const yaml = generateCompose({ ...devState, pullPolicy });

    expect(yaml.match(new RegExp(`pull_policy: ${pullPolicy}`, "g"))).toHaveLength(4);
    expect(yaml).not.toContain("pull_policy: always");
  });

  test("dev preset produces 3 agent services + 1 API service", () => {
    const yaml = generateCompose(devState);
    // Only count service definitions in the services section (before volumes:)
    const servicesSection = yaml.split("\nvolumes:\n")[0];
    const serviceHeaders = servicesSection.split("\n").filter((l) => /^ {2}[a-z][\w-]+:$/.test(l));
    // swarm-api + lead + worker-coder-1 + worker-coder-2
    expect(serviceHeaders).toHaveLength(4);
    expect(yaml).toContain("swarm-api:");
    expect(yaml).toContain("  lead:");
    expect(yaml).toContain("  worker-coder-1:");
    expect(yaml).toContain("  worker-coder-2:");
  });

  test.each([
    {
      provider: "claude" as const,
      harness: "claude" as const,
      expected: ["HARNESS_PROVIDER=", "CLAUDE_CODE_OAUTH_TOKEN"],
    },
    {
      provider: "openai" as const,
      harness: "codex" as const,
      expected: ["HARNESS_PROVIDER=", "OPENAI_API_KEY"],
    },
    {
      provider: "openrouter" as const,
      harness: "pi" as const,
      expected: ["HARNESS_PROVIDER=", "OPENROUTER_API_KEY", "MODEL_OVERRIDE"],
    },
  ])("passes $provider runtime variables to every agent service", ({
    provider,
    harness,
    expected,
  }) => {
    const yaml = generateCompose({ ...devState, provider, harness });
    const agentServices = `  lead:${yaml.split("\n  lead:")[1]}`;
    for (const variable of expected) {
      expect(agentServices.split("\n").filter((line) => line.includes(variable))).toHaveLength(3);
    }
  });

  test("passes AWS profile configuration and mount only to Bedrock agents", () => {
    const yaml = generateCompose({
      ...devState,
      provider: "bedrock",
      harness: "pi",
      awsProfile: "swarm",
      awsRegion: "us-east-1",
      modelOverride: "amazon-bedrock/anthropic.claude-sonnet-4-20250514-v1:0",
    });
    expect(yaml.match(/HARNESS_PROVIDER=\$\{HARNESS_PROVIDER\}/g)).toHaveLength(3);
    expect(yaml.match(/AWS_PROFILE=\$\{AWS_PROFILE\}/g)).toHaveLength(3);
    expect(yaml.match(/BEDROCK_AUTH_MODE=\$\{BEDROCK_AUTH_MODE\}/g)).toHaveLength(3);
    expect(yaml.match(/\$\{HOME\}\/\.aws:\/home\/worker\/\.aws:ro/g)).toHaveLength(3);
    expect(yaml.match(/Alpha: session summaries/g)).toHaveLength(3);
    expect(yaml.split("\n  lead:")[0]).not.toContain("AWS_PROFILE");
  });

  test.each([
    { provider: "openai" as const, harness: "codex" as const, variable: "OPENAI_API_KEY" },
    { provider: "openrouter" as const, harness: "pi" as const, variable: "OPENROUTER_API_KEY" },
  ])("passes $provider credentials to the API for workflow LLM nodes", ({
    provider,
    harness,
    variable,
  }) => {
    const yaml = generateCompose({ ...devState, provider, harness });
    const apiService = yaml.split("\n  lead:")[0];
    expect(apiService).toContain(variable);
  });

  // ── Solo preset: 1 coder, no lead ──

  const soloState = makeState({
    presetId: "solo",
    services: [{ template: "official/coder", displayName: "Coder", count: 1, role: "coder" }],
    agentIds: { "worker-coder": "solo-coder-id" },
    apiKey: "key",
    claudeOAuthToken: "oauth",
  });

  test("solo preset produces 1 agent service", () => {
    const yaml = generateCompose(soloState);
    const servicesSection = yaml.split("\nvolumes:\n")[0];
    const serviceHeaders = servicesSection.split("\n").filter((l) => /^ {2}[a-z][\w-]+:$/.test(l));
    // swarm-api + worker-coder
    expect(serviceHeaders).toHaveLength(2);
    expect(yaml).toContain("  worker-coder:");
    expect(yaml).not.toContain("  lead:");
  });

  test("preset install attribution is passed through to the API service", () => {
    const yaml = generateCompose(soloState);
    const apiService = yaml.split("\n  worker-coder:")[0];
    const workerService = yaml.slice(apiService.length);

    expect(apiService).toMatch(/ {6}- INSTALL_METHOD=\$\{INSTALL_METHOD\}/);
    expect(apiService).toMatch(/ {6}- INSTALL_PRESET=\$\{INSTALL_PRESET:-\}/);
    expect(workerService).not.toContain("INSTALL_METHOD");
    expect(workerService).not.toContain("INSTALL_PRESET");
  });

  test("missing preset uses an empty Compose default", () => {
    const yaml = generateCompose(makeState({ presetId: undefined }));

    expect(yaml).toMatch(/ {6}- INSTALL_METHOD=\$\{INSTALL_METHOD\}/);
    expect(yaml).toMatch(/ {6}- INSTALL_PRESET=\$\{INSTALL_PRESET:-\}/);
  });

  // ── All integrations enabled ──

  const allIntegrationsState = makeState({
    presetId: "solo",
    services: [{ template: "official/coder", displayName: "Coder", count: 1, role: "coder" }],
    agentIds: { "worker-coder": "int-coder-id" },
    apiKey: "key",
    claudeOAuthToken: "oauth",
    integrations: { github: true, slack: true, gitlab: true, sentry: true },
  });

  test("all integrations enabled includes GitHub/Slack/GitLab/Sentry env vars", () => {
    const yaml = generateCompose(allIntegrationsState);
    // GitHub vars on agent services
    expect(yaml).toContain("GITHUB_TOKEN");
    expect(yaml).toContain("GITHUB_EMAIL");
    expect(yaml).toContain("GITHUB_NAME");
    // Slack vars on API service
    expect(yaml).toContain("SLACK_BOT_TOKEN");
    expect(yaml).toContain("SLACK_APP_TOKEN");
    // GitLab vars on agent services
    expect(yaml).toContain("GITLAB_TOKEN");
    expect(yaml).toContain("GITLAB_EMAIL");
    // Sentry vars on agent services
    expect(yaml).toContain("SENTRY_AUTH_TOKEN");
    expect(yaml).toContain("SENTRY_ORG");
    // GitHub enabled flag on API service
    expect(yaml).toContain("GITHUB_DISABLE=false");
    expect(yaml).toContain("SLACK_DISABLE=false");
  });

  // ── No integrations ──

  test("no integrations omits integration env vars from agent services", () => {
    const yaml = generateCompose(soloState);
    expect(yaml).not.toContain("GITHUB_TOKEN");
    expect(yaml).not.toContain("SLACK_BOT_TOKEN");
    expect(yaml).not.toContain("GITLAB_TOKEN");
    expect(yaml).not.toContain("SENTRY_AUTH_TOKEN");
    expect(yaml).not.toContain("GITHUB_DISABLE");
    expect(yaml).not.toContain("SLACK_DISABLE");
  });

  // ── Real agent IDs appear ──

  test("agent IDs from state appear in compose output", () => {
    const yaml = generateCompose(devState);
    expect(yaml).toContain("AGENT_ID=aaa-lead-id");
    expect(yaml).toContain("AGENT_ID=bbb-coder-1");
    expect(yaml).toContain("AGENT_ID=ccc-coder-2");
  });

  // ── Port allocation starts at 3201 ──

  test("port allocation starts at 3201 and increments", () => {
    const yaml = generateCompose(devState);
    expect(yaml).toContain('"3201:3000"');
    expect(yaml).toContain('"3202:3000"');
    expect(yaml).toContain('"3203:3000"');
  });

  // ── API service has healthcheck ──

  test("API service has healthcheck", () => {
    const yaml = generateCompose(devState);
    expect(yaml).toContain("healthcheck:");
    expect(yaml).toContain("curl -f http://localhost:3013/health || exit 1");
    expect(yaml).toContain("interval: 10s");
    expect(yaml).toContain("retries: 3");
  });

  // ── Agent services depend on healthy API ──

  test("agent services depend on swarm-api being healthy", () => {
    const yaml = generateCompose(devState);
    expect(yaml).toContain("depends_on:");
    expect(yaml).toContain("condition: service_healthy");
  });
});
