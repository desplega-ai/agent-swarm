import { connect } from "node:net";
import { asRecord, expect, expectStatus } from "../http";
import { SkipError } from "../report";
import type { Scenario, ScenarioContext } from "../run";
import { callTool, expectToolError, registerWorker } from "./platformb-helpers";

const DISABLED = "runtime pools are disabled";

/** Sends a WebSocket upgrade request over a raw socket and returns the HTTP status line's code. */
async function upgradeStatus(
  ctx: ScenarioContext,
  path: string,
  headers: Record<string, string>,
): Promise<number> {
  const url = new URL(ctx.baseUrl);
  const started = performance.now();
  const status = await new Promise<number>((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    let received = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`No response to the upgrade request for ${path} within 10 seconds`));
    }, 10_000);
    socket.on("connect", () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${url.host}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Key: ${Buffer.from(crypto.randomUUID()).toString("base64").slice(0, 24)}`,
          ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
      const line = /^HTTP\/1\.[01] (\d{3})/.exec(received);
      if (!line) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(Number(line[1]));
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  ctx.recordHttpCall("GET", path.split("?")[0] ?? path, status, performance.now() - started);
  return status;
}

/**
 * The SUT runs with MULTI_RUNTIME_ENABLED=false, so the runtime-pool surface answers its flag-off
 * contract (the `runtime-pools` scenario covers the HTTP routes): every runtime-pool and
 * runtime-controller tool reports "runtime pools are disabled" and changes nothing, and the
 * remote controller socket refuses the upgrade with a 404 before it looks at any credential.
 */
export const platformbRuntime: Scenario = {
  name: "platformb-runtime",
  order: 670,
  async run(ctx) {
    const status = await ctx.api("GET", "/status");
    expectStatus(status, [200], "read runtime supervisor status");
    if (asRecord(asRecord(status.json).runtime_pools).enabled !== false) {
      throw new SkipError("Runtime pools are on: the flag-off contract does not apply to this run");
    }

    const workerId = await registerWorker(ctx, `e2e-platformb-runtime-${ctx.nonce}`);
    const connection = await ctx.connectMcp(workerId);
    try {
      const poolsBefore = Number(
        ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runtime_pools")?.n,
      );
      const controllersBefore = Number(
        ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runtime_controllers")?.n,
      );

      const poolName = `e2e-pool-${ctx.nonce}`;
      const disabledCalls: [string, Record<string, unknown>][] = [
        ["runtime-pool-list", {}],
        ["runtime-controller-list", {}],
        [
          "runtime-pool-upsert",
          { name: poolName, kind: "docker", placements: ["controller-1"], maxRuntimes: 1 },
        ],
        ["runtime-pool-upsert", { id: "pool-1", maxRuntimes: 2 }],
        ["runtime-pool-create-agent", { poolId: "pool-1", name: `e2e-pool-agent-${ctx.nonce}` }],
        ["runtime-pool-bind-agent", { agentId: workerId, poolId: "pool-1" }],
        ["runtime-pool-bind-agent", { agentId: workerId, poolId: null }],
        ["runtime-pool-delete", { poolId: "pool-1" }],
        ["runtime-pool-delete", { poolId: "pool-1", force: true }],
      ];
      for (const [tool, args] of disabledCalls) {
        expectToolError(
          await callTool(connection, tool, args),
          DISABLED,
          `${tool} ${JSON.stringify(args)}`,
        );
      }

      // Creating a pool needs name, kind and a placement; that check runs before the flag check.
      expectToolError(
        await callTool(connection, "runtime-pool-upsert", { name: poolName }),
        "Pool creation requires name, kind, and one controller placement.",
        "runtime-pool-upsert without kind and placements",
      );
      // The list tools take no arguments.
      for (const tool of ["runtime-pool-list", "runtime-controller-list"]) {
        expect(
          (await callTool(connection, tool, { unexpected: true })).isError,
          `${tool} accepted an argument it does not define`,
        );
      }
      expect(
        (await callTool(connection, "runtime-pool-delete", {})).isError,
        "runtime-pool-delete accepted a call with no poolId",
      );

      // Nothing was created or bound.
      expect(
        Number(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runtime_pools")?.n) ===
          poolsBefore &&
          Number(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runtime_controllers")?.n) ===
            controllersBefore,
        "A disabled runtime-pool tool wrote a pool or a controller",
      );
      expect(
        ctx.db.get("SELECT 1 FROM runtime_pools WHERE name = ?", [poolName]) === null,
        "The refused pool exists",
      );
      const agent = await ctx.api("GET", `/api/agents/${workerId}`);
      expectStatus(agent, [200], "read the worker after the bind attempts");
      expect(asRecord(agent.json).runtimePoolId === null, "The worker was bound to a pool");

      // --- the controller socket: flag off means 404 for the upgrade, with or without a credential.
      const connectPath = "/api/controllers/connect";
      expect(
        (await upgradeStatus(ctx, connectPath, { Authorization: `Bearer ${ctx.apiKey}` })) === 404,
        "A controller upgrade with the operator key was not refused with 404",
      );
      expect(
        (await upgradeStatus(ctx, connectPath, {})) === 404,
        "A controller upgrade with no credential was not refused with 404",
      );
      expect(
        (await upgradeStatus(ctx, connectPath, {
          Authorization: "Bearer aswt_not-a-controller-token",
        })) === 404,
        "A controller upgrade with a bad token was not refused with 404",
      );
      // Without the upgrade headers the path is a plain GET, which nothing serves.
      expectStatus(await ctx.api("GET", connectPath), [404], "plain GET of the controller socket");
    } finally {
      await connection.close();
    }
  },
};
