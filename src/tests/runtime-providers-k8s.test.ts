import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { KubernetesRuntimeProvider } from "../runtime-providers/k8s";
import {
  type ProvisionRequest,
  RUNTIME_LABELS,
  type RuntimeTargetConfig,
} from "../runtime-providers/types";

const provider = new KubernetesRuntimeProvider();
const request: ProvisionRequest = {
  runtimeId: crypto.randomUUID(),
  agentId: crypto.randomUUID(),
  poolId: "pool-1",
  ownerId: "owner-1",
  image: "worker:test",
  env: { API_KEY: `worker-${crypto.randomUUID()}`, MULTILINE: "a\nb" },
  resources: { cpu: 0.5, memoryMb: 128 },
  ttlSec: 60,
  labels: { custom: "value", [RUNTIME_LABELS.owner]: "spoofed" },
};
const labels = {
  custom: "value",
  [RUNTIME_LABELS.owner]: request.ownerId,
  [RUNTIME_LABELS.runtimeId]: request.runtimeId,
  [RUNTIME_LABELS.agentId]: request.agentId,
  [RUNTIME_LABELS.poolId]: request.poolId,
};
const metadata = {
  name: `swarm-rt-${request.runtimeId}`,
  namespace: "workers",
  uid: crypto.randomUUID(),
  labels,
  creationTimestamp: "2026-11-09T10:00:00Z",
};
const handle = {
  kind: "k8s" as const,
  externalId: metadata.name,
  createdAt: metadata.creationTimestamp,
  meta: { ...labels, "k8s.namespace": metadata.namespace, "k8s.uid": metadata.uid },
};
let server: Bun.Server<undefined>;
let target: RuntimeTargetConfig;
let handler: (req: Request) => Response | Promise<Response>;
let calls: Array<{ url: string; method: string; headers: Headers }>;
const files: string[] = [];

beforeEach(() => {
  calls = [];
  handler = () => Response.json({ metadata });
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      calls.push({ url: req.url, method: req.method, headers: new Headers(req.headers) });
      return handler(req);
    },
  });
  target = {
    K8S_API_URL: server.url.origin,
    K8S_NAMESPACE: "workers",
    K8S_TOKEN: crypto.randomUUID(),
  };
});
afterEach(async () => {
  await server.stop(true);
  for (const path of files.splice(0)) await Bun.file(path).delete();
});

