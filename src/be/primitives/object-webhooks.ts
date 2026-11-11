import { randomUUID } from "node:crypto";
import { AgentFsProvider } from "@/fs/agent-fs-provider";
import { type FileScope, FilesError } from "@/fs/provider";
import { getPublicMcpBaseUrl } from "@/utils/constants";
import { registerVolatileSecret, scrubSecrets } from "@/utils/secret-scrubber";
import { getEncryptionKey } from "../crypto/key-bootstrap";
import { decryptSecret, encryptSecret } from "../crypto/secrets-cipher";
import { getDbClient } from "../db";
import {
  AgentFsRequestError,
  agentFsRequest,
  resolveAgentFsServiceCredentials,
} from "../seed/agent-fs-provision";
import { applyFileChange, type FileChangeResult } from "./objects";

/**
 * Keeps `primitive_objects` in sync with agent-fs: one signed `file.changed`
 * webhook per drive that holds objects, registered with the API's own
 * agent-fs key (org admin; agents are only drive editors). Everything here is
 * best-effort. Without agent-fs, a public https base URL or a webhook-capable
 * agent-fs, objects still work and object-reindex is the fallback.
 */

/** Receiver route: `POST /api/objects/agent-fs-webhook/{id}`, id = row id. */
export const OBJECT_WEBHOOK_PATH = "/api/objects/agent-fs-webhook/";

const SECRET_NAME = "AGENT_FS_OBJECT_WEBHOOK_SECRET";
// A replica that claimed registration and died frees the claim after this.
const LEASE_MS = 2 * 60_000;
// A failed registration is retried no sooner than this (next object call or boot).
const RETRY_AFTER_MS = 60 * 60_000;
// shortcut: boot re-checks at most this many drives; page when a swarm has more.
const MAX_BOOT_DRIVES = 50;

type HookRow = {
  id: string;
  orgId: string;
  driveId: string;
  subscriptionId: string | null;
  url: string | null;
  secretCiphertext: string | null;
  status: "pending" | "active" | "failed";
  lastError: string | null;
  claimedAt: string | null;
  attemptedAt: string | null;
};

type ServiceCredentials = { apiUrl: string; apiKey: string; orgId: string };

export type EnsureResult = {
  status: "active" | "registered" | "skipped" | "busy" | "failed";
  reason?: string;
};

const warned = new Set<string>();

