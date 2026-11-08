import {
  type BrowserProfile,
  BrowserProfileSchema,
  type Resource,
  type ResourceCost,
  type ResourceLink,
  ResourceLinkSchema,
  type ResourceOperation,
  ResourceOperationSchema,
  ResourceSchema,
  type SandboxTemplate,
  SandboxTemplateSchema,
} from "../../types";
import { getCurrentRequestUserId } from "../../utils/request-auth-context";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { getAgentById, getDbClient, getTaskById } from "../db";
import { openSealedJson, sealJson } from "../sealed-json";
import { findUserByExternalId } from "../users";
import {
  type ResourcePrivateConfig,
  type ResourcePrivateHandle,
  registerResourceConfig,
  registerResourceHandle,
} from "./private-config";

type Actor = string | null;
const now = () => new Date().toISOString();
const actorId = (actor?: Actor) => actor ?? getCurrentRequestUserId() ?? null;

/** Resolve ancestry from task rows. Missing ancestors and cycles fail closed. */
export async function resourceTaskContext(taskId: string) {
  const task = await getTaskById(taskId);
  if (!task) return null;
  let root = task;
  const seen = new Set([root.id]);
  while (root.parentTaskId) {
    if (seen.has(root.parentTaskId)) return null;
    seen.add(root.parentTaskId);
    const parent = await getTaskById(root.parentTaskId);
    if (!parent) return null;
    root = parent;
  }
  const requester =
    task.requestedByUserId ??
    (task.slackUserId ? (await findUserByExternalId("slack", task.slackUserId))?.id : null) ??
    null;
  return { task, rootTaskId: root.id, requestedByUserId: requester };
}

function sealPrivate(value: ResourcePrivateConfig, name: string): string {
  registerResourceConfig(value, name);
  return sealJson(value);
}

export const resourcePublicColumns = Object.keys(ResourceSchema.shape)
  .map((key) => `r.${key}`)
  .join(", ");

export async function createBrowserProfile(
  input: {
    name: string;
    provider: BrowserProfile["provider"];
    ownerScope: BrowserProfile["ownerScope"];
    ownerUserId?: string;
    privateConfig?: ResourcePrivateConfig;
  },
  actor?: Actor,
): Promise<BrowserProfile> {
  const id = crypto.randomUUID();
  const timestamp = now();
  const config = sealPrivate(input.privateConfig ?? { snapshot: {} }, `resource-profile:${id}`);
  await getDbClient().run(
    `INSERT INTO browser_profiles (id, name, provider, ownerScope, ownerUserId, privateConfig, createdAt, updatedAt, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      scrubSecrets(input.name),
      input.provider,
      input.ownerScope,
      input.ownerUserId ?? null,
      config,
      timestamp,
      timestamp,
      actorId(actor),
      actorId(actor),
    ],
  );
  return (await getBrowserProfile(id))!;
}
export async function getBrowserProfile(id: string): Promise<BrowserProfile | null> {
  const row = await getDbClient().get<Record<string, unknown>>(
    "SELECT * FROM browser_profiles WHERE id = ?",
    [id],
  );
  return row ? BrowserProfileSchema.parse(row) : null;
}
export async function createSandboxTemplate(
  input: {
    name: string;
    provider: SandboxTemplate["provider"];
    version: number;
    privateConfig: ResourcePrivateConfig;
  },
  actor?: Actor,
): Promise<SandboxTemplate> {
  const id = crypto.randomUUID();
  const timestamp = now();
  const config = sealPrivate(input.privateConfig, `resource-template:${id}`);
  await getDbClient().run(
    `INSERT INTO sandbox_templates (id, name, provider, version, privateConfig, createdAt, updatedAt, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      scrubSecrets(input.name),
      input.provider,
      input.version,
      config,
      timestamp,
      timestamp,
      actorId(actor),
      actorId(actor),
    ],
  );
  return SandboxTemplateSchema.parse(
    await getDbClient().get("SELECT * FROM sandbox_templates WHERE id = ?", [id]),
  );
}

