import * as z from "zod";
import { AppMigrationReportOutputSchema } from "@/apps/schema-migrate";
import { appWriteTypesWarnings } from "@/apps/script-types";
import type { AppDefinitionWriteResult } from "@/apps/write";
import { type SwarmToolResult, toolErr, toolOk } from "@/tools/utils";

/**
 * The compact write response shared by `app-patch` and `app-patch-node`. The
 * whole app comes back only with `includeApp`. A later field (for example a
 * render `check` block) goes beside `changed` and `issues`.
 */
export const appWriteOutputShape = {
  appId: z.string().optional(),
  url: z.string().optional(),
  dryRun: z.boolean().optional(),
  versionCreated: z.number().optional(),
  updatedAt: z.string().optional(),
  changed: z.array(z.string()).optional(),
  changedCount: z.number().optional(),
  issues: z
    .array(z.looseObject({ path: z.string().optional(), message: z.string().optional() }))
    .optional(),
  closest: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  migration: AppMigrationReportOutputSchema.optional(),
  durationMs: z.number().optional(),
  app: z.unknown().optional(),
};

export async function appWriteToolResult(
  result: AppDefinitionWriteResult,
  options: { startedAt: number; includeApp?: boolean; verb: string },
): Promise<SwarmToolResult> {
  const durationMs = Math.round(performance.now() - options.startedAt);
  if (!result.ok) {
    const data = {
      ...(result.issues ? { issues: result.issues } : {}),
      ...(result.closest ? { closest: result.closest } : {}),
      durationMs,
    };
    return toolErr(result.message, {
      details: result.details ?? (result.issues ? JSON.stringify(data) : undefined),
      data,
    });
  }
  const warnings = result.dryRun ? [] : await appWriteTypesWarnings(result.appId);
  const data = {
    appId: result.appId,
    url: `/apps/${result.appId}`,
    dryRun: result.dryRun,
    ...(result.versionCreated !== undefined ? { versionCreated: result.versionCreated } : {}),
    ...(result.app ? { updatedAt: result.app.updatedAt } : {}),
    changed: result.changed,
    ...(result.changedCount > result.changed.length ? { changedCount: result.changedCount } : {}),
    issues: [],
    warnings,
    migration: result.migration,
    durationMs,
    ...(options.includeApp && result.app ? { app: result.app } : {}),
  };
  const message = result.dryRun
    ? `Dry run: app "${result.name}" would change ${result.changedCount} path(s); nothing stored.`
    : `App "${result.name}" ${options.verb}: ${result.changedCount} path(s) changed.`;
  return toolOk(message, { details: JSON.stringify(data), data });
}
