import { buildImageTemplate } from "../../e2b/dispatch";
import type { RuntimePool } from "../../types";
import { getDbClient } from "../db";
import { getRuntimeController, getRuntimeControllerTarget, getRuntimePool } from "./db";

type ImageBuild = { abort: AbortController; error?: unknown; done: boolean };
const builds = new Map<string, ImageBuild>();

export function stopE2bImageBuilds(): void {
  for (const build of builds.values()) build.abort.abort();
  builds.clear();
}

async function buildPoolImage(pool: RuntimePool, name: string, signal: AbortSignal): Promise<void> {
  const controller = await getRuntimeController(pool.placements[0]!);
  if (!controller) throw new Error("Runtime controller does not exist");
  const target = await getRuntimeControllerTarget(controller);
  signal.throwIfAborted();
  await buildImageTemplate({
    role: "worker",
    name,
    image: pool.image!.slice("docker://".length),
    cpuCount: pool.resources?.cpu ?? 4,
    memoryMb: pool.resources?.memoryMb ?? 8192,
    noCache: false,
    e2bEnv: {
      E2B_API_KEY: target.E2B_API_KEY ?? "",
      E2B_API_URL: target.E2B_API_BASE ?? target.E2B_API_URL ?? "",
      E2B_DOMAIN: target.E2B_DOMAIN ?? "",
      E2B_SANDBOX_URL: target.E2B_SANDBOX_URL ?? "",
    },
    signal,
  });
  signal.throwIfAborted();
  const saved = await getDbClient().run(
    `UPDATE runtime_pools SET resolved_image = ?, updated_at = ? WHERE id = ? AND image = ?
     AND COALESCE(json_extract(resources, '$.cpu'), 4) = ?
     AND COALESCE(json_extract(resources, '$.memoryMb'), 8192) = ?`,
    [
      name,
      new Date().toISOString(),
      pool.id,
      pool.image!,
      pool.resources?.cpu ?? 4,
      pool.resources?.memoryMb ?? 8192,
    ],
  );
  if (!saved.changes)
    throw new Error("E2B pool image or resources changed during template construction");
}

// A pending build reserves no runtime or credential and never blocks the tick.
export async function resolveE2bImage(
  poolId: string,
  tickSignal?: AbortSignal,
): Promise<string | null> {
  const pool = await getRuntimePool(poolId);
  tickSignal?.throwIfAborted();
  if (!pool?.image) throw new Error("E2B pool has no image");
  if (!pool.image.startsWith("docker://")) return pool.image;
  const image = pool.image.slice("docker://".length);
  if (!image) throw new Error("docker:// requires an image reference");
  const input = JSON.stringify([image, pool.resources?.cpu ?? 4, pool.resources?.memoryMb ?? 8192]);
  const name = `swarm-${new Bun.CryptoHasher("sha256").update(input).digest("hex").slice(0, 12)}`;
  const key = `${poolId}:${name}`;
  for (const [oldKey, build] of builds) {
    if (oldKey.startsWith(`${poolId}:`) && oldKey !== key) {
      build.abort.abort();
      builds.delete(oldKey);
    }
  }
  if (pool.resolvedImage === name) {
    builds.delete(key);
    return pool.resolvedImage;
  }
  const previous = builds.get(key);
  if (previous) {
    if (previous.done) {
      builds.delete(key);
      throw previous.error;
    }
    return null;
  }
  const build: ImageBuild = { abort: new AbortController(), done: false };
  builds.set(key, build);
  const configured = Number(process.env.RUNTIME_E2B_BUILD_TIMEOUT_SEC);
  const seconds = Number.isInteger(configured) && configured > 0 ? configured : 600;
  const timeout = setTimeout(
    () => build.abort.abort(new Error(`E2B template build exceeded ${seconds}s`)),
    seconds * 1000,
  );
  timeout.unref?.();
  const signal = build.abort.signal;
  let onAbort: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  void Promise.race([buildPoolImage(pool, name, signal), aborted])
    .catch((error: unknown) => {
      build.error = error;
    })
    .finally(() => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      build.done = true;
    });
  return null;
}
