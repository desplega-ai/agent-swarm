import * as z from "zod";
import { getDb } from "../be/db";
import { scrubSecrets } from "../utils/secret-scrubber";
import {
  type AppDefinition,
  AppElementsSchema,
  AppNameSchema,
  type AppValidationIssue,
  type ColumnDef,
  isIso8601Date,
  type ModelDef,
  parseAppDefinition,
  SYSTEM_COLUMN_KINDS,
} from "./definition";
import { upgradeAppDefinition } from "./format-upgrades";
import {
  type AppRow,
  listAllAppRowsForMigrationUnlocked,
  rebuildAppColumnIndexUnlocked,
  withMutationLock,
  writeAppRowForMigrationUnlocked,
} from "./row-store";

const MigrationValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const AppMigrationDirectiveSchema = z.union([
  z.object({ set: MigrationValueSchema }).strict(),
  z
    .object({
      from: AppNameSchema,
      map: z.record(z.string(), MigrationValueSchema).optional(),
      else: MigrationValueSchema.nullable().optional(),
    })
    .strict(),
  z.object({ coerce: z.literal(true), else: MigrationValueSchema.nullable().optional() }).strict(),
  z.object({ purge: z.literal(true) }).strict(),
]);

export const AppMigrationSchema = z.record(AppNameSchema, AppMigrationDirectiveSchema);
export const ForceElementBreakSchema = z.array(AppNameSchema).max(20);
export type AppMigration = z.infer<typeof AppMigrationSchema>;
export type AppMigrationDirective = z.infer<typeof AppMigrationDirectiveSchema>;

export const AppMigrationReportSchema = z.object({
  scanned: z.number().int().nonnegative(),
  backfilled: z.number().int().nonnegative(),
  coerced: z.number().int().nonnegative(),
  mapped: z.number().int().nonnegative(),
  elsed: z.number().int().nonnegative(),
  purgedValues: z.number().int().nonnegative(),
  idxRebuilt: z.number().int().nonnegative(),
  orphanFields: z.array(z.string()),
  userConfigChanged: z.array(z.string()),
});

export const AppMigrationReportOutputSchema = z.looseObject({
  scanned: z.number().optional(),
  backfilled: z.number().optional(),
  coerced: z.number().optional(),
  mapped: z.number().optional(),
  elsed: z.number().optional(),
  purgedValues: z.number().optional(),
  idxRebuilt: z.number().optional(),
  orphanFields: z.array(z.string()).optional(),
  userConfigChanged: z.array(z.string()).optional(),
});

export type AppMigrationReport = z.infer<typeof AppMigrationReportSchema>;

export class AppSchemaMigrationError extends Error {
  constructor(readonly issues: AppValidationIssue[]) {
    super("invalid app schema migration");
    this.name = "AppSchemaMigrationError";
  }
}

export class AppSnapshotFailure extends Error {}

export function unexpectedMigrationDetails(error: unknown): string {
  const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return `Cause: ${scrubSecrets(cause || "Unknown migration error")}`;
}

interface ModelMigrationPlan {
  modelName: string;
  rows: AppRow[];
  changedRows: AppRow[];
  rebuildColumns: string[];
}

interface MigrationPlan {
  issues: AppValidationIssue[];
  models: ModelMigrationPlan[];
  report: AppMigrationReport;
}

const EMPTY_REPORT: AppMigrationReport = {
  scanned: 0,
  backfilled: 0,
  coerced: 0,
  mapped: 0,
  elsed: 0,
  purgedValues: 0,
  idxRebuilt: 0,
  orphanFields: [],
  userConfigChanged: [],
};

const MAX_REPORTED_VALUES = 10;
const MAX_ORPHAN_FIELDS = 100;

function summarizeCounts(
  counts: Map<string, number>,
  render: (value: string, count: number) => string,
): string {
  const sorted = [...counts.entries()].sort(
    ([leftValue, leftCount], [rightValue, rightCount]) =>
      rightCount - leftCount || leftValue.localeCompare(rightValue),
  );
  const shown = sorted.slice(0, MAX_REPORTED_VALUES);
  const omitted = sorted.slice(MAX_REPORTED_VALUES);
  const summary = shown.map(([value, count]) => render(value, count)).join(", ");
  if (omitted.length === 0) return summary;
  const omittedRows = omitted.reduce((total, [, count]) => total + count, 0);
  return `${summary} — and ${omitted.length} more distinct values across ${omittedRows} rows`;
}

function definitionsEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

interface StoredAppDefinitionRow {
  id: string;
  name: string;
  definition: string;
}

interface BreakingElementChange {
  name: string;
  reasons: string[];
}

function previousElementsForCompatibility(
  previousDefinition: AppDefinition | undefined,
  previousRawDefinition: unknown,
): AppDefinition["elements"] | undefined {
  if (previousDefinition?.elements) return previousDefinition.elements;
  const upgradedRaw = upgradeAppDefinition(previousRawDefinition);
  const recoveredElements =
    typeof upgradedRaw === "object" && upgradedRaw !== null && !Array.isArray(upgradedRaw)
      ? AppElementsSchema.safeParse((upgradedRaw as Record<string, unknown>).elements)
      : undefined;
  return recoveredElements?.success ? recoveredElements.data : undefined;
}

function breakingElementChanges(
  previousDefinition: AppDefinition | undefined,
  previousRawDefinition: unknown,
  nextDefinition: AppDefinition,
): BreakingElementChange[] {
  const previousElements = previousElementsForCompatibility(
    previousDefinition,
    previousRawDefinition,
  );
  // Fail open when even the producer's elements map cannot be recovered. Repairing
  // a corrupt producer must not be blocked by corruption in its own old definition.
  if (!previousElements) return [];
  const changes: BreakingElementChange[] = [];
  for (const [name, previous] of Object.entries(previousElements)) {
    if (previous.export !== true) continue;
    const next = nextDefinition.elements?.[name];
    const reasons: string[] = [];
    if (!next) reasons.push("removed");
    else {
      if (next.export !== true) reasons.push("made private");
      if (next.mode !== previous.mode)
        reasons.push(`mode changed from ${previous.mode} to ${next.mode}`);
      const removedProps = Object.keys(previous.props ?? {}).filter(
        (propName) => !Object.hasOwn(next.props ?? {}, propName),
      );
      if (removedProps.length > 0) reasons.push(`removed props: ${removedProps.join(", ")}`);
      const changedPropKinds = Object.entries(previous.props ?? {})
        .filter(
          ([propName, prop]) =>
            Object.hasOwn(next.props ?? {}, propName) && next.props![propName]!.kind !== prop.kind,
        )
        .map(([propName, prop]) => `${propName} (${prop.kind} to ${next.props![propName]!.kind})`);
      if (changedPropKinds.length > 0) {
        reasons.push(`changed prop kinds: ${changedPropKinds.join(", ")}`);
      }
      const newRequiredProps = Object.entries(next.props ?? {})
        .filter(
          ([propName, prop]) =>
            !Object.hasOwn(previous.props ?? {}, propName) &&
            prop.required === true &&
            prop.default === undefined,
        )
        .map(([propName]) => propName);
      if (newRequiredProps.length > 0) {
        reasons.push(`added required props without defaults: ${newRequiredProps.join(", ")}`);
      }
    }
    if (reasons.length > 0) changes.push({ name, reasons });
  }
  return changes;
}

function scanRawElementReferences(
  value: unknown,
  targetAppId: string,
  elementNames: Set<string>,
  found: Set<string>,
): void {
  if (typeof value !== "object" || value === null) return;
  const definition = value as Record<string, unknown>;
  const nodeMaps: unknown[] = [];
  for (const collectionKey of ["pages", "elements"] as const) {
    const collection = definition[collectionKey];
    if (typeof collection !== "object" || collection === null || Array.isArray(collection)) {
      continue;
    }
    for (const entry of Object.values(collection)) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      nodeMaps.push((entry as Record<string, unknown>).elements);
    }
  }

  for (const nodeMap of nodeMaps) {
    if (typeof nodeMap !== "object" || nodeMap === null || Array.isArray(nodeMap)) continue;
    for (const node of Object.values(nodeMap)) {
      if (typeof node !== "object" || node === null || Array.isArray(node)) continue;
      const element = node as Record<string, unknown>;
      if (
        element.type !== "ElementRef" ||
        typeof element.props !== "object" ||
        element.props === null ||
        Array.isArray(element.props)
      ) {
        continue;
      }
      const props = element.props as Record<string, unknown>;
      if (
        props.app === targetAppId &&
        typeof props.element === "string" &&
        elementNames.has(props.element)
      ) {
        found.add(props.element);
      }
    }
  }
}

