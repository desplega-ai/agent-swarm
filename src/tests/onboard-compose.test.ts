import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCompose as generateTemplateCompose } from "../../apps/templates-ui/src/lib/compose-generator.ts";
import { readAgentFsImageTag } from "../../scripts/agent-fs-version-utils.ts";
import { applyPins, PINS } from "../../scripts/bump-agent-fs.ts";
import { AGENT_FS_VERSION } from "../commands/onboard/agent-fs-version.ts";
import { generateCompose } from "../commands/onboard/compose-generator.ts";
import { getPresetById, PRESETS } from "../commands/onboard/presets.ts";
import { INITIAL_STATE, type OnboardState } from "../commands/onboard/types.ts";
import { BASELINE_CASES, baselineState } from "./fixtures/onboard/baseline-states.ts";

function makeState(overrides: Partial<OnboardState>): OnboardState {
  return { ...INITIAL_STATE, ...overrides };
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const COMPOSE_SLACK_MODE = "SLACK_MODE=${SLACK_MODE:-socket}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const COMPOSE_SLACK_SIGNING_SECRET = "SLACK_SIGNING_SECRET=${SLACK_SIGNING_SECRET}";

describe("generateCompose", () => {
  test("uses the full preset by default and includes every official template once", () => {
    const full = getPresetById("full");

    expect(PRESETS[0]).toBe(full);
    expect(full?.services).toHaveLength(11);
    expect(full?.services.map((service) => service.template)).toEqual([
      "official/lead",
      "official/coder",
      "official/content-reviewer",
      "official/content-strategist",
      "official/content-writer",
      "official/discoverability-optimizer",
      "official/forward-deployed-engineer",
      "official/researcher",
      "official/reviewer",
      "official/tester",
      "official/ux-principles",
    ]);
  });

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
    apiKey: "example-test-api-key",
    claudeOAuthToken: "example-test-oauth",
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
      expect(agentServices.match(new RegExp(`^ {6}- ${variable}=`, "gm"))).toHaveLength(12);
    }
  });

  test("uses the always pull policy by default for every service", () => {
    const yaml = generateCompose(devState);

    expect(yaml.match(/pull_policy: always/g)).toHaveLength(4);
  });

  test("resolves every image tag from AGENT_SWARM_VERSION instead of hardcoding latest", () => {
    const yaml = generateCompose(devState);

    // A hardcoded `:latest` tracks every commit on main. The tag must stay an
    // .env-driven pin, with `latest` only as the unset fallback.
    expect(yaml).not.toMatch(/image: "ghcr\.io\/desplega-ai\/agent-swarm(-worker)?:latest"/);
    expect(
      yaml.match(/image: "ghcr\.io\/desplega-ai\/agent-swarm(-worker)?:\$\{AGENT_SWARM_VERSION/g),
    ).toHaveLength(4);
  });

  test("static example never mounts a named volume over /app", async () => {
    const yaml = await Bun.file(
      new URL("../../docker-compose.example.yml", import.meta.url),
    ).text();
    const doc = Bun.YAML.parse(yaml) as {
      services: Record<string, { volumes?: string[] }>;
    };

    // A named volume copies image content once and then shadows that path, so
    // an `:/app` mount freezes the image's migrations/ and package.json while
    // the binary upgrades. Only /app/data must persist.
    for (const [name, service] of Object.entries(doc.services)) {
      for (const mount of service.volumes ?? []) {
        expect(`${name}: ${mount}`).not.toMatch(/:\/app$/);
      }
    }
    expect(doc.services.api?.volumes).toEqual(["swarm_api_data:/app/data"]);
  });

  test("static example resolves every swarm image tag from AGENT_SWARM_VERSION", async () => {
    const yaml = await Bun.file(
      new URL("../../docker-compose.example.yml", import.meta.url),
    ).text();

    expect(yaml).not.toMatch(/image: "ghcr\.io\/desplega-ai\/agent-swarm(-worker)?:latest"/);
    // 1 API service + 12 agent services.
    expect(
      yaml.match(
        /image: "ghcr\.io\/desplega-ai\/agent-swarm(-worker)?:\$\{AGENT_SWARM_VERSION:-latest\}"/g,
      ),
    ).toHaveLength(13);
  });

  test.each([
    "missing",
    "never",
  ] as const)("uses the %s pull policy for every service", (pullPolicy) => {
    const yaml = generateCompose({ ...devState, pullPolicy });

    expect(yaml.match(new RegExp(`pull_policy: ${pullPolicy}`, "g"))).toHaveLength(4);
    expect(yaml).not.toContain("pull_policy: always");
  });

  test.each([
    "docker",
    "podman",
  ] as const)("%s agent services mount volumes where the worker reads and writes", (containerEngine) => {
    const doc = Bun.YAML.parse(generateCompose({ ...devState, containerEngine })) as {
      services: Record<string, { volumes?: string[] }>;
    };
    const agents = Object.entries(doc.services).filter(([name]) => name !== "swarm-api");

    expect(agents.map(([name]) => name)).toEqual(["lead", "worker-coder-1", "worker-coder-2"]);
    for (const [name, service] of agents) {
      expect(service.volumes).toEqual([
        "swarm_logs:/logs",
        "swarm_shared:/workspace/shared",
        `swarm_${name.replaceAll("-", "_")}:/workspace/personal`,
      ]);
    }
    expect(doc.services["swarm-api"]?.volumes).toEqual(["swarm_data:/app/data"]);
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

  test("sets the install-safe concurrency for each agent role", () => {
    const yaml = generateCompose(devState);

    expect(yaml.match(/MAX_CONCURRENT_TASKS=2/g)).toHaveLength(1);
    expect(yaml.match(/MAX_CONCURRENT_TASKS=1/g)).toHaveLength(2);
  });

  test("applies an explicit concurrency override to every agent", () => {
    const yaml = generateCompose({ ...devState, maxConcurrentTasks: 4 });

    expect(yaml.match(/MAX_CONCURRENT_TASKS=4/g)).toHaveLength(3);
  });

  test("templates builder uses the same conservative role defaults", () => {
    const yaml = generateTemplateCompose({
      services: devState.services,
      apiImage: "api",
      workerImage: "worker",
      startingPort: 3201,
      integrations: devState.integrations,
    });

    expect(yaml.match(/MAX_CONCURRENT_TASKS=2/g)).toHaveLength(1);
    expect(yaml.match(/MAX_CONCURRENT_TASKS=1/g)).toHaveLength(2);
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
    expect(yaml).toContain(COMPOSE_SLACK_MODE);
    expect(yaml).not.toContain("SLACK_SIGNING_SECRET");
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

  test("HTTP Slack compose configuration uses the signing secret and no app token", () => {
    const yaml = generateCompose({ ...allIntegrationsState, slackMode: "http" });
    expect(yaml).toContain(COMPOSE_SLACK_MODE);
    expect(yaml).toContain(COMPOSE_SLACK_SIGNING_SECRET);
    expect(yaml).not.toContain("SLACK_APP_TOKEN");
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
    expect(yaml).toContain(':}3201:3000"');
    expect(yaml).toContain(':}3202:3000"');
    expect(yaml).toContain(':}3203:3000"');
  });

  test("every published port takes its host address from AGENT_SWARM_BIND_ADDRESS", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
    const prefix = '"${AGENT_SWARM_BIND_ADDRESS:+${AGENT_SWARM_BIND_ADDRESS:-}:}';
    const yaml = generateCompose({ ...devState, bundleAgentFs: true });
    const published = yaml.match(/^ {6}- "[^"]*:30(?:13|00)"$/gm) ?? [];
    // swarm-api plus three agents; agent-fs and tei publish nothing.
    expect(published).toHaveLength(4);
    for (const line of published) {
      // Blank or unset keeps Compose's default (every interface) without an unset-variable warning.
      expect(line).toContain(prefix);
    }
    expect(yaml).toContain(`${prefix}3013:3013"`);
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

describe("generateCompose with the agent-fs bundle flag", () => {
  const serviceHeaders = (yaml: string) =>
    yaml.split("\nvolumes:\n")[0]?.match(/^ {2}[a-z][\w-]+:$/gm) ?? [];
  const serviceBlock = (yaml: string, name: string) =>
    yaml.split(`\n  ${name}:\n`)[1]?.split(/\n {2}[a-z][\w-]+:\n|\nvolumes:\n/)[0] ?? "";

  test("INITIAL_STATE keeps the bundle off", () => {
    expect(INITIAL_STATE.bundleAgentFs).toBe(false);
    expect(INITIAL_STATE.teiImage).toBeNull();
  });

  for (const { name, state } of BASELINE_CASES) {
    test(`flag off: ${name} compose equals the pre-bundle output`, async () => {
      const expected = await Bun.file(
        new URL(`./fixtures/onboard/${name}.compose.yml.txt`, import.meta.url),
      ).text();
      const yaml = generateCompose(state);
      expect(yaml).toBe(expected);
      for (const s of ["agent-fs", "tei", "COMB_ENABLED", "EMBEDDING_", "AGENT_FS_"]) {
        expect(yaml).not.toContain(s);
      }
    });
  }

  for (const { name, state } of BASELINE_CASES) {
    test(`flag on: ${name} adds agent-fs and tei without changing the rest`, () => {
      const off = generateCompose(state);
      const yaml = generateCompose({ ...state, bundleAgentFs: true });
      const agents = serviceHeaders(off).filter((h) => h !== "  swarm-api:");

      expect(serviceHeaders(yaml)).toEqual([...serviceHeaders(off), "  agent-fs:", "  tei:"]);
      expect(yaml).toMatch(/\n {2}agent_fs_data:\n {2}tei_data:\n$/);
      expect(yaml.match(/^ {4}pull_policy: /gm)).toHaveLength(agents.length + 3);
      expect(yaml.match(new RegExp(`pull_policy: ${state.pullPolicy}`, "g"))).toHaveLength(
        agents.length + 3,
      );

      // Every line of the flag-off output survives, in order.
      const onLines = yaml.split("\n");
      let cursor = 0;
      for (const line of off.split("\n")) {
        const found = onLines.indexOf(line, cursor);
        expect(found).toBeGreaterThanOrEqual(cursor);
        cursor = found + 1;
      }

      // API: proxy, Comb, dashboard links, TEI memory with quoted prefixes.
      const api = serviceBlock(yaml, "swarm-api");
      for (const line of [
        "      - AGENT_FS_API_URL=http://agent-fs:7433",
        "      - AGENT_FS_PROXY=true",
        "      - COMB_ENABLED=true",
        "      - AGENT_FS_LINK_TARGET=dashboard",
        "      - EMBEDDING_API_BASE_URL=http://tei:80/v1",
        "      - EMBEDDING_MODEL=nomic-ai/nomic-embed-text-v1.5",
        "      - EMBEDDING_API_KEY=local-tei",
        '      - "EMBEDDING_QUERY_PREFIX=search_query: "',
        '      - "EMBEDDING_DOCUMENT_PREFIX=search_document: "',
      ]) {
        expect(api.split("\n")).toContain(line);
      }
      expect(api).toContain(
        "    depends_on:\n      agent-fs:\n        condition: service_healthy\n      tei:\n        condition: service_started\n",
      );

      // Every agent reaches agent-fs and builds dashboard links.
      expect(yaml.match(/^ {6}- AGENT_FS_API_URL=http:\/\/agent-fs:7433$/gm)).toHaveLength(
        agents.length + 1,
      );
      for (const header of agents) {
        const agent = serviceBlock(yaml, header.trim().slice(0, -1));
        expect(agent).toContain("      - AGENT_FS_API_URL=http://agent-fs:7433\n");
        expect(agent).toContain("      - APP_URL=https://app.agent-swarm.dev\n");
        expect(agent).toContain("      - AGENT_FS_LINK_TARGET=dashboard\n");
      }

      // agent-fs: local disk, no MinIO, no host port.
      const afs = serviceBlock(yaml, "agent-fs");
      expect(afs).toContain("AGENT_FS_STORAGE_PROVIDER=local");
      expect(afs).toContain("AGENT_FS_LOCAL_ROOT=/data/storage");
      expect(afs).toContain("      - agent_fs_data:/data");
      expect(afs).toContain(
        `AGENT_FS_PUBLIC_URL=\${PUBLIC_MCP_BASE_URL:-http://localhost:${state.apiPort || 3013}}/agentfs`,
      );
      expect(afs).toContain("node -e");
      expect(afs).not.toContain("ports:");

      // tei: no host port, the OOM and batch flags, a 2 GB cap.
      const tei = serviceBlock(yaml, "tei");
      expect(tei).toContain(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
        'image: "${TEI_IMAGE:-ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.4}"',
      );
      expect(tei).toContain('"--max-batch-tokens", "2048"');
      expect(tei).toContain('"--max-client-batch-size", "256"');
      expect(tei).toContain("mem_limit: 2g");
      expect(tei).not.toContain("ports:");

      expect(yaml).not.toContain("minio");
      expect(yaml).not.toContain("platform:");
      expect(yaml).not.toContain("EMBEDDING_DIMENSIONS");
    });
  }

  test("flag on: the agent-fs pin equals the Helm chart tag", async () => {
    const values = new URL("../../charts/agent-swarm/values.yaml", import.meta.url);
    const tag = readAgentFsImageTag(await Bun.file(values).text(), "values.yaml");
    expect(AGENT_FS_VERSION).toBe(tag);
    const yaml = generateCompose({ ...baselineState("solo"), bundleAgentFs: true });
    expect(yaml).toContain(`    image: "ghcr.io/desplega-ai/agent-fs:${tag}"\n`);
  });

  test("bump-agent-fs rewrites the onboard pin and keeps the closing quote", async () => {
    const root = await mkdtemp(join(tmpdir(), "bump-agent-fs-"));
    try {
      const repo = new URL("../../", import.meta.url);
      const onboardPath = "src/commands/onboard/agent-fs-version.ts";
      // Copy the onboard file even if PINS drops it, so the failure is the stale version.
      for (const path of new Set([onboardPath, ...PINS.map((pin) => pin.path)])) {
        await Bun.write(join(root, path), Bun.file(new URL(path, repo)));
      }
      const onboard = join(root, onboardPath);
      expect(await Bun.file(onboard).text()).toContain(
        `export const AGENT_FS_VERSION = "${AGENT_FS_VERSION}";`,
      );
      await applyPins("9.9.9", root);
      const bumped = await Bun.file(onboard).text();
      expect(bumped).toContain('export const AGENT_FS_VERSION = "9.9.9";');
      expect(bumped).not.toContain(`"${AGENT_FS_VERSION}"`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
