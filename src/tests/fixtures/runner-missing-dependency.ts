/** Run the real claim/spawn/failure loop with only the API and provider session mocked. */
import { mock } from "bun:test";
import { join } from "node:path";
import type { ProviderName } from "../../types";

const directory = process.argv[2]!;
const scenario = process.argv[3]!;
const target = scenario === "boot-sdk" ? "opencode" : "grok";
let selected = scenario === "live-switch" ? "pi" : target;
const taskId = "55555555-5555-4555-8555-555555555555";
const adapters: string[] = [];
const registrations: string[] = [];
const lifecycle: string[] = [];
let failure: Record<string, string> | undefined;

const resolver = await import("../../prompts/resolver");
mock.module("../../prompts/resolver", () => ({ ...resolver, configureHttpResolver() {} }));
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
  async createProviderAdapter(provider: ProviderName) {
    adapters.push(provider);
    return {
      name: provider,
      traits: { hasMcp: true, hasLocalEnvironment: true, nativeSkillDiscovery: false },
      formatCommand(name: string) {
        return `/${name}`;
      },
      async createSession() {
        console.error("Missing dependency reached provider session creation");
        process.exit(2);
      },
    };
  },
}));

let claims = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.pathname === "/me")
    return Response.json({ name: "Fixture agent", soulMd: "Fixture soul" });
  if (url.pathname === "/api/config/resolved") {
    return Response.json({
      configs: [
        { key: "HARNESS_PROVIDER", value: selected },
        { key: "GROK_BINARY", value: join(directory, "missing-grok") },
        { key: "OPENCODE_SDK_PATH", value: join(directory, "missing-sdk.js") },
      ],
    });
  }
  if (url.pathname === "/api/agents" && init?.method === "POST") {
    registrations.push(JSON.parse(String(init.body)).harness_provider);
    // The worker has joined on pi. The next reconcile sees the operator's change.
    if (scenario === "live-switch") selected = target;
    return Response.json({ enabledCapabilities: [] });
  }
  if (url.pathname === "/api/poll") {
    if (++claims > 1) return new Promise(() => {});
    return Response.json({
      trigger: {
        type: "task_assigned",
        taskId,
        task: { id: taskId, task: "Missing dependency fixture", model: "openrouter/test/model" },
      },
    });
  }
  if (url.pathname === "/api/active-sessions" && init?.method === "POST")
    lifecycle.push("registered");
  if (url.pathname === `/api/tasks/${taskId}/finish`) {
    lifecycle.push("failed");
    failure = JSON.parse(String(init?.body));
    return Response.json({ task: { status: "failed" } });
  }
  if (url.pathname === `/api/active-sessions/by-task/${taskId}` && init?.method === "DELETE") {
    lifecycle.push("removed");
    await Bun.write(
      join(directory, "result.json"),
      JSON.stringify({ adapters, registrations, lifecycle, failure }),
    );
    process.exit(0);
  }
  if (url.pathname === "/api/paused-tasks") return Response.json({ tasks: [] });
  if (url.pathname === "/cancelled-tasks") return Response.json({ cancelled: [] });
  if (url.pathname.startsWith("/api/tasks/"))
    return Response.json({ task: { id: taskId, status: "in_progress" } });
  return Response.json({ enabled: false, recovered: 0, memories: [], results: [], configs: [] });
}) as typeof fetch;

const { runAgent } = await import("../../commands/runner");
await runAgent(
  { role: "worker", defaultPrompt: "Fixture", metadataType: "worker_metadata" },
  { logsDir: join(directory, "logs") },
);
