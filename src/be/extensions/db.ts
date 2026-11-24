import type { ExtensionRow } from "@desplega/storage";
import type {
  Extension,
  ExtensionManifest,
  ExtensionRun,
  ExtensionStatus,
  ExtensionVersion,
} from "../../types";
import { computeContentHash } from "../db";
import { getStorage } from "../storage";

const repo = () => getStorage().repos.extensions;

export type InstallExtensionArgs = {
  manifest: ExtensionManifest;
  files: Record<string, string>;
  priority?: number;
  config?: Record<string, unknown>;
  agentId?: string | null;
  createdBy?: string | null;
  activate?: boolean;
  changeReason?: string | null;
  /** HTTP worker upserts must not claim another creator's name. */
  ownerOnly?: string;
};

export class ExtensionOwnershipError extends Error {}

export type InstallExtensionResult = {
  extension: Extension;
  isNew: boolean;
  contentDeduped: boolean;
};

function rowToExtension(row: ExtensionRow): Extension {
  return {
    ...row,
    enabled: row.enabled === 1,
    lastError: row.lastError ?? null,
    agentId: row.agentId ?? null,
    createdByAgentId: row.createdByAgentId ?? null,
  } as Extension;
}

function canonicalFiles(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

function bundleContentHash(manifest: ExtensionManifest, files: Record<string, string>): string {
  return computeContentHash(JSON.stringify({ manifest, files: canonicalFiles(files) }));
}

export async function installExtension(
  args: InstallExtensionArgs,
): Promise<InstallExtensionResult> {
  const files = canonicalFiles(args.files);
  const manifestJson = JSON.stringify(args.manifest);
  const filesJson = JSON.stringify(files);
  const contentHash = bundleContentHash(args.manifest, files);
  const actor = args.createdBy ?? null;
  const storage = getStorage();
  const extensions = storage.repos.extensions;

  const insertFiles = async (extensionId: string) => {
    for (const [path, content] of Object.entries(files)) {
      await extensions.insertFile({
        id: crypto.randomUUID(),
        extensionId,
        path,
        content,
        contentHash: computeContentHash(content),
        actor,
      });
    }
  };

  return await storage.transaction(async () => {
    const existingRow = await extensions.findByName(args.manifest.name);
    const existing = existingRow ? rowToExtension(existingRow) : null;
    if (existing && args.ownerOnly && existing.createdByAgentId !== args.ownerOnly) {
      throw new ExtensionOwnershipError("Forbidden: extension belongs to another owner");
    }
    if (
      existing?.enabled &&
      args.ownerOnly &&
      ((args.config !== undefined && JSON.stringify(args.config) !== existing.configJson) ||
        (args.priority !== undefined && args.priority !== existing.priority))
    ) {
      throw new ExtensionOwnershipError(
        "Forbidden: only a lead or operator may change live extension configuration",
      );
    }
    const now = new Date().toISOString();

    if (!existing) {
      const id = crypto.randomUUID();
      const row = await extensions.insert({
        id,
        name: args.manifest.name,
        description: args.manifest.description,
        runtime: args.manifest.runtime,
        manifestJson,
        contentHash,
        priority: args.priority ?? 100,
        configJson: JSON.stringify(args.config ?? {}),
        createdByAgentId: args.agentId ?? null,
        actor,
        now,
      });
      if (!row) throw new Error("Failed to insert extension");

      await insertFiles(id);
      await extensions.insertVersion({
        id: crypto.randomUUID(),
        extensionId: id,
        version: 1,
        manifestJson,
        filesJson,
        contentHash,
        changedByAgentId: args.agentId ?? null,
        changedAt: now,
        changeReason: args.changeReason ?? "Initial installation",
        actor,
      });

      return { extension: rowToExtension(row), isNew: true, contentDeduped: false };
    }

    if (existing.contentHash === contentHash) {
      const row = await extensions.updateMetadata(existing.id, {
        priority: args.priority ?? existing.priority,
        configJson: args.config === undefined ? existing.configJson : JSON.stringify(args.config),
        activeVersion: args.activate ? existing.version : existing.activeVersion,
        actor,
        now,
      });
      if (!row) throw new Error("Failed to update extension metadata");
      return { extension: rowToExtension(row), isNew: false, contentDeduped: true };
    }

    const newVersion = existing.version + 1;
    const row = await extensions.updateContent(existing.id, {
      description: args.manifest.description,
      runtime: args.manifest.runtime,
      manifestJson,
      contentHash,
      version: newVersion,
      activeVersion: args.activate ? newVersion : existing.activeVersion,
      priority: args.priority ?? existing.priority,
      configJson: args.config === undefined ? existing.configJson : JSON.stringify(args.config),
      actor,
      now,
    });
    if (!row) throw new Error("Failed to update extension");

    await extensions.deleteFiles(existing.id);
    await insertFiles(existing.id);
    await extensions.insertVersion({
      id: crypto.randomUUID(),
      extensionId: existing.id,
      version: newVersion,
      manifestJson,
      filesJson,
      contentHash,
      changedByAgentId: args.agentId ?? null,
      changedAt: now,
      changeReason: args.changeReason ?? null,
      actor,
    });

    return { extension: rowToExtension(row), isNew: false, contentDeduped: false };
  });
}

export async function getExtensionFiles(extensionId: string): Promise<Record<string, string>> {
  const rows = await repo().listFiles(extensionId);
  return Object.fromEntries(rows.map((row) => [row.path, row.content]));
}

export async function getExtensionById(id: string): Promise<Extension | null> {
  const row = await repo().findById(id);
  return row ? rowToExtension(row) : null;
}

export async function getExtensionByName(name: string): Promise<Extension | null> {
  const row = await repo().findByName(name);
  return row ? rowToExtension(row) : null;
}

export async function listExtensions(): Promise<Extension[]> {
  const rows = await repo().list();
  return rows.map(rowToExtension);
}

export async function listExtensionVersions(extensionId: string): Promise<ExtensionVersion[]> {
  return (await repo().listVersions(extensionId)) as ExtensionVersion[];
}

export async function getExtensionVersion(
  extensionId: string,
  version: number,
): Promise<ExtensionVersion | null> {
  return ((await repo().getVersion(extensionId, version)) as ExtensionVersion | null) ?? null;
}

export async function activateExtensionVersionSnapshot(
  extensionId: string,
  version: number,
  updatedBy?: string | null,
): Promise<Extension | null> {
  const storage = getStorage();
  const extensions = storage.repos.extensions;
  return await storage.transaction(async () => {
    const snapshot = await extensions.getVersion(extensionId, version);
    if (!snapshot) return null;

    const manifest = JSON.parse(snapshot.manifestJson) as ExtensionManifest;
    const files = JSON.parse(snapshot.filesJson) as Record<string, string>;
    const now = new Date().toISOString();
    const row = await extensions.activateSnapshot(extensionId, {
      description: manifest.description,
      runtime: manifest.runtime,
      manifestJson: snapshot.manifestJson,
      contentHash: snapshot.contentHash,
      activeVersion: version,
      actor: updatedBy ?? null,
      now,
    });
    if (!row) return null;

    await extensions.deleteFiles(extensionId);
    for (const [path, content] of Object.entries(files)) {
      await extensions.insertFile({
        id: crypto.randomUUID(),
        extensionId,
        path,
        content,
        contentHash: computeContentHash(content),
        actor: updatedBy ?? null,
      });
    }
    return rowToExtension(row);
  });
}

export async function updateExtensionMeta(
  id: string,
  args: {
    priority?: number;
    config?: Record<string, unknown>;
    description?: string;
    updatedBy?: string | null;
    ownerOnly?: string;
  },
): Promise<Extension | null> {
  const update = {
    priority: args.priority,
    configJson: args.config === undefined ? undefined : JSON.stringify(args.config),
    description: args.description,
  };
  const hasChange = Object.values(update).some((value) => value !== undefined);
  if (!hasChange && !args.ownerOnly) return getExtensionById(id);

  const row = await repo().updateColumns(
    id,
    update,
    { actor: args.updatedBy ?? null, now: new Date().toISOString() },
    args.ownerOnly,
  );
  if (!row && args.ownerOnly) {
    throw new ExtensionOwnershipError("Forbidden: extension must be your own disabled draft");
  }
  return row ? rowToExtension(row) : null;
}

export async function setExtensionState(
  id: string,
  args: {
    enabled?: boolean;
    status?: ExtensionStatus;
    activeVersion?: number;
    agentId?: string | null;
    consecutiveFailures?: number;
    lastError?: string | null;
    updatedBy?: string | null;
  },
): Promise<Extension | null> {
  const update = {
    enabled: args.enabled,
    status: args.status,
    activeVersion: args.activeVersion,
    agentId: args.agentId,
    consecutiveFailures: args.consecutiveFailures,
    lastError: args.lastError,
  };
  if (Object.values(update).every((value) => value === undefined)) return getExtensionById(id);

  const row = await repo().updateColumns(id, update, {
    actor: args.updatedBy ?? null,
    now: new Date().toISOString(),
  });
  return row ? rowToExtension(row) : null;
}

export async function recordExtensionFailure(
  id: string,
  lastError: string,
  maxConsecutiveFailures: number,
): Promise<Extension | null> {
  const row = await repo().recordFailure(
    id,
    lastError,
    maxConsecutiveFailures,
    new Date().toISOString(),
  );
  return row ? rowToExtension(row) : null;
}

export async function deleteExtension(id: string, ownerOnly?: string): Promise<boolean> {
  const changes = await repo().delete(id, ownerOnly);
  if (changes === 0 && ownerOnly) {
    throw new ExtensionOwnershipError("Forbidden: extension must be your own disabled draft");
  }
  return changes > 0;
}

export async function insertExtensionRun(args: {
  extensionId: string;
  version: number;
  event: string;
  action: ExtensionRun["action"];
  durationMs?: number | null;
  message?: string | null;
  agentId?: string | null;
  subject?: string | null;
}): Promise<ExtensionRun> {
  const row = await repo().insertRun({
    id: crypto.randomUUID(),
    extensionId: args.extensionId,
    version: args.version,
    event: args.event,
    action: args.action,
    durationMs: args.durationMs ?? null,
    message: args.message ?? null,
    agentId: args.agentId ?? null,
    subject: args.subject ?? null,
    createdAt: new Date().toISOString(),
  });
  if (!row) throw new Error("Failed to insert extension run");
  return row as ExtensionRun;
}

export async function pruneExtensionRuns(extensionId: string, keep = 500): Promise<void> {
  await repo().pruneRuns(extensionId, keep);
}

export async function listExtensionRuns(extensionId: string, limit = 100): Promise<ExtensionRun[]> {
  return (await repo().listRuns(extensionId, Math.max(1, Math.min(500, limit)))) as ExtensionRun[];
}
