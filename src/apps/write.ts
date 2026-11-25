import { type AppDefinition, type AppValidationIssue, parseAppDefinition } from "./definition";
import { changedDefinitionPaths } from "./definition-edit";
import {
  type AppMigration,
  type AppMigrationReport,
  AppSchemaMigrationError,
  AppSnapshotFailure,
  migrateAppSchema,
  planAppSchemaMigration,
  unexpectedMigrationDetails,
  withAppDefinitionLock,
} from "./schema-migrate";
import { type AppRecord, appDefinitionNeedsRepair, getApp, updateApp } from "./store";
import { snapshotApp } from "./version";

export type NextDefinitionResult =
  | { success: true; definition: unknown }
  | { success: false; issues: AppValidationIssue[]; closest?: string[] };

export type AppDefinitionWriteResult =
  | {
      ok: true;
      dryRun: boolean;
      /** The stored app after the write; undefined on a dry run. */
      app?: AppRecord;
      appId: string;
      name: string;
      /** Version number of the snapshot of the previous definition. */
      versionCreated?: number;
      migration: AppMigrationReport;
      changed: string[];
      changedCount: number;
    }
  | {
      ok: false;
      message: string;
      issues?: AppValidationIssue[];
      closest?: string[];
      details?: string;
    };

/**
 * The one write path behind the agent-facing definition writes (`app-patch`,
 * `app-patch-node`): lock, repair check, build the next definition from the
 * stored one, parse, migrate, snapshot and store. `dryRun` stops after the
 * parse and the migration plan and writes nothing.
 */
export async function commitAppDefinitionWrite(input: {
  appId: string;
  writerAgentId: string;
  name?: string;
  description?: string | null;
  nextDefinition: (stored: AppDefinition) => NextDefinitionResult;
  migration?: AppMigration;
  forceElementBreak?: string[];
  dryRun?: boolean;
}): Promise<AppDefinitionWriteResult> {
  const notFound = { ok: false as const, message: `App ${input.appId} not found.` };
  if (!(await getApp(input.appId))) return notFound;
  return withAppDefinitionLock(input.appId, async (): Promise<AppDefinitionWriteResult> => {
    const existing = await getApp(input.appId);
    if (!existing) return notFound;
    if (appDefinitionNeedsRepair(existing)) {
      return { ok: false, message: "Definition needs repair.", issues: existing.definitionError };
    }

    const next = input.nextDefinition(existing.definition);
    if (!next.success) {
      return {
        ok: false,
        message: "Invalid app definition.",
        issues: next.issues,
        ...(next.closest ? { closest: next.closest } : {}),
      };
    }
    const parsed = await parseAppDefinition(next.definition, {
      currentAppId: input.appId,
      resolveApp: getApp,
      writerAgentId: input.writerAgentId,
      existingDefinition: existing.definition,
    });
    if (!parsed.success) {
      return { ok: false, message: "Invalid app definition.", issues: parsed.issues };
    }
    const changed = changedDefinitionPaths(existing.definition, parsed.definition);
    const migrationInput = {
      appId: input.appId,
      previousDefinition: existing.definition,
      previousRawDefinition: existing.definition,
      nextDefinition: parsed.definition,
      migration: input.migration,
      forceElementBreak: input.forceElementBreak,
    };
    try {
      if (input.dryRun) {
        return {
          ok: true,
          dryRun: true,
          appId: existing.id,
          name: input.name ?? existing.name,
          migration: await planAppSchemaMigration(migrationInput),
          changed: changed.paths,
          changedCount: changed.count,
        };
      }
      let versionCreated: number | undefined;
      const migrated = await migrateAppSchema({
        ...migrationInput,
        snapshot: async () => {
          try {
            versionCreated = (await snapshotApp(input.appId, input.writerAgentId)).version;
          } catch {
            throw new AppSnapshotFailure();
          }
        },
        writeDefinition: () =>
          updateApp(input.appId, {
            name: input.name,
            description: input.description,
            definition: parsed.definition,
          }),
      });
      if (!migrated.result) return notFound;
      return {
        ok: true,
        dryRun: false,
        app: migrated.result,
        appId: migrated.result.id,
        name: migrated.result.name,
        versionCreated,
        migration: migrated.migration,
        changed: changed.paths,
        changedCount: changed.count,
      };
    } catch (error) {
      if (error instanceof AppSchemaMigrationError) {
        return { ok: false, message: "Invalid app schema migration.", issues: error.issues };
      }
      if (error instanceof AppSnapshotFailure) {
        return { ok: false, message: "Failed to snapshot app; patch was not applied." };
      }
      return {
        ok: false,
        message: "Failed to apply app schema migration; patch was not applied.",
        details: unexpectedMigrationDetails(error),
      };
    }
  });
}
