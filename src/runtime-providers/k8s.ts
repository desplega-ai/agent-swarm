import { redactWithEnv } from "../e2b/env";
import { scrubSecrets } from "../utils/secret-scrubber";
import {
  type ConfigStatus,
  type ProvisionRequest,
  RUNTIME_LABELS,
  type RuntimeHandle,
  type RuntimeProvider,
  type RuntimeStatus,
  type RuntimeTargetConfig,
} from "./types";

const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;

type Pod = {
  metadata: {
    name: string;
    namespace: string;
    uid: string;
    labels?: Record<string, string>;
    creationTimestamp?: string;
    deletionTimestamp?: string;
  };
  status?: { phase?: string };
};

class KubernetesApiError extends Error {
  constructor(
    readonly statusCode: number,
    method: string,
  ) {
    // Kubernetes validation errors can echo the complete pod, including worker credentials.
    super(`Kubernetes ${method} pods failed (${statusCode})`);
  }
}

function configuration(target: RuntimeTargetConfig) {
  const inCluster = !target.K8S_API_URL && !!target.KUBERNETES_SERVICE_HOST;
  let url: URL;
  try {
    url = new URL(target.K8S_API_URL || "https://kubernetes.default.svc");
  } catch {
    throw new Error("K8S_API_URL must be a valid HTTPS origin.");
  }
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("K8S_API_URL must be an HTTPS origin. HTTP is allowed only on loopback.");
  if (!target.K8S_API_URL && !inCluster)
    throw new Error("Set K8S_API_URL or run the API inside Kubernetes.");
  const namespace = target.K8S_NAMESPACE || "default";
  if (namespace.length > 63 || !DNS_LABEL.test(namespace))
    throw new Error("K8S_NAMESPACE must be a valid Kubernetes namespace.");
  const tokenFile =
    target.K8S_TOKEN_FILE || (inCluster ? `${SERVICE_ACCOUNT_DIR}/token` : undefined);
  if (!target.K8S_TOKEN?.trim() && !tokenFile)
    throw new Error("Set K8S_TOKEN in secretConfig or configure K8S_TOKEN_FILE.");
  return {
    url,
    namespace,
    tokenFile,
    caFile: target.K8S_CA_FILE || (inCluster ? `${SERVICE_ACCOUNT_DIR}/ca.crt` : undefined),
  };
}

