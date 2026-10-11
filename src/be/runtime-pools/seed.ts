import { isRuntimePoolsEnabled } from "../../utils/runtime-pools-flag";
import { getDbClient } from "../db";
import { createRuntimeController, createRuntimePool } from "./db";

export async function seedRuntimePools(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!isRuntimePoolsEnabled(env)) return;
  const dockerAvailable =
    !!env.RUNTIME_DOCKER_HOST || (await Bun.file("/var/run/docker.sock").exists());
  await getDbClient().transaction(async (tx) => {
    const controllers = [
      { id: "builtin-static", kind: "static" as const, status: "online" },
      ...(dockerAvailable
        ? [{ id: "builtin-docker", kind: "docker" as const, status: "online" }]
        : []),
      { id: "builtin-e2b", kind: "e2b" as const, status: env.E2B_API_KEY ? "online" : "offline" },
    ];
    for (const controller of controllers) {
      if (
        await tx.get("SELECT id FROM runtime_controllers WHERE id = ? OR name = ?", [
          controller.id,
          controller.id,
        ])
      )
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
          secretConfig:
            controller.kind === "e2b" && env.E2B_API_KEY
              ? { E2B_API_KEY: env.E2B_API_KEY }
              : undefined,
        },
        null,
        controller.id,
      );
      await tx.run("UPDATE runtime_controllers SET status = ? WHERE id = ?", [
        controller.status,
        controller.id,
      ]);
    }
    if (
      !(await tx.get(
        "SELECT id FROM runtime_pools WHERE id = 'default-static' OR name = 'default-static'",
      ))
    ) {
      await createRuntimePool(
        { name: "default-static", kind: "static", placements: ["builtin-static"] },
        null,
        "default-static",
      );
    }
  });
}