function exportedElementCompatibilityIssues(
  appId: string,
  previousDefinition: AppDefinition | undefined,
  previousRawDefinition: unknown,
  nextDefinition: AppDefinition,
  forceElementBreak: string[],
): AppValidationIssue[] {
  const previousElements = previousElementsForCompatibility(
    previousDefinition,
    previousRawDefinition,
  );
  const knownElementNames = new Set([
    ...Object.keys(previousElements ?? {}),
    ...Object.keys(nextDefinition.elements ?? {}),
  ]);
  const forceIssues = forceElementBreak.flatMap((name, index) =>
    knownElementNames.has(name)
      ? []
      : [
          {
            path: `forceElementBreak.${index}`,
            message: `forceElementBreak names unknown element "${name}"`,
          },
        ],
  );
  if (forceIssues.length > 0) return forceIssues;

  const forced = new Set(forceElementBreak);
  const breaking = breakingElementChanges(
    previousDefinition,
    previousRawDefinition,
    nextDefinition,
  ).filter(({ name }) => !forced.has(name));
  if (breaking.length === 0) return [];

  const breakingNames = new Set(breaking.map(({ name }) => name));
  const consumersByElement = new Map<string, string[]>();
  const unscannableByElement = new Map<string, string[]>();
  for (const name of breakingNames) {
    consumersByElement.set(name, []);
    unscannableByElement.set(name, []);
  }

  // Compatibility is intentionally a full definition scan on every write;
  // Phase 4 has no reverse ElementRef index yet. This scan shares no lock with
  // consumer writes, so a concurrent consumer-add can race a producer removal;
  // Phase 6's unresolved-reference error card is the fallback for that TOCTOU.
  const rows = getDb()
    .prepare<StoredAppDefinitionRow, [string]>(
      "SELECT id, name, definition FROM apps WHERE id != ? ORDER BY name, id",
    )
    .all(appId);
  for (const row of rows) {
    let raw: unknown;
    let parseable = false;
    try {
      raw = JSON.parse(row.definition);
      parseable = parseAppDefinition(upgradeAppDefinition(raw), {
        currentAppId: row.id,
        skipExternalTargetResolution: true,
      }).success;
    } catch {
      raw = row.definition;
    }

    const found = new Set<string>();
    if (typeof raw === "string") {
      for (const name of breakingNames) {
        if (raw.includes(appId) && raw.includes(`"element"`) && raw.includes(name)) {
          unscannableByElement.get(name)!.push(`"${row.name}" (${row.id})`);
        }
      }
      continue;
    }
    scanRawElementReferences(raw, appId, breakingNames, found);
    for (const name of found) {
      consumersByElement
        .get(name)!
        .push(`"${row.name}" (${row.id})${parseable ? "" : " [raw scan: invalid definition]"}`);
    }
  }

  const issues: AppValidationIssue[] = [];
  for (const change of breaking) {
    const consumers = consumersByElement.get(change.name)!;
    const unscannable = unscannableByElement.get(change.name)!;
    if (consumers.length === 0 && unscannable.length === 0) continue;
    const consumerText = consumers.length > 0 ? ` Referencing apps: ${consumers.join(", ")}.` : "";
    const unscannableText =
      unscannable.length > 0
        ? ` ${unscannable.length} app${unscannable.length === 1 ? " is" : "s are"} unscannable but may reference it: ${unscannable.join(", ")}.`
        : "";
    issues.push({
      path: `elements.${change.name}`,
      message: `breaking change to exported element "${change.name}" (${change.reasons.join("; ")}).${consumerText}${unscannableText} Publish the breaking contract under a new element name, or retry with forceElementBreak: ["${change.name}"] to accept broken consumers.`,
    });
  }
  return issues;
}

function ownColumn(model: ModelDef | undefined, columnName: string): ColumnDef | undefined {
  return model && Object.hasOwn(model.columns, columnName) ? model.columns[columnName] : undefined;
}

