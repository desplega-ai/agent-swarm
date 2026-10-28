import { AGENT_FS_VERSION } from "./agent-fs-version.ts";
import { composeCommandText, engineForCommands } from "./container-engine.ts";
import { expandServices } from "./service-names.ts";
import type { OnboardState } from "./types.ts";

const DEFAULT_LEAD_MAX_CONCURRENT_TASKS = 2;
const DEFAULT_WORKER_MAX_CONCURRENT_TASKS = 1;

// Docker Compose env var references use ${VAR} syntax which triggers biome's
// noTemplateCurlyInString rule. We collect them via a helper to keep the
// suppression comments in one place.

// Image tag for the API and agent images. Blank or unset resolves to `latest`,
// which moves on every commit to main; operators pin a release in .env.
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const IMAGE_TAG_EXPRESSION = "${AGENT_SWARM_VERSION:-latest}";
// Host address for published ports, from AGENT_SWARM_BIND_ADDRESS in .env. Blank
// publishes on every interface, as before. 127.0.0.1 keeps the ports behind a host
// reverse proxy: Docker-published ports bypass host firewalls such as ufw.
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const BIND_ADDRESS_PREFIX = "${AGENT_SWARM_BIND_ADDRESS:+${AGENT_SWARM_BIND_ADDRESS:-}:}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_API_KEY = "      - API_KEY=${API_KEY}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_INSTALL_METHOD = "      - INSTALL_METHOD=${INSTALL_METHOD}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_INSTALL_PRESET = "      - INSTALL_PRESET=${INSTALL_PRESET:-}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_ANONYMIZED_TELEMETRY = "      - ANONYMIZED_TELEMETRY=${ANONYMIZED_TELEMETRY:-}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_TELEMETRY_ENV = "      - DESPLEGA_TELEMETRY_ENV=${DESPLEGA_TELEMETRY_ENV:-}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_SLACK_BOT_TOKEN = "      - SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_SLACK_APP_TOKEN = "      - SLACK_APP_TOKEN=${SLACK_APP_TOKEN}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_SLACK_SIGNING_SECRET = "      - SLACK_SIGNING_SECRET=${SLACK_SIGNING_SECRET}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const ENV_SLACK_MODE = "      - SLACK_MODE=${SLACK_MODE:-socket}";
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
// `z` relabels the bind mount for SELinux as shared, since every worker mounts it.
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const AWS_PROFILE_VOLUME_SELINUX = "      - ${HOME}/.aws:/home/worker/.aws:ro,z";
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

// ── Bundled agent-fs + TEI (`onboard --yes`, flag `bundleAgentFs`) ──
const APP_URL = "https://app.agent-swarm.dev";
const AGENT_FS_INTERNAL_URL = "http://agent-fs:7433";
const TEI_MODEL = "nomic-ai/nomic-embed-text-v1.5";
// Compose `${PUBLIC_MCP_BASE_URL:-http://localhost:<port>}`; the caller appends `<port>}`.
const ENV_AGENT_FS_PUBLIC_URL_PREFIX =
  "      - AGENT_FS_PUBLIC_URL=${PUBLIC_MCP_BASE_URL:-http://localhost:";
const TEI_IMAGE_EXPRESSION =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
  "${TEI_IMAGE:-ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.4}";

/** The API side of the bundle: agent-fs proxy, Comb, dashboard links, TEI memory. */
function appendBundleApiEnvironment(lines: string[]) {
  lines.push(`      - AGENT_FS_API_URL=${AGENT_FS_INTERNAL_URL}`);
  lines.push("      - AGENT_FS_PROXY=true");
  lines.push("      - COMB_ENABLED=true");
  lines.push("      - AGENT_FS_LINK_TARGET=dashboard");
  lines.push("      - EMBEDDING_API_BASE_URL=http://tei:80/v1");
  lines.push(`      - EMBEDDING_MODEL=${TEI_MODEL}`);
  lines.push("      - EMBEDDING_API_KEY=local-tei");
  // Quoted: unquoted, `KEY=search_query: ` parses as a mapping and drops the trailing space.
  lines.push('      - "EMBEDDING_QUERY_PREFIX=search_query: "');
  lines.push('      - "EMBEDDING_DOCUMENT_PREFIX=search_document: "');
}

