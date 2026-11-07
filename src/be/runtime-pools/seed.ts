import { createRuntimeProvider } from "../../runtime-providers";
import { isRuntimePoolsEnabled } from "../../utils/runtime-pools-flag";
import { getDbClient } from "../db";
import {
  checkE2bControllerConfig,
  createRuntimeController,
  createRuntimePool,
  getRuntimeController,
  getRuntimeControllerTarget,
  updateRuntimeController,
} from "./db";

export async function seedRuntimePools(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!isRuntimePoolsEnabled(env)) return;
  const dockerHost = env.RUNTIME_DOCKER_HOST || env.DOCKER_HOST || "unix:///var/run/docker.sock";
  const dockerAvailable =
    !!env.RUNTIME_DOCKER_HOST ||
    (dockerHost.startsWith("unix:///") &&
      (await Bun.$`test -S ${dockerHost.slice(7)}`.quiet().nothrow()).exitCode === 0);
  let dockerOnline = false;
  if (dockerAvailable) {
    const host = dockerHost;
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
      { id: "builtin-boxd", kind: "boxd" as const, status: "offline" },
    ];
    for (const controller of controllers) {
      const existing = await getRuntimeController(controller.id);
      if (!existing) {
        if (controller.kind === "docker" && !dockerAvailable) continue;
        // Opt-in: only a deployment that sets BOXD_API_KEY gets a boxd controller.
        if (controller.kind === "boxd" && !env.BOXD_API_KEY) continue;
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
            secretConfig: { E2B_API_KEY: env.E2B_API_KEY }, // gitleaks:allow (env reference)
          });
        const config = await checkE2bControllerConfig(
          (await getRuntimeController(controller.id))!,
          undefined,
          env,
        );
        controller.status = config.ready ? "online" : "offline";
      }
      if (controller.kind === "boxd") {
        if (
          env.BOXD_API_KEY &&
          !stored.secretConfigError &&
          !stored.secretConfigKeys.includes("BOXD_API_KEY")
        )
          await updateRuntimeController(controller.id, {
            secretConfig: { BOXD_API_KEY: env.BOXD_API_KEY }, // gitleaks:allow (env reference)
          });
        const target = await getRuntimeControllerTarget(
          (await getRuntimeController(controller.id))!,
          env,
        );
        controller.status = (await createRuntimeProvider("boxd", target)).checkConfig(target).ready
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
