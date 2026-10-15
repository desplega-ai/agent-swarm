import { expect, test } from "bun:test";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

test(
  "Stop hook closes its session without a runtime shutdown signal",
  async () => {
    const tempDir = `/tmp/hook-runtime-close-${crypto.randomUUID()}`;
    const agentId = crypto.randomUUID();
    const runtimeId = crypto.randomUUID();
    const closes: Array<{ body: unknown; agentId: string | null; runtimeId: string | null }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname === "/close") {
          closes.push({
            body: await req.json(),
            agentId: req.headers.get("X-Agent-ID"),
            runtimeId: req.headers.get("X-Runtime-Instance-ID"),
          });
          return new Response(null, { status: 204 });
        }
        return Response.json({ error: "Agent not found" }, { status: 404 });
      },
    });
    await Bun.$`mkdir -p ${tempDir}`.quiet();
    try {
      await Bun.write(
        `${tempDir}/.mcp.json`,
        JSON.stringify({
          mcpServers: {
            "agent-swarm": {
              url: `http://localhost:${server.port}/mcp`,
              headers: {
                Authorization: "Bearer test-hook-key",
                "X-Agent-ID": agentId,
                "X-Runtime-Instance-ID": runtimeId,
              },
            },
          },
        }),
      );
      expectChildOk(
        await runChild([process.execPath, `${import.meta.dir}/../hooks/hook.ts`], {
          cwd: tempDir,
          env: {
            ...process.env,
            CLAUDE_PROJECT_DIR: tempDir,
            PATH: tempDir,
            ANONYMIZED_TELEMETRY: "false",
          },
          stdin: JSON.stringify({ hook_event_name: "Stop", cwd: tempDir }),
        }),
        "Stop hook",
      );
      expect(closes).toEqual([{ body: { runtimeShutdown: false }, agentId, runtimeId }]);
    } finally {
      server.stop(true);
      await Bun.$`rm -rf ${tempDir}`.quiet();
    }
  },
  CHILD_PROCESS_TEST_BUDGET_MS,
);
