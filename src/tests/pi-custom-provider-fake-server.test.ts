/**
 * Acceptance 2 (NaN/Helmcode plan, Phase 4): the real pi SDK runs a
 * `helmcode/*` model end to end against a fake OpenAI-compatible server.
 *
 * Production shape: `process.env.HELMCODE_API_KEY` holds the raw credential
 * pool (a comma list), while the runner's per-task env holds the one picked
 * member. models.json only carries `"$HELMCODE_API_KEY"`, so the request must
 * authenticate with the picked key handed over as a pi runtime key, never the
 * comma list. No real NaN or Helmcode endpoint is contacted: the provider
 * block's baseUrl is pointed at a local `Bun.serve` on a free port.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createPiRuntimeAuth,
  PiMonoAdapter,
  resolveModel,
  writeSessionModelsJson,
} from "../providers/pi-mono-adapter";
import type { ProviderEvent, ProviderResult } from "../providers/types";
import { clearVolatileSecretsForTesting, registerVolatileSecret } from "../utils/secret-scrubber";
import { randomToken } from "./synthetic-secret-helpers";

const PICKED = "example-helmcode-picked";
const POOL = "example-helmcode-pool-a,example-helmcode-pool-b";

interface SeenRequest {
  path: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

describe("pi SDK + helmcode custom provider against a fake OpenAI-compatible server", () => {
  const seen: SeenRequest[] = [];
  let server: ReturnType<typeof Bun.serve>;
  let dir: string;
  const originalPoolVar = process.env.HELMCODE_API_KEY;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-helmcode-fake-"));
    // The shared process env holds the raw pool, as the entrypoint exports it.
    process.env.HELMCODE_API_KEY = POOL;
    // pi's own agent-dir env var: the runtime loads <dir>/models.json.
    process.env.PI_CODING_AGENT_DIR = dir;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        const body = req.method === "POST" ? ((await req.json()) as Record<string, unknown>) : {};
        seen.push({ path: url.pathname, authorization: req.headers.get("authorization"), body });
        if (!url.pathname.endsWith("/chat/completions")) {
          return Response.json({ object: "list", data: [] });
        }
        const base = {
          id: "chatcmpl-fake",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: String(body.model),
        };
        if (body.stream === false) {
          return Response.json({
            ...base,
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "pong" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          });
        }
        const stream =
          sseChunk({
            ...base,
            choices: [
              { index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: null },
            ],
          }) +
          sseChunk({
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          }) +
          "data: [DONE]\n\n";
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      },
    });
  });

  afterAll(() => {
    server?.stop(true);
    if (originalPoolVar === undefined) delete process.env.HELMCODE_API_KEY;
    else process.env.HELMCODE_API_KEY = originalPoolVar;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(dir, { recursive: true, force: true });
  });

  test(
    "request carries Bearer <picked> (not the process.env pool) and model glm5.3",
    async () => {
      // The runner's per-task env: one picked key.
      const taskEnv = { HELMCODE_API_KEY: PICKED };
      const models = await writeSessionModelsJson(dir, {
        ...taskEnv,
        HELMCODE_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      });
      const modelsPath = models.modelsPath as string;
      const written = JSON.parse(await Bun.file(modelsPath).text());
      expect(written.providers.helmcode.apiKey).toBe("$HELMCODE_API_KEY");

      const modelRuntime = await createPiRuntimeAuth(taskEnv, modelsPath);
      await models.dispose();
      const model = resolveModel("helmcode/glm5.3", taskEnv, modelRuntime);
      expect(model?.provider).toBe("helmcode");
      expect(model?.id).toBe("glm5.3");

      const { session } = await createAgentSession({
        cwd: dir,
        agentDir: dir,
        modelRuntime,
        model,
        noTools: "all",
        sessionManager: SessionManager.inMemory(),
      });
      try {
        await session.prompt("Reply with the single word pong.");
        expect(session.getLastAssistantText()).toBe("pong");
      } finally {
        session.dispose();
      }

      const chatCalls = seen.filter((r) => r.path.endsWith("/chat/completions"));
      expect(chatCalls.length).toBeGreaterThanOrEqual(1);
      for (const call of chatCalls) {
        expect(call.authorization).toBe(`Bearer ${PICKED}`);
        expect(call.authorization).not.toContain(",");
        expect(call.body.model).toBe("glm5.3");
      }
    },
    { timeout: 30_000 },
  );
});

// ─── Real PiMonoAdapter sessions: endpoint/key isolation and error scrubbing ───

interface FakeServer {
  url: string;
  seen: SeenRequest[];
  stop(): void;
}

/** A fake OpenAI-compatible server that answers `pong`, or 401 echoing the bearer key. */
function startFakeServer(mode: "pong" | "echo-401"): FakeServer {
  const seen: SeenRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "POST" ? ((await req.json()) as Record<string, unknown>) : {};
      const authorization = req.headers.get("authorization");
      seen.push({ path: url.pathname, authorization, body });
      if (!url.pathname.endsWith("/chat/completions")) {
        return Response.json({ object: "list", data: [] });
      }
      if (mode === "echo-401") {
        const key = (authorization ?? "").replace(/^Bearer /, "");
        return Response.json(
          {
            error: { message: `Incorrect API key provided: ${key}`, type: "invalid_request_error" },
          },
          { status: 401 },
        );
      }
      const base = {
        id: "chatcmpl-fake",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: String(body.model),
      };
      const stream =
        sseChunk({
          ...base,
          choices: [
            { index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: null },
          ],
        }) +
        sseChunk({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }) +
        "data: [DONE]\n\n";
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, seen, stop: () => server.stop(true) };
}

