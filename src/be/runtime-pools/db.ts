import type { z } from "zod";
import {
  type ConfigStatus,
  createRuntimeProvider,
  type RuntimeTargetConfig,
} from "../../runtime-providers";
import type { Agent, DeliveryMode, RuntimeController, RuntimePool } from "../../types";
import {
  RuntimeControllerCreateSchema,
  RuntimeControllerUpdateSchema,
  RuntimePoolCreateAgentSchema,
  RuntimePoolCreateSchema,
  RuntimePoolUpdateSchema,
} from "../../types";
import { registerVolatileSecret, scrubSecrets } from "../../utils/secret-scrubber";
import { decryptSecret, encryptSecret, getEncryptionKey } from "../crypto";
import { createAgent, getAgentById, getAllAgents, getDbClient, upsertSwarmConfig } from "../db";
import { type AgentRow, rowToAgent } from "../db/agents";
import { registerStoredSecret } from "../secret-registry";
import { RuntimePoolError } from "./errors";
import { revokeControllerTokens } from "./tokens";

export { RuntimePoolError } from "./errors";

type ControllerRow = Omit<
  RuntimeController,
  "config" | "secretConfigKeys" | "secretConfigError"
> & {
  config: string;
  secretConfig: string | null;
};
type PoolRow = Omit<RuntimePool, "placements" | "env" | "resources" | "enabled"> & {
  placements: string;
  env: string;
  resources: string | null;
  enabled: number;
};
const controllerColumns = `id, name, kind, placement, config, secret_config AS secretConfig,
  status, last_seen_at AS lastSeenAt, last_error AS lastError, last_error_at AS lastErrorAt,
  created_by AS createdBy, updated_by AS updatedBy, created_at AS createdAt, updated_at AS updatedAt`;
const poolColumns = `id, name, kind, placements, image, lifecycle, idle_minutes AS idleMinutes,
  slots_per_runtime AS slotsPerRuntime, max_runtimes AS maxRuntimes, min_runtimes AS minRuntimes,
  delivery, env, resources, ttl_sec AS ttlSec, resolved_image AS resolvedImage, enabled,
  consecutive_failures AS consecutiveFailures, circuit_open_until AS circuitOpenUntil,
  last_error AS lastError, last_error_at AS lastErrorAt, created_by AS createdBy,
  updated_by AS updatedBy, created_at AS createdAt, updated_at AS updatedAt`;

function controllerSecrets(row: ControllerRow): Record<string, string> {
  return row.secretConfig ? JSON.parse(decryptSecret(row.secretConfig, getEncryptionKey())) : {};
}
function rowToController(row: ControllerRow): RuntimeController {
  const { secretConfig: _, ...publicRow } = row;
  let secretConfigKeys: string[] = [];
  let secretConfigError: boolean | undefined;
  try {
    secretConfigKeys = Object.keys(controllerSecrets(row)).sort();
  } catch {
    secretConfigError = true;
  }
  return {
    ...publicRow,
    config: JSON.parse(row.config),
    secretConfigKeys,
    ...(secretConfigError ? { secretConfigError } : {}),
  };
}
function rowToPool(row: PoolRow): RuntimePool {
  return {
    ...row,
    placements: JSON.parse(row.placements),
    env: JSON.parse(row.env),
    resources: row.resources ? JSON.parse(row.resources) : null,
    enabled: row.enabled === 1,
  };
}
function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new RuntimePoolError(result.error.issues.map((issue) => issue.message).join(". "));
  return result.data;
}
function supportedKind(kind: string): void {
  if (kind === "k8s") throw new RuntimePoolError("k8s provider not implemented");
}

export async function listRuntimeControllers(): Promise<RuntimeController[]> {
  return (
    await getDbClient().query<ControllerRow>(
      `SELECT ${controllerColumns} FROM runtime_controllers ORDER BY name`,
    )
  ).map(rowToController);
}
export async function getRuntimeController(id: string): Promise<RuntimeController | null> {
  const row = await getDbClient().get<ControllerRow>(
    `SELECT ${controllerColumns} FROM runtime_controllers WHERE id = ?`,
    [id],
  );
  return row ? rowToController(row) : null;
}
export async function getRuntimeControllerSecrets(id: string): Promise<Record<string, string>> {
  const row = await getDbClient().get<ControllerRow>(
    `SELECT ${controllerColumns} FROM runtime_controllers WHERE id = ?`,
    [id],
  );
  if (!row) throw new RuntimePoolError("Controller not found", 404);
  return controllerSecrets(row);
}

