import {
  activateExtensionVersionSnapshot,
  getExtensionById,
  getExtensionFiles,
  getExtensionVersion,
  insertExtensionRun,
  listExtensions,
  pruneExtensionRuns,
  setExtensionState,
} from "../be/extensions/db";
import type { Extension } from "../types";
import { ExtensionManifestSchema } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { listRegistered, registerLoaded, unregister } from "./dispatcher";
import { deactivateExtensionAgent, ensureExtensionAgent } from "./identity";
import {
  cleanExtensionTmpRoot,
  type LoadableExtension,
  loadExtension,
  removeExtensionTmpRoot,
} from "./loader";
import { initExtensionPostBridge, teardownExtensionPostBridge } from "./post-bridge";

const EXTENSION_RELOAD_INTERVAL_MS = 30_000;

let reloadTimer: ReturnType<typeof setTimeout> | undefined;
let pollInFlight: Promise<void> | undefined;
let polling = false;
let loopbackBaseUrl: string | undefined;
let lastObservedUpdate = "";
const attemptedFingerprints = new Map<string, string>();

export class ExtensionLifecycleError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "ExtensionLifecycleError";
  }
}

export function setExtensionLoopbackBaseUrl(url: string): void {
  loopbackBaseUrl = url;
}

export function getExtensionLoopbackBaseUrl(): string {
  if (!loopbackBaseUrl) throw new ExtensionLifecycleError("extension loopback not ready");
  return loopbackBaseUrl;
}

function extensionFingerprint(extension: Extension): string {
  return JSON.stringify({
    activeVersion: extension.activeVersion,
    configJson: extension.configJson,
    enabled: extension.enabled,
    priority: extension.priority,
  });
}

function maxUpdatedAt(extensions: Extension[]): string {
  return extensions.reduce(
    (latest, extension) => (extension.updatedAt > latest ? extension.updatedAt : latest),
    "",
  );
}

async function loadableExtension(record: Extension): Promise<LoadableExtension> {
  if (record.activeVersion !== record.version) {
    const version = await getExtensionVersion(record.id, record.activeVersion);
    if (!version) {
      throw new ExtensionLifecycleError(
        `Extension version ${record.activeVersion} was not found`,
        404,
      );
    }
    return {
      record: {
        ...record,
        manifestJson: version.manifestJson,
        contentHash: version.contentHash,
      },
      manifest: ExtensionManifestSchema.parse(JSON.parse(version.manifestJson)),
      files: JSON.parse(version.filesJson) as Record<string, string>,
    };
  }
  return {
    record,
    manifest: ExtensionManifestSchema.parse(JSON.parse(record.manifestJson)),
    files: await getExtensionFiles(record.id),
  };
}

async function removeRegistered(id: string): Promise<void> {
  const previous = unregister(id);
  if (previous) await previous.dispose();
}

// Record the request before importing code, including attempts whose load fails.
async function recordLifecycleRequest(
  record: Extension,
  operation: string,
  agentId: string | undefined,
  version = record.activeVersion,
): Promise<void> {
  if (!agentId) return;
  await insertExtensionRun({
    extensionId: record.id,
    version,
    event: `lifecycle.${operation}.requested`,
    action: "continue",
    agentId,
    subject: record.name,
  });
}

export async function enableExtension(
  id: string,
  opts: { by?: string | null; agentId?: string } = {},
): Promise<Extension> {
  initExtensionPostBridge();
  let record = await getExtensionById(id);
  if (!record) throw new ExtensionLifecycleError("Extension not found", 404);

  await recordLifecycleRequest(record, "enable", opts.agentId);
  const agentId = await ensureExtensionAgent(record.name);
  const identified = await setExtensionState(id, { agentId, updatedBy: opts.by });
  if (!identified) throw new ExtensionLifecycleError("Extension not found", 404);
  record = identified;

  await removeRegistered(id);
  attemptedFingerprints.set(id, extensionFingerprint(record));
  const loaded = await loadExtension(await loadableExtension(record));
  registerLoaded(loaded);
  try {
    const enabled = await setExtensionState(id, {
      enabled: true,
      status: "enabled",
      consecutiveFailures: 0,
      lastError: null,
      agentId,
      updatedBy: opts.by,
    });
    if (!enabled) throw new ExtensionLifecycleError("Extension not found", 404);
    loaded.record = enabled;
    attemptedFingerprints.set(id, extensionFingerprint(enabled));
    return enabled;
  } catch (error) {
    await removeRegistered(id);
    throw error;
  }
}

export async function disableExtension(
  id: string,
  opts: { by?: string | null; agentId?: string } = {},
): Promise<Extension> {
  const record = await getExtensionById(id);
  if (!record) throw new ExtensionLifecycleError("Extension not found", 404);
  await recordLifecycleRequest(record, "disable", opts.agentId);
  await removeRegistered(id);
  attemptedFingerprints.delete(id);
  await deactivateExtensionAgent(record.name);
  const disabled = await setExtensionState(id, {
    enabled: false,
    status: "disabled",
    updatedBy: opts.by,
  });
  if (!disabled) throw new ExtensionLifecycleError("Extension not found", 404);
  return disabled;
}

