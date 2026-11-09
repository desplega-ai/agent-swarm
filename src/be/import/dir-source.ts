/**
 * The `dir` import source: reads a package root (read only) and validates
 * every item before the importer writes anything. A package that fails any
 * check throws {@link ImportPackageError} with every diagnostic at once.
 *
 * With a root `swarm-import.{yaml,yml,json}` the manifest lists the items.
 * Without one, the directory convention applies: `workflows/*.{yaml,yml,json}`,
 * `skills/<id>/SKILL.md`, `scripts/*.ts`, `agents/<name>.md`.
 */

import { realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, sep } from "node:path";
import { extractScriptSignature } from "../../scripts-runtime/extract-signature";
import { validateScriptImports } from "../../scripts-runtime/import-allowlist";
import { ExtensionWorkflowFileSchema } from "../../types";
import { IDENTITY_MD_MAX_CHARS } from "../../utils/identity-field-budget";
import { getExecutorRegistry } from "../../workflows";
import { validateDefinition } from "../../workflows/definition";
import { computeContentHash, normalizeSkillFilePath, SKILL_FILE_LIMITS } from "../db";
import {
  hashOf,
  type ScriptSpec,
  type SkillFileSpec,
  type SkillSpec,
  scriptHash,
  skillHash,
  skillSpecOf,
  type WorkflowSpec,
} from "../extensions/assets";
import { extractArgsJsonSchema } from "../scripts/extract-schema";
import { typecheckScript } from "../scripts/typecheck";
import { parseSkillContent } from "../skill-parser";
import {
  formatIssues,
  type ImportManifest,
  ImportManifestSchema,
  type ImportSource,
} from "./schema";

export const MANIFEST_FILENAMES = [
  "swarm-import.yaml",
  "swarm-import.yml",
  "swarm-import.json",
] as const;

export type ImportedWorkflow = { key: string; spec: WorkflowSpec; hash: string };
export type ImportedSkill = {
  key: string;
  spec: SkillSpec;
  files: SkillFileSpec[];
  hash: string;
};
/** Scripts are keyed by their global name. */
export type ImportedScript = { key: string; spec: ScriptSpec; hash: string };
export type ImportedAgent = {
  /** `id:<agent id>` or `name:<agent name>`. */
  key: string;
  agentId: string | null;
  agentName: string | null;
  instructions: { text: string; hash: string } | null;
  /** Local skill ids to install. */
  skills: string[];
};

/** Every kind is optional: an omitted kind imports nothing. */
export type ImportPackage = {
  workflows: ImportedWorkflow[];
  skills: ImportedSkill[];
  scripts: ImportedScript[];
  agents: ImportedAgent[];
};

export class ImportPackageError extends Error {
  constructor(readonly diagnostics: string[]) {
    super(diagnostics.join("\n"));
    this.name = "ImportPackageError";
  }
}

function parseStructured(file: string, text: string): unknown {
  const yaml = /\.ya?ml$/i.test(file);
  try {
    return yaml ? Bun.YAML.parse(text) : JSON.parse(text);
  } catch {
    // Parser messages quote the input; name the file only.
    throw new ImportPackageError([`${file}: cannot parse as ${yaml ? "YAML" : "JSON"}`]);
  }
}

