import { buildImageTemplate } from "../../e2b/dispatch";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { getDbClient } from "../db";
import { getRuntimeController, getRuntimeControllerTarget, getRuntimePool } from "./db";

export async function resolveE2bImage(poolId: string): Promise<string> {
  const pool = await getRuntimePool(poolId);
  if (!pool?.image) throw new Error("E2B pool has no image");
  if (!pool.image.startsWith("docker://")) return pool.image;
  if (pool.resolvedImage) return pool.resolvedImage;
  const controller = await getRuntimeController(pool.placements[0]!);
  if (!controller) throw new Error("Runtime controller does not exist");
  const target = await getRuntimeControllerTarget(controller);
  const image = pool.image.slice("docker://".length);
  if (!image) throw new Error("docker:// requires an image reference");
  const name = `swarm-${new Bun.CryptoHasher("sha256").update(image).digest("hex").slice(0, 12)}`;
  const result = await buildImageTemplate({
    role: "worker",
    name,
    image,
    cpuCount: pool.resources?.cpu ?? 4,
    memoryMb: pool.resources?.memoryMb ?? 8192,
    noCache: false,
    e2bEnv: Object.fromEntries(
      Object.entries(target)
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([key, value]) => [key === "E2B_API_BASE" ? "E2B_API_URL" : key, value]),
    ),
  });
  if (result.exitCode !== 0)
    throw new Error(scrubSecrets(result.stderr || result.stdout || "E2B image build failed"));
  const saved = await getDbClient().run(
    "UPDATE runtime_pools SET resolved_image = ?, updated_at = ? WHERE id = ? AND image = ?",
    [name, new Date().toISOString(), pool.id, pool.image],
  );
  if (!saved.changes) throw new Error("E2B pool image changed during template construction");
  return name;
}
