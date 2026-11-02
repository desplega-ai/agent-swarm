/**
 * Runs the real runner loop in a child process up to the first task spawn,
 * and records whether the task-start API reads (memory search, parent task)
 * were in flight together, plus the prompt the provider receives.
 */
import { mock } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderSessionConfig } from "../../providers/types";

const directory = process.argv[2]!;
const taskId = "55555555-5555-4555-8555-555555555555";
const parentTaskId = "66666666-6666-4666-8666-666666666666";
const PARENT_OUTPUT_SENTINEL = "PARENT_OUTPUT_SENTINEL_9c2e";

// Each gated read waits until the other one has been sent (or a fallback timer
// fires). Reads issued one after another leave `ranAlone` set.
const gated = new Set<string>();
let releaseGate: () => void = () => {};
const bothSent = new Promise<void>((resolve) => {
  releaseGate = resolve;
});
let ranAlone = false;
async function gate(name: string): Promise<void> {
  gated.add(name);
  if (gated.has("memory") && gated.has("parent")) releaseGate();
  await Promise.race([bothSent, Bun.sleep(1_000)]);
  if (!(gated.has("memory") && gated.has("parent"))) ranAlone = true;
}

const resolver = await import("../../prompts/resolver");
mock.module("../../prompts/resolver", () => ({
  ...resolver,
  configureHttpResolver() {},
}));
const profileSync = await import("../../commands/profile-sync");
mock.module("../../commands/profile-sync", () => ({
  ...profileSync,
  SOUL_MD_PATH: join(directory, "SOUL.md"),
  IDENTITY_MD_PATH: join(directory, "IDENTITY.md"),
  TOOLS_MD_PATH: join(directory, "TOOLS.md"),
  HEARTBEAT_MD_PATH: join(directory, "HEARTBEAT.md"),
  CLAUDE_MD_PATH: join(directory, "CLAUDE.md"),
  WORKSPACE_CLAUDE_MD_PATH: join(directory, "CLAUDE.md"),
  SETUP_SCRIPT_PATH: join(directory, "start-up.sh"),
  IDENTITY_BASELINES_PATH: join(directory, "baselines.json"),
  async readIdentityBaselines() {
    return {};
  },
  async writeProfileFileFromDb() {
    return null;
  },
  async writeIdentityBaselines() {},
  async syncProfileFilesToServer() {},
  async prependProfileSyncRejectionBanner(prompt: string) {
    return { prompt, injected: false };
  },
  async fetchProfileSyncRejectionBanner() {
    return "";
  },
}));
mock.module("../../utils/skills-refresh", () => ({
  async refreshSkillsIfChanged() {
    return { changed: false };
  },
}));
const credentials = await import("../../utils/credentials");
mock.module("../../utils/credentials", () => ({
  ...credentials,
  async resolveCredentialPools() {
    return [];
  },
}));

mock.module("../../providers/index", () => ({
  async createProviderAdapter() {
    return {
      name: "pi",
      traits: { hasMcp: true, hasLocalEnvironment: true, nativeSkillDiscovery: false },
      formatCommand(name: string, args: string) {
        return `/${name} ${args}`;
      },
      async createSession(config: ProviderSessionConfig) {
        writeFileSync(
          join(directory, "result.json"),
          JSON.stringify({ taskId: config.taskId, prompt: config.prompt, ranAlone }),
        );
        // runAgent runs forever; the first spawn is the task under test.
        process.exit(0);
      },
    };
  },
}));

let claims = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.pathname === "/me") {
    return Response.json({ name: "Fixture agent", soulMd: "Fixture soul" });
  }
  if (url.pathname === "/api/poll") {
    claims++;
    if (claims > 1) return new Promise(() => {});
    return Response.json({
      trigger: {
        type: "task_assigned",
        taskId,
        task: { id: taskId, task: "Follow up on the parent task", parentTaskId },
      },
    });
  }
  if (url.pathname === "/api/memory/search") {
    await gate("memory");
    return Response.json({ results: [] });
  }
  if (url.pathname === `/api/tasks/${parentTaskId}`) {
    await gate("parent");
    return Response.json({
      id: parentTaskId,
      task: "Parent subject",
      status: "completed",
      output: PARENT_OUTPUT_SENTINEL,
    });
  }
  if (url.pathname === "/api/config/resolved") return Response.json({ configs: [] });
  if (url.pathname === "/api/agents") return Response.json({ enabledCapabilities: [] });
  if (url.pathname === "/api/paused-tasks") return Response.json({ tasks: [] });
  if (url.pathname === "/cancelled-tasks") return Response.json({ cancelled: [] });
  if (url.pathname.startsWith("/api/tasks/")) {
    return Response.json({ task: { id: taskId, status: "in_progress" } });
  }
  return Response.json({ enabled: false, recovered: 0, memories: [], configs: [] });
}) as typeof fetch;

process.env.MAX_CONCURRENT_TASKS = "1";
const { runAgent } = await import("../../commands/runner");
await runAgent(
  { role: "worker", defaultPrompt: "Fixture", metadataType: "worker_metadata" },
  { logsDir: join(directory, "logs"), systemPrompt: "Additional fixture instructions" },
);
