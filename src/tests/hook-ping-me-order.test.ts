import { expect, test } from "bun:test";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

/**
 * Runs the Claude hook once against a server whose /ping holds until /me
 * arrives (or a short timeout passes), and returns the order the server saw.
 */
async function runHookAndRecord(hookEventName: string): Promise<string[]> {
  const tempDir = `/tmp/hook-ping-me-order-${crypto.randomUUID()}`;
  const events: string[] = [];
  let releasePing: (() => void) | undefined;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/ping") {
        events.push("ping:start");
        await new Promise<void>((resolve) => {
          releasePing = resolve;
          setTimeout(resolve, 300);
        });
        events.push("ping:end");
        return new Response(null, { status: 204 });
      }
      if (path === "/me") {
        events.push("me");
        releasePing?.();
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
              "X-Agent-ID": crypto.randomUUID(),
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
        stdin: JSON.stringify({ hook_event_name: hookEventName, cwd: tempDir }),
      }),
      `${hookEventName} hook`,
    );
    return events;
  } finally {
    server.stop(true);
    await Bun.$`rm -rf ${tempDir}`.quiet();
  }
}

test(
  "tool events send /ping and /me together",
  async () => {
    const events = await runHookAndRecord("PostToolUse");
    expect(events).toContain("me");
    expect(events.indexOf("me")).toBeLessThan(events.indexOf("ping:end"));
  },
  CHILD_PROCESS_TEST_BUDGET_MS,
);

test(
  "non-tool events read /me only after /ping completes",
  async () => {
    const events = await runHookAndRecord("UserPromptSubmit");
    expect(events).toEqual(["ping:start", "ping:end", "me"]);
  },
  CHILD_PROCESS_TEST_BUDGET_MS,
);
