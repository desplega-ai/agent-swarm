import { expandServices } from "./service-names.ts";
import type { OnboardState } from "./types.ts";

/**
 * Generate a .env file string from onboard wizard state.
 * Uses real values from state (not placeholders).
 */
export function generateEnv(state: OnboardState): string {
  const expanded = expandServices(state.services, state.agentIds);
  const lines: string[] = [];

  // ── Core ──
  lines.push("# === Core ===");
  lines.push(`API_KEY=${state.apiKey}`);
  const port = state.apiPort || 3013;
  lines.push(`MCP_BASE_URL=http://localhost:${port}`);
  lines.push("APP_URL=https://app.agent-swarm.dev");

  // Install path — read by src/telemetry.ts at boot to attribute the
  // "which entry point produced this install" cohort. Boolean/enum only,
  // never an identifier. Installs that never ran the wizard (hand-written
  // docker-compose, manual `bun run start:http`) simply won't have this
  // var set, and telemetry falls back to "manual".
  lines.push(
    `INSTALL_METHOD=${state.nonInteractive ? "onboard_noninteractive" : "onboard_interactive"}`,
  );
  if (state.presetId) {
    lines.push(`INSTALL_PRESET=${state.presetId}`);
  }

  // ── Authentication ──
  lines.push("");
  lines.push("# === Authentication ===");
  lines.push(`HARNESS_PROVIDER=${state.harness}`);
  switch (state.provider) {
    case "claude":
      if (state.credentialType === "api_key") {
        lines.push(`ANTHROPIC_API_KEY=${state.anthropicApiKey}`);
      } else {
        lines.push(`CLAUDE_CODE_OAUTH_TOKEN=${state.claudeOAuthToken}`);
      }
      break;
    case "openai":
      lines.push(`OPENAI_API_KEY=${state.openaiApiKey}`);
      break;
    case "openrouter":
      lines.push(`OPENROUTER_API_KEY=${state.openrouterApiKey}`);
      lines.push(`MODEL_OVERRIDE=${state.modelOverride}`);
      break;
    case "bedrock":
      lines.push("# AWS Bedrock (alpha)");
      lines.push(
        "# Alpha: session summaries, memory rating, spend tracking and model tiers may be missing on Bedrock.",
      );
      lines.push("BEDROCK_AUTH_MODE=sdk");
      lines.push(`AWS_REGION=${state.awsRegion}`);
      if (state.awsProfile) {
        lines.push(`AWS_PROFILE=${state.awsProfile}`);
      } else {
        lines.push(`AWS_ACCESS_KEY_ID=${state.awsAccessKeyId}`);
        lines.push(`AWS_SECRET_ACCESS_KEY=${state.awsSecretAccessKey}`);
        if (state.awsSessionToken) lines.push(`AWS_SESSION_TOKEN=${state.awsSessionToken}`);
      }
      lines.push(`MODEL_OVERRIDE=${state.modelOverride}`);
      break;
  }

  // ── Integrations ──
  lines.push("");
  lines.push("# === Integrations ===");

  // GitHub
  if (state.integrations.github) {
    lines.push("");
    lines.push("# GitHub");
    lines.push(`GITHUB_TOKEN=${state.githubToken}`);
    lines.push(`GITHUB_EMAIL=${state.githubEmail}`);
    lines.push(`GITHUB_NAME=${state.githubName}`);
    lines.push("GITHUB_DISABLE=false");
  } else {
    lines.push("GITHUB_DISABLE=true");
  }

  // Slack
  if (state.integrations.slack) {
    lines.push("");
    lines.push("# Slack");
    lines.push(`SLACK_BOT_TOKEN=${state.slackBotToken}`);
    lines.push(`SLACK_APP_TOKEN=${state.slackAppToken}`);
    lines.push("SLACK_DISABLE=false");
  } else {
    lines.push("SLACK_DISABLE=true");
  }

  // GitLab
  if (state.integrations.gitlab) {
    lines.push("");
    lines.push("# GitLab");
    lines.push(`GITLAB_TOKEN=${state.gitlabToken}`);
    lines.push(`GITLAB_EMAIL=${state.gitlabEmail}`);
  }

  // Sentry
  if (state.integrations.sentry) {
    lines.push("");
    lines.push("# Sentry");
    lines.push(`SENTRY_AUTH_TOKEN=${state.sentryToken}`);
    lines.push(`SENTRY_ORG=${state.sentryOrg}`);
  }

  // ── Agent IDs ──
  lines.push("");
  lines.push("# === Agent IDs (for reference) ===");
  for (const svc of expanded) {
    lines.push(`# ${svc.name} = ${svc.agentId}`);
  }

  return `${lines.join("\n")}\n`;
}
