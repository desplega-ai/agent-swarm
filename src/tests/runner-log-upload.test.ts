import { expect, test } from "bun:test";
import { spawnProviderProcess } from "../commands/runner";
import type { ProviderEvent } from "../providers/types";

test("runner uploads bounded oversized and escaped events without losing adjacent lines", async () => {
  const directory = `${import.meta.dir}/../../work/runner-upload-${crypto.randomUUID()}`;
  const bodies: Array<{ bytes: number; lines: string[] }> = [];
  const before = "before-oversized-event";
  const after = "after-control-events";
  const bodyLimit = 16 * 1024 * 1024;
  const expectedLines = 7;
  let resolveUploads!: () => void;
  const uploaded = new Promise<void>((resolve) => {
    resolveUploads = resolve;
  });
  const server = Bun.serve({
    port: 0,
    maxRequestBodySize: 32 * 1024 * 1024,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/api/session-logs") {
        return Response.json({ configs: [], enabled: false });
      }
      const text = await request.text();
      const bytes = new TextEncoder().encode(text).length;
      const body = JSON.parse(text) as { lines: string[] };
      bodies.push({ bytes, lines: body.lines });
      if (bodies.reduce((total, batch) => total + batch.lines.length, 0) === expectedLines) {
        resolveUploads();
      }
      return bytes > bodyLimit
        ? new Response("body too large", { status: 413 })
        : Response.json({ success: true, count: body.lines.length }, { status: 201 });
    },
  });
  try {
    await Bun.$`mkdir -p ${directory}`.quiet();
    const adapter = {
      name: "pi",
      traits: {},
      async createSession() {
        return {
          sessionId: crypto.randomUUID(),
          onEvent(listener: (event: ProviderEvent) => void) {
            for (const content of [
              before,
              JSON.stringify({ type: "tool_end", result: "x".repeat(17 * 1024 * 1024) }),
              ...Array.from({ length: 4 }, () => "\u0000".repeat(1024 * 1024)),
              after,
            ]) {
              listener({ type: "raw_log", content });
            }
          },
          async waitForCompletion() {
            return { exitCode: 0, isError: false };
          },
          async abort() {},
        };
      },
    } as unknown as Parameters<typeof spawnProviderProcess>[0];
    const running = await spawnProviderProcess(
      adapter,
      {
        prompt: "fixture",
        systemPrompt: "fixture",
        logFile: `${directory}/session.jsonl`,
        role: "worker",
        apiUrl: server.url.origin,
        apiKey: "example-runner-key",
        agentId: crypto.randomUUID(),
        runnerSessionId: crypto.randomUUID(),
        iteration: 1,
        taskId: crypto.randomUUID(),
        harnessProvider: "pi",
        cwd: directory,
      },
      directory,
    );
    await running.promise;
    await Promise.race([
      uploaded,
      Bun.sleep(5_000).then(() => {
        throw new Error("runner did not upload all seven emitted log lines");
      }),
    ]);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body.bytes).toBeLessThanOrEqual(bodyLimit);
    const accepted = bodies.filter((body) => body.bytes <= bodyLimit).flatMap((body) => body.lines);
    expect(accepted).toHaveLength(expectedLines);
    expect(accepted).toContain(before);
    expect(accepted).toContain(after);
    expect(accepted.some((line) => line.includes("[truncated"))).toBe(true);
  } finally {
    await server.stop(true);
    await Bun.$`rm -rf ${directory}`.quiet();
  }
}, 15_000);