export async function activateVersion(
  id: string,
  version: number,
  opts: { by?: string | null; agentId?: string } = {},
): Promise<Extension> {
  const current = await getExtensionById(id);
  if (!current) throw new ExtensionLifecycleError("Extension not found", 404);
  if (!(await getExtensionVersion(id, version))) {
    throw new ExtensionLifecycleError(`Extension version ${version} was not found`, 404);
  }

  await recordLifecycleRequest(current, "activate-version", opts.agentId, version);
  const wasEnabled = current.enabled;
  if (wasEnabled) await disableExtension(id, opts);
  const activated = await activateExtensionVersionSnapshot(id, version, opts.by);
  if (!activated)
    throw new ExtensionLifecycleError(`Extension version ${version} was not found`, 404);
  return wasEnabled ? await enableExtension(id, opts) : activated;
}

export async function reloadExtension(
  id: string,
  opts: { by?: string | null; agentId?: string } = {},
): Promise<Extension> {
  const record = await getExtensionById(id);
  if (!record) throw new ExtensionLifecycleError("Extension not found", 404);
  if (!record.enabled) return record;
  return await enableExtension(id, opts);
}

async function syncEnabledExtensions(extensions: Extension[]): Promise<void> {
  const enabledIds = new Set(
    extensions.filter((extension) => extension.enabled).map((extension) => extension.id),
  );
  for (const loaded of listRegistered()) {
    if (!enabledIds.has(loaded.record.id)) {
      await removeRegistered(loaded.record.id);
      attemptedFingerprints.delete(loaded.record.id);
    }
  }

  for (const extension of extensions) {
    if (!extension.enabled) continue;
    const fingerprint = extensionFingerprint(extension);
    const registered = listRegistered().find((loaded) => loaded.record.id === extension.id);
    if (registered && extensionFingerprint(registered.record) === fingerprint) continue;
    if (!registered && attemptedFingerprints.get(extension.id) === fingerprint) continue;
    attemptedFingerprints.set(extension.id, fingerprint);
    try {
      await enableExtension(extension.id);
    } catch (error) {
      console.error(
        `[extensions] Reload failed for ${extension.name}:`,
        scrubSecrets(error instanceof Error ? error.message : String(error)),
      );
    }
  }
}

async function pollForExtensionChanges(): Promise<void> {
  const extensions = await listExtensions();
  const observedUpdate = maxUpdatedAt(extensions);
  if (observedUpdate !== lastObservedUpdate) {
    lastObservedUpdate = observedUpdate;
    await syncEnabledExtensions(extensions);
  }
  for (const extension of extensions) await pruneExtensionRuns(extension.id);
}

function startReloadPoll(): void {
  if (polling) return;
  polling = true;
  scheduleReloadPoll();
}

function scheduleReloadPoll(): void {
  if (!polling) return;
  reloadTimer = setTimeout(() => {
    reloadTimer = undefined;
    pollInFlight = pollForExtensionChanges()
      .catch((error) => {
        console.error(
          "[extensions] Reload poll failed:",
          scrubSecrets(error instanceof Error ? error.message : String(error)),
        );
      })
      .finally(() => {
        pollInFlight = undefined;
        scheduleReloadPoll();
      });
  }, EXTENSION_RELOAD_INTERVAL_MS);
  reloadTimer.unref?.();
}

export async function loadEnabledExtensions(): Promise<void> {
  initExtensionPostBridge();
  for (const loaded of listRegistered()) await removeRegistered(loaded.record.id);
  await cleanExtensionTmpRoot();
  attemptedFingerprints.clear();

  const extensions = await listExtensions();
  for (const extension of extensions) {
    await pruneExtensionRuns(extension.id);
    if (!extension.enabled) continue;
    attemptedFingerprints.set(extension.id, extensionFingerprint(extension));
    try {
      await enableExtension(extension.id);
    } catch (error) {
      console.error(
        `[extensions] Load failed for ${extension.name}:`,
        scrubSecrets(error instanceof Error ? error.message : String(error)),
      );
    }
  }
  lastObservedUpdate = maxUpdatedAt(await listExtensions());
  startReloadPoll();
}

export async function stopExtensionRuntime(): Promise<void> {
  polling = false;
  if (reloadTimer) {
    clearTimeout(reloadTimer);
    reloadTimer = undefined;
  }
  await pollInFlight;
  loopbackBaseUrl = undefined;
  teardownExtensionPostBridge();
  for (const loaded of listRegistered()) await removeRegistered(loaded.record.id);
  attemptedFingerprints.clear();
  await removeExtensionTmpRoot();
}
