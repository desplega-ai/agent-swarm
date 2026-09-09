/** Runs the real runner loop in a child process so module mocks cannot leak. */
import { mock } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ProviderSessionConfig } from "../../providers/types";

const scenario = process.argv[2];
const directory = process.argv[3]!;
const concurrent = scenario === "concurrent";
const toolsPath = join(directory, "TOOLS.md");
const baselinesPath = join(directory, "baselines.json");
const taskIds = ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
const captures: string[] = [];
let profileReads = 0;
let claims = 0;
let firstCompleted = false;
let editDuringRefresh = false;
let baselineAtFirstSpawn = "";
const bootProfile = {
  name: "Fixture agent",
  description: "Runner integration fixture",
  soulMd: "Soul before boot refresh",
  identityMd: "Identity before boot refresh",
  toolsMd: "Tools before boot refresh",
  claudeMd: "Notes before boot refresh",
  heartbeatMd: "Heartbeat before boot refresh",
};

// Preserve the real prompt builder and registered default templates. Only
// disable HTTP template overrides, which are unrelated to identity refresh.
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
  TOOLS_MD_PATH: toolsPath,
  HEARTBEAT_MD_PATH: join(directory, "HEARTBEAT.md"),
  CLAUDE_MD_PATH: join(directory, "CLAUDE.md"),
  WORKSPACE_CLAUDE_MD_PATH: join(directory, "CLAUDE.md"),
  SETUP_SCRIPT_PATH: join(directory, "start-up.sh"),
  IDENTITY_BASELINES_PATH: baselinesPath,
  async readIdentityBaselines() {
    return JSON.parse(readFileSync(baselinesPath, "utf8"));
  },
  async writeProfileFileFromDb(path: string, content: string) {
    writeFileSync(join(directory, basename(path)), content);
    return null;
  },
  async writeIdentityBaselines(baselines: Record<string, string>) {
    writeFileSync(baselinesPath, JSON.stringify(baselines));
  },
  async syncProfileFilesToServer() {},
  async prependProfileSyncRejectionBanner(prompt: string) {
    return { prompt, injected: false };
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
        captures.push(config.systemPrompt);
        if (captures.length === 1) {
          baselineAtFirstSpawn = readFileSync(baselinesPath, "utf8");
        } else {
          writeFileSync(
            join(directory, "result.json"),
            JSON.stringify({
              captures,
              profileReads,
              claims,
              firstCompleted,
              editDuringRefresh,
              tools: readFileSync(toolsPath, "utf8"),
              baselineAtFirstSpawn,
              baselineAtSecondSpawn: readFileSync(baselinesPath, "utf8"),
            }),
          );
          // runAgent deliberately runs forever. The child owns all timers and
          // fake sessions, so exiting here is the fixture's bounded stop.
          process.exit(0);
        }
        return {
          sessionId: `session-${captures.length}`,
          onEvent() {},
          async abort() {},
          async waitForCompletion() {
            if (concurrent) return new Promise(() => {});
            firstCompleted = true;
            return { exitCode: 0, isError: false, output: "Fixture completed" };
          },
        };
      },
    };
  },
}));

// All requests terminate here, including config/telemetry. No live API or DB
// is used. The profile changes only after the first provider was spawned.
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.pathname === "/me") {
    profileReads++;
    if (captures.length === 0) return Response.json(bootProfile);
    if (scenario === "null") return Response.json(null);
    if (scenario === "timeout") return new Promise(() => {});
    if (concurrent) {
      // Task A's session is still running when task B starts its refresh.
      // Release B's response only after A edits the shared workspace on a
      // separate event-loop turn, so this is an in-flight interleaving.
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          writeFileSync(toolsPath, "Task A local edit");
          editDuringRefresh = captures.length === 1 && claims === 2 && !firstCompleted;
          resolve();
        }, 0);
      });
    }
    return Response.json({
      ...bootProfile,
      soulMd: "Soul changed after task A",
      identityMd: "Identity changed after task A",
      claudeMd: "",
      toolsMd: "",
      heartbeatMd: "",
    });
  }
  if (url.pathname === "/api/poll") {
    claims++;
    return Response.json({
      trigger: {
        type: "task_assigned",
        taskId: taskIds[claims - 1],
        task: { id: taskIds[claims - 1], task: "Exercise identity refresh" },
      },
    });
  }
  if (url.pathname === "/api/config/resolved") return Response.json({ configs: [] });
  if (url.pathname === "/api/agents") return Response.json({ enabledCapabilities: [] });
  if (url.pathname === "/api/paused-tasks") return Response.json({ tasks: [] });
  if (url.pathname === "/cancelled-tasks") return Response.json({ cancelled: [] });
  if (url.pathname.startsWith("/api/tasks/")) {
    return Response.json({ task: { status: "completed", output: "Fixture completed" } });
  }
  return Response.json({ enabled: false, recovered: 0, memories: [], configs: [] });
}) as typeof fetch;

process.env.MAX_CONCURRENT_TASKS = concurrent ? "2" : "1";
const { runAgent } = await import("../../commands/runner");
await runAgent(
  { role: "worker", defaultPrompt: "Fixture", metadataType: "worker_metadata" },
  {
    logsDir: join(directory, "logs"),
    systemPrompt: "Additional fixture instructions",
  },
);