function appendBundleServices(lines: string[], state: OnboardState, apiPort: number) {
  lines.push("");
  lines.push("  agent-fs:");
  lines.push(`    image: "ghcr.io/desplega-ai/agent-fs:${AGENT_FS_VERSION}"`);
  lines.push("    container_name: swarm-agent-fs");
  lines.push(`    pull_policy: ${state.pullPolicy}`);
  lines.push("");
  lines.push("    environment:");
  lines.push("      - AGENT_FS_HOME=/data");
  lines.push("      - AGENT_FS_STORAGE_PROVIDER=local");
  lines.push("      - AGENT_FS_LOCAL_ROOT=/data/storage");
  lines.push("      - HOST=0.0.0.0");
  lines.push("      - SERVER_HOST=0.0.0.0");
  lines.push("      - PORT=7433");
  lines.push("      - SERVER_PORT=7433");
  lines.push("      - EMBEDDING_PROVIDER=local");
  // The browser reaches agent-fs through the API proxy, on the tunnel URL when there is one.
  lines.push(`${ENV_AGENT_FS_PUBLIC_URL_PREFIX}${apiPort}}/agentfs`);
  lines.push(`      - AGENT_FS_APP_URL=${APP_URL}`);
  lines.push("");
  lines.push("    volumes:");
  lines.push("      - agent_fs_data:/data");
  lines.push("");
  lines.push("    healthcheck:");
  lines.push("      # The agent-fs image has no curl or wget.");
  lines.push(
    `      test: ["CMD-SHELL", "node -e \\"fetch('http://127.0.0.1:7433/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))\\""]`,
  );
  lines.push("      interval: 10s");
  lines.push("      timeout: 5s");
  lines.push("      retries: 30");
  lines.push("      start_period: 10s");
  lines.push("");
  lines.push("    restart: unless-stopped");

  lines.push("");
  lines.push("  tei:");
  lines.push(`    image: "${TEI_IMAGE_EXPRESSION}"`);
  lines.push("    container_name: swarm-tei");
  lines.push(`    pull_policy: ${state.pullPolicy}`);
  // --max-batch-tokens 2048: the default warmup passed 5.4 GB and was OOM-killed on an 8 GB box.
  // --max-client-batch-size 256: the default 32 rejects documents with more than 32 chunks.
  lines.push(
    `    command: ["--model-id", "${TEI_MODEL}", "--max-batch-tokens", "2048", "--max-client-batch-size", "256"]`,
  );
  lines.push("    mem_limit: 2g");
  lines.push("");
  lines.push("    volumes:");
  lines.push("      - tei_data:/data");
  lines.push("");
  lines.push("    healthcheck:");
  lines.push('      test: ["CMD-SHELL", "curl -sf http://127.0.0.1:80/health || exit 1"]');
  lines.push("      interval: 10s");
  lines.push("      timeout: 5s");
  lines.push("      retries: 30");
  lines.push("      start_period: 180s");
  lines.push("");
  lines.push("    restart: unless-stopped");
}

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
  const engine = engineForCommands(state.containerEngine);
  lines.push(`# ${engine === "podman" ? "Podman" : "Docker"} Compose for Agent Swarm`);
  lines.push("# Generated by `agent-swarm onboard`");
  lines.push("#");
  lines.push("# Usage:");
  lines.push(`#   ${composeCommandText(engine, "--env-file .env up -d")}`);
  lines.push("#");
  lines.push("# Image version: set AGENT_SWARM_VERSION in .env to a published release.");
  lines.push("# Blank falls back to `latest`, which moves on every commit to main and is");
  lines.push("# not a release. Releases: https://github.com/desplega-ai/agent-swarm/releases");
  lines.push("# Upgrade/rollback (migrations are forward-only, so back up first):");
  lines.push(
    "# https://github.com/desplega-ai/agent-swarm/blob/main/skills/agent-swarm/references/upgrade.md",
  );
  lines.push("");
  lines.push("services:");

  // ── API service ──
  lines.push("  swarm-api:");
  lines.push(`    image: "ghcr.io/desplega-ai/agent-swarm:${IMAGE_TAG_EXPRESSION}"`);
  lines.push("    container_name: swarm-api");
  lines.push(`    pull_policy: ${state.pullPolicy}`);
  lines.push("    stop_grace_period: 60s");
  lines.push("");
  const port = state.apiPort || 3013;

  lines.push("    environment:");
  lines.push(ENV_API_KEY);
  lines.push(ENV_INSTALL_METHOD);
  lines.push(ENV_INSTALL_PRESET);
  lines.push(ENV_ANONYMIZED_TELEMETRY);
  lines.push(ENV_TELEMETRY_ENV);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
  lines.push("      - MEMORY_HYBRID_SEARCH=${MEMORY_HYBRID_SEARCH-1}");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
  lines.push("      - MEMORY_GRAPH_EXPANSION=${MEMORY_GRAPH_EXPANSION-1}");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
  lines.push("      - MEMORY_RATERS=${MEMORY_RATERS-implicit-citation,explicit-self}");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
  lines.push("      - MEMORY_DEMOTION_FLOOR=${MEMORY_DEMOTION_FLOOR-1.0}");
  appendProviderEnvironment(lines, state, false);
  lines.push(`      - MCP_BASE_URL=http://localhost:${port}`);
  lines.push(`      - APP_URL=${APP_URL}`);

  if (state.integrations.slack) {
    lines.push("      - SLACK_DISABLE=false");
    lines.push(ENV_SLACK_MODE);
    lines.push(ENV_SLACK_BOT_TOKEN);
    lines.push(state.slackMode === "http" ? ENV_SLACK_SIGNING_SECRET : ENV_SLACK_APP_TOKEN);
  }

  if (state.integrations.github) {
    lines.push("      - GITHUB_DISABLE=false");
  }

  if (state.bundleAgentFs) {
    appendBundleApiEnvironment(lines);
    lines.push("");
    // The boot seeder provisions agent-fs, so it must be up first. TEI only needs to
    // start: a first boot downloads 1.1 GB of weights, and memory falls back to
    // keyword search until it is ready.
    lines.push("    depends_on:");
    lines.push("      agent-fs:");
    lines.push("        condition: service_healthy");
    lines.push("      tei:");
    lines.push("        condition: service_started");
  }

  lines.push("");
  lines.push("    ports:");
  lines.push(`      - "${BIND_ADDRESS_PREFIX}${port}:3013"`);
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
    lines.push(`    image: "ghcr.io/desplega-ai/agent-swarm-worker:${IMAGE_TAG_EXPRESSION}"`);
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
    lines.push(ENV_ANONYMIZED_TELEMETRY);
    lines.push(ENV_TELEMETRY_ENV);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
    lines.push("      - MEMORY_RATERS=${MEMORY_RATERS-implicit-citation,explicit-self}");
    lines.push(`      - AGENT_ID=${svc.agentId}`);
    lines.push(`      - AGENT_NAME=${agentName}`);
    lines.push(`      - AGENT_ROLE=${agentRole}`);
    lines.push(`      - TEMPLATE_ID=${svc.entry.template}`);
    lines.push("      - MCP_BASE_URL=http://swarm-api:3013");
    lines.push("      - YOLO=true");
    lines.push("      - SWARM_URL=http://swarm-api:3013");

    const maxConcurrentTasks =
      state.maxConcurrentTasks ??
      (svc.entry.isLead ? DEFAULT_LEAD_MAX_CONCURRENT_TASKS : DEFAULT_WORKER_MAX_CONCURRENT_TASKS);
    lines.push(`      - MAX_CONCURRENT_TASKS=${maxConcurrentTasks}`);

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

    if (state.bundleAgentFs) {
      lines.push(`      - AGENT_FS_API_URL=${AGENT_FS_INTERNAL_URL}`);
      lines.push(`      - APP_URL=${APP_URL}`);
      lines.push("      - AGENT_FS_LINK_TARGET=dashboard");
    }

    lines.push("");
    lines.push("    ports:");
    lines.push(`      - "${BIND_ADDRESS_PREFIX}${port}:3000"`);
    lines.push("");
    lines.push("    volumes:");
    // Same targets as docker-compose.example.yml: the worker logs to /logs and
    // keeps its clones and files under /workspace.
    lines.push("      - swarm_logs:/logs");
    lines.push("      - swarm_shared:/workspace/shared");
    lines.push(`      - swarm_${svc.sanitizedName}:/workspace/personal`);
    if (state.provider === "bedrock" && state.awsProfile) {
      lines.push(engine === "podman" ? AWS_PROFILE_VOLUME_SELINUX : AWS_PROFILE_VOLUME);
    }
    lines.push("");
    lines.push("    restart: unless-stopped");
  }

  if (state.bundleAgentFs) appendBundleServices(lines, state, port);

  // ── Volumes section ──
  lines.push("");
  lines.push("volumes:");
  lines.push("  swarm_data:");
  lines.push("  swarm_logs:");
  lines.push("  swarm_shared:");
  for (const svc of expanded) {
    lines.push(`  swarm_${svc.sanitizedName}:`);
  }
  if (state.bundleAgentFs) {
    lines.push("  agent_fs_data:");
    lines.push("  tei_data:");
  }

  return `${lines.join("\n")}\n`;
}
