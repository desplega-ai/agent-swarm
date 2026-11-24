import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/sdk";
import { applyProviderKeySplice, type OpencodeConfig } from "../providers/opencode-adapter";
import { createModelDiscovery } from "../utils/provider-model-discovery";
import { effectiveModelLimits } from "../utils/provider-model-limits";

test("real pinned host preserves separate input/output/context facts before the first prompt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "model-limits-sdk-"));
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      calls++;
      expect(new URL(req.url).pathname).toBe("/gateway/model/info");
      expect(req.headers.get("authorization")).toBe("Bearer synthetic-sdk-key");
      return Response.json({
        data: [
          {
            model_name: "example-large-chat",
            model_info: {
              max_input_tokens: 922000,
              max_output_tokens: 128000,
              max_tokens: 128000,
            },
          },
        ],
      });
    },
  });
  try {
    const baseURL = `http://127.0.0.1:${server.port}/gateway/v1`;
    const discovered = await createModelDiscovery()({
      provider: "openrouter",
      modelId: "example-large-chat",
      key: "synthetic-sdk-key",
      baseURL,
    });
    for (const semantics of ["conservative", "input-plus-output"] as const) {
      const limits = effectiveModelLimits({ discovered: discovered.limits, semantics });
      const config: OpencodeConfig = { model: "openrouter/example-large-chat" };
      applyProviderKeySplice(config, "openrouter/example-large-chat", {
        OPENROUTER_API_KEY: "synthetic-sdk-key",
      });
      const provider = config.provider?.openrouter;
      if (!provider?.models) throw new Error("missing model entry");
      provider.options = { ...provider.options, baseURL };
      provider.models["example-large-chat"] = {
        ...provider.models["example-large-chat"],
        limit: {
          input: limits.input,
          output: limits.output,
          context: limits.context,
        },
      };
      const host = await OpenCode.create({
        plugins: [
          {
            id: "agent-swarm",
            async setup() {
              await Bun.sleep(50);
            },
          },
        ],
        config: { content: JSON.stringify(config) },
        log: { level: "error", emit: () => {} },
      });
      try {
        await host.sessions.create({ location: { directory } });
        let models = await host.model.list({ location: { directory } });
        // SDK activation performs filesystem work and competes with four test
        // workers in CI. Production preparation retains its separate 5s cap.
        const deadline = Date.now() + 20000;
        let plugins = await host.plugin.list({ location: { directory } });
        while (
          !plugins.data.some((p) => p.id === "agent-swarm" && p.state.status === "active") &&
          Date.now() < deadline
        ) {
          await Bun.sleep(25);
          plugins = await host.plugin.list({ location: { directory } });
        }
        expect(
          plugins.data.some((p) => p.id === "agent-swarm" && p.state.status === "active"),
        ).toBe(true);
        models = await host.model.list({ location: { directory } });
        while (
          !models.data.some(
            (m) => m.providerID === "openrouter" && m.id === "example-large-chat",
          ) &&
          Date.now() < deadline
        ) {
          await Bun.sleep(25);
          models = await host.model.list({ location: { directory } });
        }
        const actual = models.data.find(
          (model) => model.providerID === "openrouter" && model.id === "example-large-chat",
        );
        expect(actual?.limit).toEqual({
          input: 922000,
          output: 128000,
          context: semantics === "conservative" ? 922000 : 1050000,
        });
        // Pinned 2.4.1 compaction inputWindow uses min(input, context), not
        // context-output. Sum interpretation must not enlarge the input budget.
        expect(Math.min(actual?.limit.input ?? Infinity, actual?.limit.context ?? Infinity)).toBe(
          922000,
        );
      } finally {
        await host.close();
      }
    }
    expect(calls).toBe(1); // No model/inference call was needed for this proof.
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