function isPurgeDirective(
  directive: AppMigrationDirective | undefined,
): directive is Extract<AppMigrationDirective, { purge: true }> {
  return directive !== undefined && "purge" in directive;
}

function columnAccepts(column: ColumnDef, value: unknown): boolean {
  if (value === null) return column.hidden === true || column.required !== true;
  if (column.kind === "string") return typeof value === "string";
  if (column.kind === "number") return typeof value === "number" && Number.isFinite(value);
  if (column.kind === "boolean") return typeof value === "boolean";
  if (column.kind === "date") return typeof value === "string" && isIso8601Date(value);
  return typeof value === "string" && Boolean(column.enum?.includes(value));
}

function coerceValue(
  value: unknown,
  oldColumn: ColumnDef | undefined,
  nextColumn: ColumnDef,
): unknown {
  if (columnAccepts(nextColumn, value)) return value;
  if (value === null || value === undefined) return undefined;
  if (nextColumn.kind === "string") {
    if (oldColumn?.kind === "number" && typeof value === "number") return String(value);
    if (oldColumn?.kind === "boolean" && typeof value === "boolean") return String(value);
    if (oldColumn?.kind === "date" && typeof value === "string") return value;
  }
  if (
    nextColumn.kind === "number" &&
    typeof value === "string" &&
    /^[+-]?\d+(?:\.\d+)?$/.test(value)
  ) {
    const converted = Number(value);
    if (Number.isFinite(converted)) return converted;
  }
  if (nextColumn.kind === "boolean" && typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  if (nextColumn.kind === "date" && typeof value === "string" && isIso8601Date(value)) {
    return value;
  }
  return undefined;
}

function valueLabel(value: unknown): string {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? String(value) : encoded;
}

function valueCounts(rows: AppRow[], columnName: string, column: ColumnDef): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!Object.hasOwn(row, columnName) || columnAccepts(column, row[columnName])) continue;
    const label = valueLabel(row[columnName]);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return summarizeCounts(
    counts,
    (value, count) => `${count} ${count === 1 ? "row holds" : "rows hold"} ${value}`,
  );
}

function validateDirectiveOrder(migration: AppMigration): AppValidationIssue[] {
  const issues: AppValidationIssue[] = [];
  for (const [columnName, directive] of Object.entries(migration)) {
    if (Object.hasOwn(SYSTEM_COLUMN_KINDS, columnName)) {
      issues.push({
        path: `migration.${columnName}`,
        message: `system field "${columnName}" cannot be migrated or purged`,
      });
      continue;
    }
    if (
      "from" in directive &&
      directive.from !== columnName &&
      Object.hasOwn(migration, directive.from)
    ) {
      issues.push({
        path: `migration.${columnName}.from`,
        message: `from chains are not supported: source column "${directive.from}" also has a migration directive`,
      });
    }
  }
  return issues;
}

function validateDirectiveValues(
  modelName: string,
  columnName: string,
  column: ColumnDef,
  directive: AppMigrationDirective,
): AppValidationIssue[] {
  const values: unknown[] = [];
  if ("set" in directive) values.push(directive.set);
  if ("map" in directive && directive.map) values.push(...Object.values(directive.map));
  if ("else" in directive && Object.hasOwn(directive, "else")) values.push(directive.else);
  return values.flatMap((value) =>
    columnAccepts(column, value)
      ? []
      : [
          {
            path: `migration.${columnName}`,
            message: `value ${valueLabel(value)} is not valid for models.${modelName}.columns.${columnName}`,
          },
        ],
  );
}

function changedColumnNames(
  oldModel: ModelDef | undefined,
  nextModel: ModelDef | undefined,
): Set<string> {
  const names = new Set([
    ...Object.keys(oldModel?.columns ?? {}),
    ...Object.keys(nextModel?.columns ?? {}),
  ]);
  return new Set(
    [...names].filter(
      (name) => !definitionsEqual(ownColumn(oldModel, name), ownColumn(nextModel, name)),
    ),
  );
}

function modelAt(definition: AppDefinition | undefined, modelName: string): ModelDef | undefined {
  return definition && Object.hasOwn(definition.models, modelName)
    ? definition.models[modelName]
    : undefined;
}

