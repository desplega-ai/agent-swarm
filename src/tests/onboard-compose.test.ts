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
