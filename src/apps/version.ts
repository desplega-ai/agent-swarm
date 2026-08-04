import { type AppVersion, createAppVersion, getAppVersions, getDb } from "../be/db";
import { decodeAppDefinition } from "./store";

export type AppSnapshot = {
  name: string;
  description: string | null;
  definition: unknown;
};

type StoredAppRow = {
  name: string;
  description: string | null;
  definition: string;
};

function snapshotDefinition(rawDefinition: string): unknown {
  try {
    return JSON.parse(rawDefinition);
  } catch {
    return rawDefinition;
  }
}

/**
 * Snapshot an app's pre-write state. This intentionally reads the definition
 * column directly: recovery snapshots must not depend on it being decodable.
 */
export function snapshotApp(appId: string, changedByAgentId?: string): AppVersion {
  const app = getDb()
    .prepare<StoredAppRow, [string]>("SELECT name, description, definition FROM apps WHERE id = ?")
    .get(appId);
  if (!app) throw new Error(`App ${appId} not found — cannot create snapshot`);

  const versions = getAppVersions(appId);
  const version = (versions[0]?.version ?? 0) + 1;
  const snapshot: AppSnapshot = {
    name: app.name,
    description: app.description,
    definition: snapshotDefinition(app.definition),
  };
  return createAppVersion({ appId, version, snapshot, changedByAgentId });
}

export function decodeAppVersion(appVersion: AppVersion): AppVersion {
  if (
    typeof appVersion.snapshot !== "object" ||
    appVersion.snapshot === null ||
    Array.isArray(appVersion.snapshot)
  ) {
    return appVersion;
  }
  const snapshot = appVersion.snapshot as AppSnapshot;
  const decoded = decodeAppDefinition(snapshot.definition);
  return {
    ...appVersion,
    snapshot: {
      ...snapshot,
      definition: decoded.definition,
      ...(decoded.definitionError ? { definitionError: decoded.definitionError } : {}),
    },
  };
}