function affectedModelNames(
  previousDefinition: AppDefinition | undefined,
  nextDefinition: AppDefinition,
  migration: AppMigration,
): string[] {
  const modelNames = new Set([
    ...Object.keys(previousDefinition?.models ?? {}),
    ...Object.keys(nextDefinition.models),
  ]);
  if (previousDefinition === undefined) return [...modelNames].sort();
  return [...modelNames]
    .filter((modelName) => {
      const previousModel = modelAt(previousDefinition, modelName);
      const nextModel = modelAt(nextDefinition, modelName);
      if (!definitionsEqual(previousModel, nextModel)) return true;
      const changedColumns = changedColumnNames(previousModel, nextModel);
      return Object.entries(migration).some(([columnName, directive]) => {
        if (Object.hasOwn(SYSTEM_COLUMN_KINDS, columnName)) return false;
        const nextColumn = ownColumn(nextModel, columnName);
        if (!isPurgeDirective(directive)) return changedColumns.has(columnName);
        // A hidden target can be purged without changing its definition. A missing
        // target may be an orphan and therefore must be scanned to know applicability.
        return nextColumn?.hidden === true || nextColumn === undefined;
      });
    })
    .sort();
}

function applyDirective(
  rows: AppRow[],
  modelName: string,
  columnName: string,
  directive: AppMigrationDirective,
  oldColumn: ColumnDef | undefined,
  nextColumn: ColumnDef | undefined,
  oldModel: ModelDef | undefined,
  nextModel: ModelDef | undefined,
  report: AppMigrationReport,
  issues: AppValidationIssue[],
  path: string,
): void {
  if (isPurgeDirective(directive)) {
    for (const row of rows) {
      if (!Object.hasOwn(row, columnName)) continue;
      delete row[columnName];
      report.purgedValues += 1;
    }
    return;
  }
  if (!nextColumn) return;

  if ("set" in directive) {
    for (const row of rows) {
      row[columnName] = directive.set;
      report.backfilled += 1;
    }
    return;
  }

  if (
    "from" in directive &&
    !Object.hasOwn(oldModel?.columns ?? {}, directive.from) &&
    !Object.hasOwn(nextModel?.columns ?? {}, directive.from)
  ) {
    issues.push({
      path: `${path}.from`,
      message: `source column "${directive.from}" does not exist in models.${modelName}`,
    });
    return;
  }

  const unresolved = new Map<string, number>();
  const hasExplicitElse = "else" in directive && Object.hasOwn(directive, "else");
  for (const row of rows) {
    // A row that omits the column stays absent when the target permits absence.
    // When the target is (newly) required, fall through so the row fills from
    // `else` or lands in the unresolved report — never silently violates required.
    if (
      "coerce" in directive &&
      !Object.hasOwn(row, columnName) &&
      (nextColumn.hidden === true || nextColumn.required !== true)
    ) {
      continue;
    }
    let value: unknown;
    let resolved = false;
    if ("from" in directive) {
      const sourceValue = row[directive.from];
      if (directive.map && Object.hasOwn(directive.map, String(sourceValue))) {
        value = directive.map[String(sourceValue)];
        if (columnAccepts(nextColumn, value)) {
          resolved = true;
          report.mapped += 1;
        }
      } else if (!directive.map && sourceValue !== undefined) {
        value = sourceValue;
        if (columnAccepts(nextColumn, value)) {
          resolved = true;
          report.mapped += 1;
        }
      }
    } else {
      const sourceValue = row[columnName];
      const converted = coerceValue(sourceValue, oldColumn, nextColumn);
      if (converted !== undefined) {
        value = converted;
        resolved = true;
        if (!Object.is(converted, sourceValue)) report.coerced += 1;
      }
    }

    if (!resolved) {
      if (hasExplicitElse) {
        value = directive.else;
        resolved = true;
        report.elsed += 1;
      } else if (
        "from" in directive &&
        (nextColumn.hidden === true || nextColumn.required !== true)
      ) {
        if (Object.hasOwn(row, columnName)) delete row[columnName];
        continue;
      } else {
        const source = "from" in directive ? row[directive.from] : row[columnName];
        const label = valueLabel(source);
        unresolved.set(label, (unresolved.get(label) ?? 0) + 1);
        continue;
      }
    }

    if (!columnAccepts(nextColumn, value)) {
      const label = valueLabel(value);
      unresolved.set(label, (unresolved.get(label) ?? 0) + 1);
      continue;
    }
    if (value === null) delete row[columnName];
    else row[columnName] = value;
  }

  if (unresolved.size > 0) {
    const counts = summarizeCounts(
      unresolved,
      (value, count) => `${count} ${count === 1 ? "row" : "rows"} cannot migrate ${value}`,
    );
    issues.push({
      path,
      message: hasExplicitElse
        ? `${counts} — the provided else value ${valueLabel(directive.else)} is invalid for models.${modelName}.columns.${columnName}`
        : `${counts} in models.${modelName}.columns.${columnName} — provide an else value`,
    });
  }
}

