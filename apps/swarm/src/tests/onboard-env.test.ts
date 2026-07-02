import { describe, expect, test } from "bun:test";
import { generateEnv } from "../commands/onboard/env-generator.ts";
import { INITIAL_STATE, type OnboardState } from "../commands/onboard/types.ts";

function makeState(overrides: Partial<OnboardState>): OnboardState {
  return { ...INITIAL_STATE, ...overrides };
}

describe("generateEnv", () => {
  // ── Claude harness with OAuth token ──

  test("Claude harness includes CLAUDE_CODE_OAUTH_TOKEN with actual value", () => {
    const state = makeState({
      harness: "claude",
      claudeOAuthToken: "oauth-tok-abc123",
      apiKey: "my-api-key",
      services: [{ template: "official/coder", displayName: "Coder", count: 1, role: "coder" }],
      agentIds: { "worker-coder": "coder-uuid" },
    });
    const env = generateEnv(state);
    expect(env).toContain("CLAUDE_CODE_OAUTH_TOKEN=oauth-tok-abc123");
  });

  // ── GitHub integration enabled ──

  test("GitHub integration enabled includes GITHUB_TOKEN, GITHUB_EMAIL, GITHUB_NAME", () => {
    const state = makeState({
      apiKey: "key",
      claudeOAuthToken: "tok",
      integrations: { github: true, slack: false, gitlab: false, sentry: false },
      githubToken: "ghp_mytoken",
      githubEmail: "dev@example.com",
      githubName: "Dev User",
      services: [{ template: "official/coder", displayName: "Coder", count: 1, role: "coder" }],
      agentIds: { "worker-coder": "id-1" },
    });
    const env = generateEnv(state);
    expect(env).toContain("GITHUB_TOKEN=ghp_mytoken");
    expect(env).toContain("GITHUB_EMAIL=dev@example.com");
    expect(env).toContain("GITHUB_NAME=Dev User");
    expect(env).toContain("GITHUB_DISABLE=false");
  });

  // ── Slack integration enabled ──

  test("Slack integration enabled includes SLACK_BOT_TOKEN and SLACK_APP_TOKEN", () => {
    const state = makeState({
      apiKey: "key",
      claudeOAuthToken: "tok",
      integrations: { github: false, slack: true, gitlab: false, sentry: false },
      slackBotToken: "xoxb-slack-bot",
      slackAppToken: "xapp-slack-app",
      services: [{ template: "official/coder", displayName: "Coder", count: 1, role: "coder" }],
      agentIds: { "worker-coder": "id-1" },
    });
    const env = generateEnv(state);
    expect(env).toContain("SLACK_BOT_TOKEN=xoxb-slack-bot");
    expect(env).toContain("SLACK_APP_TOKEN=xapp-slack-app");
    expect(env).toContain("SLACK_DISABLE=false");
  });

  // ── No integrations: only core section ──

  test("no integrations outputs disable flags and no integration credentials", () => {
    const state = makeState({
      apiKey: "key-123",
      claudeOAuthToken: "tok-456",
      services: [{ template: "official/coder", displayName: "Coder", count: 1, role: "coder" }],
      agentIds: { "worker-coder": "id-1" },
    });
    const env = generateEnv(state);
    // Core values present
    expect(env).toContain("API_KEY=key-123");
    expect(env).toContain("CLAUDE_CODE_OAUTH_TOKEN=tok-456");
    // Integrations disabled
    expect(env).toContain("GITHUB_DISABLE=true");
    expect(env).toContain("SLACK_DISABLE=true");
    // No integration credentials
    expect(env).not.toContain("GITHUB_TOKEN=");
    expect(env).not.toContain("SLACK_BOT_TOKEN=");
    expect(env).not.toContain("GITLAB_TOKEN=");
    expect(env).not.toContain("SENTRY_AUTH_TOKEN=");
  });

  // ── Actual credential values appear (not placeholder text) ──

  test("actual credential values appear, not placeholder text", () => {
    const state = makeState({
      apiKey: "real-api-key-789",
      claudeOAuthToken: "real-oauth-token-xyz",
      integrations: { github: true, slack: true, gitlab: true, sentry: true },
      githubToken: "ghp_realtoken",
      githubEmail: "real@mail.com",
      githubName: "Real Name",
      slackBotToken: "xoxb-real",
      slackAppToken: "xapp-real",
      gitlabToken: "glpat-real",
      gitlabEmail: "gl@mail.com",
      sentryToken: "sntrys_real",
      sentryOrg: "my-org",
      services: [{ template: "official/coder", displayName: "Coder", count: 1, role: "coder" }],
      agentIds: { "worker-coder": "id-1" },
    });
    const env = generateEnv(state);
    expect(env).toContain("API_KEY=real-api-key-789");
    expect(env).toContain("CLAUDE_CODE_OAUTH_TOKEN=real-oauth-token-xyz");
    expect(env).toContain("GITHUB_TOKEN=ghp_realtoken");
    expect(env).toContain("SLACK_BOT_TOKEN=xoxb-real");
    expect(env).toContain("GITLAB_TOKEN=glpat-real");
    expect(env).toContain("SENTRY_AUTH_TOKEN=sntrys_real");
    expect(env).toContain("SENTRY_ORG=my-org");
    // No placeholder text like "your-token-here"
    expect(env).not.toContain("your-");
    expect(env).not.toContain("<");
    expect(env).not.toContain("placeholder");
  });

  // ── Agent IDs appear as comments ──

  test("agent IDs appear as comments in Agent IDs section", () => {
    const state = makeState({
      apiKey: "key",
      claudeOAuthToken: "tok",
      services: [
        { template: "official/lead", displayName: "Lead", count: 1, role: "lead", isLead: true },
        { template: "official/coder", displayName: "Coder", count: 2, role: "coder" },
      ],
      agentIds: {
        lead: "lead-uuid-111",
        "worker-coder-1": "coder-uuid-222",
        "worker-coder-2": "coder-uuid-333",
      },
    });
    const env = generateEnv(state);
    expect(env).toContain("# === Agent IDs (for reference) ===");
    expect(env).toContain("# lead = lead-uuid-111");
    expect(env).toContain("# worker-coder-1 = coder-uuid-222");
    expect(env).toContain("# worker-coder-2 = coder-uuid-333");
  });

  // ── GitLab integration ──

  test("GitLab integration enabled includes GITLAB_TOKEN and GITLAB_EMAIL", () => {
    const state = makeState({
      apiKey: "key",
      claudeOAuthToken: "tok",
      integrations: { github: false, slack: false, gitlab: true, sentry: false },
      gitlabToken: "glpat-abc",
      gitlabEmail: "gl@example.com",
      services: [{ template: "official/coder", displayName: "Coder", count: 1, role: "coder" }],
      agentIds: { "worker-coder": "id-1" },
    });
    const env = generateEnv(state);
    expect(env).toContain("GITLAB_TOKEN=glpat-abc");
    expect(env).toContain("GITLAB_EMAIL=gl@example.com");
  });

  // ── Sentry integration ──

  test("Sentry integration enabled includes SENTRY_AUTH_TOKEN and SENTRY_ORG", () => {
    const state = makeState({
      apiKey: "key",
      claudeOAuthToken: "tok",
      integrations: { github: false, slack: false, gitlab: false, sentry: true },
      sentryToken: "sntrys-tok",
      sentryOrg: "sentry-org",
      services: [{ template: "official/coder", displayName: "Coder", count: 1, role: "coder" }],
      agentIds: { "worker-coder": "id-1" },
    });
    const env = generateEnv(state);
    expect(env).toContain("SENTRY_AUTH_TOKEN=sntrys-tok");
    expect(env).toContain("SENTRY_ORG=sentry-org");
  });
});
