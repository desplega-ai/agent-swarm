import type { ScriptTypeContext } from "../be/scripts/type-contributors";
import { type ColumnDef, type ColumnKind, SYSTEM_COLUMN_KINDS } from "./definition";
import { type AppRecord, listAppRecords } from "./store";

export const MAX_APP_TYPES_BYTES = 32 * 1024;

const APP_TYPES_PREAMBLE = `// ── Swarm Apps: generated per-app types (source: apps table) ───────────────
// Rows are the app's declared columns plus the 5 system columns. Query
// overloads narrow only when appId AND query are string literals.

export interface SwarmAppQueryResult<Row> {
  success: boolean;
  status: number;
  data: {
    success: boolean;
    message: string;
    details?: string;
    rows?: Row[];
    count?: number;
    [key: string]: unknown;
  };
}
`;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function pascalIdentifier(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const identifier = words
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1).toLowerCase()}`)
    .join("")
    .replace(/^\d+/, "");
  return identifier || "Unnamed";
}

function dedupe(identifier: string, seen: Set<string>): string {
  if (!seen.has(identifier)) {
    seen.add(identifier);
    return identifier;
  }
  let suffix = 2;
  while (seen.has(`${identifier}_${suffix}`)) suffix += 1;
  const deduped = `${identifier}_${suffix}`;
  seen.add(deduped);
  return deduped;
}

function commentSafe(value: string): string {
  // U+2028/U+2029 are JS line terminators too — they end a `//` comment.
  return value
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/\*\//g, "")
    .trim()
    .slice(0, 80);
}

function tsTypeForColumn(column: Pick<ColumnDef, "kind" | "enum">): string {
  if (column.kind !== "enum") return column.kind === "date" ? "string" : column.kind;
  return column.enum?.map((value) => JSON.stringify(value)).join(" | ") || "string";
}

function tsTypeForKind(kind: ColumnKind): string {
  return tsTypeForColumn({ kind });
}

function renderModel(
  modelName: string,
  model: AppRecord["definition"]["models"][string],
  seen: Set<string>,
) {
  const interfaceName = dedupe(pascalIdentifier(modelName), seen);
  const columns = Object.entries(model.columns)
    .filter(([, column]) => column.hidden !== true)
    .map(([columnName, column]) => {
      const optional = column.required === true ? "" : "?";
      const declaration = `    ${columnName}${optional}: ${tsTypeForColumn(column)};`;
      return column.kind === "date" ? `    /** date */\n${declaration}` : declaration;
    });
  return {
    interfaceName,
    source: `  /** Model \`${modelName}\`. */
  export interface ${interfaceName} {
    id: string;
    createdAt: string;
    updatedAt: string;
    createdBy?: string;
    updatedBy?: string;
${columns.join("\n")}
  }`,
  };
}

type ParamType = { kind: "primitive"; name: string } | { kind: "literals"; values: string[] };

function paramTypeForColumn(
  column: Pick<ColumnDef, "kind" | "enum"> | undefined,
  columnName: string,
): ParamType {
  if (!column) {
    return Object.hasOwn(SYSTEM_COLUMN_KINDS, columnName)
      ? { kind: "primitive", name: tsTypeForKind(SYSTEM_COLUMN_KINDS[columnName]!) }
      : { kind: "primitive", name: "unknown" };
  }
  if (column.kind === "enum" && column.enum?.length) {
    return { kind: "literals", values: column.enum };
  }
  return { kind: "primitive", name: tsTypeForColumn(column) };
}

/**
 * The runtime validates one param value against EVERY filter column that
 * references it (`resolveQueryFilters`), so a reused `$param` accepts only the
 * intersection of the columns' inputs — never the union. Disjoint columns
 * intersect to `never` (the specialized overload becomes uncallable; the loose
 * fallback still compiles such calls, untyped).
 */
function intersectParamTypes(a: ParamType, b: ParamType): ParamType {
  if (a.kind === "primitive" && a.name === "unknown") return b;
  if (b.kind === "primitive" && b.name === "unknown") return a;
  if (a.kind === "literals" && b.kind === "literals") {
    return { kind: "literals", values: a.values.filter((value) => b.values.includes(value)) };
  }
  if (a.kind === "literals") {
    return b.kind === "primitive" && b.name === "string" ? a : { kind: "literals", values: [] };
  }
  if (b.kind === "literals") {
    return a.name === "string" ? b : { kind: "literals", values: [] };
  }
  return a.name === b.name ? a : { kind: "literals", values: [] };
}

function renderParamType(type: ParamType): string {
  if (type.kind === "primitive") return type.name;
  if (type.values.length === 0) return "never";
  return type.values.map((value) => JSON.stringify(value)).join(" | ");
}

