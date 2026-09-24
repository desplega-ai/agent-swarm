import {
  type ExtensionManifest,
  ExtensionManifestSchema,
  type ExtensionWorkflowFile,
  ExtensionWorkflowFileSchema,
} from "../types";

/** A predefined extension directory holds exactly one of these. */
export const MANIFEST_FILENAMES = ["manifest.yaml", "manifest.yml", "manifest.json"] as const;

/** Parse YAML (`.yaml`/`.yml`) or JSON (`.json`) text into a plain value. */
export function parseStructuredText(filename: string, text: string): unknown {
  const lower = filename.toLowerCase();
  try {
    if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return Bun.YAML.parse(text);
    if (lower.endsWith(".json")) return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${filename}: cannot parse: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  throw new Error(`${filename}: unsupported format, expected .yaml, .yml or .json`);
}

/** Parse a YAML or JSON manifest and validate it against `ExtensionManifestSchema`. */
export function parseManifestText(filename: string, text: string): ExtensionManifest {
  const parsed = ExtensionManifestSchema.safeParse(parseStructuredText(filename, text));
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `  ${issue.path.join(".") || "manifest"}: ${issue.message}`,
    );
    throw new Error(`${filename}: invalid extension manifest\n${issues.join("\n")}`);
  }
  return parsed.data;
}

/** Every single-file bundle path the manifest points at: hooks, scripts, workflow files. */
export function referencedBundlePaths(manifest: ExtensionManifest): string[] {
  return [
    manifest.assets.hooks,
    ...(manifest.assets.scripts ?? []).map((script) => script.file),
    ...(manifest.assets.workflows ?? []).map((workflow) => workflow.file),
  ];
}

/** Skill directories: each holds `SKILL.md` plus optional `files/**`. */
export function skillDirs(manifest: ExtensionManifest): string[] {
  return (manifest.assets.skills ?? []).map((skill) => skill.dir);
}

/** Parse a YAML or JSON workflow file an extension ships and check its name prefix. */
export function parseWorkflowText(
  filename: string,
  text: string,
  extensionName: string,
): ExtensionWorkflowFile {
  const parsed = ExtensionWorkflowFileSchema.safeParse(parseStructuredText(filename, text));
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `  ${issue.path.join(".") || "workflow"}: ${issue.message}`,
    );
    throw new Error(`${filename}: invalid workflow file\n${issues.join("\n")}`);
  }
  if (!parsed.data.name.startsWith(`${extensionName}-`)) {
    throw new Error(`${filename}: workflow name must start with "${extensionName}-"`);
  }
  return parsed.data;
}
