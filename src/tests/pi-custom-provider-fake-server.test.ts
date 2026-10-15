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
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createPiRuntimeAuth,
  ensureCustomProvidersModelsJson,
  resolveModel,
} from "../providers/pi-mono-adapter";

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
      await ensureCustomProvidersModelsJson(dir, taskEnv);

      // Point the block we wrote at the fake server (the only edit).
      const modelsPath = join(dir, "models.json");
      const written = JSON.parse(await Bun.file(modelsPath).text());
      expect(written.providers.helmcode.apiKey).toBe("$HELMCODE_API_KEY");
      written.providers.helmcode.baseUrl = `http://127.0.0.1:${server.port}/v1`;
      await Bun.write(modelsPath, JSON.stringify(written));

      const modelRuntime = await createPiRuntimeAuth(taskEnv);
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