describe("Kubernetes runtime provider", () => {
  test("validates configuration without accepting remote plaintext or URL credentials", () => {
    expect(provider.checkConfig(target).ready).toBe(true);
    expect(provider.checkConfig({}).ready).toBe(false);
    expect(provider.checkConfig({ K8S_API_URL: "https://cluster.test" }).ready).toBe(false);
    expect(provider.checkConfig({ KUBERNETES_SERVICE_HOST: "10.0.0.1" }).ready).toBe(true);
    for (const url of [
      "http://cluster.test",
      "ftp://cluster.test",
      "https://user:pass@cluster.test",
      "https://cluster.test/path",
      "https://cluster.test?token=secret",
    ]) {
      expect(provider.checkConfig({ ...target, K8S_API_URL: url }).ready).toBe(false);
    }
    for (const namespace of ["../other", "UPPER", "a.b", "a".repeat(64)])
      expect(provider.checkConfig({ ...target, K8S_NAMESPACE: namespace }).ready).toBe(false);
  });

  test("creates a worker pod with authoritative labels, resources, env, and no cluster token", async () => {
    let body: Record<string, unknown> = {};
    handler = async (req) => {
      body = (await req.json()) as typeof body;
      return Response.json({ metadata });
    };
    expect(
      await provider.provision(
        { ...target, K8S_SERVICE_ACCOUNT: "worker", K8S_IMAGE_PULL_SECRETS: "registry, secondary" },
        request,
      ),
    ).toEqual(handle);
    expect(calls[0]?.method).toBe("POST");
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/namespaces/workers/pods");
    expect(calls[0]?.headers.get("Authorization")).toBe(`Bearer ${target.K8S_TOKEN}`);
    expect(body).toEqual({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: metadata.name, namespace: "workers", labels },
      spec: {
        restartPolicy: "Never",
        automountServiceAccountToken: false,
        serviceAccountName: "worker",
        imagePullSecrets: [{ name: "registry" }, { name: "secondary" }],
        activeDeadlineSeconds: 60,
        containers: [
          {
            name: "worker",
            image: request.image,
            env: Object.entries(request.env).map(([name, value]) => ({ name, value })),
            resources: {
              requests: { cpu: "0.5", memory: "128Mi" },
              limits: { cpu: "0.5", memory: "128Mi" },
            },
          },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toContain(target.K8S_TOKEN!);
    expect(JSON.stringify(handle)).not.toContain(request.env.API_KEY!);
  });

  test("reads fixed service account files again after token rotation", async () => {
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    let current = first;
    const originalFile = Bun.file;
    const read = spyOn(Bun, "file").mockImplementation((path, options) => {
      if (path === "/var/run/secrets/kubernetes.io/serviceaccount/token")
        return { text: async () => current } as ReturnType<typeof Bun.file>;
      if (path === "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt")
        return { text: async () => "cluster-ca" } as ReturnType<typeof Bun.file>;
      return originalFile(path, options);
    });
    const send = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ metadata }))
      .mockResolvedValueOnce(Response.json({ metadata }));
    try {
      const config = { KUBERNETES_SERVICE_HOST: "10.0.0.1", K8S_NAMESPACE: "workers" };
      await provider.provision(config, request);
      current = second;
      await provider.provision(config, { ...request, runtimeId: crypto.randomUUID() });
      expect(send.mock.calls.map(([url]) => String(url))).toEqual([
        "https://kubernetes.default.svc/api/v1/namespaces/workers/pods",
        "https://kubernetes.default.svc/api/v1/namespaces/workers/pods",
      ]);
      expect(
        send.mock.calls.map(([, options]) => new Headers(options?.headers).get("authorization")),
      ).toEqual([`Bearer ${first}`, `Bearer ${second}`]);
      for (const [, options] of send.mock.calls)
        expect(options).toMatchObject({ tls: { ca: "cluster-ca" } });
      expect(read.mock.calls.map(([path]) => path)).toEqual([
        "/var/run/secrets/kubernetes.io/serviceaccount/token",
        "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
        "/var/run/secrets/kubernetes.io/serviceaccount/token",
        "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
      ]);
    } finally {
      read.mockRestore();
      send.mockRestore();
    }
  });

  test("external endpoints never inherit mounted service account credentials", async () => {
    const config = { K8S_API_URL: server.url.origin, KUBERNETES_SERVICE_HOST: "10.0.0.1" };
    const read = spyOn(Bun, "file");
    try {
      expect(provider.checkConfig(config).ready).toBe(false);
      await expect(provider.provision(config, request)).rejects.toThrow("Set K8S_TOKEN");
      expect(read).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    } finally {
      read.mockRestore();
    }
  });

  test("rejects controller file paths before reading or forwarding host secrets", async () => {
    const path = `/tmp/k8s-review-secret-${crypto.randomUUID()}`;
    files.push(path);
    await Bun.write(path, crypto.randomUUID());
    const read = spyOn(Bun, "file");
    try {
      for (const key of ["K8S_TOKEN_FILE", "K8S_CA_FILE"]) {
        const config = { ...target, [key]: path };
        if (key === "K8S_TOKEN_FILE") delete config.K8S_TOKEN;
        expect(provider.checkConfig(config).ready).toBe(false);
        await expect(provider.provision(config, request)).rejects.toThrow("not supported");
        await expect(provider.list(config, request.ownerId)).rejects.toThrow("not supported");
        await expect(provider.terminate(config, handle)).rejects.toThrow("not supported");
        expect(await provider.status(config, handle)).toBe("unknown");
      }
      expect(read).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    } finally {
      read.mockRestore();
    }
  });

  test("keeps worker and cluster credentials out of Kubernetes failure messages", async () => {
    handler = () =>
      Response.json(
        { message: JSON.stringify({ token: target.K8S_TOKEN, env: request.env }) },
        { status: 422 },
      );
    await expect(provider.provision(target, request)).rejects.toThrow(
      "Kubernetes POST pods failed (422)",
    );
    handler = () => Response.json({}, { status: 403 });
    await expect(provider.list(target, request.ownerId)).rejects.toThrow(
      "Kubernetes GET pods failed (403)",
    );
    await expect(provider.terminate(target, handle)).rejects.toThrow(
      "Kubernetes DELETE pods failed (403)",
    );
    expect(await provider.status(target, handle)).toBe("unknown");
  });

  test("lists only this owner's runtimes and follows continuation tokens", async () => {
    handler = (req) => {
      const query = new URL(req.url).searchParams;
      expect(query.get("labelSelector")).toBe(`swarm.owner=${request.ownerId},swarm.runtime-id`);
      return query.has("continue")
        ? Response.json({ items: [{ metadata: { ...metadata, name: "second" } }], metadata: {} })
        : Response.json({
            items: [
              { metadata },
              {
                metadata: { ...metadata, labels: { ...labels, [RUNTIME_LABELS.owner]: "foreign" } },
              },
              { metadata: { ...metadata, labels: { [RUNTIME_LABELS.owner]: request.ownerId } } },
            ],
            metadata: { continue: "next+page/=" },
          });
    };
    expect(await provider.list(target, request.ownerId)).toEqual([
      handle,
      { ...handle, externalId: "second" },
    ]);
    expect(new URL(calls[1]!.url).searchParams.get("continue")).toBe("next+page/=");
  });

  test("maps pod phases and detects replaced pods", async () => {
    for (const [phase, status] of [
      ["Pending", "starting"],
      ["Running", "running"],
      ["Succeeded", "exited"],
      ["Failed", "failed"],
      ["Unknown", "unknown"],
    ]) {
      handler = () => Response.json({ metadata, status: { phase } });
      expect(await provider.status(target, handle)).toBe(status);
    }
    handler = () =>
      Response.json({
        metadata: { ...metadata, uid: "replacement" },
        status: { phase: "Running" },
      });
    expect(await provider.status(target, handle)).toBe("exited");
    handler = () => Response.json({}, { status: 404 });
    expect(await provider.status(target, handle)).toBe("exited");
  });

  test("deletes with a UID precondition and preserves missing or replaced pods", async () => {
    let body: unknown;
    handler = async (req) => {
      body = await req.json();
      return Response.json({});
    };
    await provider.terminate(target, handle);
    expect(calls[0]?.method).toBe("DELETE");
    expect(body).toEqual({
      apiVersion: "v1",
      kind: "DeleteOptions",
      preconditions: { uid: metadata.uid },
    });
    for (const status of [404, 409]) {
      handler = () => Response.json({}, { status });
      await provider.terminate(target, handle);
    }
    const count = calls.length;
    await expect(provider.terminate({ ...target, K8S_NAMESPACE: "other" }, handle)).rejects.toThrow(
      "configured namespace",
    );
    await expect(provider.terminate(target, { ...handle, meta: undefined })).rejects.toThrow(
      "pod UID",
    );
    expect(calls).toHaveLength(count);
  });

  test("rejects persistent cache before making an infrastructure request", async () => {
    await expect(
      provider.provision(target, { ...request, cache: { key: "cache", mountPath: "/cache" } }),
    ).rejects.toThrow("do not support persistent caches");
    expect(calls).toHaveLength(0);
  });
});
