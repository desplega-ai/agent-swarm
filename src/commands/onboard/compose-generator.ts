import { expandServices } from "./service-names.ts";
import type { OnboardState } from "./types.ts";

// Docker Compose env var references use ${VAR} syntax which triggers biome's
// noTemplateCurlyInString rule. We collect them via a helper to keep the
// suppression comments in one place.

// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_API_KEY = "      - API_KEY=${API_KEY}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_INSTALL_METHOD = "      - INSTALL_METHOD=${INSTALL_METHOD}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_INSTALL_PRESET = "      - INSTALL_PRESET=${INSTALL_PRESET:-}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_SLACK_BOT_TOKEN = "      - SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_SLACK_APP_TOKEN = "      - SLACK_APP_TOKEN=${SLACK_APP_TOKEN}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_CLAUDE_OAUTH = "      - CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_ANTHROPIC_KEY = "      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_HARNESS_PROVIDER = "      - HARNESS_PROVIDER=${HARNESS_PROVIDER}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_OPENAI_KEY = "      - OPENAI_API_KEY=${OPENAI_API_KEY}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_OPENROUTER_KEY = "      - OPENROUTER_API_KEY=${OPENROUTER_API_KEY}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_MODEL_OVERRIDE = "      - MODEL_OVERRIDE=${MODEL_OVERRIDE}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_AWS_REGION = "      - AWS_REGION=${AWS_REGION}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_AWS_ACCESS_KEY_ID = "      - AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_AWS_SECRET_ACCESS_KEY = "      - AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_AWS_SESSION_TOKEN = "      - AWS_SESSION_TOKEN=${AWS_SESSION_TOKEN:-}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_AWS_PROFILE = "      - AWS_PROFILE=${AWS_PROFILE}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_BEDROCK_AUTH_MODE = "      - BEDROCK_AUTH_MODE=${BEDROCK_AUTH_MODE}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const AWS_PROFILE_VOLUME = "      - ${HOME}/.aws:/home/worker/.aws:ro";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_GITHUB_TOKEN = "      - GITHUB_TOKEN=${GITHUB_TOKEN}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_GITHUB_EMAIL = "      - GITHUB_EMAIL=${GITHUB_EMAIL}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_GITHUB_NAME = "      - GITHUB_NAME=${GITHUB_NAME}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_GITLAB_TOKEN = "      - GITLAB_TOKEN=${GITLAB_TOKEN}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_GITLAB_EMAIL = "      - GITLAB_EMAIL=${GITLAB_EMAIL}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_SENTRY_AUTH_TOKEN = "      - SENTRY_AUTH_TOKEN=${SENTRY_AUTH_TOKEN}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_SENTRY_ORG = "      - SENTRY_ORG=${SENTRY_ORG}";

function appendProviderEnvironment(lines: string[], state: OnboardState, includeHarness: boolean) {
  if (includeHarness) lines.push(ENV_HARNESS_PROVIDER);
  switch (state.provider) {
    case "claude":
      lines.push(state.credentialType === "api_key" ? ENV_ANTHROPIC_KEY : ENV_CLAUDE_OAUTH);
      break;
    case "openai":
      lines.push(ENV_OPENAI_KEY);
      break;
    case "openrouter":
      lines.push(ENV_OPENROUTER_KEY);
      lines.push(ENV_MODEL_OVERRIDE);
      break;
    case "bedrock":
      // Workflow LLM nodes do not support Bedrock yet, so the API does not need AWS credentials.
      if (!includeHarness) break;
      lines.push("      # AWS Bedrock (alpha)");
      lines.push(
        "      # Alpha: session summaries, memory rating, spend tracking and model tiers may be missing on Bedrock.",
      );
      lines.push(ENV_BEDROCK_AUTH_MODE);
      lines.push(ENV_AWS_REGION);
      lines.push(ENV_MODEL_OVERRIDE);
      if (state.awsProfile) {
        lines.push(ENV_AWS_PROFILE);
      } else {
        lines.push(ENV_AWS_ACCESS_KEY_ID);
        lines.push(ENV_AWS_SECRET_ACCESS_KEY);
        if (state.awsSessionToken) lines.push(ENV_AWS_SESSION_TOKEN);
      }
      break;
  }
}

/**
 * Generate a docker-compose.yml string from onboard wizard state.
 * Builds the YAML as plain strings (no YAML library) following the pattern
 * used in apps/templates-ui/src/lib/compose-generator.ts.
 */
