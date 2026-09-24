import { getDbClient } from "../be/db";
import {
  type AssetPlan,
  preflightAssets,
  type ReconcileResult,
  type RemoveResult,
  reconcileAssets,
  removeAssets,
  setAssetsEnabled,
} from "../be/extensions/assets";
import {
  activateExtensionVersionSnapshot,
  deleteExtension,
  getExtensionById,
  getExtensionVersion,
  type InstallExtensionArgs,
  type InstallExtensionResult,
  insertExtensionRun,
  installExtension,
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
  // Always load the immutable selected version. The mutable current-file projection
  // can advance while an agent stages a draft after we read the extension row.
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
    // After the hooks load: a load error leaves the assets paused.
    await setAssetsEnabled(id, true, opts.by);
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
  await setAssetsEnabled(id, false, opts.by);
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

  const snapshot = await getExtensionVersion(id, version);
  if (!snapshot) {
    throw new ExtensionLifecycleError(`Extension version ${version} was not found`, 404);
  }
  const plan = await planAssets(
    ExtensionManifestSchema.parse(JSON.parse(snapshot.manifestJson)),
    JSON.parse(snapshot.filesJson) as Record<string, string>,
  );

  await recordLifecycleRequest(current, "activate-version", opts.agentId, version);
  const wasEnabled = current.enabled;
  if (wasEnabled) await disableExtension(id, opts);
  const activated = await getDbClient().transaction(async () => {
    const agentId = await ensureExtensionAgent(current.name);
    const row = await activateExtensionVersionSnapshot(id, version, opts.by);
    if (!row) return null;
    await reconcileAssets({ extensionId: id, agentId, plan, actor: opts.by });
    return row;
  });
  if (!activated)
    throw new ExtensionLifecycleError(`Extension version ${version} was not found`, 404);
  return wasEnabled ? await enableExtension(id, opts) : activated;
}

async function planAssets(
  manifest: Parameters<typeof preflightAssets>[0],
  files: Record<string, string>,
): Promise<AssetPlan> {
  const preflight = await preflightAssets(manifest, files);
  if (!preflight.ok) throw new ExtensionAssetsInvalidError(preflight.diagnostics);
  return preflight.plan;
}

/** A bundle's scripts or schedules failed their checks; nothing was written. */
export class ExtensionAssetsInvalidError extends Error {
  constructor(readonly diagnostics: string[]) {
    super(diagnostics.join("\n"));
    this.name = "ExtensionAssetsInvalidError";
  }
}

export type InstallWithAssetsResult = InstallExtensionResult & {
  assets: ReconcileResult | null;
};

/**
 * Install a validated bundle and the assets it declares in one transaction:
 * the `ext:<name>` agent, the extension rows, then every asset (created disabled).
 * Asset checks run first, outside the transaction. Assets are written only when the
 * installed version is the active one; a staged version gets them on activation.
 */
export async function installExtensionWithAssets(
  args: InstallExtensionArgs,
): Promise<InstallWithAssetsResult> {
  const plan = await planAssets(args.manifest, args.files);
  return await getDbClient().transaction(async () => {
    const agentId = await ensureExtensionAgent(args.manifest.name);
    const installed = await installExtension(args);
    const extension = installed.extension;
    const assets =
      extension.activeVersion === extension.version
        ? await reconcileAssets({
            extensionId: extension.id,
            agentId,
            plan,
            actor: args.createdBy ?? null,
          })
        : null;
    return { ...installed, assets };
  });
}

/** Uninstall: remove pristine assets, detach edited ones, and delete the extension. */
export async function uninstallExtension(id: string, ownerOnly?: string): Promise<RemoveResult> {
  return await getDbClient().transaction(async () => {
    const assets = await removeAssets(id);
    await deleteExtension(id, ownerOnly);
    return assets;
  });
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
