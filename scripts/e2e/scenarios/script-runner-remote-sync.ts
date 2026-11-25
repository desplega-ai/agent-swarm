import { rm } from "node:fs/promises";
import { WebSocket } from "ws";
import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import { benchmarkScripts } from "../script-runner";

export const scriptRunnerRemoteSync: Scenario = {
  name: "script-runner-remote-sync",
  order: 499,
  async run(ctx) {
    const path = "/api/script-runners/connect";
    const upgrade = (token: string) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(ctx.baseUrl.replace(/^http/, "ws") + path, {
          headers: { Authorization: `Bearer ${token}` },
        });
        ws.on("unexpected-response", (_req, response) => {
          response.resume();
          const status = response.statusCode ?? 0;
          ctx.recordHttpCall("GET", path, status);
          resolve(status);
          ws.terminate();
        });
        ws.on("open", () => {
          ctx.recordHttpCall("GET", path, 101);
          resolve(101);
          ws.close();
        });
        ws.on("error", () => {});
      });
    expect(
      (await upgrade(ctx.apiKey)) === (ctx.db.engine === "sqlite" ? 409 : 401),
      "engine and operator key gate",
    );
    if (ctx.db.engine === "sqlite") {
      const result = await ctx.api("GET", "/api/script-runners");
      expectStatus(result, [200], "list runners with embedded execution");
      expect(asRecords(result.json, "sessions").length === 0, "SQLite has no remote sessions");
      return;
    }
    const minted = await ctx.api("POST", "/api/script-runners/credentials", {
      body: { name: ctx.nonce, expiresAt: new Date(Date.now() + 3600000).toISOString() },
    });
    expectStatus(minted, [201], "mint credential");
    const token = asString(asRecord(minted.json).token, "token");
    const credentialId = asString(asRecord(asRecord(minted.json).credential).id, "credential id");
    const agent = await ctx.api("POST", "/api/agents", {
      body: { name: `remote-${ctx.nonce}`, role: "worker", status: "online" },
    });
    const agentId = asString(asRecord(agent.json).id, "agent id");
    const run = (executor: string, source = "export default () => 42") =>
      ctx.api("POST", "/api/scripts/run", { agentId, body: { executor, source } });
    const sessions = async () =>
      asRecords((await ctx.api("GET", "/api/script-runners")).json, "sessions");
    for (const executor of ["native", "quickjs"])
      expect(asRecord((await run(executor)).json).result === 42, "embedded baseline");
    if (process.env.E2E_SCRIPT_RUNNER_BENCH === "1")
      ctx.log(
        `Embedded benchmark: ${JSON.stringify(await benchmarkScripts(ctx.baseUrl, ctx.apiKey))}`,
      );
    // A synthetic runner verifies collisions and an ordinary missing response.
    const instanceId = crypto.randomUUID();
    const connectFixture = (credential: string, held: string[] = []) =>
      new Promise<{ ws: WebSocket; code: number }>((resolve) => {
        const ws = new WebSocket(ctx.baseUrl.replace(/^http/, "ws") + path, {
          headers: { Authorization: `Bearer ${credential}` },
        });
        ws.on("error", () => {});
        ws.on("open", () =>
          ws.send(
            JSON.stringify({
              type: "hello",
              instanceId,
              version: 1,
              slots: 1,
              executors: ["native"],
              held,
            }),
          ),
        );
        ws.once("message", () => resolve({ ws, code: 0 }));
        ws.once("close", (code) => resolve({ ws, code }));
      });
    const fixture = await connectFixture(token);
    expect(fixture.code === 0, "fixture runner welcomed");
    const duplicate = await connectFixture(token);
    expect(duplicate.code === 1011, "duplicate instance is retryable");
    const secondCredential = await ctx.api("POST", "/api/script-runners/credentials", {
      body: { name: `second-${ctx.nonce}` },
    });
    expectStatus(secondCredential, [201], "mint second credential");
    const otherToken = asString(asRecord(secondCredential.json).token, "second token");
    const otherDuplicate = await connectFixture(otherToken);
    expect(otherDuplicate.code === 1008, "an instance cannot change its bound credential");
    const held = await connectFixture(otherToken, [crypto.randomUUID()]);
    expect(held.code === 1008, "held jobs cannot be adopted");
    try {
      const started = performance.now();
      const unanswered = await run("native");
      expect(
        asRecord(unanswered.json).error === "executor_error",
        "missing result fails at RPC deadline",
      );
      expect(performance.now() - started < 40000, "RPC deadline bounds caller lifetime");
      expect(
        await pollUntil(async () => (await sessions()).length === 0, 3000, 50),
        "deadline removes dead session",
      );
    } finally {
      fixture.ws.terminate();
    }
    const replacement = await connectFixture(token);
    expect(replacement.code === 0, "same instance reconnects after old session closes");
    let jobReceived = false;
    replacement.ws.once("message", () => {
      jobReceived = true;
    });
    const requestAbort = new AbortController();
    const ignoredAbort = fetch(`${ctx.baseUrl}/api/scripts/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.apiKey}`,
        "X-Agent-ID": agentId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ executor: "native", source: "export default () => 42" }),
      signal: requestAbort.signal,
    }).catch(() => null);
    try {
      expect(
        await pollUntil(() => jobReceived, 10000, 50),
        "synthetic runner received job before abort",
      );
      requestAbort.abort();
      await ignoredAbort;
      expect(
        await pollUntil(async () => (await sessions()).length === 0, 8000, 50),
        "unanswered abort terminates socket and releases pending call",
      );
    } finally {
      requestAbort.abort();
      replacement.ws.terminate();
    }
    expect(
      await pollUntil(async () => (await sessions()).length === 0, 3000, 50),
      "replacement closes",
    );
    let runner = ctx.startScriptRunner(token);
    try {
      expect(
        await pollUntil(async () => (await sessions()).length === 1, 15000, 50),
        "runner connected",
      );
      ctx.recordHttpCall("GET", path, 101);
      for (let index = 0; index < 20; index++) {
        const result = await run(index % 2 ? "native" : "quickjs");
        expectStatus(result, [200], "remote run");
        expect(asRecord(result.json).result === 42, "remote result");
      }
      expect((await sessions())[0]?.jobsCompleted === 20, "both executors ran remotely");
      if (process.env.E2E_SCRIPT_RUNNER_BENCH === "1")
        ctx.log(
          `Remote benchmark: ${JSON.stringify(await benchmarkScripts(ctx.baseUrl, ctx.apiKey))}`,
        );
      const longSource =
        "export default async () => { await new Promise(r => setTimeout(r, 20000)); return 42; }";
      const pending = run("native", longSource);
      expect(
        await pollUntil(async () => (await sessions())[0]?.jobsInFlight === 1, 10000, 50),
        "run in flight",
      );
      const busyCount = (await sessions())[0]?.jobsCompleted;
      expect(
        asRecord((await run("quickjs")).json).result === 42,
        "busy runner falls back to embedded",
      );
      expect(
        (await sessions())[0]?.jobsCompleted === busyCount,
        "fallback consumes no remote slot",
      );
      await runner.stop("SIGKILL");
      expect(
        asRecord((await pending).json).error === "executor_error",
        "disconnect fails pending caller",
      );
      runner = ctx.startScriptRunner(token);
      expect(
        await pollUntil(async () => (await sessions()).length === 1, 15000, 50),
        "runner reconnected",
      );
      const abort = new AbortController();
      const aborted = fetch(`${ctx.baseUrl}/api/scripts/run`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.apiKey}`,
          "X-Agent-ID": agentId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ executor: "native", source: longSource }),
        signal: abort.signal,
      }).catch(() => null);
      expect(
        await pollUntil(async () => (await sessions())[0]?.jobsInFlight === 1, 10000, 50),
        "abort run in flight",
      );
      abort.abort();
      await aborted;
      expect(
        await pollUntil(
          async () => (await sessions())[0]?.jobsInFlight === 0 && runner.logs().includes("killed"),
          10000,
          50,
        ),
        "client abort kills remote job",
      );
      const marker = `/tmp/phase4-${ctx.nonce}.pid`;
      try {
        const restartRun = run(
          "native",
          `export default async () => { await Bun.write(${JSON.stringify(marker)}, String(process.pid)); await new Promise(r => setTimeout(r, 20000)); return 42; }`,
        ).catch(() => null);
        expect(
          await pollUntil(() => Bun.file(marker).exists(), 10000, 50),
          "native process started",
        );
        const pid = Number(await Bun.file(marker).text());
        await ctx.restartSut();
        await restartRun;
        const started = performance.now();
        expect(
          await pollUntil(async () => (await sessions()).length === 1, 3000, 50),
          "first hello within three seconds of healthy API",
        );
        expect(performance.now() - started < 3000, "fast reconnect");
        expect(
          await pollUntil(
            () => {
              try {
                process.kill(pid, 0);
                return false;
              } catch {
                return true;
              }
            },
            5000,
            50,
          ),
          "restart kills old inline child",
        );
      } finally {
        await rm(marker, { force: true });
      }
      await ctx.restartSut({ env: { SCRIPT_EXECUTOR: "quickjs" } });
      expect(
        await pollUntil(async () => (await sessions()).length === 1, 10000, 50),
        "reconnect to restricted API",
      );
      expectStatus(await run("native"), [400], "API executor ceiling");
      expect(asRecord((await run("quickjs")).json).result === 42, "restricted remote quickjs");
      await ctx.api("DELETE", `/api/script-runners/credentials/${credentialId}`);
      expect(
        await pollUntil(async () => (await sessions()).length === 0, 5000, 50),
        "revoke closes session after commit",
      );
      expect((await upgrade(token)) === 401, "revoked upgrade refused");
      expect(
        !runner.logs().includes(token) &&
          !runner.logs().includes("export default") &&
          !runner.logs().includes('"result"'),
        "runner logs contain only ids and codes",
      );
    } finally {
      await runner.stop();
      await ctx.restartSut();
    }
  },
};
