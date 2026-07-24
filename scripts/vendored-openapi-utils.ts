import { createHash } from "node:crypto";

export type ManifestEntry = {
  slug: string;
  name: string;
  domain: string;
  specFile: string;
  specSourceUrl: string;
  specVersionPin: string;
  baseUrl: string;
  categories: string[];
  presetId?: string;
  docsUrl: string;
  blessedOperations: string[];
  specSha256: string;
  refreshMode?: "openapi" | "operator-review";
  sourceSemantics: "machine-openapi" | "operator-reference";
  sourceSha256?: string;
  upstreamVersion?: string;
};

export type Manifest = { version: 1; integrations: ManifestEntry[] };

const HTTP_METHODS = new Set(["delete", "get", "head", "options", "patch", "post", "put"]);

function collectReferences(value: unknown, references: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, references);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$ref" && typeof nested === "string") references.add(nested);
    else collectReferences(nested, references);
  }
}

function decodeJsonPointerSegment(segment: string): string {
  return decodeURIComponent(segment).replaceAll("~1", "/").replaceAll("~0", "~");
}

function referencedComponents(document: Record<string, unknown>, paths: Record<string, unknown>) {
  const references = new Set<string>();
  collectReferences(paths, references);
  const components: Record<string, Record<string, unknown>> = {};
  const definitions: Record<string, unknown> = {};
  const queued = [...references];
  for (let index = 0; index < queued.length; index += 1) {
    const reference = queued[index];
    if (!reference) continue;
    const componentMatch = /^#\/components\/([^/]+)\/([^/]+)$/.exec(reference);
    const definitionMatch = /^#\/definitions\/([^/]+)$/.exec(reference);
    const componentGroup = componentMatch?.[1]
      ? decodeJsonPointerSegment(componentMatch[1])
      : undefined;
    const componentName = componentMatch?.[2]
      ? decodeJsonPointerSegment(componentMatch[2])
      : undefined;
    const definitionName = definitionMatch?.[1]
      ? decodeJsonPointerSegment(definitionMatch[1])
      : undefined;
    const source = componentMatch
      ? (
          (document.components as Record<string, unknown> | undefined)?.[componentGroup!] as
            | Record<string, unknown>
            | undefined
        )?.[componentName!]
      : definitionMatch
        ? (document.definitions as Record<string, unknown> | undefined)?.[definitionName!]
        : undefined;
    if (source === undefined) {
      throw new Error(`Blessed operations reference missing local schema ${reference}.`);
    }
    if (componentMatch) {
      components[componentGroup!] ??= {};
      if (components[componentGroup!][componentName!] !== undefined) continue;
      components[componentGroup!][componentName!] = source;
    } else if (definitionMatch) {
      if (definitions[definitionName!] !== undefined) continue;
      definitions[definitionName!] = source;
    }
    const nested = new Set<string>();
    collectReferences(source, nested);
    for (const nestedReference of nested) {
      if (!references.has(nestedReference)) {
        references.add(nestedReference);
        queued.push(nestedReference);
      }
    }
  }
  return { components, definitions };
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sorted(nested)]),
  );
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sorted(value), null, 2)}\n`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Keep only manifest-declared HTTP operations and deterministic OpenAPI metadata. */
export function trimOpenapiSpec(source: unknown, entry: ManifestEntry): Record<string, unknown> {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`${entry.slug}: upstream spec is not an object.`);
  }
  const document = source as Record<string, unknown>;
  const sourcePaths = document.paths;
  if (!sourcePaths || typeof sourcePaths !== "object" || Array.isArray(sourcePaths)) {
    throw new Error(`${entry.slug}: upstream spec has no paths object.`);
  }
  const selected = new Map<string, Set<string>>();
  for (const operation of entry.blessedOperations) {
    const match = /^(DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT) (\/\S+)$/.exec(operation);
    if (!match) throw new Error(`${entry.slug}: invalid blessed operation ${operation}.`);
    const methods = selected.get(match[2]) ?? new Set<string>();
    methods.add(match[1].toLowerCase());
    selected.set(match[2], methods);
  }
  const paths: Record<string, unknown> = {};
  for (const [pathName, methods] of selected) {
    const sourcePath = (sourcePaths as Record<string, unknown>)[pathName];
    if (!sourcePath || typeof sourcePath !== "object" || Array.isArray(sourcePath)) {
      throw new Error(`${entry.slug}: upstream spec is missing ${pathName}.`);
    }
    const pathItem: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(sourcePath as Record<string, unknown>)) {
      if (!HTTP_METHODS.has(key) || methods.has(key)) pathItem[key] = value;
    }
    for (const method of methods) {
      if (!(method in pathItem))
        throw new Error(
          `${entry.slug}: upstream spec is missing ${method.toUpperCase()} ${pathName}.`,
        );
    }
    paths[pathName] = pathItem;
  }
  const { components, definitions } = referencedComponents(document, paths);
  const trimmed: Record<string, unknown> = {
    ...(typeof document.openapi === "string" ? { openapi: document.openapi } : {}),
    ...(typeof document.swagger === "string" ? { swagger: document.swagger } : {}),
    info: document.info,
    ...(document.servers ? { servers: document.servers } : {}),
    ...(document.host ? { host: document.host } : {}),
    ...(document.basePath ? { basePath: document.basePath } : {}),
    ...(document.schemes ? { schemes: document.schemes } : {}),
    ...(Object.keys(components).length > 0 ? { components } : {}),
    ...(Object.keys(definitions).length > 0 ? { definitions } : {}),
    paths,
  };
  return trimmed;
}