export function generateCompose(state: OnboardState): string {
  const expanded = expandServices(state.services, state.agentIds);
  const lines: string[] = [];

  // Header
  lines.push("# Docker Compose for Agent Swarm");
  lines.push("# Generated by `agent-swarm onboard`");
  lines.push("#");
  lines.push("# Usage:");
  lines.push("#   docker compose --env-file .env up -d");
  lines.push("");
  lines.push("services:");

  // ── API service ──
  lines.push("  swarm-api:");
  lines.push('    image: "ghcr.io/desplega-ai/agent-swarm:latest"');
  lines.push("    container_name: swarm-api");
  lines.push(`    pull_policy: ${state.pullPolicy}`);
  lines.push("    stop_grace_period: 60s");
  lines.push("");
  const port = state.apiPort || 3013;

  lines.push("    environment:");
  lines.push(ENV_API_KEY);
  lines.push(ENV_INSTALL_METHOD);
  lines.push(ENV_INSTALL_PRESET);
  appendProviderEnvironment(lines, state, false);
  lines.push(`      - MCP_BASE_URL=http://localhost:${port}`);
  lines.push("      - APP_URL=https://app.agent-swarm.dev");

  if (state.integrations.slack) {
    lines.push("      - SLACK_DISABLE=false");
    lines.push(ENV_SLACK_BOT_TOKEN);
    lines.push(ENV_SLACK_APP_TOKEN);
  }

  if (state.integrations.github) {
    lines.push("      - GITHUB_DISABLE=false");
  }

  lines.push("");
  lines.push("    ports:");
  lines.push(`      - "${port}:3013"`);
  lines.push("");
  lines.push("    volumes:");
  lines.push("      - swarm_data:/app/data");
  lines.push("");
  lines.push("    healthcheck:");
  lines.push('      test: ["CMD-SHELL", "curl -f http://localhost:3013/health || exit 1"]');
  lines.push("      interval: 10s");
  lines.push("      timeout: 5s");
  lines.push("      retries: 3");
  lines.push("      start_period: 15s");
  lines.push("");
  lines.push("    restart: unless-stopped");

  // ── Agent services ──
  let nextPort = 3201;

  for (const svc of expanded) {
    const port = nextPort++;
    const agentRole = svc.entry.isLead ? "lead" : "worker";
    const agentName =
      svc.entry.count > 1 ? `${svc.entry.displayName} ${svc.index + 1}` : svc.entry.displayName;

    lines.push("");
    lines.push(`  ${svc.name}:`);
    lines.push('    image: "ghcr.io/desplega-ai/agent-swarm-worker:latest"');
    lines.push(`    container_name: ${svc.containerName}`);
    lines.push(`    pull_policy: ${state.pullPolicy}`);
    lines.push("    stop_grace_period: 60s");
    lines.push("");
    lines.push("    depends_on:");
    lines.push("      swarm-api:");
    lines.push("        condition: service_healthy");
    lines.push("");
    lines.push("    environment:");
    appendProviderEnvironment(lines, state, true);
    lines.push(ENV_API_KEY);
    lines.push(`      - AGENT_ID=${svc.agentId}`);
    lines.push(`      - AGENT_NAME=${agentName}`);
    lines.push(`      - AGENT_ROLE=${agentRole}`);
    lines.push(`      - TEMPLATE_ID=${svc.entry.template}`);
    lines.push("      - MCP_BASE_URL=http://swarm-api:3013");
    lines.push("      - YOLO=true");
    lines.push("      - SWARM_URL=http://swarm-api:3013");

    if (svc.entry.isLead) {
      lines.push("      - MAX_CONCURRENT_TASKS=1");
    }

    if (state.integrations.github) {
      lines.push(ENV_GITHUB_TOKEN);
      lines.push(ENV_GITHUB_EMAIL);
      lines.push(ENV_GITHUB_NAME);
    }

    if (state.integrations.gitlab) {
      lines.push(ENV_GITLAB_TOKEN);
      lines.push(ENV_GITLAB_EMAIL);
    }

    if (state.integrations.sentry) {
      lines.push(ENV_SENTRY_AUTH_TOKEN);
      lines.push(ENV_SENTRY_ORG);
    }

    lines.push("");
    lines.push("    ports:");
    lines.push(`      - "${port}:3000"`);
    lines.push("");
    lines.push("    volumes:");
    lines.push("      - swarm_logs:/app/logs");
    lines.push("      - swarm_shared:/app/shared");
    lines.push(`      - swarm_${svc.sanitizedName}:/app/agent`);
    if (state.provider === "bedrock" && state.awsProfile) {
      lines.push(AWS_PROFILE_VOLUME);
    }
    lines.push("");
    lines.push("    restart: unless-stopped");
  }

  // ── Volumes section ──
  lines.push("");
  lines.push("volumes:");
  lines.push("  swarm_data:");
  lines.push("  swarm_logs:");
  lines.push("  swarm_shared:");
  for (const svc of expanded) {
    lines.push(`  swarm_${svc.sanitizedName}:`);
  }

  return `${lines.join("\n")}\n`;
}
