/**
 * File-based resource import (#2494). Called once at API boot, after the
 * built-in seeders. With no source configured it does nothing.
 *
 * Per source: load and validate the whole package (nothing is written when
 * any item fails), resolve ownership, run the kind seeders, install skill
 * assignments, and store assignments for agents that have not registered.
 * Every failure is logged and contained; boot always continues.
 */

import { getDbClient } from "../db";
import { runSeeder } from "../seed/runner";
import type { SeederResult } from "../seed/types";
import { ImportConfigError, loadImportSources } from "./config";
import { type ImportPackage, ImportPackageError, loadDirPackage } from "./dir-source";
import type { ImportSource } from "./schema";
import { installImportedSkills, prepareSeeders } from "./seeders";

export type ImportReport = {
  sourceId: string;
  /** Why the import stopped. `validate`: the package was invalid and nothing was written. */
  error?: string[];
  failedAt?: "validate" | "apply";
  results: SeederResult[];
  conflicts: string[];
  /** `agent <key>: ...` lines; resolved when that agent registers. */
  unresolved: string[];
  installed: number;
};

async function storePending(source: ImportSource, pkg: ImportPackage, keys: Set<string>) {
  await getDbClient().transaction(async (tx) => {
    // Rewritten on every import, so an entry removed from the package drops out.
    await tx.run("DELETE FROM import_pending_assignments WHERE sourceId = ?", [source.id]);
    const now = new Date().toISOString();
    for (const agent of pkg.agents.filter((entry) => keys.has(entry.key))) {
      await tx.run(
        `INSERT INTO import_pending_assignments
           (sourceId, agentKey, agentId, agentName, instructions, instructionsHash, skillKeys, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          source.id,
          agent.key,
          agent.agentId,
          agent.agentName,
          agent.instructions?.text ?? null,
          agent.instructions?.hash ?? null,
          JSON.stringify(agent.skills),
          now,
        ],
      );
    }
  });
}

/** Import one source. Never throws. */
export async function importSource(source: ImportSource): Promise<ImportReport> {
  const report: ImportReport = {
    sourceId: source.id,
    results: [],
    conflicts: [],
    unresolved: [],
    installed: 0,
  };
  let pkg: ImportPackage;
  try {
    pkg = await loadDirPackage(source);
  } catch (error) {
    report.error =
      error instanceof ImportPackageError ? error.diagnostics : [(error as Error).message];
    report.failedAt = "validate";
    return report;
  }

  try {
    const prepared = await prepareSeeders(source, pkg);
    report.conflicts = prepared.conflicts;
    for (const seeder of prepared.seeders) {
      report.results.push(await runSeeder(seeder, { quiet: true }));
    }
    for (const { agentId, agent } of prepared.assignments) {
      const { installed, missing } = await installImportedSkills(source.id, agentId, agent.skills);
      report.installed += installed;
      if (missing.length > 0) {
        report.unresolved.push(`agent ${agent.key}: skills not imported: ${missing.join(", ")}`);
      }
    }
    await storePending(source, pkg, new Set(prepared.unresolved.map((agent) => agent.key)));
    for (const agent of prepared.unresolved) {
      report.unresolved.push(
        `agent ${agent.key}: not registered; applies when it registers (instructions: ${agent.instructions ? "yes" : "no"}, skills: ${agent.skills.length})`,
      );
    }
  } catch (error) {
    report.error = [(error as Error).message];
    report.failedAt = "apply";
  }
  return report;
}

function logReport(report: ImportReport): void {
  const tag = `[import:${report.sourceId}]`;
  if (report.error) {
    console.error(
      report.failedAt === "validate"
        ? `${tag} package invalid, nothing imported:`
        : `${tag} import stopped after a write error:`,
    );
    for (const line of report.error) console.error(`${tag}   ${line}`);
  }
  for (const r of report.results) {
    if (r.created + r.updated + r.skippedUnchanged + r.skippedUserModified + r.failed.length === 0) {
      continue;
    }
    const kind = r.kind.split(":").pop();
    console.log(
      `${tag} ${kind} created=${r.created} updated=${r.updated} unchanged=${r.skippedUnchanged} ` +
        `preserved=${r.skippedUserModified} failed=${r.failed.length}`,
    );
    for (const f of r.failed) console.error(`${tag} FAILED ${kind} ${f.key}: ${f.error}`);
  }
  if (report.installed > 0) console.log(`${tag} skill installs added=${report.installed}`);
  for (const line of report.conflicts) console.warn(`${tag} conflict ${line}`);
  for (const line of report.unresolved) console.warn(`${tag} unresolved ${line}`);
}

/** Boot entry point. Returns one report per configured source. */
export async function runImports(
  env: Record<string, string | undefined> = process.env,
): Promise<ImportReport[]> {
  let sources: ImportSource[];
  try {
    sources = await loadImportSources(env);
  } catch (error) {
    const lines = error instanceof ImportConfigError ? error.diagnostics : ["invalid config"];
    for (const line of lines) console.error(`[import] config ignored: ${line}`);
    return [];
  }
  const reports: ImportReport[] = [];
  for (const source of sources) {
    const report = await importSource(source);
    logReport(report);
    reports.push(report);
  }
  return reports;
}
