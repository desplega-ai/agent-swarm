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
  return value
    .replace(/[\r\n]+/g, " ")
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

function renderQuery(
  app: AppRecord,
  namespace: string,
  queryName: string,
  query: NonNullable<AppRecord["definition"]["queries"]>[string],
  modelInterfaceName: string,
): string {
  const model = app.definition.models[query.model]!;
  const params = new Map<string, string[]>();
  for (const [columnName, value] of Object.entries(query.filter ?? {})) {
    if (typeof value !== "object" || value === null || !("$param" in value)) continue;
    const column = model.columns[columnName];
    const type = column
      ? tsTypeForColumn(column)
      : Object.hasOwn(SYSTEM_COLUMN_KINDS, columnName)
        ? tsTypeForKind(SYSTEM_COLUMN_KINDS[columnName]!)
        : "unknown";
    const types = params.get(value.$param) ?? [];
    if (!types.includes(type)) types.push(type);
    params.set(value.$param, types);
  }
  const paramEntries = [...params.entries()];
  const paramsType =
    paramEntries.length === 0
      ? "params?: Record<string, never>;"
      : `params: { ${paramEntries.map(([name, types]) => `${name}: ${types.join(" | ")}`).join("; ")} };`;
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
  const modelNames = new Set<string>();
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

function skippedAppComment(app: AppRecord): string {
  return `// Skipped app ${JSON.stringify(app.id)}: stored definition could not be decoded.\n`;
}

function omittedAppsComment(apps: AppRecord[]): string {
  return `// Omitted app types due to the ${MAX_APP_TYPES_BYTES}-byte budget: ${apps
    .map((app) => commentSafe(app.name) || app.id)
    .join(", ")}.\n`;
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
  const skipped = apps
    .filter((app) => app.definitionError)
    .map(skippedAppComment)
    .join("");
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
