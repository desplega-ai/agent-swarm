/**
 * The provider key splice and the `helmcode` block, run through the real
 * `@opencode/sdk` embedded host against a fake OpenAI-compatible server.
 *
 * `applyProviderKeySplice` builds the provider entry; the test only repoints
 * `options.baseURL` at a local `Bun.serve({ port: 0 })` that answers
 * `/v1/chat/completions`, then checks the request OpenCode sent: the picked
 * pool member as the bearer (not the comma pool sitting in `process.env`) and
 * the bare model id. The model catalog is bundled in the SDK, and no request
 * leaves the machine. The control test pins why `env: []` is needed: without
 * it, the pool in `process.env` beats `options.apiKey`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode, type OpenCodeEvent } from "@opencode/sdk";
import { applyProviderKeySplice, type OpencodeConfig } from "../providers/opencode-adapter";

const TEST_TIMEOUT_MS = 60_000;

const PICKED = "sk-helmcode-picked-live-0123456789";
const POOL_IN_PROCESS_ENV = "sk-helmcode-wrong-aaaaaaaaaa,sk-helmcode-wrong-bbbbbbbbbb";

type SeenRequest = { path: string; authorization: string | null; model?: string };

let server: ReturnType<typeof Bun.serve>;
let directory: string;
const seen: SeenRequest[] = [];
let prevHelmcodeKey: string | undefined;

/** One streamed (or plain) assistant turn that says "pong". */
function completion(model: string, stream: boolean): Response {
  const base = { id: "chatcmpl-test", created: 0, model };
  const usage = { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 };
  if (!stream) {
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
      usage,
    });
  }
  const chunk = (body: Record<string, unknown>) =>
    `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", ...body })}\n\n`;
  const sse =
    chunk({
      choices: [{ index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: null }],
    }) +
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }) +
    "data: [DONE]\n\n";
  return new Response(sse, { headers: { "content-type": "text/event-stream" } });
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "opencode-helmcode-sdk-"));
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as any) : {};
      seen.push({
        path: url.pathname,
        authorization: req.headers.get("authorization"),
        model: body?.model,
      });
      if (url.pathname.endsWith("/chat/completions")) {
        return completion(String(body?.model ?? ""), body?.stream === true);
      }
      return new Response("not found", { status: 404 });
    },
  });
  // The pool a production entrypoint exports raw; the splice must beat it.
  prevHelmcodeKey = process.env.HELMCODE_API_KEY;
  process.env.HELMCODE_API_KEY = POOL_IN_PROCESS_ENV;
});

afterAll(() => {
  server.stop(true);
  rmSync(directory, { recursive: true, force: true });
  if (prevHelmcodeKey === undefined) delete process.env.HELMCODE_API_KEY;
  else process.env.HELMCODE_API_KEY = prevHelmcodeKey;
});

async function runOnePrompt(config: OpencodeConfig): Promise<string> {
  const host = await OpenCode.create({
    config: { content: JSON.stringify(config) },
    plugins: [],
    log: { level: "error", emit: () => {} },
  });
  try {
    const session = await host.sessions.create({ location: { directory } });
    const done = (async () => {
      for await (const event of host.events.subscribe() as AsyncIterable<OpenCodeEvent>) {
        const data = (event as { data?: { sessionID?: string; error?: unknown } }).data;
        if (data?.sessionID !== session.id) continue;
        if (event.type === "session.execution.succeeded") return "succeeded";
        if (event.type === "session.execution.failed") {
          return `failed: ${JSON.stringify(data.error)}`;
        }
      }
      return "stream ended";
    })();
    await host.sessions.prompt({ sessionID: session.id, text: "say pong", delivery: "queue" });
    return await done;
  } finally {
    await host.close();
  }
}

describe("provider key splice through the real OpenCode host", () => {
  test(
    "sends the picked key and the bare model id to the provider's baseURL",
    async () => {
      seen.length = 0;
      const model = "helmcode/glm5.3";
      const config: OpencodeConfig = { model };
      const spliced = applyProviderKeySplice(config, model, { HELMCODE_API_KEY: PICKED });
      expect(spliced?.name).toBe("HELMCODE_API_KEY");
      const helmcode = config.provider?.helmcode;
      if (!helmcode?.options) throw new Error("helmcode block missing");
      helmcode.options.baseURL = `http://127.0.0.1:${server.port}/v1`;

      const outcome = await runOnePrompt(config);

      const chats = seen.filter((r) => r.path === "/v1/chat/completions");
      expect(chats.length).toBeGreaterThan(0);
      for (const chat of chats) {
        expect(chat.authorization).toBe(`Bearer ${PICKED}`);
        expect(chat.model).toBe("glm5.3");
      }
      expect(outcome).toBe("succeeded");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "nan (built-in provider): env [] plus the picked key beats a pool in process.env",
    async () => {
      const prevNan = process.env.NAN_API_KEY;
      process.env.NAN_API_KEY = POOL_IN_PROCESS_ENV;
      seen.length = 0;
      try {
        const model = "nan/glm5.3-flash";
        const config: OpencodeConfig = { model };
        const spliced = applyProviderKeySplice(config, model, { NAN_API_KEY: PICKED });
        expect(spliced?.name).toBe("NAN_API_KEY");
        const nan = config.provider?.nan;
        if (!nan?.options) throw new Error("nan block missing");
        nan.options.baseURL = `http://127.0.0.1:${server.port}/v1`;

        const outcome = await runOnePrompt(config);

        const chats = seen.filter((r) => r.path === "/v1/chat/completions");
        expect(chats.length).toBeGreaterThan(0);
        for (const chat of chats) {
          expect(chat.authorization).toBe(`Bearer ${PICKED}`);
          expect(chat.model).toBe("glm5.3-flash");
        }
        expect(outcome).toBe("succeeded");
      } finally {
        if (prevNan === undefined) delete process.env.NAN_API_KEY;
        else process.env.NAN_API_KEY = prevNan;
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "nan control: without the splice the pool in process.env reaches the provider",
    async () => {
      const prevNan = process.env.NAN_API_KEY;
      process.env.NAN_API_KEY = POOL_IN_PROCESS_ENV;
      seen.length = 0;
      try {
        const model = "nan/glm5.3-flash";
        const config: OpencodeConfig = {
          model,
          provider: {
            nan: { options: { apiKey: PICKED, baseURL: `http://127.0.0.1:${server.port}/v1` } },
          },
        };
        await runOnePrompt(config);
        const chats = seen.filter((r) => r.path === "/v1/chat/completions");
        expect(chats.length).toBeGreaterThan(0);
        expect(chats[0]?.authorization).not.toBe(`Bearer ${PICKED}`);
      } finally {
        if (prevNan === undefined) delete process.env.NAN_API_KEY;
        else process.env.NAN_API_KEY = prevNan;
      }
    },
    TEST_TIMEOUT_MS,
  );
});