async function kubernetesApi<T>(
  target: RuntimeTargetConfig,
  method: string,
  suffix = "",
  body?: unknown,
): Promise<T> {
  const config = configuration(target);
  const token = target.K8S_TOKEN?.trim() || (await Bun.file(config.tokenFile!).text()).trim();
  if (!token) throw new Error("Kubernetes token is empty.");
  const ca =
    target.K8S_CA_CERT || (config.caFile ? await Bun.file(config.caFile).text() : undefined);
  try {
    const response = await fetch(
      new URL(`/api/v1/namespaces/${config.namespace}/pods${suffix}`, config.url),
      {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        ...(ca ? { tls: { ca } } : {}),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new KubernetesApiError(response.status, method);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof KubernetesApiError) throw error;
    throw new Error(redactWithEnv(scrubSecrets(String(error)), { K8S_TOKEN: token }));
  }
}

function podHandle(pod: Pod): RuntimeHandle {
  return {
    kind: "k8s",
    externalId: pod.metadata.name,
    createdAt: pod.metadata.creationTimestamp,
    meta: {
      ...pod.metadata.labels,
      "k8s.namespace": pod.metadata.namespace,
      "k8s.uid": pod.metadata.uid,
    },
  };
}

function handlePath(target: RuntimeTargetConfig, handle: RuntimeHandle): string {
  if (
    handle.kind !== "k8s" ||
    !handle.meta?.["k8s.uid"] ||
    handle.meta["k8s.namespace"] !== configuration(target).namespace
  )
    throw new Error("Kubernetes handle must include a pod UID and the configured namespace.");
  return `/${encodeURIComponent(handle.externalId)}`;
}

export class KubernetesRuntimeProvider implements RuntimeProvider {
  readonly kind = "k8s" as const;
  readonly traits = { canProvision: true, ephemeralDisk: true, supportsPause: false };

  checkConfig(target: RuntimeTargetConfig): ConfigStatus {
    try {
      configuration(target);
      return { ready: true, missing: [] };
    } catch (error) {
      return { ready: false, missing: [], hint: scrubSecrets(String(error)) };
    }
  }

  async provision(target: RuntimeTargetConfig, req: ProvisionRequest): Promise<RuntimeHandle> {
    try {
      if (req.cache) throw new Error("Kubernetes pools do not support persistent caches.");
      const labels = {
        ...req.labels,
        [RUNTIME_LABELS.owner]: req.ownerId,
        [RUNTIME_LABELS.runtimeId]: req.runtimeId,
        [RUNTIME_LABELS.poolId]: req.poolId,
        [RUNTIME_LABELS.agentId]: req.agentId,
      };
      const limits = {
        ...(req.resources?.cpu ? { cpu: String(req.resources.cpu) } : {}),
        ...(req.resources?.memoryMb ? { memory: `${req.resources.memoryMb}Mi` } : {}),
      };
      const name = `swarm-rt-${req.runtimeId}`;
      const pod = await kubernetesApi<Pod>(target, "POST", "", {
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name, namespace: configuration(target).namespace, labels },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          ...(target.K8S_SERVICE_ACCOUNT ? { serviceAccountName: target.K8S_SERVICE_ACCOUNT } : {}),
          ...(target.K8S_IMAGE_PULL_SECRETS
            ? {
                imagePullSecrets: target.K8S_IMAGE_PULL_SECRETS.split(",")
                  .map((name) => ({ name: name.trim() }))
                  .filter((secret) => secret.name),
              }
            : {}),
          ...(req.ttlSec ? { activeDeadlineSeconds: req.ttlSec } : {}),
          containers: [
            {
              name: "worker",
              image: req.image,
              env: Object.entries(req.env).map(([name, value]) => ({ name, value })),
              ...(Object.keys(limits).length ? { resources: { requests: limits, limits } } : {}),
            },
          ],
        },
      });
      return podHandle(pod);
    } catch (error) {
      throw new Error(redactWithEnv(scrubSecrets(String(error)), req.env));
    }
  }

  async terminate(target: RuntimeTargetConfig, handle: RuntimeHandle): Promise<void> {
    const path = handlePath(target, handle);
    try {
      await kubernetesApi(target, "DELETE", path, {
        apiVersion: "v1",
        kind: "DeleteOptions",
        preconditions: { uid: handle.meta!["k8s.uid"] },
      });
    } catch (error) {
      // A UID conflict means another pod now uses the name. Preserve that pod.
      if (!(error instanceof KubernetesApiError && [404, 409].includes(error.statusCode)))
        throw error;
    }
  }

  async status(target: RuntimeTargetConfig, handle: RuntimeHandle): Promise<RuntimeStatus> {
    try {
      const pod = await kubernetesApi<Pod>(target, "GET", handlePath(target, handle));
      if (pod.metadata.uid !== handle.meta!["k8s.uid"]) return "exited";
      if (pod.metadata.deletionTimestamp) return "exited";
      switch (pod.status?.phase) {
        case "Pending":
          return "starting";
        case "Running":
          return "running";
        case "Succeeded":
          return "exited";
        case "Failed":
          return "failed";
        default:
          return "unknown";
      }
    } catch (error) {
      return error instanceof KubernetesApiError && error.statusCode === 404 ? "exited" : "unknown";
    }
  }

  async list(target: RuntimeTargetConfig, ownerId: string): Promise<RuntimeHandle[]> {
    const query = new URLSearchParams({
      labelSelector: `${RUNTIME_LABELS.owner}=${ownerId},${RUNTIME_LABELS.runtimeId}`,
      limit: "500",
    });
    const handles: RuntimeHandle[] = [];
    let continuation: string | undefined;
    do {
      if (continuation) query.set("continue", continuation);
      const page = await kubernetesApi<{ items: Pod[]; metadata?: { continue?: string } }>(
        target,
        "GET",
        `?${query}`,
      );
      for (const pod of page.items) {
        const labels = pod.metadata.labels;
        if (labels?.[RUNTIME_LABELS.owner] === ownerId && labels[RUNTIME_LABELS.runtimeId])
          handles.push(podHandle(pod));
      }
      continuation = page.metadata?.continue;
    } while (continuation);
    return handles;
  }
}
