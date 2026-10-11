import { isRuntimePoolsEnabled } from "../../utils/runtime-pools-flag";
import { getDbClient } from "../db";
import {
  createRuntimeController,
  createRuntimePool,
  getRuntimeController,
  updateRuntimeController,
} from "./db";

export async function seedRuntimePools(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!isRuntimePoolsEnabled(env)) return;
  const dockerAvailable =
    !!env.RUNTIME_DOCKER_HOST || (await Bun.file("/var/run/docker.sock").exists());
  let dockerOnline = false;
  if (dockerAvailable) {
    const host = env.RUNTIME_DOCKER_HOST || "unix:///var/run/docker.sock";
    try {
      const response = await fetch(
        host.startsWith("unix://")
          ? "http://localhost/_ping"
          : `${host.replace(/^tcp:\/\//, "http://").replace(/\/$/, "")}/_ping`,
        {
          ...(host.startsWith("unix://") ? { unix: host.slice(7) } : {}),
          signal: AbortSignal.timeout(1000),
        },
      );
      dockerOnline = response.ok && (await response.text()).trim() === "OK";
    } catch {
      dockerOnline = false;
    }
  }
  await getDbClient().transaction(async (tx) => {
    const controllers = [
      { id: "builtin-static", kind: "static" as const, status: "online" },
      {
        id: "builtin-docker",
        kind: "docker" as const,
        status: dockerOnline ? "online" : "offline",
      },
      { id: "builtin-e2b", kind: "e2b" as const, status: "offline" },
    ];
    for (const controller of controllers) {
      const existing = await getRuntimeController(controller.id);
      if (!existing) {
        if (controller.kind === "docker" && !dockerAvailable) continue;
        if (await tx.get("SELECT id FROM runtime_controllers WHERE name = ?", [controller.id]))
          continue;
        await createRuntimeController(
          {
            name: controller.id,
            kind: controller.kind,
            placement: "builtin",
            config:
              controller.kind === "docker" && env.RUNTIME_DOCKER_HOST
                ? { DOCKER_HOST: env.RUNTIME_DOCKER_HOST }
                : {},
          },
          null,
          controller.id,
        );
      }
      const stored = existing ?? (await getRuntimeController(controller.id))!;
      if (stored.placement !== "builtin" || stored.kind !== controller.kind) continue;
      if (controller.kind === "e2b") {
        if (
          env.E2B_API_KEY &&
          !stored.secretConfigError &&
          !stored.secretConfigKeys.includes("E2B_API_KEY")
        )
          await updateRuntimeController(controller.id, {
            secretConfig: { E2B_API_KEY: env.E2B_API_KEY },
          });
        controller.status =
          !stored.secretConfigError &&
          (env.E2B_API_KEY || stored.secretConfigKeys.includes("E2B_API_KEY"))
            ? "online"
            : "offline";
      }
      await tx.run("UPDATE runtime_controllers SET status = ?, updated_at = ? WHERE id = ?", [
        controller.status,
        new Date().toISOString(),
        controller.id,
      ]);
    }
    if (
      !(await tx.get(
        "SELECT key FROM seed_state WHERE kind = 'maintenance' AND key = 'runtime-pools-default-static'",
      ))
    ) {
      if (
        !(await tx.get(
          "SELECT id FROM runtime_pools WHERE id = 'default-static' OR name = 'default-static'",
        ))
      )
        await createRuntimePool(
          { name: "default-static", kind: "static", placements: ["builtin-static"] },
          null,
          "default-static",
        );
      await tx.run(
        "INSERT INTO seed_state (kind, key, seededHash) VALUES ('maintenance', 'runtime-pools-default-static', '1')",
      );
    }
  });
}
