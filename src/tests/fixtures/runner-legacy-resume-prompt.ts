/**
 * Runs the real runner boot in a child process up to the legacy paused-task
 * resume, and records the prompts the provider receives for that session.
 */
import { mock } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderSessionConfig } from "../../providers/types";

const directory = process.argv[2]!;
const pausedTaskId = "44444444-4444-4444-8444-444444444444";
const REQUESTER_SENTINEL = "RESUME_REQUESTER_SENTINEL_7f3a";
const MISSING_DIR = "/nonexistent/legacy-resume-dir-7f3a";

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
          JSON.stringify({
            taskId: config.taskId,
            prompt: config.prompt,
            systemPrompt: config.systemPrompt,
          }),
        );
        // runAgent runs forever; the first spawn is the resumed task.
        process.exit(0);
      },
    };
  },
}));

// All requests terminate here. The paused-tasks endpoint carries the
// requester projection the API attaches, as on a task_assigned trigger.
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.pathname === "/me") {
    return Response.json({ name: "Fixture agent", soulMd: "Fixture soul" });
  }
  if (url.pathname === "/api/paused-tasks") {
    return Response.json({
      tasks: [
        {
          id: pausedTaskId,
          task: "Resume the paused fixture task",
          status: "paused",
          dir: MISSING_DIR,
          attachments: [],
          requestedBy: {
            id: "user-1",
            name: "Fixture Requester",
            email: "requester@example.com",
            role: "CTO",
            notes: REQUESTER_SENTINEL,
          },
        },
      ],
    });
  }
  if (url.pathname === "/api/poll") return new Promise(() => {});
  if (url.pathname === "/api/config/resolved") return Response.json({ configs: [] });
  if (url.pathname === "/api/agents") return Response.json({ enabledCapabilities: [] });
  if (url.pathname === "/cancelled-tasks") return Response.json({ cancelled: [] });
  if (url.pathname.startsWith("/api/tasks/")) {
    return Response.json({ success: true, task: { id: pausedTaskId, status: "in_progress" } });
  }
  return Response.json({ enabled: false, recovered: 0, memories: [], configs: [] });
}) as typeof fetch;

process.env.MAX_CONCURRENT_TASKS = "1";
const { runAgent } = await import("../../commands/runner");
await runAgent(
  { role: "worker", defaultPrompt: "Fixture", metadataType: "worker_metadata" },
  { logsDir: join(directory, "logs"), systemPrompt: "Additional fixture instructions" },
);
