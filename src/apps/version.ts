import { type AppVersion, createAppVersion, getAppVersions, getDb } from "../be/db";
import { type AppDefinition, type AppValidationIssue, parseAppDefinition } from "./definition";
import { upgradeAppDefinition } from "./format-upgrades";
import {
  type AppMigration,
  type AppMigrationReport,
  AppSnapshotFailure,
  migrateAppSchema,
  withAppDefinitionLock,
} from "./schema-migrate";
import {
  type AppRecord,
  appDefinitionNeedsRepair,
  decodeAppDefinition,
  getApp,
  updateApp,
} from "./store";

export type AppSnapshot = {
  name: string;
  description: string | null;
  definition: unknown;
};

export class AppRollbackAppNotFoundError extends Error {
  constructor(appId: string) {
    super(`App ${appId} not found.`);
    this.name = "AppRollbackAppNotFoundError";
  }
}

export class AppRollbackVersionNotFoundError extends Error {
  constructor(version: number) {
    super(`App version ${version} not found.`);
    this.name = "AppRollbackVersionNotFoundError";
  }
}

export class AppRollbackDefinitionError extends Error {
  constructor(
    readonly version: number,
    readonly issues: AppValidationIssue[],
  ) {
    super(
      `target snapshot v${version}'s definition is invalid under current validation; migration directives cannot fix it — choose a different version with app-history`,
    );
    this.name = "AppRollbackDefinitionError";
  }
}

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

function rollbackSnapshot(version: AppVersion): {
  name: string;
  description: string | null;
  definition: AppDefinition;
} {
  if (
    typeof version.snapshot !== "object" ||
    version.snapshot === null ||
    Array.isArray(version.snapshot)
  ) {
    throw new AppRollbackDefinitionError(version.version, [
      { path: "snapshot", message: "app version snapshot must be an object" },
    ]);
  }
  const snapshot = version.snapshot as Partial<AppSnapshot>;
  if (typeof snapshot.name !== "string") {
    throw new AppRollbackDefinitionError(version.version, [
      { path: "snapshot.name", message: "app version snapshot is missing its name" },
    ]);
  }
  if (
    snapshot.description !== null &&
    snapshot.description !== undefined &&
    typeof snapshot.description !== "string"
  ) {
    throw new AppRollbackDefinitionError(version.version, [
      { path: "snapshot.description", message: "app version snapshot has an invalid description" },
    ]);
  }

  const parsed = parseAppDefinition(upgradeAppDefinition(snapshot.definition), {
    currentAppId: version.appId,
    resolveApp: getApp,
  });
  if (!parsed.success) throw new AppRollbackDefinitionError(version.version, parsed.issues);
  return {
    name: snapshot.name,
    description: snapshot.description ?? null,
    definition: parsed.definition,
  };
}

/**
 * Restore a historical definition through the ordinary schema migration path.
 * The caller-facing rollback is serialized as one definition write and snapshots
 * the current state inside migrateAppSchema, making a successful rollback undoable.
 */
export async function rollbackApp(input: {
  appId: string;
  version: number;
  migration?: AppMigration;
  forceElementBreak?: string[];
  changedByAgentId?: string;
}): Promise<{ app: AppRecord; migration: AppMigrationReport }> {
  return withAppDefinitionLock(input.appId, async () => {
    const existing = getApp(input.appId);
    if (!existing) throw new AppRollbackAppNotFoundError(input.appId);

    const version = getAppVersions(input.appId).find(
      (candidate) => candidate.version === input.version,
    );
    if (!version) throw new AppRollbackVersionNotFoundError(input.version);
    const snapshot = rollbackSnapshot(version);

    const migrated = await migrateAppSchema({
      appId: input.appId,
      previousDefinition: appDefinitionNeedsRepair(existing) ? undefined : existing.definition,
      previousRawDefinition: existing.definition,
      nextDefinition: snapshot.definition,
      migration: input.migration,
      forceElementBreak: input.forceElementBreak,
      snapshot: () => {
        try {
          snapshotApp(input.appId, input.changedByAgentId);
        } catch {
          throw new AppSnapshotFailure();
        }
      },
      writeDefinition: () =>
        updateApp(input.appId, {
          name: snapshot.name,
          description: snapshot.description,
          definition: snapshot.definition,
        }),
    });
    if (!migrated.result) throw new AppRollbackAppNotFoundError(input.appId);
    return { app: migrated.result, migration: migrated.migration };
  });
}
