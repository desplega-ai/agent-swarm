import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLegacyDriverFixture } from "../db";
import { asRecord, expect, pollUntil } from "../http";
import type { Scenario } from "../run";
import { repoRoot } from "../sut";

export const dbDriverStartup: Scenario = {
  name: "db-driver-startup",
  order: 23,
  async run(ctx) {
    const root = join(tmpdir(), `db-worker-review-startup-${crypto.randomUUID()}`);
    await Bun.$`mkdir -p ${root}`.quiet();
    const endpoint = new URL(ctx.sutEnv.DESPLEGA_TELEMETRY_ENDPOINT!);
    expect(
      endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1",
      "startup fixtures require loopback telemetry",
    );
    try {
      for (const mode of ["invalid", "memory", "legacy"] as const) {
        const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
        const port = listener.port!;
        listener.stop(true);
        const path = `${root}/${mode}.sqlite`;
        if (mode === "legacy") await writeLegacyDriverFixture(ctx.sutEnv.DATABASE_PATH!, path);
        const child = Bun.spawn([process.execPath, "run", "src/http.ts"], {
          cwd: repoRoot,
          env: {
            ...ctx.sutEnv,
            PORT: String(port),
            DB_DRIVER: mode === "invalid" ? "unsupported" : "worker",
            NODE_ENV: mode === "memory" ? "production" : "test",
            DATABASE_PATH: mode === "memory" ? ":memory:" : path,
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 30_000,
        });
        const output = Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        try {
          if (mode !== "legacy") {
            const code = await child.exited;
            const logs = (await output).join("\n");
            expect(
              code !== 0 && child.signalCode === null,
              `${mode} must fail startup without a timeout`,
            );
            expect(
              logs.includes(
                mode === "invalid"
                  ? "DB_DRIVER must be sqlite or worker"
                  : "requires a file database",
              ),
              `${mode} must report its configuration error`,
            );
          } else {
            const base = `http://127.0.0.1:${port}`;
            expect(
              await pollUntil(
                async () => {
                  try {
                    return (await fetch(`${base}/health`)).ok;
                  } catch {
                    return false;
                  }
                },
                25_000,
                100,
              ),
              "legacy fixture must become ready",
            );
            const response = await fetch(`${base}/api/stats`, {
              headers: { Authorization: `Bearer ${ctx.apiKey}` },
            });
            expect(
              response.ok && asRecord(await response.json()).dbDriver === "worker",
              "legacy encrypted DB_DRIVER cannot override or prevent Worker selection",
            );
            const health = asRecord(await (await fetch(`${base}/health`)).json());
            expect(
              !("dbDriver" in health) && health.status === "ok",
              "public health preserves configuration privacy",
            );
          }
        } finally {
          if (child.exitCode === null) child.kill("SIGTERM");
          await child.exited;
          await output;
        }
      }
    } finally {
      await Bun.$`rm -rf ${root}`.quiet();
    }
  },
};