function planModel(
  appId: string,
  modelName: string,
  oldModel: ModelDef | undefined,
  nextModel: ModelDef | undefined,
  migration: AppMigration,
  oldSideUnparseable: boolean,
  report: AppMigrationReport,
  orphanFields: Set<string>,
  appliedDirectives: Set<string>,
): ModelMigrationPlan & { issues: AppValidationIssue[] } {
  const persistedRows = listAllAppRowsForMigrationUnlocked(appId, modelName);
  const rows = persistedRows.map((row) => structuredClone(row));
  const issues: AppValidationIssue[] = [];
  const changedColumns = changedColumnNames(oldModel, nextModel);
  const rebuildColumns = new Set(changedColumns);
  report.scanned += rows.length;

  if (oldModel && !nextModel && rows.length > 0) {
    issues.push({
      path: `models.${modelName}`,
      message: `model holds ${rows.length} ${rows.length === 1 ? "row" : "rows"} — delete its rows before removing the model`,
    });
  }

  for (const columnName of changedColumns) {
    const oldColumn = ownColumn(oldModel, columnName);
    const nextColumn = ownColumn(nextModel, columnName);
    const directive = migration[columnName];
    const path = `models.${modelName}.columns.${columnName}`;

    const exactUnhide =
      oldColumn?.hidden === true &&
      nextColumn?.hidden !== true &&
      definitionsEqual({ ...oldColumn, hidden: undefined }, { ...nextColumn, hidden: undefined });
    if (
      oldColumn?.hidden === true &&
      nextColumn !== undefined &&
      nextColumn?.hidden !== true &&
      !exactUnhide
    ) {
      issues.push({
        path,
        message: `name is held by hidden column — unhide it exactly, or remove it with migration.${columnName} {purge:true}`,
      });
      continue;
    }

    if (!nextColumn) {
      const count = rows.filter((row) => Object.hasOwn(row, columnName)).length;
      if (count > 0 && !isPurgeDirective(directive)) {
        issues.push({
          path,
          message: `column holds values on ${count} ${count === 1 ? "row" : "rows"} — hide it, or purge explicitly with migration.${columnName}.purge`,
        });
      }
      continue;
    }

    if (exactUnhide && nextColumn.required === true && (!directive || !("set" in directive))) {
      const missing = rows.filter(
        (row) => !Object.hasOwn(row, columnName) || row[columnName] === null,
      ).length;
      if (missing > 0) {
        issues.push({
          path,
          message: `unhiding required column would leave ${missing} ${missing === 1 ? "row" : "rows"} without a value — provide migration.${columnName} {set: ...} or unhide without required`,
        });
        continue;
      }
    }

    const newlyRequired =
      nextColumn.hidden !== true &&
      nextColumn.required === true &&
      !exactUnhide &&
      (oldColumn === undefined || oldColumn.required !== true || oldColumn.hidden === true);
    if (!directive && newlyRequired && rows.length > 0) {
      const missing = rows.filter(
        (row) => !Object.hasOwn(row, columnName) || row[columnName] === null,
      ).length;
      if (missing === 0) {
        // Existing rows already satisfy the newly declared invariant.
      } else if (oldSideUnparseable) {
        issues.push({
          path,
          message: `required column is missing on ${missing} ${missing === 1 ? "row" : "rows"} while repairing an unparseable definition — provide migration.${columnName} {set: ...}; rows are never changed implicitly on this path`,
        });
      } else if (nextColumn.default !== undefined) {
        for (const row of rows) {
          if (Object.hasOwn(row, columnName) && row[columnName] !== null) continue;
          row[columnName] = nextColumn.default;
          report.backfilled += 1;
        }
      } else {
        issues.push({
          path,
          message: `required column is missing on ${missing} ${missing === 1 ? "row" : "rows"} — provide a migration set/from directive or a default`,
        });
      }
    }

    const compatibilityChanged =
      oldColumn !== undefined &&
      (oldColumn.kind !== nextColumn.kind ||
        (nextColumn.kind === "enum" &&
          !definitionsEqual(oldColumn.enum ?? [], nextColumn.enum ?? [])));
    if (!directive && compatibilityChanged) {
      const counts = valueCounts(rows, columnName, nextColumn);
      if (counts) {
        issues.push({
          path,
          message: `${counts} — provide migration.${columnName} with coerce/else or from/map`,
        });
      }
    }
  }

  for (const [columnName, directive] of Object.entries(migration)) {
    if (Object.hasOwn(SYSTEM_COLUMN_KINDS, columnName)) continue;
    const oldColumn = ownColumn(oldModel, columnName);
    const nextColumn = ownColumn(nextModel, columnName);
    const isOrphan =
      rows.some((row) => Object.hasOwn(row, columnName)) && !oldColumn && !nextColumn;
    const applies = isPurgeDirective(directive)
      ? nextColumn?.hidden === true ||
        (nextColumn === undefined && (changedColumns.has(columnName) || isOrphan))
      : changedColumns.has(columnName);
    if (!applies) continue;
    appliedDirectives.add(columnName);
    if (!isPurgeDirective(directive) && !nextColumn) {
      issues.push({
        path: `migration.${columnName}`,
        message: `target column "${columnName}" does not exist in models.${modelName} after the change`,
      });
      continue;
    }
    if (nextColumn) {
      issues.push(...validateDirectiveValues(modelName, columnName, nextColumn, directive));
    }
    applyDirective(
      rows,
      modelName,
      columnName,
      directive,
      oldColumn,
      nextColumn,
      oldModel,
      nextModel,
      report,
      issues,
      `migration.${columnName}`,
    );
    rebuildColumns.add(columnName);
  }

  if (nextModel) {
    for (const row of rows) {
      for (const field of Object.keys(row)) {
        if (Object.hasOwn(SYSTEM_COLUMN_KINDS, field) || Object.hasOwn(nextModel.columns, field)) {
          continue;
        }
        orphanFields.add(field);
      }
    }
  }

  const changedRows = rows.filter((row, index) => !definitionsEqual(row, persistedRows[index]));
  return {
    modelName,
    rows,
    changedRows,
    rebuildColumns: [...rebuildColumns].sort(),
    issues,
  };
}