function renderQuery(
  app: AppRecord,
  namespace: string,
  queryName: string,
  query: NonNullable<AppRecord["definition"]["queries"]>[string],
  modelInterfaceName: string,
): string {
  const model = app.definition.models[query.model]!;
  const params = new Map<string, ParamType>();
  for (const [columnName, value] of Object.entries(query.filter ?? {})) {
    if (typeof value !== "object" || value === null || !("$param" in value)) continue;
    const next = paramTypeForColumn(model.columns[columnName], columnName);
    const prior = params.get(value.$param);
    params.set(value.$param, prior ? intersectParamTypes(prior, next) : next);
  }
  const paramEntries = [...params.entries()];
  const paramsType =
    paramEntries.length === 0
      ? "params?: Record<string, never>;"
      : `params: { ${paramEntries.map(([name, type]) => `${name}: ${renderParamType(type)}`).join("; ")} };`;
  const paramsComment =
    paramEntries.length === 0
      ? "No params."
      : `Params: ${paramEntries.map(([name]) => `\`${name}\``).join(", ")}.`;
  return `  /** App "${commentSafe(app.name)}" · query \`${queryName}\` → rows of model \`${query.model}\`. ${paramsComment} */
  app_query(args: {
    appId: ${JSON.stringify(app.id)};
    query: ${JSON.stringify(queryName)};
    ${paramsType}
  }): Promise<SwarmAppQueryResult<${namespace}.${modelInterfaceName}>>;`;
}

function renderApp(app: AppRecord, namespace: string): string {
  // Reserve the generated alias so a model named `actionName` dedupes to
  // `ActionName_2` instead of colliding with `type ActionName`.
  const modelNames = new Set<string>(["ActionName"]);
  const renderedModels = Object.entries(app.definition.models).map(([modelName, model]) =>
    renderModel(modelName, model, modelNames),
  );
  const modelInterfaces = new Map(
    Object.keys(app.definition.models).map((modelName, index) => [
      modelName,
      renderedModels[index]!.interfaceName,
    ]),
  );
  const actionNames = Object.keys(app.definition.actions ?? {});
  const description = app.description ? ` — ${commentSafe(app.description)}` : "";
  const queries = Object.entries(app.definition.queries ?? {}).map(([queryName, query]) =>
    renderQuery(app, namespace, queryName, query, modelInterfaces.get(query.model)!),
  );
  const actionType =
    actionNames.length === 0
      ? "never"
      : actionNames.map((name) => JSON.stringify(name)).join(" | ");
  return `/** App "${commentSafe(app.name)}" — id ${JSON.stringify(app.id)}${description} */
export namespace ${namespace} {
${renderedModels.map((model) => model.source).join("\n\n")}

  /** Declared actions. Invocation is REST-only: POST /api/apps/<id>/actions/<name>. */
  export type ActionName = ${actionType};
}

export interface SwarmSdk {
${queries.join("\n\n")}
}
`;
}

/** Skipped/omitted trailers list at most this many apps so metadata alone can never blow the byte budget. */
const MAX_LISTED_METADATA_APPS = 10;

function skippedAppsComment(apps: AppRecord[]): string {
  if (apps.length === 0) return "";
  const lines = apps
    .slice(0, MAX_LISTED_METADATA_APPS)
    .map(
      (app) =>
        `// Skipped app ${JSON.stringify(app.id)}: stored definition could not be decoded.\n`,
    );
  const rest = apps.length - MAX_LISTED_METADATA_APPS;
  if (rest > 0) lines.push(`// ...and ${rest} more app(s) with undecodable definitions skipped.\n`);
  return lines.join("");
}

function omittedAppsComment(apps: AppRecord[]): string {
  const listed = apps
    .slice(0, MAX_LISTED_METADATA_APPS)
    .map((app) => `${commentSafe(app.name) || app.id} (${app.id})`)
    .join(", ");
  const rest = apps.length - MAX_LISTED_METADATA_APPS;
  return `// ${apps.length} more app(s) omitted (type budget): ${listed}${
    rest > 0 ? `, +${rest} more` : ""
  } — call app-get for their shape.\n`;
}

/** Renders the pure, generated per-app `.d.ts` overlay for script authors. */
export function renderAppTypes(apps: AppRecord[]): string {
  const renderableApps = apps.filter((app) => !app.definitionError);
  if (renderableApps.length === 0) return "";

  const namespaces = new Set<string>();
  const renderedApps = renderableApps.map((app) => ({
    app,
    source: renderApp(app, `App_${dedupe(pascalIdentifier(app.name), namespaces)}`),
  }));
  const skipped = skippedAppsComment(apps.filter((app) => app.definitionError));
  const kept: Array<(typeof renderedApps)[number]> = [];
  const omitted: AppRecord[] = [];
  let result = `${APP_TYPES_PREAMBLE}\n${skipped}`;

  for (const [index, rendered] of renderedApps.entries()) {
    if (byteLength(`${result}${rendered.source}\n`) <= MAX_APP_TYPES_BYTES) {
      kept.push(rendered);
      result += `${rendered.source}\n`;
    } else {
      omitted.push(...renderedApps.slice(index).map((item) => item.app));
      break;
    }
  }

  while (
    omitted.length > 0 &&
    byteLength(`${result}${omittedAppsComment(omitted)}`) > MAX_APP_TYPES_BYTES
  ) {
    const removed = kept.pop();
    if (!removed) break;
    result = `${APP_TYPES_PREAMBLE}\n${skipped}${kept.map((item) => `${item.source}\n`).join("")}`;
    omitted.unshift(removed.app);
  }

  return omitted.length > 0 ? `${result}${omittedAppsComment(omitted)}` : result;
}

/**
 * Generates types for every app. `context` is accepted for the future
 * `app.use` RBAC filter hook; apps are intentionally unfiltered today.
 */
export function getScriptAppTypes(_context: ScriptTypeContext = {}): string {
  try {
    return renderAppTypes(listAppRecords());
  } catch {
    return "";
  }
}