/** One warning per drive and reason per process, so a broken setup does not flood logs. */
function warnOnce(driveId: string, reason: string): void {
  const key = `${driveId}\u0000${reason}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(
    `[objects] agent-fs webhook for drive ${driveId} not registered: ${reason}. object-reindex keeps objects in sync.`,
  );
}

const errorText = (error: unknown) =>
  scrubSecrets(error instanceof Error ? error.message : String(error));

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * Make sure agent-fs sends this drive's `file.changed` events to the swarm.
 * Idempotent across calls, boots and replicas: one row per drive, one replica
 * holds the registration claim, and an existing swarm hook on the drive is
 * reused instead of creating another. Never throws.
 */
export async function ensureObjectWebhook(orgId: string, driveId: string): Promise<EnsureResult> {
  try {
    return await ensure(orgId, driveId);
  } catch (error) {
    const reason = errorText(error);
    warnOnce(driveId, reason);
    return { status: "failed", reason };
  }
}

/** Boot pass over every drive that already holds objects. Never throws. */
export async function ensureObjectWebhooksForKnownDrives(): Promise<EnsureResult[]> {
  try {
    const drives = await getDbClient().query<{ orgId: string; driveId: string }>(
      "SELECT DISTINCT orgId, driveId FROM primitive_objects ORDER BY orgId, driveId LIMIT ?",
      [MAX_BOOT_DRIVES],
    );
    const results: EnsureResult[] = [];
    for (const { orgId, driveId } of drives) {
      results.push(await ensureObjectWebhook(orgId, driveId));
    }
    return results;
  } catch (error) {
    console.warn(`[objects] agent-fs webhook boot check failed: ${errorText(error)}`);
    return [];
  }
}

function skipped(driveId: string, reason: string): EnsureResult {
  warnOnce(driveId, reason);
  return { status: "skipped", reason };
}

async function ensure(orgId: string, driveId: string): Promise<EnsureResult> {
  const base = getPublicMcpBaseUrl();
  if (!base.startsWith("https://")) {
    return skipped(driveId, "PUBLIC_MCP_BASE_URL / MCP_BASE_URL is not a public https URL");
  }
  const service = await resolveAgentFsServiceCredentials();
  if (!service) {
    return skipped(driveId, "the API has no agent-fs URL, service key or org configured");
  }
  if (service.orgId !== orgId) {
    return skipped(driveId, "the drive is outside the swarm's agent-fs org");
  }

  const db = getDbClient();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  await db.run(
    `INSERT INTO agent_fs_object_webhooks (id, orgId, driveId, status, createdAt, updatedAt)
     VALUES (?, ?, ?, 'pending', ?, ?) ON CONFLICT(orgId, driveId) DO NOTHING`,
    [randomUUID(), orgId, driveId, nowIso, nowIso],
  );
  const row = await db.get<HookRow>(
    "SELECT * FROM agent_fs_object_webhooks WHERE orgId = ? AND driveId = ?",
    [orgId, driveId],
  );
  if (!row) throw new Error("webhook row vanished after insert");
  const url = `${base}${OBJECT_WEBHOOK_PATH}${row.id}`;
  if (row.status === "active" && row.url === url && row.secretCiphertext) {
    return { status: "active" };
  }

  // One replica registers. A lapsed lease or an old failure frees the claim.
  const { changes } = await db.run(
    `UPDATE agent_fs_object_webhooks SET claimedAt = ?
     WHERE id = ? AND (claimedAt IS NULL OR claimedAt < ?)
       AND NOT (status = 'failed' AND attemptedAt > ?)`,
    [
      nowIso,
      row.id,
      new Date(now - LEASE_MS).toISOString(),
      new Date(now - RETRY_AFTER_MS).toISOString(),
    ],
  );
  if (changes === 0) {
    return {
      status: "busy",
      reason:
        row.status === "failed"
          ? `last attempt failed (${row.lastError ?? "unknown"}); retrying later`
          : "another replica is registering",
    };
  }

  const doneIso = new Date().toISOString();
  try {
    const { subscriptionId, secret } = await register(service, row, base, url);
    registerVolatileSecret(secret, SECRET_NAME);
    await db.run(
      `UPDATE agent_fs_object_webhooks
       SET subscriptionId = ?, url = ?, secretCiphertext = ?, status = 'active',
           lastError = NULL, claimedAt = NULL, attemptedAt = ?, updatedAt = ?
       WHERE id = ?`,
      [subscriptionId, url, encryptSecret(secret, getEncryptionKey()), doneIso, doneIso, row.id],
    );
    console.log(`[objects] agent-fs webhook registered for drive ${driveId}`);
    return { status: "registered" };
  } catch (error) {
    const reason = errorText(error);
    // The stored secret stays: deliveries to the old URL still verify.
    await db.run(
      `UPDATE agent_fs_object_webhooks
       SET status = 'failed', lastError = ?, claimedAt = NULL, attemptedAt = ?, updatedAt = ?
       WHERE id = ?`,
      [reason, doneIso, doneIso, row.id],
    );
    warnOnce(driveId, reason);
    return { status: "failed", reason };
  }
}

/**
 * Register or update the drive's hook. Reuses, in order: the subscription
 * this row registered, then any swarm hook on the drive under this base URL
 * (left by a lost row or an old row id). Creates one only when neither exists.
 */
async function register(
  service: ServiceCredentials,
  row: HookRow,
  base: string,
  url: string,
): Promise<{ subscriptionId: string; secret: string }> {
  const ops = async (body: Record<string, unknown>) =>
    asRecord(
      await agentFsRequest(service.apiUrl, `/orgs/${encodeURIComponent(service.orgId)}/ops`, {
        method: "POST",
        headers: { authorization: `Bearer ${service.apiKey}` },
        body: { driveId: row.driveId, ...body },
      }),
    );
  const settings = { url, eventTypes: ["file.changed"] };

  let existingId = row.subscriptionId;
  if (!existingId) {
    const { webhooks } = await ops({ op: "webhook-list", scope: "drive" });
    const ours = (Array.isArray(webhooks) ? webhooks : [])
      .map(asRecord)
      .find(
        (hook) =>
          typeof hook.url === "string" && hook.url.startsWith(`${base}${OBJECT_WEBHOOK_PATH}`),
      );
    existingId = typeof ours?.id === "string" ? ours.id : null;
  }

  if (existingId) {
    const knownSecret =
      existingId === row.subscriptionId && row.secretCiphertext
        ? readSecret(row.secretCiphertext)
        : null;
    try {
      const updated = await ops({
        op: "webhook-update",
        id: existingId,
        ...settings,
        enabled: true,
        ...(knownSecret ? {} : { rotateSecret: true }),
      });
      const secret = typeof updated.secret === "string" ? updated.secret : knownSecret;
      if (!secret) throw new Error("agent-fs webhook-update returned no signing secret");
      return { subscriptionId: existingId, secret };
    } catch (error) {
      // Deleted on the agent-fs side: create a new one below.
      if (!(error instanceof AgentFsRequestError && error.status === 404)) throw error;
    }
  }

  const created = await ops({
    op: "webhook-create",
    scope: "drive",
    ...settings,
    description: "agent-swarm: keeps object pointers in sync",
  });
  if (typeof created.id !== "string" || typeof created.secret !== "string") {
    throw new Error("agent-fs webhook-create returned no id or signing secret");
  }
  return { subscriptionId: created.id, secret: created.secret };
}

function readSecret(ciphertext: string): string | null {
  try {
    const secret = decryptSecret(ciphertext, getEncryptionKey());
    registerVolatileSecret(secret, SECRET_NAME);
    return secret;
  } catch {
    // Encryption key changed: the caller rotates the secret.
    return null;
  }
}

/** The signing secret for a receiver row, or null when the row is unknown or not registered. */
export async function objectWebhookSecret(
  hookId: string,
): Promise<{ secret: string; orgId: string; driveId: string } | null> {
  const row = await getDbClient().get<HookRow>(
    "SELECT * FROM agent_fs_object_webhooks WHERE id = ?",
    [hookId],
  );
  if (!row?.secretCiphertext) return null;
  const secret = readSecret(row.secretCiphertext);
  return secret ? { secret, orgId: row.orgId, driveId: row.driveId } : null;
}

export type ObjectWebhookOutcome =
  | { status: 200; result: FileChangeResult }
  | { status: 400 | 503; error: string };

/**
 * Handle one verified delivery body. 200 for every event the swarm has
 * settled (applied or ignored); 503 when agent-fs could not be read, so
 * agent-fs retries the delivery.
 */
export async function handleObjectWebhookEvent(
  hook: { orgId: string; driveId: string },
  envelope: unknown,
): Promise<ObjectWebhookOutcome> {
  const { type, data: rawData } = asRecord(envelope);
  if (type !== "file.changed") {
    return {
      status: 200,
      result: { action: "ignored", path: "", reason: `event ${String(type)}` },
    };
  }
  const data = asRecord(rawData);
  const { path, version, operation } = data;
  if (typeof path !== "string" || typeof operation !== "string" || !Number.isSafeInteger(version)) {
    return { status: 400, error: "file.changed data needs path, version and operation" };
  }
  if (data.orgId !== hook.orgId || data.driveId !== hook.driveId) {
    return {
      status: 200,
      result: { action: "ignored", path, reason: "event for another drive than this hook" },
    };
  }

  const service = await resolveAgentFsServiceCredentials();
  const provider = service
    ? new AgentFsProvider({ ...service, orgId: hook.orgId, driveId: hook.driveId })
    : null;
  const scope = (filePath: string): FileScope => ({
    taskId: "",
    name: "",
    key: filePath,
    orgId: hook.orgId,
    driveId: hook.driveId,
  });
  const noService = () =>
    new FilesError("Provider", "the API has no agent-fs service key to read the file");
  try {
    const result = await applyFileChange(
      { orgId: hook.orgId, driveId: hook.driveId, path, version: version as number, operation },
      {
        download: async (filePath) => {
          if (!provider) throw noService();
          return provider.download(scope(filePath));
        },
        exists: async (filePath) => {
          if (!provider) throw noService();
          return provider.exists(scope(filePath));
        },
      },
    );
    return { status: 200, result };
  } catch (error) {
    if (error instanceof FilesError) return { status: 503, error: errorText(error) };
    throw error;
  }
}