function buildPlan(
  appId: string,
  previousDefinition: AppDefinition | undefined,
  previousRawDefinition: unknown,
  nextDefinition: AppDefinition,
  migration: AppMigration,
  forceElementBreak: string[],
): MigrationPlan {
  const issues = [
    ...validateDirectiveOrder(migration),
    ...exportedElementCompatibilityIssues(
      appId,
      previousDefinition,
      previousRawDefinition,
      nextDefinition,
      forceElementBreak,
    ),
  ];
  const report = structuredClone(EMPTY_REPORT);
  const userConfigNames = new Set([
    ...Object.keys(previousDefinition?.userConfig ?? {}),
    ...Object.keys(nextDefinition.userConfig ?? {}),
  ]);
  report.userConfigChanged = [...userConfigNames]
    .filter(
      (name) =>
        !definitionsEqual(
          previousDefinition?.userConfig?.[name],
          nextDefinition.userConfig?.[name],
        ),
    )
    .sort();
  const oldSideUnparseable = previousDefinition === undefined;
  const affected = affectedModelNames(previousDefinition, nextDefinition, migration);
  const orphanFields = new Set<string>();
  const appliedDirectives = new Set<string>();
  const models = affected.map((modelName) => {
    const previousModel = modelAt(previousDefinition, modelName);
    const nextModel = modelAt(nextDefinition, modelName);
    const plan = planModel(
      appId,
      modelName,
      previousModel,
      nextModel,
      migration,
      oldSideUnparseable,
      report,
      orphanFields,
      appliedDirectives,
    );
    issues.push(...plan.issues);
    report.idxRebuilt += plan.rebuildColumns.length;
    return plan;
  });
  for (const [columnName, directive] of Object.entries(migration)) {
    if (Object.hasOwn(SYSTEM_COLUMN_KINDS, columnName) || appliedDirectives.has(columnName)) {
      continue;
    }
    const exists = Object.values(nextDefinition.models).some(
      (model) => ownColumn(model, columnName) !== undefined,
    );
    issues.push({
      path: `migration.${columnName}`,
      message: isPurgeDirective(directive)
        ? `purge does not target a removed, hidden, or orphan field named "${columnName}"`
        : exists
          ? `directive does not target a changed column named "${columnName}"`
          : `target column "${columnName}" does not exist in the merged definition`,
    });
  }
  const sortedOrphans = [...orphanFields].sort();
  report.orphanFields = sortedOrphans.slice(
    0,
    sortedOrphans.length > MAX_ORPHAN_FIELDS ? MAX_ORPHAN_FIELDS - 1 : MAX_ORPHAN_FIELDS,
  );
  if (sortedOrphans.length > MAX_ORPHAN_FIELDS) {
    report.orphanFields.push(`…and ${sortedOrphans.length - (MAX_ORPHAN_FIELDS - 1)} more`);
  }
  return { issues, models, report };
}

