/**
 * Operator import config. Read from `process.env` after boot injected global
 * `swarm_config` rows (`loadGlobalConfigsIntoEnv`), so a stored row wins over
 * the deployment env like every other config key.
 */

import { formatIssues, type ImportSource, ImportSourcesSchema } from "./schema";

/** Fixed-text config failure. Never carries the configured value. */
export class ImportConfigError extends Error {
  constructor(readonly diagnostics: string[]) {
    super(diagnostics.join("; "));
    this.name = "ImportConfigError";
  }
}

function parseText(label: string, text: string, yaml: boolean): unknown {
  try {
    return yaml ? Bun.YAML.parse(text) : JSON.parse(text);
  } catch {
    // The parser message quotes the input; keep it out of the log.
    throw new ImportConfigError([`${label}: cannot parse as ${yaml ? "YAML" : "JSON"}`]);
  }
}

/** The configured sources, or `[]` when neither variable is set (boot unchanged). */
export async function loadImportSources(
  env: Record<string, string | undefined> = process.env,
): Promise<ImportSource[]> {
  const inline = env.SWARM_IMPORT_SOURCES?.trim();
  const file = env.SWARM_IMPORT_SOURCES_FILE?.trim();
  if (!inline && !file) return [];
  if (inline && file) {
    throw new ImportConfigError([
      "set only one of SWARM_IMPORT_SOURCES and SWARM_IMPORT_SOURCES_FILE",
    ]);
  }

  let raw: unknown;
  let label: string;
  if (inline) {
    label = "SWARM_IMPORT_SOURCES";
    raw = parseText(label, inline, false);
  } else {
    label = "SWARM_IMPORT_SOURCES_FILE";
    const handle = Bun.file(file as string);
    if (!(await handle.exists())) throw new ImportConfigError([`${label}: file not found`]);
    raw = parseText(label, await handle.text(), /\.ya?ml$/i.test(file as string));
  }

  const parsed = ImportSourcesSchema.safeParse(raw);
  if (!parsed.success) throw new ImportConfigError(formatIssues(label, parsed.error.issues));
  return parsed.data;
}