export async function createResource(
  input: {
    kind: Resource["kind"];
    provider: Resource["provider"];
    creatorAgentId: string;
    sourceTaskId: string;
    /** Non-secret caller key. The database reserves it before any provider action. */
    createRequestKey: string;
    profileId?: string;
    templateId?: string;
    privateConfig?: ResourcePrivateConfig;
    expiresAt: string;
  },
  actor?: Actor,
): Promise<Resource> {
  if (!input.createRequestKey?.trim())
    throw new Error("An explicit create request key is required.");
  return getDbClient().transaction(async (client) => {
    const privateConfig = input.privateConfig ?? { snapshot: {} };
    const existing = await client.get<Record<string, unknown>>(
      "SELECT * FROM resources WHERE creatorAgentId = ? AND sourceTaskId = ? AND createRequestKey = ?",
      [input.creatorAgentId, input.sourceTaskId, input.createRequestKey],
    );
    if (existing) {
      if (
        existing.kind !== input.kind ||
        existing.provider !== input.provider ||
        existing.profileId !== (input.profileId ?? null) ||
        existing.templateId !== (input.templateId ?? null) ||
        !Bun.deepEquals(openSealedJson(existing.privateConfig as string), privateConfig)
      )
        throw new Error("The create request key already identifies a different request.");
      // A reservation retry grants no permission to use the resource.
      return ResourceSchema.parse(existing);
    }
    const context = await resourceTaskContext(input.sourceTaskId);
    if (
      !context ||
      context.task.agentId !== input.creatorAgentId ||
      !(await getAgentById(input.creatorAgentId))
    )
      throw new Error("A valid source task and creator agent are required.");
    const profile = input.profileId ? await getBrowserProfile(input.profileId) : null;
    if (
      input.profileId &&
      (!profile ||
        profile.deletedAt ||
        profile.provider !== input.provider ||
        (profile.ownerScope === "user" && profile.ownerUserId !== context.requestedByUserId))
    ) {
      throw new Error("The source task cannot use this browser profile.");
    }
    const template = input.templateId
      ? await client.get<SandboxTemplate>(
          "SELECT * FROM sandbox_templates WHERE id = ? AND deletedAt IS NULL",
          [input.templateId],
        )
      : null;
    if (input.templateId && (!template || template.provider !== input.provider))
      throw new Error("The sandbox template is unavailable.");
    const timestamp = now();
    const id = crypto.randomUUID();
    const config = sealPrivate(privateConfig, `resource:${id}`);
    await client.run(
      `INSERT INTO resources (id, kind, provider, state, creatorAgentId, requestedByUserId, sourceTaskId, createRequestKey, rootTaskId, profileId, templateId, templateVersion, privateConfig, providerHandle, lastActivityAt, expiresAt, createdAt, updatedAt, created_by, updated_by)
       VALUES (?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.kind,
        input.provider,
        input.creatorAgentId,
        context.requestedByUserId,
        input.sourceTaskId,
        input.createRequestKey,
        context.rootTaskId,
        input.profileId ?? null,
        input.templateId ?? null,
        template?.version ?? null,
        config,
        null,
        timestamp,
        input.expiresAt,
        timestamp,
        timestamp,
        actorId(actor),
        actorId(actor),
      ],
    );
    return (await getResource(id))!;
  });
}
export async function getResource(id: string): Promise<Resource | null> {
  const row = await getDbClient().get<Record<string, unknown>>(
    `SELECT ${resourcePublicColumns} FROM resources r WHERE r.id = ?`,
    [id],
  );
  return row ? ResourceSchema.parse(row) : null;
}
/** Only internal provider execution can read these values. Never serialize this result. */
export async function getResourcePrivate(
  id: string,
): Promise<{ config: unknown; handle: unknown } | null> {
  const row = await getDbClient().get<{ privateConfig: string; providerHandle: string | null }>(
    "SELECT privateConfig, providerHandle FROM resources WHERE id = ?",
    [id],
  );
  return row
    ? {
        config: openSealedJson(row.privateConfig),
        handle: row.providerHandle ? openSealedJson(row.providerHandle) : null,
      }
    : null;
}
export async function addResourceLink(
  input: Omit<ResourceLink, "id">,
  actor?: Actor,
): Promise<void> {
  const timestamp = now();
  await getDbClient().run(
    `INSERT INTO resource_links (id, resourceId, kind, targetId, isPrimary, createdAt, updatedAt, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(resourceId, kind, targetId) DO NOTHING`,
    [
      crypto.randomUUID(),
      input.resourceId,
      input.kind,
      input.targetId,
      input.isPrimary ? 1 : 0,
      timestamp,
      timestamp,
      actorId(actor),
      actorId(actor),
    ],
  );
}

export async function listResourceLinks(resourceId: string): Promise<ResourceLink[]> {
  const rows = await getDbClient().query<{
    id: string;
    resourceId: string;
    kind: string;
    targetId: string;
    isPrimary: number;
  }>(
    "SELECT id, resourceId, kind, targetId, isPrimary FROM resource_links WHERE resourceId = ? ORDER BY id",
    [resourceId],
  );
  return rows.map((row) => ResourceLinkSchema.parse({ ...row, isPrimary: row.isPrimary === 1 }));
}
export async function insertResourceOperation(
  input: {
    resourceId: string;
    generation: number;
    kind: ResourceOperation["kind"];
    idempotencyKey: string;
    privateConfig?: ResourcePrivateConfig;
  },
  actor?: Actor,
): Promise<ResourceOperation> {
  return getDbClient().transaction(async (client) => {
    const privateConfig = input.privateConfig ?? { snapshot: {} };
    const existing = await client.get<Record<string, unknown>>(
      "SELECT * FROM resource_operations WHERE resourceId = ? AND idempotencyKey = ?",
      [input.resourceId, input.idempotencyKey],
    );
    // Recorded retries remain stable even when the resource advances to another generation.
    if (existing) {
      if (
        existing.generation !== input.generation ||
        existing.kind !== input.kind ||
        !Bun.deepEquals(openSealedJson(existing.privateConfig as string), privateConfig)
      )
        throw new Error("The operation key already identifies a different request.");
      return ResourceOperationSchema.parse(existing);
    }
    const resource = await client.get<{ generation: number }>(
      "SELECT generation FROM resources WHERE id = ?",
      [input.resourceId],
    );
    if (!resource || resource.generation !== input.generation)
      throw new Error("The resource generation is unavailable.");
    const timestamp = now();
    const config = sealPrivate(privateConfig, `resource:${input.resourceId}`);
    await client.run(
      `INSERT INTO resource_operations (id, resourceId, generation, kind, status, idempotencyKey, privateConfig, createdAt, updatedAt, created_by, updated_by) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?) ON CONFLICT(resourceId, idempotencyKey) DO NOTHING`,
      [
        crypto.randomUUID(),
        input.resourceId,
        input.generation,
        input.kind,
        input.idempotencyKey,
        config,
        timestamp,
        timestamp,
        actorId(actor),
        actorId(actor),
      ],
    );
    const row = await getDbClient().get<Record<string, unknown>>(
      "SELECT * FROM resource_operations WHERE resourceId = ? AND idempotencyKey = ?",
      [input.resourceId, input.idempotencyKey],
    );
    return ResourceOperationSchema.parse(row);
  });
}
export async function insertResourceCost(
  input: Omit<ResourceCost, "id"> & { checkpointKey: string },
  actor?: Actor,
): Promise<void> {
  const timestamp = now();
  await getDbClient().run(
    `INSERT INTO resource_costs (id, resourceId, generation, dimension, agentId, requestedByUserId, sourceTaskId, intervalStart, intervalEnd, amountUsd, costSource, checkpointKey, createdAt, updatedAt, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(checkpointKey) DO NOTHING`,
    [
      crypto.randomUUID(),
      input.resourceId,
      input.generation,
      input.dimension,
      input.agentId,
      input.requestedByUserId,
      input.sourceTaskId,
      input.intervalStart,
      input.intervalEnd,
      input.amountUsd,
      input.costSource,
      input.checkpointKey,
      timestamp,
      timestamp,
      actorId(actor),
      actorId(actor),
    ],
  );
}

/** Register encrypted values before any public display or audit can emit them. */
export async function loadResourceSecrets(): Promise<{ count: number; failed: number }> {
  let count = 0;
  let failed = 0;
  for (const table of [
    "resources",
    "browser_profiles",
    "sandbox_templates",
    "resource_operations",
  ] as const) {
    const rows = await getDbClient().query<{
      id: string;
      privateConfig: string;
      providerHandle?: string | null;
    }>(`SELECT id, privateConfig${table === "resources" ? ", providerHandle" : ""} FROM ${table}`);
    for (const row of rows)
      for (const [field, value] of Object.entries({
        privateConfig: row.privateConfig,
        providerHandle: row.providerHandle,
      })) {
        if (!value) continue;
        try {
          if (field === "providerHandle")
            registerResourceHandle(
              openSealedJson(value) as ResourcePrivateHandle,
              `resource:${row.id}`,
            );
          else
            registerResourceConfig(
              openSealedJson(value) as ResourcePrivateConfig,
              `resource:${row.id}`,
            );
          count++;
        } catch {
          failed++;
        }
      }
  }
  return { count, failed };
}