// AppNameSchema requires a lowercase-letter prefix, so this can never collide
// with a real model lock key.
const APP_DEFINITION_LOCK_SENTINEL = "__definition__";

/**
 * Serializes an app definition's full read-modify-write sequence. This lock must
 * always be acquired before any model mutation lock. Row-write paths only take
 * model locks and never take this lock, so they cannot form a lock-order cycle.
 * Do not call this recursively for the same app.
 */
export function withAppDefinitionLock<T>(
  appId: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  return withMutationLock(appId, APP_DEFINITION_LOCK_SENTINEL, operation);
}

function withModelLocks<T>(
  appId: string,
  modelNames: string[],
  operation: () => T | Promise<T>,
): Promise<T> {
  const acquire = (index: number): Promise<T> => {
    if (index >= modelNames.length) return Promise.resolve(operation());
    return withMutationLock(appId, modelNames[index]!, () => acquire(index + 1));
  };
  return acquire(0);
}

/**
 * Caller must hold withAppDefinitionLock for the entire read/merge/parse call
 * that produced these definitions. Model locks are nested beneath that lock.
 * The snapshot and writeDefinition callbacks run while both lock levels are
 * held; they must not call withMutationLock or purgeAppRows for the same
 * app/model, which would self-deadlock.
 */
export async function migrateAppSchema<T>(input: {
  appId: string;
  previousDefinition?: AppDefinition;
  previousRawDefinition?: unknown;
  nextDefinition: AppDefinition;
  migration?: AppMigration;
  forceElementBreak?: string[];
  snapshot: () => void;
  writeDefinition: () => T;
}): Promise<{ result: T; migration: AppMigrationReport }> {
  const migration = input.migration ?? {};
  const modelNames = affectedModelNames(input.previousDefinition, input.nextDefinition, migration);
  return withModelLocks(input.appId, modelNames, () => {
    const plan = buildPlan(
      input.appId,
      input.previousDefinition,
      input.previousRawDefinition,
      input.nextDefinition,
      migration,
      input.forceElementBreak ?? [],
    );
    if (plan.issues.length > 0) throw new AppSchemaMigrationError(plan.issues);

    const transaction = getDb().transaction(() => {
      input.snapshot();
      for (const modelPlan of plan.models) {
        for (const row of modelPlan.changedRows) {
          writeAppRowForMigrationUnlocked(input.appId, modelPlan.modelName, row);
        }
        const nextModel = Object.hasOwn(input.nextDefinition.models, modelPlan.modelName)
          ? input.nextDefinition.models[modelPlan.modelName]
          : undefined;
        for (const columnName of modelPlan.rebuildColumns) {
          rebuildAppColumnIndexUnlocked(
            input.appId,
            modelPlan.modelName,
            columnName,
            ownColumn(nextModel, columnName),
            modelPlan.rows,
          );
        }
      }
      return input.writeDefinition();
    });
    return { result: transaction(), migration: plan.report };
  });
}