/** Every file under `root`, recursively. */
function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("PiMonoAdapter sessions against fake OpenAI-compatible servers", () => {
  let agentDir: string;
  let scratch: string;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const servers: FakeServer[] = [];
  let log: ReturnType<typeof spyOn>;

  beforeAll(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-adapter-agentdir-"));
    scratch = mkdtempSync(join(tmpdir(), "pi-adapter-scratch-"));
    // Every session shares this agent dir, as all sessions of one worker do.
    process.env.PI_CODING_AGENT_DIR = agentDir;
    log = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const server of servers.splice(0)) server.stop();
    clearVolatileSecretsForTesting();
  });

  afterAll(() => {
    log.mockRestore();
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  async function runSession(
    name: string,
    model: string,
    env: Record<string, string>,
  ): Promise<{ result: ProviderResult; events: ProviderEvent[]; logFile: string }> {
    const cwd = mkdtempSync(join(scratch, `${name}-cwd-`));
    const logFile = join(scratch, `${name}-${crypto.randomUUID()}.jsonl`);
    const session = await new PiMonoAdapter().createSession({
      prompt: "Reply with the single word pong.",
      systemPrompt: "test",
      model,
      role: "worker",
      agentId: "test-agent",
      taskId: `task-${name}`,
      // No swarm API: skips MCP discovery.
      apiUrl: "",
      apiKey: "",
      cwd,
      logFile,
      env,
    });
    const events: ProviderEvent[] = [];
    session.onEvent((event) => events.push(event));
    const result = await session.waitForCompletion();
    return { result, events, logFile };
  }

  test(
    "two concurrent sessions each reach their own endpoint with their own key",
    async () => {
      const a = startFakeServer("pong");
      const b = startFakeServer("pong");
      servers.push(a, b);
      const keyA = `example-helmcode-a-${randomToken(16)}`;
      const keyB = `example-helmcode-b-${randomToken(16)}`;
      const [first, second] = await Promise.all([
        runSession("a", "helmcode/glm5.3", { HELMCODE_API_KEY: keyA, HELMCODE_BASE_URL: a.url }),
        runSession("b", "helmcode/glm5.3", { HELMCODE_API_KEY: keyB, HELMCODE_BASE_URL: b.url }),
      ]);
      expect(first.result.isError).toBe(false);
      expect(second.result.isError).toBe(false);

      const chatA = a.seen.filter((r) => r.path.endsWith("/chat/completions"));
      const chatB = b.seen.filter((r) => r.path.endsWith("/chat/completions"));
      expect(chatA.length).toBeGreaterThanOrEqual(1);
      expect(chatB.length).toBeGreaterThanOrEqual(1);
      expect(new Set(chatA.map((r) => r.authorization))).toEqual(new Set([`Bearer ${keyA}`]));
      expect(new Set(chatB.map((r) => r.authorization))).toEqual(new Set([`Bearer ${keyB}`]));
      // Nothing was written into the shared agent dir's models.json.
      expect(filesUnder(agentDir).some((f) => f.endsWith("/models.json"))).toBe(false);
    },
    { timeout: 30_000 },
  );

  test(
    "an OpenRouter gateway session never leaks its endpoint into a concurrent default session",
    async () => {
      const a = startFakeServer("pong");
      const b = startFakeServer("pong");
      servers.push(a, b);
      const keyA = `example-openrouter-a-${randomToken(16)}`;
      const keyB = `example-openrouter-b-${randomToken(16)}`;
      const sharedPath = join(agentDir, "models.json");
      // The operator's hand-authored gateway, used by every default session.
      const shared = JSON.stringify({ providers: { openrouter: { baseUrl: b.url } } });
      await Bun.write(sharedPath, shared);

      // Hold session A on its first write into the shared agent dir (the old
      // code wrote models.json, then the marker: this pauses between them)
      // and run session B in that window. Without such a write A runs first.
      const originalWrite = Bun.write;
      const sharedWrites: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held!: () => void;
      const heldA = new Promise<void>((resolve) => {
        held = resolve;
      });
      Bun.write = (async (...args: Parameters<typeof Bun.write>) => {
        const path = String(args[0]);
        if (path.startsWith(`${agentDir}/`) && !path.startsWith(join(agentDir, "sessions"))) {
          sharedWrites.push(path);
          if (path.endsWith(".agent-swarm-openrouter-override.json")) {
            held();
            await gate;
          }
        }
        return originalWrite(...args);
      }) as typeof Bun.write;
      const model = "openrouter/deepseek/deepseek-v4.1-flash";
      let sharedAfter: string;
      try {
        const runA = runSession("or-a", model, {
          OPENROUTER_API_KEY: keyA,
          OPENROUTER_BASE_URL: a.url,
        });
        await Promise.race([heldA, runA]);
        const second = await runSession("or-b", model, { OPENROUTER_API_KEY: keyB });
        release();
        const first = await runA;
        expect(first.result.isError).toBe(false);
        expect(second.result.isError).toBe(false);
      } finally {
        release();
        Bun.write = originalWrite;
        sharedAfter = readFileSync(sharedPath, "utf-8");
        rmSync(sharedPath, { force: true });
      }

      const chatA = a.seen.filter((r) => r.path.endsWith("/chat/completions"));
      const chatB = b.seen.filter((r) => r.path.endsWith("/chat/completions"));
      expect(chatA.length).toBeGreaterThanOrEqual(1);
      expect(chatB.length).toBeGreaterThanOrEqual(1);
      expect(new Set(chatA.map((r) => r.authorization))).toEqual(new Set([`Bearer ${keyA}`]));
      expect(new Set(chatB.map((r) => r.authorization))).toEqual(new Set([`Bearer ${keyB}`]));
      // Nothing wrote the shared config: it is still the operator's file.
      expect(sharedWrites).toEqual([]);
      expect(sharedAfter).toBe(shared);
    },
    { timeout: 30_000 },
  );

  // Opaque keys: no token-shape regex matches them, and none is in process.env.
  const cases: Array<{
    label: string;
    model: string;
    keyVar: string;
    preRegister: boolean;
  }> = [
    {
      label: "canonical var",
      model: "helmcode/glm5.3",
      keyVar: "HELMCODE_API_KEY",
      preRegister: false,
    },
    {
      label: "already registered",
      model: "helmcode/glm5.3",
      keyVar: "HELMCODE_API_KEY",
      preRegister: true,
    },
    {
      label: "HELMCODE_API_NAN alias",
      model: "nan/glm5.3",
      keyVar: "HELMCODE_API_NAN",
      preRegister: false,
    },
  ];

  for (const { label, model, keyVar, preRegister } of cases) {
    test(
      `a 401 echoing the key (${label}) never reaches the failure reason, events, adapter log or pi's session file`,
      async () => {
        const server = startFakeServer("echo-401");
        servers.push(server);
        const key = `opaque${randomToken(28)}`;
        expect(process.env[keyVar]).not.toBe(key);
        if (preRegister) registerVolatileSecret(key, keyVar);
        const baseVar = model.startsWith("nan/") ? "NAN_BASE_URL" : "HELMCODE_BASE_URL";
        const warn = spyOn(console, "warn").mockImplementation(() => {});
        let run: Awaited<ReturnType<typeof runSession>>;
        try {
          run = await runSession(`leak-${keyVar}`, model, { [keyVar]: key, [baseVar]: server.url });
        } finally {
          warn.mockRestore();
        }

        // Control: the key really went out and the provider echoed it.
        const chat = server.seen.filter((r) => r.path.endsWith("/chat/completions"));
        expect(chat.map((r) => r.authorization)).toContain(`Bearer ${key}`);

        expect(run.result.isError).toBe(true);
        expect(run.result.failureReason).toContain("Incorrect API key provided");
        expect(run.result.failureReason).not.toContain(key);
        expect(JSON.stringify(run.events)).not.toContain(key);
        expect(run.events.some((e) => e.type === "error")).toBe(true);
        expect(readFileSync(run.logFile, "utf-8")).not.toContain(key);

        const sessionFiles = filesUnder(join(agentDir, "sessions")).filter((f) =>
          f.endsWith(".jsonl"),
        );
        expect(sessionFiles.length).toBeGreaterThanOrEqual(1);
        const native = sessionFiles.map((f) => readFileSync(f, "utf-8")).join("\n");
        expect(native).toContain("Incorrect API key provided");
        expect(native).not.toContain(key);
      },
      { timeout: 30_000 },
    );
  }
});
