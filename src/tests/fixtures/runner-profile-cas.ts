/** Real runner boot and session sync against the parent test's profile API.
 * The provider ends one session and exits at the next spawn; IO stays in argv[2]. */
import { mock } from "bun:test";
import { basename, join } from "node:path";
import { installProfileWriteGuard } from "./profile-write-guard";

const directory = process.argv[2]!;
const protectedPaths = process.argv[5] ? JSON.parse(process.argv[5]) : undefined;
installProfileWriteGuard(directory, protectedPaths);
const scenario = process.argv[4];
let archiveFailed = false;
const taskIds = ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"];
let spawns = 0;
let claims = 0;

const resolver = await import("../../prompts/resolver");
mock.module("../../prompts/resolver", () => ({
  ...resolver,
  configureHttpResolver() {},
}));
const profileSync = await import("../../commands/profile-sync");
const io = profileSync.PROFILE_FILE_IO;
io.readFile = async (path) => {
  const target = join(directory, basename(path));
  const file = Bun.file(target);
  return (await file.exists()) ? await file.text() : undefined;
};
io.writeFile = async (path, content) => {
  if (scenario === "preservation-error" && path.includes("TOOLS.md.pre-boot-") && !archiveFailed) {
    archiveFailed = true;
    throw new Error("Boot archive failed once");
  }
  await Bun.write(join(directory, basename(path)), content);
};
io.baselinesLockPath =
  scenario === "baseline-error" ? "/dev/null/baselines.lock" : join(directory, "baselines.lock");
mock.module("../../commands/profile-sync", () => ({
  ...profileSync,
  ...(scenario === "direct-write"
    ? {
        async writeProfileFileFromDb(path: string, content: string) {
          await Bun.write(join(protectedPaths.workspace, basename(path)), content);
        },
      }
    : {}),
  SOUL_MD_PATH: join(directory, "SOUL.md"),
  IDENTITY_MD_PATH: join(directory, "IDENTITY.md"),
  TOOLS_MD_PATH: join(directory, "TOOLS.md"),
  HEARTBEAT_MD_PATH: join(directory, "HEARTBEAT.md"),
  CLAUDE_MD_PATH: join(directory, "CLAUDE.md"),
  WORKSPACE_CLAUDE_MD_PATH: join(directory, "CLAUDE.md"),
  SETUP_SCRIPT_PATH: join(directory, "start-up.sh"),
  IDENTITY_BASELINES_PATH: join(directory, "identity-baselines.json"),
  resolveClaudeMdPath: () => join(directory, "CLAUDE.md"),
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
      async createSession() {
        spawns++;
        if (spawns === 1) {
          if (scenario !== "preservation-error") {
            await Bun.write(join(directory, "TOOLS.md"), "tools edited in session 1");
          }
        } else {
          process.exit(0);
        }
        return {
          sessionId: `session-${spawns}`,
          onEvent() {},
          async abort() {},
          async waitForCompletion() {
            return { exitCode: 0, isError: false, output: "Fixture completed" };
          },
        };
      },
    };
  },
}));

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.pathname === "/me" || (url.pathname.endsWith("/profile") && init?.method === "PUT")) {
    return originalFetch(`${process.argv[3]}${url.pathname}`, init);
  }
  if (url.pathname === "/api/poll") {
    claims++;
    return Response.json({
      trigger: {
        type: "task_assigned",
        taskId: taskIds[claims - 1],
        task: { id: taskIds[claims - 1], task: "Exercise the profile settle" },
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

process.env.MAX_CONCURRENT_TASKS = "1";
const { runAgent } = await import("../../commands/runner");
await runAgent(
  { role: "worker", defaultPrompt: "Fixture", metadataType: "worker_metadata" },
  { logsDir: join(directory, "logs"), systemPrompt: "Fixture instructions" },
);
