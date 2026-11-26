// Trial of `@emulators/ai` (vercel-labs/emulate) as the SUT's inference backend.
//
// The suite's own mock (`mocks/llm.ts`) synthesizes OpenAI answers by hand. This scenario
// points OPENROUTER_BASE_URL at the emulator instead, for one restart, and drives the two
// server-side inference paths through it:
//   - `/api/internal/raw-llm`: the ai SDK on the OpenAI Responses API, unary. Text, a JSON
//     schema object, and an injected 429 the SDK must retry past.
//   - task auto-titling: pi-ai on Chat Completions, streamed, with `set_title` forced as a
//     tool call. The emulator answers with a scripted tool call and the title must land.
//     OpenRouter is opt-in for internal calls (#3667): with OPENROUTER_API_KEY and a Claude
//     token both set, the title comes from a stub `claude` CLI and the emulator sees nothing;
//     only INTERNAL_LLM_PROVIDER=openrouter sends it to the emulator. GET /status reports
//     the policy in `internal_ai`.
// The emulator's call record (`GET /_ai/calls`) proves which wire format, stream mode and
// rule answered each call, so the assertions check the request shape, not only the result.
// Embeddings stay on the suite mock: the emulator has no embeddings route.
import { createEmulator } from "emulate";
import { asRecord, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import { readTask } from "./core-helpers";
import { putConfig, reloadConfig } from "./platform-helpers";

type AiCall = {
  format?: string;
  stream?: boolean;
  status?: number;
  /** Declared tool names. */
  tools?: string[];
  toolChoice?: unknown;
  matched?: { id?: string } | null;
};

export const llmEmulateAi: Scenario = {
  name: "llm-emulate-ai",
  order: 364,
  async run(ctx) {
    const textMarker = `emu-text-${ctx.nonce}`;
    const retryMarker = `emu-retry-${ctx.nonce}`;
    const objectMarker = `emu-object-${ctx.nonce}`;
    const titleMarker = `emu-title-${ctx.nonce}`;
    const textReply = `emulated answer ${ctx.nonce}`;
    const objectLabel = `emulated-${ctx.nonce}`;
    const title = `Emulated title ${ctx.nonce}`;
    const claudeMarker = `emu-claude-${ctx.nonce}`;
    const claudeTitle = `Claude CLI title ${ctx.nonce}`;
    // Stands in for `claude -p --output-format json --json-schema …`: reads the prompt,
    // answers the envelope with `structured_output`, and records that it ran.
    const claudeStub = `/tmp/e2e-claude-stub-${ctx.nonce}.sh`;
    const claudeRan = `/tmp/e2e-claude-stub-${ctx.nonce}.ran`;
    await Bun.write(
      claudeStub,
      `#!/bin/sh\ncat >/dev/null\necho "$*" >> ${claudeRan}\necho '${JSON.stringify({ result: "", structured_output: { title: claudeTitle } })}'\n`,
    );
    await Bun.$`chmod +x ${claudeStub}`.quiet();

    const emulator = await createEmulator({
      service: "ai",
      port: 0,
      seed: {
        ai: {
          rules: [
            {
              id: "raw-text",
              match: { format: "openai-responses", textContains: textMarker },
              reply: [{ type: "text", text: textReply }],
            },
            {
              id: "raw-retry-429",
              match: { format: "openai-responses", textContains: retryMarker },
              times: 1,
              error: {
                status: 429,
                message: "Injected rate limit.",
                headers: { "retry-after-ms": "10" },
              },
            },
            {
              id: "raw-retry-ok",
              match: { format: "openai-responses", textContains: retryMarker },
              reply: [{ type: "text", text: `${textReply} after retry` }],
            },
            {
              id: "raw-object",
              match: { format: "openai-responses", textContains: objectMarker },
              reply: [{ type: "object", value: { label: objectLabel } }],
            },
            {
              id: "task-title",
              match: {
                format: "openai-chat",
                stream: true,
                tool: "set_title",
                textContains: titleMarker,
              },
              reply: [{ type: "tool_call", name: "set_title", arguments: { title } }],
            },
          ],
        },
      },
    });
    // The emulator binds 127.0.0.1; its advertised url says localhost.
    const origin = `http://127.0.0.1:${new URL(emulator.url).port}`;
    const calls = async (): Promise<AiCall[]> => {
      const response = await fetch(`${origin}/_ai/calls`);
      expect(response.ok, `GET /_ai/calls answered ${response.status}`);
      return (await response.json()) as AiCall[];
    };
    const callsFor = async (ruleId: string) =>
      (await calls()).filter((call) => call.matched?.id === ruleId);

    let restarted = false;
    const taskIds: string[] = [];
    let providerConfigId: string | undefined;
    const readInternalAi = async () => {
      const status = await ctx.api("GET", "/status");
      expectStatus(status, [200], "read /status");
      return asRecord(asRecord(status.json).internal_ai);
    };
    const createTask = async (marker: string) => {
      const created = await ctx.api("POST", "/api/tasks", {
        body: {
          task: `Investigate the emulated inference backend for the e2e suite (${marker})`,
          source: "api",
        },
      });
      expectStatus(created, [201], "create a task for auto-titling");
      const id = asString(asRecord(created.json).id, "task id");
      taskIds.push(id);
      return id;
    };
    const waitForTitle = async (id: string, expected: string) => {
      let storedTitle: unknown;
      const titled = await pollUntil(async () => {
        storedTitle = (await readTask(ctx, id)).title;
        return storedTitle === expected;
      }, 20_000);
      expect(
        titled,
        `the auto-title listener never stored "${expected}" (last: ${String(storedTitle)})`,
      );
    };
    try {
      restarted = true;
      await ctx.restartSut({
        env: {
          OPENROUTER_BASE_URL: `${origin}/v1`,
          CLAUDE_CODE_OAUTH_TOKEN: `e2e-fake-${ctx.nonce}`,
          CLAUDE_BINARY: claudeStub,
        },
      });

      // ── default policy: an OpenRouter key alone is not an opt-in ──
      const auto = await readInternalAi();
      expect(
        auto.provider === "auto" &&
          Array.isArray(auto.order) &&
          auto.order[0] === "claude-cli" &&
          !auto.order.includes("openrouter"),
        `/status internal_ai must report the auto order without OpenRouter: ${JSON.stringify(auto)}`,
      );
      await waitForTitle(await createTask(claudeMarker), claudeTitle);
      const stubArgs = await Bun.file(claudeRan).text();
      expect(
        stubArgs.includes("--model haiku"),
        `the title must come from claude -p --model haiku: ${stubArgs}`,
      );
      const openRouterTitleCalls = (await calls()).filter((call) =>
        JSON.stringify(call).includes(claudeMarker),
      );
      expect(
        openRouterTitleCalls.length === 0,
        `with a Claude token set, a title went to OpenRouter: ${JSON.stringify(openRouterTitleCalls)}`,
      );

      // ── explicit opt-in: INTERNAL_LLM_PROVIDER=openrouter ──
      const invalid = await ctx.api("PUT", "/api/config", {
        body: { scope: "global", key: "INTERNAL_LLM_PROVIDER", value: "deepseek" },
      });
      expectStatus(invalid, [400], "an unknown INTERNAL_LLM_PROVIDER is refused");
      providerConfigId = String(
        (await putConfig(ctx, { key: "INTERNAL_LLM_PROVIDER", value: "openrouter" })).id,
      );
      await reloadConfig(ctx);
      const optedIn = await readInternalAi();
      expect(
        optedIn.provider === "openrouter" && JSON.stringify(optedIn.order) === '["openrouter"]',
        `/status internal_ai must report the OpenRouter opt-in: ${JSON.stringify(optedIn)}`,
      );

      // ── raw-llm, plain text: Responses API, unary ──
      const text = await ctx.api("POST", "/api/internal/raw-llm", {
        body: { prompt: `say something ${textMarker}` },
      });
      expectStatus(text, [200], "raw-llm through the emulator");
      expect(
        asRecord(text.json).result === textReply,
        `raw-llm must return the emulator's scripted text: ${text.text}`,
      );
      const [textCall] = await callsFor("raw-text");
      expect(
        textCall?.format === "openai-responses" && textCall.stream === false,
        `raw-llm must post a unary Responses request: ${JSON.stringify(textCall)}`,
      );

      // ── raw-llm, injected 429: the ai SDK retries and the second attempt answers ──
      const retried = await ctx.api("POST", "/api/internal/raw-llm", {
        body: { prompt: `say something ${retryMarker}` },
      });
      expectStatus(retried, [200], "raw-llm after one 429");
      expect(
        asRecord(retried.json).result === `${textReply} after retry`,
        `raw-llm must recover from one 429: ${retried.text}`,
      );
      const rateLimited = await callsFor("raw-retry-429");
      expect(
        rateLimited.length === 1 && rateLimited[0]?.status === 429,
        `the emulator must have answered exactly one 429: ${JSON.stringify(rateLimited)}`,
      );

      // ── raw-llm with a schema: structured output ──
      const object = await ctx.api("POST", "/api/internal/raw-llm", {
        body: {
          prompt: `classify ${objectMarker}`,
          schema: {
            type: "object",
            properties: { label: { type: "string" } },
            required: ["label"],
          },
        },
      });
      expectStatus(object, [200], "raw-llm with a schema through the emulator");
      expect(
        asRecord(asRecord(object.json).result).label === objectLabel,
        `raw-llm with a schema must return the emulator's scripted object: ${object.text}`,
      );

      // ── task auto-title: Chat Completions, streamed, forced set_title tool call ──
      await waitForTitle(await createTask(titleMarker), title);
      const [titleCall] = await callsFor("task-title");
      expect(
        titleCall?.format === "openai-chat" &&
          titleCall.stream === true &&
          titleCall.tools?.includes("set_title") &&
          titleCall.toolChoice === "required",
        `auto-title must stream a Chat Completions request that forces set_title: ${JSON.stringify(titleCall)}`,
      );

      // None of these prompts reached the suite's own inference mock.
      // The nonce is per run, so match this scenario's markers, not the bare nonce.
      const markers = [textMarker, retryMarker, objectMarker, titleMarker, claudeMarker];
      const leaked = ctx.llm.requests.filter((request) => {
        const body = JSON.stringify(request.body ?? "");
        return markers.some((marker) => body.includes(marker));
      });
      expect(
        leaked.length === 0,
        `${leaked.length} request(s) went to the suite mock, not the emulator`,
      );
    } finally {
      for (const id of taskIds) await ctx.api("POST", `/api/tasks/${id}/cancel`, { body: {} });
      if (providerConfigId) await ctx.api("DELETE", `/api/config/${providerConfigId}`);
      // Later scenarios run on the base environment and the suite mock.
      if (restarted) await ctx.restartSut();
      await emulator.close();
      await Bun.$`rm -f ${claudeStub} ${claudeRan}`.quiet();
    }
  },
};
