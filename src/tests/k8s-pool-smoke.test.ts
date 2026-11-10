import { expect, test } from "bun:test";
import { chmod, mkdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, runChild } from "./test-proc";

const script = join(import.meta.dir, "../../scripts/k8s-pool-smoke.ts");

test(
  "Kubernetes smoke help needs no credentials or cluster",
  async () => {
    const result = await runChild(["bun", script, "--help"], {
      env: { ...process.env, AGENT_SWARM_API_KEY: "", API_KEY: "" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--namespace");
  },
  CHILD_PROCESS_TEST_BUDGET_MS,
);

for (const mode of [
  "success",
  "pod-failure",
  "api-failure",
  "cleanup-failure",
  "pod-and-cleanup-failure",
] as const) {
  test(
    `Kubernetes smoke cleans only its test resources: ${mode}`,
    async () => {
      const dir = `/tmp/k8s-review-smoke-${crypto.randomUUID()}`;
      await mkdir(dir, { mode: 0o700 });
      const stateFile = join(dir, "state.json");
      const kubectl = join(dir, "kubectl");
      const ids = {
        controller: crypto.randomUUID(),
        pool: crypto.randomUUID(),
        agent: crypto.randomUUID(),
        runtime: crypto.randomUUID(),
      };
      const operatorKey = crypto.randomUUID();
      const workerKey = `aseph_${crypto.randomUUID()}`;
      const cleanupFails = mode.includes("cleanup-failure");
      const podFails = mode === "pod-failure" || mode === "pod-and-cleanup-failure";
      let disabled = false;
      const deletes: string[] = [];
      const pod = {
        metadata: {
          name: `swarm-rt-${ids.runtime}`,
          uid: crypto.randomUUID(),
          labels: { "swarm.agent-id": ids.agent, "swarm.pool-id": ids.pool },
        },
        spec: {
          automountServiceAccountToken: false,
          restartPolicy: "Never",
          containers: [
            {
              name: "worker",
              resources: { limits: { cpu: "1", memory: podFails ? "64Mi" : "2Gi" } },
              env: [{ name: "AGENT_SWARM_API_KEY", value: workerKey }],
            },
          ],
        },
      };
      await Bun.write(stateFile, JSON.stringify({ ids, pod, disabled }));
      await Bun.write(
        kubectl,
        `#!/usr/bin/env bun
const state = await Bun.file(process.env.K8S_SMOKE_STATE_FILE).json();
const args = Bun.argv.slice(2);
if (args.includes('delete') || !args.includes('get')) process.exit(2);
const selector = args[args.indexOf('-l') + 1];
const owned = selector === 'swarm.runtime-id=' + state.ids.runtime || selector === 'swarm.pool-id=' + state.ids.pool;
console.log(JSON.stringify({items: owned && !state.disabled ? [state.pod] : []}));
`,
      );
      await chmod(kubectl, 0o700);
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req) {
          expect(req.headers.get("authorization")).toBe(`Bearer ${operatorKey}`);
          const path = new URL(req.url).pathname;
          if (path === "/status")
            return Response.json({ runtime_pools: { enabled: true, supervisor: "running" } });
          if (path === "/api/runtime-controllers" && req.method === "POST") {
            const body = await req.json();
            expect(body).toMatchObject({
              kind: "k8s",
              placement: "builtin",
              config: { K8S_NAMESPACE: "workers", WORKER_API_URL: "http://api.example.test" },
            });
            expect(JSON.stringify(body)).not.toContain(operatorKey);
            return Response.json({ controller: { id: ids.controller, secretConfigKeys: [] } });
          }
          if (path === "/api/runtime-pools" && req.method === "POST")
            return Response.json({ pool: { id: ids.pool } });
          if (path === `/api/runtime-pools/${ids.pool}/agents`)
            return Response.json({ agent: { id: ids.agent } });
          if (path === `/api/runtime-pools/${ids.pool}/runtimes`) {
            if (disabled && cleanupFails)
              return Response.json({ message: workerKey }, { status: 503 });
            if (!disabled && mode === "api-failure")
              return Response.json({ message: workerKey }, { status: 403 });
            return Response.json({
              runtimes: [
                {
                  id: ids.runtime,
                  status: disabled ? "offline" : "active",
                  externalHandle: {
                    kind: "k8s",
                    controllerId: ids.controller,
                    externalId: pod.metadata.name,
                    meta: { "k8s.uid": pod.metadata.uid },
                  },
                },
              ],
            });
          }
          if (path === `/api/runtime-pools/${ids.pool}` && req.method === "PATCH") {
            expect(await req.json()).toEqual({ enabled: false });
            disabled = true;
            await Bun.write(stateFile, JSON.stringify({ ids, pod, disabled }));
            if (cleanupFails) return Response.json({ message: workerKey }, { status: 500 });
            return Response.json({});
          }
          if (req.method === "DELETE") {
            deletes.push(path);
            if (cleanupFails) return Response.json({ message: workerKey }, { status: 500 });
            return Response.json({});
          }
          return Response.json({}, { status: 404 });
        },
      });
      try {
        const result = await runChild(
          [
            "bun",
            script,
            "--api",
            server.url.origin,
            "--worker-api",
            "http://api.example.test",
            "--namespace",
            "workers",
            "--context",
            "test-context",
          ],
          {
            env: {
              ...process.env,
              PATH: `${dir}:${process.env.PATH}`,
              AGENT_SWARM_API_KEY: operatorKey,
              K8S_SMOKE_STATE_FILE: stateFile,
            },
          },
        );
        expect(result.exitCode).toBe(mode === "success" ? 0 : 1);
        expect(disabled).toBe(true);
        expect(deletes).toEqual([
          `/api/runtime-pools/${ids.pool}`,
          `/api/runtime-controllers/${ids.controller}`,
        ]);
        if (cleanupFails) {
          expect(result.stdout).not.toContain("PASS: drained pool");
          expect(result.stderr).toContain(`PATCH /api/runtime-pools/${ids.pool} failed (500)`);
          expect(result.stderr).toContain(
            `GET /api/runtime-pools/${ids.pool}/runtimes failed (503)`,
          );
          expect(result.stderr).toContain(
            `DELETE /api/runtime-pools/${ids.pool}?force=true failed (500)`,
          );
          expect(result.stderr).toContain(
            `DELETE /api/runtime-controllers/${ids.controller} failed (500)`,
          );
        } else {
          expect(result.stdout).toContain("deleted pods, pool, and controller");
        }
        if (podFails) expect(result.stderr).toContain("Worker resource limits differ.");
        expect(result.stdout + result.stderr).not.toContain(operatorKey);
        expect(result.stdout + result.stderr).not.toContain(workerKey);
      } finally {
        await server.stop(true);
        await Bun.file(kubectl).delete();
        await Bun.file(stateFile).delete();
        await rmdir(dir);
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
}
