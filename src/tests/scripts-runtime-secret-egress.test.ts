import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runScript } from "../scripts-runtime/loader";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";

const savedEnv = { ...process.env };

beforeEach(() => {
  process.env.AGENT_SWARM_API_KEY = "runtime-egress-secret-1234567890";
  refreshSecretScrubberCache();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  refreshSecretScrubberCache();
});

describe("runtime secret egress", () => {
  test("scrubObject catches unwrapped returned config secrets", async () => {
    const output = await runScript({
      agentId: "agent-1",
      resources: { memoryMb: 2048 },
      source:
        "export default async (_args, ctx) => ({ leaked: ctx.stdlib.Redacted.value(ctx.swarm.config.apiKey) });",
    });

    expect(output.result).toEqual({ leaked: "[REDACTED:AGENT_SWARM_API_KEY]" });
  });

  test("wrapped config values stringify to redacted in the result file", async () => {
    const output = await runScript({
      agentId: "agent-1",
      resources: { memoryMb: 2048 },
      source: "export default async (_args, ctx) => ({ wrapped: ctx.swarm.config.apiKey });",
    });

    expect(output.result).toEqual({ wrapped: "<redacted>" });
  });
});