export async function getRuntimeControllerTarget(
  controller: RuntimeController,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeTargetConfig> {
  const secrets = await getRuntimeControllerSecrets(controller.id);
  for (const [key, value] of Object.entries(secrets))
    registerVolatileSecret(value, `runtime-controller:${controller.id}:${key}`);
  return {
    DOCKER_HOST: env.DOCKER_HOST,
    DOCKER_NETWORK: env.DOCKER_NETWORK,
    DOCKER_EXTRA_HOSTS: env.DOCKER_EXTRA_HOSTS,
    E2B_API_BASE: env.E2B_API_BASE,
    E2B_MAX_CONTINUOUS_SEC: env.E2B_MAX_CONTINUOUS_SEC,
    RUNTIME_WORKER_API_URL: env.RUNTIME_WORKER_API_URL,
    PUBLIC_MCP_BASE_URL: env.PUBLIC_MCP_BASE_URL,
    ...controller.config,
    ...secrets,
  };
}

export async function checkE2bControllerConfig(
  controller: RuntimeController,
  target?: RuntimeTargetConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConfigStatus> {
  let config: ConfigStatus;
  try {
    const resolved = target ?? (await getRuntimeControllerTarget(controller, env));
    config = (await createRuntimeProvider("e2b", resolved)).checkConfig(resolved);
  } catch (error) {
    config = { ready: false, missing: [], hint: scrubSecrets(String(error)) };
  }
  const status = config.ready ? "online" : "offline";
  const prefix = "E2B configuration: ";
  const error = config.ready
    ? null
    : prefix + scrubSecrets(config.hint ?? `Missing configuration: ${config.missing.join(", ")}`);
  if (
    controller.status === status &&
    (controller.lastError === error ||
      (controller.lastError !== null && !controller.lastError.startsWith(prefix)))
  )
    return config;
  const now = new Date().toISOString();
  await getDbClient().run(
    `UPDATE runtime_controllers SET status = ?,
     last_error = CASE WHEN last_error IS NULL OR substr(last_error, 1, ?) = ? THEN ? ELSE last_error END,
     last_error_at = CASE WHEN last_error IS NULL OR substr(last_error, 1, ?) = ? THEN ? ELSE last_error_at END,
     updated_at = ? WHERE id = ? AND (status != ? OR
       ((last_error IS NULL OR substr(last_error, 1, ?) = ?) AND last_error IS NOT ?))`,
    [
      status,
      prefix.length,
      prefix,
      error,
      prefix.length,
      prefix,
      error ? now : null,
      now,
      controller.id,
      status,
      prefix.length,
      prefix,
      error,
    ],
  );
  return config;
}

export async function createRuntimeController(
  input: z.input<typeof RuntimeControllerCreateSchema>,
  actor: string | null = null,
  id: string = crypto.randomUUID(),
): Promise<RuntimeController> {
  const data = parseInput(RuntimeControllerCreateSchema, input);
  supportedKind(data.kind);
  return await getDbClient().transaction(async (tx) => {
    if (
      await tx.get("SELECT id FROM runtime_controllers WHERE name = ? OR id = ?", [data.name, id])
    )
      throw new RuntimePoolError("Controller already exists", 409);
    const secrets = Object.fromEntries(
      Object.entries(data.secretConfig ?? {}).filter(
        (entry): entry is [string, string] => entry[1] !== null,
      ),
    );
    const encrypted = Object.keys(secrets).length
      ? encryptSecret(JSON.stringify(secrets), getEncryptionKey())
      : null;
    getDbClient().afterCommit(() => {
      for (const [key, value] of Object.entries(secrets))
        registerStoredSecret(value, `runtime-controller:${id}:${key}`);
    });
    await tx.run(
      `INSERT INTO runtime_controllers (id, name, kind, placement, config, secret_config, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        data.name,
        data.kind,
        data.placement,
        JSON.stringify(data.config),
        encrypted,
        actor,
        actor,
      ],
    );
    return (await getRuntimeController(id))!;
  });
}
export async function updateRuntimeController(
  id: string,
  input: z.input<typeof RuntimeControllerUpdateSchema>,
  actor: string | null = null,
): Promise<RuntimeController> {
  const patch = parseInput(RuntimeControllerUpdateSchema, input);
  return await getDbClient().transaction(async (tx) => {
    const row = await tx.get<ControllerRow>(
      `SELECT ${controllerColumns} FROM runtime_controllers WHERE id = ?`,
      [id],
    );
    if (!row) throw new RuntimePoolError("Controller not found", 404);
    const data = { ...rowToController(row), ...patch };
    supportedKind(data.kind);
    if (
      await tx.get("SELECT id FROM runtime_controllers WHERE name = ? AND id != ?", [data.name, id])
    )
      throw new RuntimePoolError("Controller name already exists", 409);
    const pools = await listRuntimePools();
    if (pools.some((pool) => pool.placements.includes(id) && pool.kind !== data.kind))
      throw new RuntimePoolError("Pool kind must equal controller kind");
    let encrypted = row.secretConfig;
    if (patch.secretConfig !== undefined) {
      const secrets = controllerSecrets(row);
      for (const [key, value] of Object.entries(patch.secretConfig)) {
        if (value === null) delete secrets[key];
        else secrets[key] = value;
      }
      encrypted = Object.keys(secrets).length
        ? encryptSecret(JSON.stringify(secrets), getEncryptionKey())
        : null;
      getDbClient().afterCommit(() => {
        for (const [key, value] of Object.entries(secrets))
          registerStoredSecret(value, `runtime-controller:${id}:${key}`);
      });
    }
    await tx.run(
      `UPDATE runtime_controllers SET name = ?, kind = ?, placement = ?, config = ?, secret_config = ?, updated_by = COALESCE(?, updated_by), updated_at = ? WHERE id = ?`,
      [
        data.name,
        data.kind,
        data.placement,
        JSON.stringify(data.config),
        encrypted,
        actor,
        new Date().toISOString(),
        id,
      ],
    );
    return (await getRuntimeController(id))!;
  });
}
export async function deleteRuntimeController(id: string): Promise<void> {
  await getDbClient().transaction(async (tx) => {
    if (!(await getRuntimeController(id))) throw new RuntimePoolError("Controller not found", 404);
    if ((await listRuntimePools()).some((pool) => pool.placements.includes(id)))
      throw new RuntimePoolError("Controller has runtime pools", 409);
    await revokeControllerTokens(id);
    await tx.run("DELETE FROM runtime_controllers WHERE id = ?", [id]);
  });
}

export async function listRuntimePools(): Promise<RuntimePool[]> {
  return (
    await getDbClient().query<PoolRow>(`SELECT ${poolColumns} FROM runtime_pools ORDER BY name`)
  ).map(rowToPool);
}
export async function getRuntimePool(id: string): Promise<RuntimePool | null> {
  const row = await getDbClient().get<PoolRow>(
    `SELECT ${poolColumns} FROM runtime_pools WHERE id = ?`,
    [id],
  );
  return row ? rowToPool(row) : null;
}
async function validatePool(data: z.output<typeof RuntimePoolCreateSchema>): Promise<void> {
  supportedKind(data.kind);
  const controller = await getRuntimeController(data.placements[0]!);
  if (!controller) throw new RuntimePoolError("Controller not found");
  if (data.kind !== controller.kind)
    throw new RuntimePoolError("Pool kind must equal controller kind");
  if (data.maxRuntimes !== null && data.minRuntimes > data.maxRuntimes)
    throw new RuntimePoolError("minRuntimes must not exceed maxRuntimes");
  // The supervisor cannot start a runtime without an image, so reject the pool here.
  if (data.kind !== "static" && !data.image?.trim())
    throw new RuntimePoolError(`${data.kind} pools require an image`);
  if (data.kind === "static") {
    data.lifecycle = "idle";
    data.idleMinutes = null;
  }
}
export async function createRuntimePool(
  input: z.input<typeof RuntimePoolCreateSchema>,
  actor: string | null = null,
  id: string = crypto.randomUUID(),
): Promise<RuntimePool> {
  const data = parseInput(RuntimePoolCreateSchema, input);
  return await getDbClient().transaction(async (tx) => {
    await validatePool(data);
    if (await tx.get("SELECT id FROM runtime_pools WHERE name = ? OR id = ?", [data.name, id]))
      throw new RuntimePoolError("Pool already exists", 409);
    await tx.run(
      `INSERT INTO runtime_pools (id, name, kind, placements, image, lifecycle, idle_minutes, slots_per_runtime, max_runtimes, min_runtimes, delivery, env, resources, ttl_sec, enabled, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        data.name,
        data.kind,
        JSON.stringify(data.placements),
        data.image ?? null,
        data.lifecycle,
        data.idleMinutes,
        data.slotsPerRuntime,
        data.maxRuntimes,
        data.minRuntimes,
        data.delivery,
        JSON.stringify(data.env),
        data.resources ? JSON.stringify(data.resources) : null,
        data.ttlSec,
        Number(data.enabled),
        actor,
        actor,
      ],
    );
    return (await getRuntimePool(id))!;
  });
}
export async function updateRuntimePool(
  id: string,
  input: z.input<typeof RuntimePoolUpdateSchema>,
  actor: string | null = null,
): Promise<RuntimePool> {
  const patch = parseInput(RuntimePoolUpdateSchema, input);
  return await getDbClient().transaction(async (tx) => {
    const existing = await getRuntimePool(id);
    if (!existing) throw new RuntimePoolError("Pool not found", 404);
    const data = { ...existing, ...patch };
    if (
      (data.kind !== existing.kind || data.placements[0] !== existing.placements[0]) &&
      (await tx.get(
        "SELECT id FROM runtime_instances WHERE pool_id = ? AND status != 'offline' LIMIT 1",
        [id],
      ))
    )
      throw new RuntimePoolError(
        "Pool has non-offline runtimes. Disable the pool and wait for teardown before changing its placement or provider kind.",
        409,
      );
    await validatePool(data);
    if (await tx.get("SELECT id FROM runtime_pools WHERE name = ? AND id != ?", [data.name, id]))
      throw new RuntimePoolError("Pool name already exists", 409);
    await tx.run(
      `UPDATE runtime_pools SET name = ?, kind = ?, placements = ?, image = ?, resolved_image = ?, lifecycle = ?, idle_minutes = ?, slots_per_runtime = ?, max_runtimes = ?, min_runtimes = ?, delivery = ?, env = ?, resources = ?, ttl_sec = ?, enabled = ?, updated_by = COALESCE(?, updated_by), updated_at = ? WHERE id = ?`,
      [
        data.name,
        data.kind,
        JSON.stringify(data.placements),
        data.image ?? null,
        data.image !== existing.image ||
        (data.resources?.cpu ?? 4) !== (existing.resources?.cpu ?? 4) ||
        (data.resources?.memoryMb ?? 8192) !== (existing.resources?.memoryMb ?? 8192)
          ? null
          : existing.resolvedImage,
        data.lifecycle,
        data.idleMinutes,
        data.slotsPerRuntime,
        data.maxRuntimes,
        data.minRuntimes,
        data.delivery,
        JSON.stringify(data.env),
        data.resources ? JSON.stringify(data.resources) : null,
        data.ttlSec,
        Number(data.enabled),
        actor,
        new Date().toISOString(),
        id,
      ],
    );
    return (await getRuntimePool(id))!;
  });
}
export async function deleteRuntimePool(
  id: string,
  force = false,
  actor: string | null = null,
): Promise<void> {
  await getDbClient().transaction(async (tx) => {
    if (!(await getRuntimePool(id))) throw new RuntimePoolError("Pool not found", 404);
    if (
      await tx.get(
        "SELECT id FROM runtime_instances WHERE pool_id = ? AND status != 'offline' LIMIT 1",
        [id],
      )
    )
      throw new RuntimePoolError(
        "Pool has non-offline runtimes. Scale to zero or disable the pool and wait for teardown before deletion.",
        409,
      );
    if (!force && (await listAgentsForPool(id)).length)
      throw new RuntimePoolError("Pool has bound agents", 409);
    if (force) {
      await tx.run(
        "UPDATE agents SET runtime_pool_id = NULL, lastUpdatedAt = ?, updated_by = COALESCE(?, updated_by) WHERE runtime_pool_id = ?",
        [new Date().toISOString(), actor, id],
      );
    }
    await tx.run("DELETE FROM runtime_pools WHERE id = ?", [id]);
  });
}
export async function bindAgentToPool(
  agentId: string,
  poolId: string | null,
  actor: string | null = null,
): Promise<Agent> {
  return await getDbClient().transaction(async (tx) => {
    if (poolId !== null && !(await getRuntimePool(poolId)))
      throw new RuntimePoolError("Pool not found", 404);
    const agent = await getAgentById(agentId);
    if (!agent) throw new RuntimePoolError("Agent not found", 404);
    if (
      agent.runtimePoolId !== poolId &&
      (await tx.get(
        "SELECT id FROM runtime_instances WHERE agent_id = ? AND pool_id IS NOT NULL AND status != 'offline' LIMIT 1",
        [agentId],
      ))
    )
      throw new RuntimePoolError(
        "Agent has non-offline pool runtimes. Disable its pool and wait for teardown before changing its binding.",
        409,
      );
    const row = await tx.get<AgentRow>(
      "UPDATE agents SET runtime_pool_id = ?, lastUpdatedAt = ?, updated_by = COALESCE(?, updated_by) WHERE id = ? RETURNING *",
      [poolId, new Date().toISOString(), actor, agentId],
    );
    if (!row) throw new RuntimePoolError("Agent not found", 404);
    return rowToAgent(row);
  });
}
export async function listAgentsForPool(poolId: string): Promise<Agent[]> {
  return (
    await getDbClient().query<AgentRow>(
      "SELECT * FROM agents WHERE runtime_pool_id = ? ORDER BY name",
      [poolId],
    )
  ).map((row) => rowToAgent(row));
}
export async function getPoolForAgent(agentId: string): Promise<RuntimePool | null> {
  const agent = await getAgentById(agentId);
  return agent?.runtimePoolId ? getRuntimePool(agent.runtimePoolId) : null;
}
export function resolvePoolDelivery(
  pool: Pick<RuntimePool, "delivery">,
  env: NodeJS.ProcessEnv = process.env,
): DeliveryMode {
  return pool.delivery ?? (env.RUNTIME_DEFAULT_DELIVERY === "push" ? "push" : "poll");
}
export async function createPoolAgent(
  poolId: string,
  input: z.input<typeof RuntimePoolCreateAgentSchema>,
  actor: string | null = null,
): Promise<Agent> {
  const data = parseInput(RuntimePoolCreateAgentSchema, input);
  return await getDbClient().transaction(async () => {
    if (!(await getRuntimePool(poolId))) throw new RuntimePoolError("Pool not found", 404);
    const agents = await getAllAgents({ includeExtensions: true });
    if (agents.some((agent) => agent.name === data.name))
      throw new RuntimePoolError("Agent name already exists", 409);
    if (data.isLead && agents.some((agent) => agent.isLead))
      throw new RuntimePoolError("Only one lead agent is allowed", 409);
    const agent = await createAgent({
      name: data.name,
      isLead: data.isLead ?? false,
      status: "offline",
      capabilities: [],
      maxTasks: data.maxTasks,
      harnessProvider: data.harnessProvider,
    });
    if (data.templateId)
      await upsertSwarmConfig({
        scope: "agent",
        scopeId: agent.id,
        key: "TEMPLATE_ID",
        value: data.templateId,
      });
    await getDbClient().run("UPDATE agents SET created_by = ?, updated_by = ? WHERE id = ?", [
      actor,
      actor,
      agent.id,
    ]);
    return await bindAgentToPool(agent.id, poolId, actor);
  });
}

export async function loadRuntimeControllerSecrets(): Promise<{ count: number; failed: number }> {
  const rows = await getDbClient().query<ControllerRow>(
    `SELECT ${controllerColumns} FROM runtime_controllers WHERE secret_config IS NOT NULL`,
  );
  let count = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      for (const [key, value] of Object.entries(controllerSecrets(row))) {
        registerStoredSecret(value, `runtime-controller:${row.id}:${key}`);
        count++;
      }
    } catch {
      failed++;
    }
  }
  return { count, failed };
}