async function scan(root: string, pattern: string): Promise<string[]> {
  try {
    return (await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })))
      .map((path) => path.split("\\").join("/"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Read `path` relative to the package root. Symlinks and `..` segments may
 * point anywhere, so the resolved path must stay inside the resolved root.
 */
async function readText(root: string, path: string): Promise<string | undefined> {
  const resolved = await realpath(join(root, path)).catch(() => null);
  if (resolved === null) return undefined;
  const base = await realpath(root);
  if (resolved !== base && !resolved.startsWith(base + sep)) {
    throw new ImportPackageError([`${path}: resolves outside the package`]);
  }
  const file = Bun.file(resolved);
  return (await file.exists()) ? await file.text() : undefined;
}

const stem = (path: string) => basename(path, extname(path));

/** Manifest the directory convention implies. */
async function conventionManifest(root: string): Promise<unknown> {
  return {
    workflows: (await scan(root, "workflows/*.{yaml,yml,json}")).map((file) => ({
      id: stem(file),
      file,
    })),
    skills: (await scan(root, "skills/*/SKILL.md")).map((file) => ({
      id: basename(dirname(file)),
      dir: dirname(file),
    })),
    scripts: (await scan(root, "scripts/*.ts")).map((file) => ({
      name: stem(file),
      file,
      // shortcut: no description source in the convention; use a manifest for searchable descriptions.
      description: `Imported script ${stem(file)}`,
    })),
    agents: (await scan(root, "agents/*.md")).map((file) => ({
      name: stem(file),
      instructions: file,
    })),
  };
}

async function readManifest(root: string): Promise<unknown> {
  const present: string[] = [];
  for (const name of MANIFEST_FILENAMES) {
    if (await Bun.file(join(root, name)).exists()) present.push(name);
  }
  if (present.length > 1) {
    throw new ImportPackageError([`manifest: found ${present.join(", ")}; keep exactly one`]);
  }
  const name = present[0];
  if (!name) return conventionManifest(root);
  return parseStructured(name, (await readText(root, name)) as string);
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return [...dupes];
}

async function loadWorkflows(
  root: string,
  manifest: ImportManifest,
  diagnostics: string[],
): Promise<ImportedWorkflow[]> {
  const workflows: ImportedWorkflow[] = [];
  for (const entry of manifest.workflows ?? []) {
    const label = `workflow ${entry.id}`;
    const text = await readText(root, entry.file);
    if (text === undefined) {
      diagnostics.push(`${label}: ${entry.file} not found`);
      continue;
    }
    let raw: unknown;
    try {
      raw = parseStructured(entry.file, text);
    } catch (error) {
      diagnostics.push(...(error as ImportPackageError).diagnostics);
      continue;
    }
    const parsed = ExtensionWorkflowFileSchema.safeParse(raw);
    if (!parsed.success) {
      diagnostics.push(...formatIssues(entry.file, parsed.error.issues));
      continue;
    }
    const validation = validateDefinition(parsed.data.definition, getExecutorRegistry());
    if (!validation.valid) {
      diagnostics.push(`${label}: ${validation.errors.join("; ")}`);
      continue;
    }
    const spec: WorkflowSpec = {
      name: parsed.data.name,
      description: parsed.data.description || null,
      definition: parsed.data.definition,
      triggers: parsed.data.triggers ?? [],
      cooldown: parsed.data.cooldown ?? null,
      input: parsed.data.input ?? null,
      triggerSchema: parsed.data.triggerSchema ?? null,
    };
    workflows.push({ key: entry.id, spec, hash: hashOf(spec) });
  }
  for (const name of duplicates(workflows.map((workflow) => workflow.spec.name))) {
    diagnostics.push(`workflows: name "${name}" is used by more than one file`);
  }
  return workflows;
}

/**
 * The checks `upsertSkillFiles` runs at storage time, run before any write.
 * The seeder replaces a skill's whole file set, so `files` is the stored set.
 */
function assertSkillFileSet(files: SkillFileSpec[]): void {
  let total = 0;
  for (const file of files) {
    const path = normalizeSkillFilePath(file.path);
    const size = Buffer.byteLength(file.content, "utf8");
    if (size > SKILL_FILE_LIMITS.maxFileBytes) {
      throw new Error(`File ${path} exceeds max size ${SKILL_FILE_LIMITS.maxFileBytes}`);
    }
    total += size;
  }
  if (files.length > SKILL_FILE_LIMITS.maxCount) {
    throw new Error(`Skill file count exceeds max ${SKILL_FILE_LIMITS.maxCount}`);
  }
  if (total > SKILL_FILE_LIMITS.maxTotalBytes) {
    throw new Error(`Skill files exceed max total size ${SKILL_FILE_LIMITS.maxTotalBytes}`);
  }
}

async function loadSkills(
  root: string,
  manifest: ImportManifest,
  diagnostics: string[],
): Promise<ImportedSkill[]> {
  const skills: ImportedSkill[] = [];
  for (const entry of manifest.skills ?? []) {
    const label = `skill ${entry.id}`;
    const content = await readText(root, `${entry.dir}/SKILL.md`);
    if (content === undefined) {
      diagnostics.push(`${label}: ${entry.dir}/SKILL.md not found`);
      continue;
    }
    const files: SkillFileSpec[] = [];
    for (const path of await scan(join(root, entry.dir, "files"), "**/*")) {
      files.push({ path, content: (await readText(root, `${entry.dir}/files/${path}`)) ?? "" });
    }
    let spec: SkillSpec;
    try {
      spec = skillSpecOf(content, parseSkillContent(content), files.length > 0);
      assertSkillFileSet(files);
    } catch (error) {
      diagnostics.push(`${label}: ${(error as Error).message}`);
      continue;
    }
    skills.push({ key: entry.id, spec, files, hash: skillHash(spec, files) });
  }
  for (const name of duplicates(skills.map((skill) => skill.spec.name))) {
    diagnostics.push(`skills: name "${name}" is used by more than one SKILL.md`);
  }
  return skills;
}

async function loadScripts(
  root: string,
  manifest: ImportManifest,
  diagnostics: string[],
): Promise<ImportedScript[]> {
  const scripts: ImportedScript[] = [];
  for (const entry of manifest.scripts ?? []) {
    const label = `script ${entry.name}`;
    const source = await readText(root, entry.file);
    if (source === undefined) {
      diagnostics.push(`${label}: ${entry.file} not found`);
      continue;
    }
    const imports = validateScriptImports(source);
    if (!imports.ok) {
      diagnostics.push(`${label}: ${imports.diagnostic}`);
      continue;
    }
    const typecheck = await typecheckScript(source);
    if (!typecheck.ok) {
      diagnostics.push(...typecheck.diagnostics.map((line) => `${label} (${entry.file}): ${line}`));
      continue;
    }
    const spec: ScriptSpec = {
      source,
      description: entry.description,
      intent: entry.intent ?? entry.description,
      signatureJson: JSON.stringify(extractScriptSignature(source)),
      argsJsonSchema: await extractArgsJsonSchema(source),
      fsMode: "none",
    };
    scripts.push({ key: entry.name, spec, hash: scriptHash(spec) });
  }
  return scripts;
}

async function loadAgents(
  root: string,
  manifest: ImportManifest,
  diagnostics: string[],
): Promise<ImportedAgent[]> {
  const skillIds = new Set((manifest.skills ?? []).map((skill) => skill.id));
  const agents: ImportedAgent[] = [];
  for (const entry of manifest.agents ?? []) {
    const key = entry.id !== undefined ? `id:${entry.id}` : `name:${entry.name}`;
    const label = `agent ${key}`;
    let instructions: ImportedAgent["instructions"] = null;
    if (entry.instructions !== undefined) {
      const text = await readText(root, entry.instructions);
      if (text === undefined) {
        diagnostics.push(`${label}: ${entry.instructions} not found`);
        continue;
      }
      if (text.length > IDENTITY_MD_MAX_CHARS) {
        diagnostics.push(
          `${label}: ${entry.instructions} is longer than ${IDENTITY_MD_MAX_CHARS} characters`,
        );
        continue;
      }
      instructions = { text, hash: computeContentHash(text) };
    }
    const unknown = (entry.skills ?? []).filter((id) => !skillIds.has(id));
    if (unknown.length > 0) {
      diagnostics.push(`${label}: skills not declared in this package: ${unknown.join(", ")}`);
      continue;
    }
    agents.push({
      key,
      agentId: entry.id ?? null,
      agentName: entry.name ?? null,
      instructions,
      skills: [...new Set(entry.skills ?? [])],
    });
  }
  return agents;
}

/** Load and validate a whole package. Reads only; never writes to `source.path`. */
export async function loadDirPackage(source: ImportSource): Promise<ImportPackage> {
  const root = source.path;
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw new ImportPackageError(["path: not a readable directory"]);

  const parsed = ImportManifestSchema.safeParse(await readManifest(root));
  if (!parsed.success) throw new ImportPackageError(formatIssues("manifest", parsed.error.issues));
  const manifest = parsed.data;

  const diagnostics: string[] = [];
  const kinds = {
    workflows: (manifest.workflows ?? []).map((item) => item.id),
    skills: (manifest.skills ?? []).map((item) => item.id),
    scripts: (manifest.scripts ?? []).map((item) => item.name),
    agents: (manifest.agents ?? []).map((item) => item.id ?? `name:${item.name}`),
  };
  for (const [kind, ids] of Object.entries(kinds)) {
    for (const id of duplicates(ids)) diagnostics.push(`${kind}: "${id}" is declared twice`);
  }

  const pkg: ImportPackage = {
    workflows: await loadWorkflows(root, manifest, diagnostics),
    skills: await loadSkills(root, manifest, diagnostics),
    scripts: await loadScripts(root, manifest, diagnostics),
    agents: await loadAgents(root, manifest, diagnostics),
  };
  if (diagnostics.length > 0) throw new ImportPackageError(diagnostics);
  return pkg;
}
