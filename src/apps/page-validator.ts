import {
  type AppDefinition,
  type AppValidationIssue,
  isIso8601Date,
  SYSTEM_COLUMN_KINDS,
} from "./definition";

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  enum?: unknown[];
  const?: unknown;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
}

export interface AppCatalog {
  componentTypes: string[];
  actionTypes: string[];
  components: Record<string, { description: string; slots?: string[]; props: JsonSchema }>;
  actions: Record<string, { description: string; params: JsonSchema }>;
}

interface SchemaValidationResult {
  issues: AppValidationIssue[];
  stateRefs: StateRef[];
}

interface StateRef {
  path: string;
  value: string;
}

export const ELEMENT_KEYS = new Set([
  "type",
  "props",
  "children",
  "on",
  "visible",
  "repeat",
  "watch",
]);
const UI_STATE_COMPONENTS = new Set(["SearchInput", "Select", "Tabs"]);
const CONDITION_KEYS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "not"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isStateBinding(value: unknown): value is { $state: string } {
  return (
    isPlainObject(value) && Object.keys(value).length === 1 && typeof value.$state === "string"
  );
}

function isStateCondition(value: unknown): value is { $state: string } {
  return (
    isPlainObject(value) &&
    typeof value.$state === "string" &&
    Object.keys(value).some((key) => CONDITION_KEYS.has(key))
  );
}

function isParamBinding(value: unknown): value is { $param: string } {
  return (
    isPlainObject(value) && Object.keys(value).length === 1 && typeof value.$param === "string"
  );
}

function isRepeatBinding(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  if (keys[0] === "$item") return typeof value.$item === "string";
  return keys[0] === "$index" && value.$index === true;
}

function collectRepeatBindingPaths(value: unknown, path: string, paths: string[]): void {
  if (isRepeatBinding(value)) {
    paths.push(path);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      collectRepeatBindingPaths(child, appendPath(path, index), paths);
    }
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    collectRepeatBindingPaths(child, appendPath(path, key), paths);
  }
}

function isActionSentinel(value: unknown): boolean {
  if (!isPlainObject(value) || Object.keys(value).length !== 1) return false;
  if (typeof value.$row === "string") return true;
  if (value.$rowIndex === true) return true;
  return typeof value.$form === "string";
}

function appendPath(path: string, part: string | number): string {
  return path ? `${path}.${part}` : String(part);
}

function issue(path: string, message: string): AppValidationIssue {
  return { path, message };
}

function dedupeIssues(issues: AppValidationIssue[]): AppValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter(({ path, message }) => {
    const key = `${path}\0${message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    default:
      return true;
  }
}

function equalJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    (Array.isArray(left) && Array.isArray(right)) ||
    (isPlainObject(left) && isPlainObject(right))
  ) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
}

function validateSchema(
  value: unknown,
  schema: JsonSchema,
  path: string,
  allowActionSentinels: boolean,
  skipPath?: (path: string) => boolean,
): SchemaValidationResult {
  if (isStateBinding(value)) {
    return { issues: [], stateRefs: [{ path, value: value.$state }] };
  }

  if (isRepeatBinding(value)) return { issues: [], stateRefs: [] };

  if (isActionSentinel(value)) {
    return allowActionSentinels
      ? { issues: [], stateRefs: [] }
      : {
          issues: [
            issue(path, "$row, $rowIndex, and $form bindings are only allowed in action params"),
          ],
          stateRefs: [],
        };
  }

  if (schema.anyOf) {
    for (const candidate of schema.anyOf) {
      const result = validateSchema(value, candidate, path, allowActionSentinels);
      if (result.issues.length === 0) return result;
    }
    return { issues: [issue(path, "must match one of the allowed schemas")], stateRefs: [] };
  }

  if (schema.const !== undefined && !equalJsonValue(value, schema.const)) {
    return { issues: [issue(path, `must equal ${JSON.stringify(schema.const)}`)], stateRefs: [] };
  }
  if (schema.enum && !schema.enum.some((candidate) => equalJsonValue(value, candidate))) {
    return {
      issues: [issue(path, `must be one of ${schema.enum.map(String).join(", ")}`)],
      stateRefs: [],
    };
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 0 && !types.some((type) => typeMatches(value, type))) {
    return { issues: [issue(path, `must be ${types.join(" or ")}`)], stateRefs: [] };
  }

  const result: SchemaValidationResult = { issues: [], stateRefs: [] };
  if (isPlainObject(value)) {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        result.issues.push(issue(appendPath(path, required), "is required"));
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const childPath = appendPath(path, key);
      if (skipPath?.(childPath)) continue;
      const propertySchema = properties[key];
      if (propertySchema) {
        const childAllowsActionSentinels =
          allowActionSentinels ||
          (key === "params" &&
            Object.hasOwn(properties, "action") &&
            (schema.required ?? []).includes("action"));
        const childResult = validateSchema(
          child,
          propertySchema,
          childPath,
          childAllowsActionSentinels,
          skipPath,
        );
        result.issues.push(...childResult.issues);
        result.stateRefs.push(...childResult.stateRefs);
      } else if (schema.additionalProperties === false) {
        result.issues.push(issue(childPath, "unknown property"));
      } else if (isPlainObject(schema.additionalProperties)) {
        const childResult = validateSchema(
          child,
          schema.additionalProperties,
          childPath,
          allowActionSentinels,
          skipPath,
        );
        result.issues.push(...childResult.issues);
        result.stateRefs.push(...childResult.stateRefs);
      } else {
        const childResult = validateSchema(child, {}, childPath, allowActionSentinels, skipPath);
        result.issues.push(...childResult.issues);
        result.stateRefs.push(...childResult.stateRefs);
      }
    }
  } else if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const childResult = validateSchema(
        child,
        schema.items ?? {},
        appendPath(path, index),
        allowActionSentinels,
        skipPath,
      );
      result.issues.push(...childResult.issues);
      result.stateRefs.push(...childResult.stateRefs);
    }
  }
  return result;
}

function actionParams(
  step: Record<string, unknown>,
  path: string,
  definition: AppDefinition,
  catalog: AppCatalog,
  validateNavigation = false,
): SchemaValidationResult {
  const result: SchemaValidationResult = { issues: [], stateRefs: [] };
  if (typeof step.action !== "string") {
    result.issues.push(issue(appendPath(path, "action"), "must be a string"));
    return result;
  }

  if (validateNavigation) {
    if (step.action !== "app.navigate") return result;

    const paramsPath = appendPath(path, "params");
    const params = step.params ?? {};
    if (!isPlainObject(params)) return result;

    const targetPage = params.page;
    if (typeof targetPage !== "string") {
      if (isActionSentinel(targetPage) || isStateBinding(targetPage)) {
        result.issues.push(issue(appendPath(paramsPath, "page"), "must be a literal page name"));
      }
      return result;
    }

    const target = Object.hasOwn(definition.pages, targetPage)
      ? definition.pages[targetPage]
      : undefined;
    if (!target) {
      result.issues.push(issue(appendPath(paramsPath, "page"), `unknown page "${targetPage}"`));
      return result;
    }

    const suppliedParams =
      isPlainObject(params.params) &&
      !isActionSentinel(params.params) &&
      !isStateBinding(params.params)
        ? params.params
        : {};
    const declaredParams = target.params ?? {};
    for (const name of Object.keys(suppliedParams)) {
      if (!Object.hasOwn(declaredParams, name)) {
        result.issues.push(
          issue(
            appendPath(appendPath(paramsPath, "params"), name),
            `param "${name}" is not declared by target page "${targetPage}"`,
          ),
        );
      }
    }
    for (const [name, parameter] of Object.entries(declaredParams)) {
      if (parameter.required === true && !Object.hasOwn(suppliedParams, name)) {
        result.issues.push(
          issue(
            appendPath(appendPath(paramsPath, "params"), name),
            `required param "${name}" is missing for target page "${targetPage}"`,
          ),
        );
      }
    }
    return result;
  }

  const actionDefinition = catalog.actions[step.action];
  if (!catalog.actionTypes.includes(step.action) || !actionDefinition) {
    result.issues.push(issue(appendPath(path, "action"), `unknown action type "${step.action}"`));
    return result;
  }

  const paramsPath = appendPath(path, "params");
  const params = step.params ?? {};
  const schemaResult = validateSchema(params, actionDefinition.params, paramsPath, true);
  result.issues.push(...schemaResult.issues);
  result.stateRefs.push(...schemaResult.stateRefs);
  if (!isPlainObject(params)) return result;

  if (step.action === "app.mutate") {
    const model = params.model;
    if (typeof model !== "string" || !Object.hasOwn(definition.models, model)) {
      result.issues.push(
        issue(appendPath(paramsPath, "model"), `unknown model "${String(model)}"`),
      );
      return result;
    }

    const op = params.op;
    if (op !== "create" && op !== "update" && op !== "delete") {
      result.issues.push(issue(appendPath(paramsPath, "op"), "must be create, update, or delete"));
    }
    if (op === "update" || op === "delete") {
      const rowId = params.rowId;
      const validRowId =
        typeof rowId === "string" ||
        (isPlainObject(rowId) && typeof rowId.$row === "string" && Object.keys(rowId).length === 1);
      if (!validRowId) {
        result.issues.push(
          issue(
            appendPath(paramsPath, "rowId"),
            "is required for update and delete and must be a string or $row binding",
          ),
        );
      }
    }

    if (
      isPlainObject(params.values) &&
      !isActionSentinel(params.values) &&
      !isStateBinding(params.values)
    ) {
      for (const column of Object.keys(params.values)) {
        const columnDefinition = definition.models[model]!.columns[column];
        if (!columnDefinition || columnDefinition.hidden === true) {
          result.issues.push(
            issue(
              appendPath(appendPath(paramsPath, "values"), column),
              `unknown or hidden column "${column}"`,
            ),
          );
        }
      }
    }
  } else if (step.action === "app.refresh") {
    if (
      typeof params.query === "string" &&
      !Object.hasOwn(definition.queries ?? {}, params.query)
    ) {
      result.issues.push(issue(appendPath(paramsPath, "query"), `unknown query "${params.query}"`));
    }
  } else if (step.action === "app.action") {
    if (typeof params.name !== "string" || !Object.hasOwn(definition.actions ?? {}, params.name)) {
      result.issues.push(
        issue(appendPath(paramsPath, "name"), `unknown app action "${String(params.name)}"`),
      );
    }
  }

  return result;
}

function validateActionChain(
  chain: unknown,
  path: string,
  definition: AppDefinition,
  catalog: AppCatalog,
): SchemaValidationResult {
  const result: SchemaValidationResult = { issues: [], stateRefs: [] };
  if (!Array.isArray(chain)) {
    result.issues.push(issue(path, "must be an action array"));
    return result;
  }
  for (const [index, step] of chain.entries()) {
    const stepPath = appendPath(path, index);
    if (!isPlainObject(step)) {
      result.issues.push(issue(stepPath, "must be an action object"));
      continue;
    }
    const stepResult = actionParams(step, stepPath, definition, catalog);
    result.issues.push(...stepResult.issues);
    result.stateRefs.push(...stepResult.stateRefs);
  }
  return result;
}

function validateActionMap(
  value: unknown,
  path: string,
  definition: AppDefinition,
  catalog: AppCatalog,
  allowSingle: boolean,
): SchemaValidationResult {
  const result: SchemaValidationResult = { issues: [], stateRefs: [] };
  if (!isPlainObject(value)) {
    result.issues.push(issue(path, "must be an object of action chains"));
    return result;
  }
  for (const [event, chain] of Object.entries(value)) {
    const eventPath = appendPath(path, event);
    const normalized = allowSingle && isPlainObject(chain) ? [chain] : chain;
    const chainResult = validateActionChain(normalized, eventPath, definition, catalog);
    result.issues.push(...chainResult.issues);
    result.stateRefs.push(...chainResult.stateRefs);
  }
  return result;
}

function validateStateRef(
  ref: StateRef,
  definition: AppDefinition,
  formIds: Set<string>,
  uiIds: Set<string>,
  pageParams: Record<string, unknown>,
): AppValidationIssue | null {
  if (ref.value === "/route/page") return null;
  const routeParam = /^\/route\/params\/([^/]+)$/.exec(ref.value);
  if (routeParam) {
    const name = routeParam[1]!;
    return Object.hasOwn(pageParams, name)
      ? null
      : issue(ref.path, `state reference targets unknown route param "${name}"`);
  }

  const userConfigMatch = /^\/user\/([^/]+)(\/.*)?$/.exec(ref.value);
  if (userConfigMatch) {
    const [, name, suffix] = userConfigMatch;
    if (suffix) {
      return issue(
        ref.path,
        `userConfig state reference "${ref.value}" must target exactly /user/<field>; nested paths are not supported`,
      );
    }
    if (Object.hasOwn(definition.userConfig ?? {}, name!)) return null;
    const declared = Object.keys(definition.userConfig ?? {}).sort();
    return issue(
      ref.path,
      `state reference targets unknown userConfig field "${name}"; declared fields: ${declared.length > 0 ? declared.join(", ") : "none"}`,
    );
  }

  const match = /^\/(queries|forms|actions|ui)\/([^/]+)(?:\/.*)?$/.exec(ref.value);
  if (!match) return issue(ref.path, `invalid state reference "${ref.value}"`);

  const [, namespace, name] = match;
  const exists =
    (namespace === "queries" && Object.hasOwn(definition.queries ?? {}, name!)) ||
    (namespace === "forms" && formIds.has(name!)) ||
    (namespace === "actions" && Object.hasOwn(definition.actions ?? {}, name!)) ||
    (namespace === "ui" && uiIds.has(name!));
  const targetKind =
    namespace === "queries"
      ? "query"
      : namespace === "forms"
        ? "form"
        : namespace === "actions"
          ? "action"
          : "UI control";
  if (!exists) return issue(ref.path, `state reference targets unknown ${targetKind} "${name}"`);

  if (namespace === "queries") {
    const dataMatch = /^\/queries\/[^/]+\/data(?:\/(.*))?$/.exec(ref.value);
    const segments = dataMatch?.[1]?.split("/").filter(Boolean) ?? [];
    if (/^\d+$/.test(segments[0] ?? "")) segments.shift();
    const columnName = segments[0];
    const query = definition.queries?.[name!];
    if (columnName && query && Object.hasOwn(definition.models, query.model)) {
      return fieldBindingIssue(query.model, definition.models[query.model]!, columnName, ref.path);
    }
  }

  return null;
}

const COMPARISON_KEYS = ["eq", "neq", "gt", "gte", "lt", "lte"] as const;

/**
 * Shape-check a `visible` value against what the renderer actually evaluates:
 * a boolean, a `{ $state }` binding, a `{ $state, <one comparison>, not?: true }`
 * condition, or `$and` / `$or` arrays of those. Anything else — notably the
 * plausible-looking wrapper `{"not": {"$state": …}}` — is silently ignored at
 * runtime (the element just stays visible), so the write must fail loudly
 * instead.
 */
function visibleConditionIssues(value: unknown, path: string): AppValidationIssue[] {
  if (typeof value === "boolean") return [];
  if (!isPlainObject(value)) {
    return [issue(path, "visible must be a boolean, a { $state } binding, or a condition object")];
  }
  for (const logical of ["$and", "$or"] as const) {
    if (!Object.hasOwn(value, logical)) continue;
    const children = value[logical];
    if (!Array.isArray(children)) {
      return [issue(appendPath(path, logical), "must be an array of conditions")];
    }
    return children.flatMap((child, index) =>
      visibleConditionIssues(child, appendPath(appendPath(path, logical), index)),
    );
  }
  if (typeof value.$state !== "string") {
    return [
      issue(
        path,
        'a visible condition must bind "$state" (or combine conditions with "$and"/"$or") — a wrapper like {"not": {…}} is not evaluated by the renderer',
      ),
    ];
  }
  const found: AppValidationIssue[] = [];
  const comparisons = COMPARISON_KEYS.filter((key) => value[key] !== undefined);
  if (comparisons.length > 1) {
    found.push(
      issue(
        path,
        `use exactly one comparison key per condition (found ${comparisons.join(", ")}); combine conditions with "$and"/"$or"`,
      ),
    );
  }
  if (Object.hasOwn(value, "not") && value.not !== true) {
    found.push(
      issue(
        appendPath(path, "not"),
        '"not" is a negation flag and must be exactly true (e.g. { "$state": "/queries/q/data/0/id", "not": true } shows the element when the value is absent/falsy)',
      ),
    );
  }
  return found;
}

function collectStateRefs(value: unknown, path: string, refs: StateRef[]): void {
  if (isStateBinding(value) || isStateCondition(value)) {
    refs.push({ path, value: value.$state });
  }
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      collectStateRefs(child, appendPath(path, index), refs);
    }
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key !== "$state") collectStateRefs(child, appendPath(path, key), refs);
  }
}

function queryModelFromDataBinding(
  definition: AppDefinition,
  value: unknown,
): { modelName: string; model: AppDefinition["models"][string] } | null {
  if (!isStateBinding(value)) return null;
  const match = /^\/queries\/([^/]+)\/data(?:\/\d+)?$/.exec(value.$state);
  if (!match) return null;
  const queryName = match[1]!;
  const query = Object.hasOwn(definition.queries ?? {}, queryName)
    ? definition.queries?.[queryName]
    : undefined;
  if (!query || !Object.hasOwn(definition.models, query.model)) return null;
  return { modelName: query.model, model: definition.models[query.model]! };
}

function fieldBindingIssue(
  modelName: string,
  model: AppDefinition["models"][string],
  columnName: string,
  path: string,
  allowSystemField = true,
): AppValidationIssue | null {
  if (columnName === "") return null;
  const column = Object.hasOwn(model.columns, columnName) ? model.columns[columnName] : undefined;
  if (column && column.hidden !== true) return null;
  // System fields are queryable and renderable even though they are not declared columns.
  if (allowSystemField && Object.hasOwn(SYSTEM_COLUMN_KINDS, columnName)) return null;
  return issue(path, `unknown or hidden column "${columnName}" on model "${modelName}"`);
}

function collectRowFieldIssues(
  value: unknown,
  path: string,
  modelName: string,
  model: AppDefinition["models"][string],
  issues: AppValidationIssue[],
): void {
  if (isPlainObject(value) && typeof value.$row === "string") {
    const found = fieldBindingIssue(modelName, model, value.$row, appendPath(path, "$row"));
    if (found) issues.push(found);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      collectRowFieldIssues(child, appendPath(path, index), modelName, model, issues);
    }
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    collectRowFieldIssues(child, appendPath(path, key), modelName, model, issues);
  }
}

function literalMutateModel(
  definition: AppDefinition,
  chain: unknown,
): { modelName: string; model: AppDefinition["models"][string] } | null {
  if (!Array.isArray(chain)) return null;
  const names = new Set<string>();
  for (const step of chain) {
    if (
      isPlainObject(step) &&
      step.action === "app.mutate" &&
      isPlainObject(step.params) &&
      typeof step.params.model === "string"
    ) {
      names.add(step.params.model);
    }
  }
  if (names.size !== 1) return null;
  const modelName = [...names][0]!;
  return Object.hasOwn(definition.models, modelName)
    ? { modelName, model: definition.models[modelName]! }
    : null;
}

function visitActionChain(
  chain: unknown,
  path: string,
  visit: (step: Record<string, unknown>, path: string) => void,
  allowSingle: boolean,
): void {
  const normalized = allowSingle && isPlainObject(chain) ? [chain] : chain;
  if (!Array.isArray(normalized)) return;
  for (const [index, step] of normalized.entries()) {
    if (isPlainObject(step)) visit(step, appendPath(path, index));
  }
}

function visitPageActionSteps(
  page: ElementTree,
  pagePath: string,
  visit: (step: Record<string, unknown>, path: string) => void,
): void {
  if (!isPlainObject(page.elements)) return;
  for (const [elementId, rawElement] of Object.entries(page.elements)) {
    if (!isPlainObject(rawElement)) continue;
    const elementPath = `${pagePath}.elements.${elementId}`;

    for (const key of ["on", "watch"] as const) {
      const actionMap = rawElement[key];
      if (!isPlainObject(actionMap)) continue;
      for (const [event, chain] of Object.entries(actionMap)) {
        visitActionChain(chain, `${elementPath}.${key}.${event}`, visit, true);
      }
    }

    if (!isPlainObject(rawElement.props)) continue;
    if (rawElement.type === "Table" && Array.isArray(rawElement.props.rowActions)) {
      for (const [index, rowAction] of rawElement.props.rowActions.entries()) {
        if (!isPlainObject(rowAction)) continue;
        visitActionChain(
          rowAction.actions,
          `${elementPath}.props.rowActions.${index}.actions`,
          visit,
          false,
        );
      }
    }
    if (rawElement.type === "Form") {
      visitActionChain(rawElement.props.onSubmit, `${elementPath}.props.onSubmit`, visit, false);
    }
  }
}

export function crossPageDefinitionIssues(
  definition: AppDefinition,
  catalog: AppCatalog,
): AppValidationIssue[] {
  const issues: AppValidationIssue[] = [];

  if (!Object.hasOwn(definition.pages, definition.defaultPage)) {
    issues.push(issue("defaultPage", `default page "${definition.defaultPage}" not found`));
  }

  for (const [pageName, page] of Object.entries(definition.pages)) {
    const pagePath = appendPath("pages", pageName);
    const declaredParams = page.params ?? {};

    visitPageActionSteps(page, pagePath, (step, path) => {
      const result = actionParams(step, path, definition, catalog, true);
      issues.push(...result.issues);
    });

    if (!isPlainObject(page.elements)) continue;
    for (const [elementId, rawElement] of Object.entries(page.elements)) {
      if (!isPlainObject(rawElement)) continue;
      const elementPath = `${pagePath}.elements.${elementId}`;
      if (rawElement.type === "Drawer" && isPlainObject(rawElement.props)) {
        const paramPath = `${elementPath}.props.param`;
        if (
          Object.hasOwn(rawElement.props, "param") &&
          typeof rawElement.props.param !== "string"
        ) {
          issues.push(
            issue(paramPath, "Drawer param must be a literal route param name (not a binding)"),
          );
        } else if (
          typeof rawElement.props.param === "string" &&
          !Object.hasOwn(declaredParams, rawElement.props.param)
        ) {
          issues.push(
            issue(
              paramPath,
              `param "${rawElement.props.param}" is not declared on page "${pageName}"`,
            ),
          );
        }
      }
    }

    const refs: StateRef[] = [];
    collectStateRefs(page, pagePath, refs);
    for (const ref of refs) {
      const queryMatch = /^\/queries\/([^/]+)(?:\/.*)?$/.exec(ref.value);
      if (!queryMatch) continue;
      const queryName = queryMatch[1]!;
      const query = definition.queries?.[queryName];
      if (!query) continue;
      for (const value of Object.values(query.filter ?? {})) {
        if (!isParamBinding(value) || Object.hasOwn(declaredParams, value.$param)) continue;
        issues.push(
          issue(ref.path, `query "${queryName}" requires undeclared page param "${value.$param}"`),
        );
      }
    }
  }

  return dedupeIssues(issues);
}

export interface ElementReferenceTarget {
  id: string;
  name?: string;
  definition: AppDefinition;
  definitionError?: AppValidationIssue[];
}

export interface ElementReferenceContext {
  currentAppId?: string;
  resolveApp?: (
    appId: string,
  ) => ElementReferenceTarget | null | Promise<ElementReferenceTarget | null>;
  /** Internal compatibility-scan mode: validate everything except unresolved external targets. */
  skipExternalTargetResolution?: boolean;
}

interface ElementRefNode {
  path: string;
  node: Record<string, unknown>;
}

interface ElementTree {
  root: string;
  elements: Record<string, unknown>;
}

const MAX_ELEMENT_REF_DEPTH = 5;
const MAX_ELEMENT_REF_EXPANSION_WORK = 100;
const MAX_ELEMENT_REF_EXPANSION_ISSUES = 100;

function collectElementRefs(
  elements: Record<string, unknown>,
  elementsPath: string,
): ElementRefNode[] {
  const refs: ElementRefNode[] = [];
  for (const [elementId, rawElement] of Object.entries(elements)) {
    if (!isPlainObject(rawElement) || rawElement.type !== "ElementRef") continue;
    refs.push({ path: appendPath(elementsPath, elementId), node: rawElement });
  }
  return refs;
}

function reusableElementHasSlot(element: NonNullable<AppDefinition["elements"]>[string]): boolean {
  return Object.values(element.elements).some(
    (node) => isPlainObject(node) && node.type === "ElementSlot",
  );
}

function isElementPropBinding(value: unknown): boolean {
  return isStateBinding(value) || isRepeatBinding(value);
}

function elementPropAccepts(
  prop: NonNullable<NonNullable<AppDefinition["elements"]>[string]["props"]>[string],
  value: unknown,
): boolean {
  if (isElementPropBinding(value)) return true;
  if (prop.kind === "string") return typeof value === "string";
  if (prop.kind === "enum") {
    return typeof value === "string" && Boolean(prop.enum?.includes(value));
  }
  if (prop.kind === "number") return typeof value === "number" && Number.isFinite(value);
  if (prop.kind === "boolean") return typeof value === "boolean";
  return typeof value === "string" && isIso8601Date(value);
}

async function elementReferenceIssues(
  definition: AppDefinition,
  context: ElementReferenceContext,
): Promise<AppValidationIssue[]> {
  const issues: AppValidationIssue[] = [];
  const rootAppId = context.currentAppId ?? "$self";
  const cleanTargetDepths = new Map<string, number>();
  let expansionWork = 0;
  let expansionIssueCount = 0;
  let expansionStopped = false;

  const stopExpansion = (path: string): void => {
    if (expansionStopped) return;
    expansionStopped = true;
    issues.push(
      issue(path, "element reference expansion exceeded budget — simplify the reference graph"),
    );
  };

  const pushExpansionIssue = (found: AppValidationIssue): void => {
    if (expansionStopped) return;
    if (expansionIssueCount >= MAX_ELEMENT_REF_EXPANSION_ISSUES) {
      stopExpansion(found.path);
      return;
    }
    expansionIssueCount += 1;
    issues.push(found);
  };

  const consumeExpansionWork = (path: string): boolean => {
    if (expansionStopped) return false;
    if (expansionWork >= MAX_ELEMENT_REF_EXPANSION_WORK) {
      stopExpansion(path);
      return false;
    }
    expansionWork += 1;
    return true;
  };

  type ResolvedTargetApp = {
    appId: string;
    name?: string;
    definition: AppDefinition;
    unparseable?: boolean;
  };
  const resolvedApps = new Map<string, ResolvedTargetApp | null>();

  const resolveTarget = async (appId: string): Promise<ResolvedTargetApp | null> => {
    if (appId === rootAppId) return { appId, definition };
    if (resolvedApps.has(appId)) return resolvedApps.get(appId)!;
    const resolved = await context.resolveApp?.(appId);
    const target = resolved
      ? {
          appId,
          name: resolved.name,
          definition: resolved.definition,
          unparseable: resolved.definitionError !== undefined,
        }
      : null;
    resolvedApps.set(appId, target);
    return target;
  };

  const describeTargetApp = (target: ResolvedTargetApp): string =>
    target.appId === rootAppId && !target.name
      ? "this app"
      : `app "${target.name ?? target.appId}"`;

  const validateReference = async (
    ref: ElementRefNode,
    ownerDefinition: AppDefinition,
    ownerAppId: string,
    depth: number,
    stack: Set<string>,
  ): Promise<boolean> => {
    if (expansionStopped) return false;
    if (!isPlainObject(ref.node.props)) return false;
    let referenceClean = true;
    const elementName = ref.node.props.element;
    if (typeof elementName !== "string") {
      pushExpansionIssue(
        issue(
          appendPath(ref.path, "props.element"),
          "element and app must be literal strings — dynamic references are not supported",
        ),
      );
      return false;
    }
    const explicitAppId = ref.node.props.app;
    if (explicitAppId !== undefined && typeof explicitAppId !== "string") {
      pushExpansionIssue(
        issue(
          appendPath(ref.path, "props.app"),
          "element and app must be literal strings — dynamic references are not supported",
        ),
      );
      return false;
    }
    const targetAppId = explicitAppId ?? ownerAppId;
    if (depth > MAX_ELEMENT_REF_DEPTH) {
      pushExpansionIssue(
        issue(
          appendPath(ref.path, "props.element"),
          `element reference expansion exceeds the maximum depth of ${MAX_ELEMENT_REF_DEPTH}`,
        ),
      );
      return false;
    }

    const targetApp =
      targetAppId === ownerAppId
        ? { appId: ownerAppId, definition: ownerDefinition }
        : await resolveTarget(targetAppId);
    if (!targetApp) {
      if (context.skipExternalTargetResolution && targetAppId !== ownerAppId) return true;
      pushExpansionIssue(
        issue(appendPath(ref.path, "props.app"), `referenced app "${targetAppId}" not found`),
      );
      return false;
    }
    if (targetApp.unparseable) {
      pushExpansionIssue(
        issue(
          appendPath(ref.path, "props.app"),
          `referenced app "${targetApp.name ?? targetAppId}" has an invalid definition and cannot supply elements`,
        ),
      );
      return false;
    }

    const target = targetApp.definition.elements?.[elementName];
    if (!target) {
      const targetLocation = targetAppId === rootAppId ? "" : ` in ${describeTargetApp(targetApp)}`;
      pushExpansionIssue(
        issue(
          appendPath(ref.path, "props.element"),
          `element "${elementName}" not found${targetLocation}`,
        ),
      );
      return false;
    }
    if (targetAppId !== ownerAppId && target.export !== true) {
      referenceClean = false;
      pushExpansionIssue(
        issue(
          appendPath(ref.path, "props.element"),
          `element "${elementName}" in ${describeTargetApp(targetApp)} is private; set export: true before referencing it from another app`,
        ),
      );
    }

    const suppliedProps = isPlainObject(ref.node.props.props) ? ref.node.props.props : {};
    const declaredProps = target.props ?? {};
    for (const propName of Object.keys(suppliedProps)) {
      const declared = declaredProps[propName];
      if (!declared) {
        referenceClean = false;
        pushExpansionIssue(
          issue(
            `${ref.path}.props.props.${propName}`,
            `prop "${propName}" is not declared by element "${elementName}"`,
          ),
        );
      } else if (!elementPropAccepts(declared, suppliedProps[propName])) {
        referenceClean = false;
        pushExpansionIssue(
          issue(
            `${ref.path}.props.props.${propName}`,
            `prop "${propName}" must be a ${declared.kind} value or a binding`,
          ),
        );
      }
    }
    for (const [propName, declared] of Object.entries(declaredProps)) {
      if (
        declared.required === true &&
        declared.default === undefined &&
        !Object.hasOwn(suppliedProps, propName)
      ) {
        referenceClean = false;
        pushExpansionIssue(
          issue(
            `${ref.path}.props.props.${propName}`,
            `required prop "${propName}" is missing for element "${elementName}"`,
          ),
        );
      }
    }

    if (
      Array.isArray(ref.node.children) &&
      ref.node.children.length > 0 &&
      !reusableElementHasSlot(target)
    ) {
      referenceClean = false;
      pushExpansionIssue(
        issue(
          appendPath(ref.path, "children"),
          `element "${elementName}" has no ElementSlot and cannot accept children`,
        ),
      );
    }

    const targetKey = `${targetAppId}\0${elementName}`;
    if (stack.has(targetKey)) {
      const targetLocation = targetAppId === rootAppId ? "" : ` in ${describeTargetApp(targetApp)}`;
      pushExpansionIssue(
        issue(
          appendPath(ref.path, "props.element"),
          `recursive element reference cycle reaches "${elementName}"${targetLocation}`,
        ),
      );
      return false;
    }
    const cleanAtDepth = cleanTargetDepths.get(targetKey);
    if (cleanAtDepth !== undefined && depth <= cleanAtDepth) return referenceClean;
    if (!consumeExpansionWork(appendPath(ref.path, "props.element"))) return false;

    const nextStack = new Set(stack).add(targetKey);
    let targetClean = true;
    for (const nested of collectElementRefs(
      target.elements,
      `${ref.path}.target.${elementName}.elements`,
    )) {
      if (
        !(await validateReference(nested, targetApp.definition, targetAppId, depth + 1, nextStack))
      ) {
        targetClean = false;
      }
      if (expansionStopped) break;
    }
    if (targetClean && !expansionStopped) {
      cleanTargetDepths.set(targetKey, Math.max(cleanAtDepth ?? 0, depth));
    }
    return referenceClean && targetClean;
  };

  for (const [pageName, page] of Object.entries(definition.pages)) {
    if (expansionStopped) break;
    for (const ref of collectElementRefs(page.elements, `pages.${pageName}.elements`)) {
      await validateReference(ref, definition, rootAppId, 1, new Set());
      if (expansionStopped) break;
    }
  }
  for (const [elementName, element] of Object.entries(definition.elements ?? {})) {
    if (expansionStopped) break;
    const stack = new Set([`${rootAppId}\0${elementName}`]);
    for (const ref of collectElementRefs(element.elements, `elements.${elementName}.elements`)) {
      await validateReference(ref, definition, rootAppId, 1, stack);
      if (expansionStopped) break;
    }
  }
  return issues;
}

export async function elementDefinitionIssues(
  definition: AppDefinition,
  catalog: AppCatalog,
  context: ElementReferenceContext = {},
): Promise<AppValidationIssue[]> {
  const issues: AppValidationIssue[] = [];
  for (const [elementName, element] of Object.entries(definition.elements ?? {})) {
    const elementPath = `elements.${elementName}`;
    issues.push(
      ...validatePage(definition, catalog, {
        tree: element,
        path: elementPath,
        elementMode: element.mode,
        elementProps: element.props,
      }),
    );

    const slots = Object.entries(element.elements).filter(
      ([, node]) => isPlainObject(node) && node.type === "ElementSlot",
    );
    if (element.mode === "pure" && slots.length > 1) {
      for (const [slotId] of slots.slice(1)) {
        issues.push(
          issue(
            `${elementPath}.elements.${slotId}`,
            "pure elements may contain at most one ElementSlot",
          ),
        );
      }
    }

    visitPageActionSteps(element, elementPath, (step, path) => {
      const navigation = actionParams(step, path, definition, catalog, true);
      issues.push(...navigation.issues);
      if (element.mode === "pure") {
        issues.push(
          issue(
            appendPath(path, "action"),
            "pure elements cannot invoke actions — use a bound element",
          ),
        );
      } else if (element.export === true && step.action === "app.navigate") {
        issues.push(
          issue(
            appendPath(path, "action"),
            "exported bound elements cannot use app.navigate; keep navigation in the consuming app or make the element private",
          ),
        );
      }
    });
  }
  for (const referenceIssue of await elementReferenceIssues(definition, context)) {
    issues.push(referenceIssue);
  }
  return dedupeIssues(issues);
}

interface ElementTreeValidationTarget {
  tree: ElementTree;
  path: string;
  elementMode: "pure" | "bound";
  elementProps?: Record<string, unknown>;
}

export function validatePage(
  definition: AppDefinition,
  catalog: AppCatalog,
  target: string | ElementTreeValidationTarget,
): AppValidationIssue[] {
  const issues: AppValidationIssue[] = [];
  const stateRefs: StateRef[] = [];
  const formIds = new Set<string>();
  const uiIds = new Set<string>();
  const pageName = typeof target === "string" ? target : undefined;
  const options = typeof target === "string" ? undefined : target;
  const page = options?.tree ?? definition.pages[pageName!]!;
  const pagePath = options?.path ?? appendPath("pages", pageName!);
  const pageParams = pageName ? (definition.pages[pageName]?.params ?? {}) : {};
  const elementsPath = appendPath(pagePath, "elements");
  const root = page.root;
  const elements = page.elements;

  if (typeof root !== "string")
    issues.push(issue(appendPath(pagePath, "root"), "must be a string"));
  if (!isPlainObject(elements)) {
    issues.push(issue(elementsPath, "must be a non-empty object"));
    return issues;
  }
  const elementEntries = Object.entries(elements);
  if (elementEntries.length === 0) {
    issues.push(issue(elementsPath, "must be a non-empty object"));
    return issues;
  }
  if (typeof root === "string" && !Object.hasOwn(elements, root)) {
    issues.push(issue(appendPath(pagePath, "root"), `root element "${root}" not found`));
  }

  for (const [elementId, rawElement] of elementEntries) {
    const elementPath = appendPath(elementsPath, elementId);
    if (!isPlainObject(rawElement)) {
      issues.push(issue(elementPath, "must be an element object"));
      continue;
    }
    for (const key of Object.keys(rawElement)) {
      if (!ELEMENT_KEYS.has(key))
        issues.push(issue(appendPath(elementPath, key), "unknown element key"));
    }

    const type = rawElement.type;
    const component = typeof type === "string" ? catalog.components[type] : undefined;
    if (typeof type !== "string") {
      issues.push(issue(appendPath(elementPath, "type"), "must be a string"));
    } else if (!catalog.componentTypes.includes(type) || !component) {
      issues.push(issue(appendPath(elementPath, "type"), `unknown component type "${type}"`));
    }

    if (type === "ElementSlot") {
      if (options?.elementMode !== "pure") {
        issues.push(
          issue(
            appendPath(elementPath, "type"),
            "ElementSlot is only allowed inside a pure reusable element",
          ),
        );
      }
      if (
        Object.hasOwn(rawElement, "children") &&
        (!Array.isArray(rawElement.children) || rawElement.children.length > 0)
      ) {
        issues.push(issue(appendPath(elementPath, "children"), "ElementSlot must be a leaf"));
      }
    }

    if (component) {
      const propsPath = appendPath(elementPath, "props");
      const actionChainPath = (path: string): boolean =>
        (type === "Form" && path === `${propsPath}.onSubmit`) ||
        (type === "Table" && /^.+\.rowActions\.\d+\.actions$/.test(path));
      const propsResult = validateSchema(
        Object.hasOwn(rawElement, "props") ? rawElement.props : {},
        component.props,
        propsPath,
        false,
        actionChainPath,
      );
      issues.push(...propsResult.issues);
      stateRefs.push(...propsResult.stateRefs);
      if (
        type === "Form" &&
        isPlainObject(rawElement.props) &&
        typeof rawElement.props.id === "string"
      ) {
        formIds.add(rawElement.props.id);
      }
      if (
        typeof type === "string" &&
        UI_STATE_COMPONENTS.has(type) &&
        isPlainObject(rawElement.props) &&
        typeof rawElement.props.id === "string"
      ) {
        uiIds.add(rawElement.props.id);
      }
    } else if (!Object.hasOwn(rawElement, "props")) {
      issues.push(issue(appendPath(elementPath, "props"), "is required"));
    }

    if (isPlainObject(rawElement.props)) {
      // `busyWith` names a custom action whose `/actions/<name>/status` slot
      // drives the busy affordance — a typo'd name silently watches a slot
      // nothing writes (button never disables, duplicate invocations), so
      // cross-check it like `app.action` names.
      if (
        typeof rawElement.props.busyWith === "string" &&
        !Object.hasOwn(definition.actions ?? {}, rawElement.props.busyWith)
      ) {
        issues.push(
          issue(
            `${elementPath}.props.busyWith`,
            `unknown app action "${rawElement.props.busyWith}"`,
          ),
        );
      }
      if (type === "Table") {
        const queryModel = queryModelFromDataBinding(definition, rawElement.props.data);
        if (queryModel) {
          if (Array.isArray(rawElement.props.columns)) {
            for (const [index, field] of rawElement.props.columns.entries()) {
              if (!isPlainObject(field) || typeof field.key !== "string") continue;
              const found = fieldBindingIssue(
                queryModel.modelName,
                queryModel.model,
                field.key,
                `${elementPath}.props.columns.${index}.key`,
              );
              if (found) issues.push(found);
            }
          }
          if (
            isPlainObject(rawElement.props.filters) &&
            !isStateBinding(rawElement.props.filters)
          ) {
            for (const columnName of Object.keys(rawElement.props.filters)) {
              const found = fieldBindingIssue(
                queryModel.modelName,
                queryModel.model,
                columnName,
                `${elementPath}.props.filters.${columnName}`,
              );
              if (found) issues.push(found);
            }
          }
          collectRowFieldIssues(
            rawElement.props.rowActions,
            `${elementPath}.props.rowActions`,
            queryModel.modelName,
            queryModel.model,
            issues,
          );
        }
      } else if (type === "DetailList") {
        const queryModel = queryModelFromDataBinding(definition, rawElement.props.data);
        if (queryModel && Array.isArray(rawElement.props.fields)) {
          for (const [index, field] of rawElement.props.fields.entries()) {
            if (!isPlainObject(field) || typeof field.key !== "string") continue;
            const found = fieldBindingIssue(
              queryModel.modelName,
              queryModel.model,
              field.key,
              `${elementPath}.props.fields.${index}.key`,
            );
            if (found) issues.push(found);
          }
        }
      } else if (type === "Form") {
        // `$`-prefixed names are reserved runtime slots under `/forms/<id>/`
        // (`$error` carries the inline mutate failure) — a field stored there
        // would render as the failure state and be cleared on submit. The
        // catalog schema also carries this as a JSON-schema `pattern`, which
        // this validator does not evaluate — hence the explicit check.
        if (Array.isArray(rawElement.props.fields)) {
          for (const [index, field] of rawElement.props.fields.entries()) {
            if (!isPlainObject(field) || typeof field.name !== "string") continue;
            if (field.name.startsWith("$")) {
              issues.push(
                issue(
                  `${elementPath}.props.fields.${index}.name`,
                  "field names must not start with '$' (reserved form slots)",
                ),
              );
            }
          }
        }
        const mutateModel = literalMutateModel(definition, rawElement.props.onSubmit);
        if (mutateModel && Array.isArray(rawElement.props.fields)) {
          for (const [index, field] of rawElement.props.fields.entries()) {
            if (!isPlainObject(field) || typeof field.name !== "string") continue;
            const found = fieldBindingIssue(
              mutateModel.modelName,
              mutateModel.model,
              field.name,
              `${elementPath}.props.fields.${index}.name`,
              false,
            );
            if (found) issues.push(found);
          }
        }
      }
    }

    if (Object.hasOwn(rawElement, "children") && type !== "ElementSlot") {
      if (!Array.isArray(rawElement.children)) {
        issues.push(issue(appendPath(elementPath, "children"), "must be an array of element ids"));
      } else {
        for (const [index, child] of rawElement.children.entries()) {
          if (typeof child !== "string") {
            issues.push(
              issue(appendPath(appendPath(elementPath, "children"), index), "must be a string"),
            );
          }
        }
      }
      if (component && !component.slots) {
        issues.push(
          issue(
            appendPath(elementPath, "children"),
            `component "${type}" does not accept children`,
          ),
        );
      }
    }

    if (Object.hasOwn(rawElement, "on")) {
      const onResult = validateActionMap(
        rawElement.on,
        appendPath(elementPath, "on"),
        definition,
        catalog,
        true,
      );
      issues.push(...onResult.issues);
      stateRefs.push(...onResult.stateRefs);
    }
    if (Object.hasOwn(rawElement, "watch")) {
      const watchResult = validateActionMap(
        rawElement.watch,
        appendPath(elementPath, "watch"),
        definition,
        catalog,
        true,
      );
      issues.push(...watchResult.issues);
      stateRefs.push(...watchResult.stateRefs);
    }
    for (const key of ["visible", "repeat"] as const) {
      if (!Object.hasOwn(rawElement, key)) continue;
      const bindingPath = appendPath(elementPath, key);
      const bindingResult = validateSchema(rawElement[key], {}, bindingPath, false);
      issues.push(...bindingResult.issues);
      stateRefs.push(...bindingResult.stateRefs);
      if (key === "visible") {
        collectStateRefs(rawElement[key], bindingPath, stateRefs);
        issues.push(...visibleConditionIssues(rawElement[key], bindingPath));
      }
    }

    if (
      type === "Table" &&
      isPlainObject(rawElement.props) &&
      Array.isArray(rawElement.props.rowActions)
    ) {
      for (const [rowActionIndex, rowAction] of rawElement.props.rowActions.entries()) {
        if (!isPlainObject(rowAction) || !Object.hasOwn(rowAction, "actions")) continue;
        const chainResult = validateActionChain(
          rowAction.actions,
          `${elementPath}.props.rowActions.${rowActionIndex}.actions`,
          definition,
          catalog,
        );
        issues.push(...chainResult.issues);
        stateRefs.push(...chainResult.stateRefs);
      }
    }
    if (
      type === "Form" &&
      isPlainObject(rawElement.props) &&
      Object.hasOwn(rawElement.props, "onSubmit")
    ) {
      const chainResult = validateActionChain(
        rawElement.props.onSubmit,
        `${elementPath}.props.onSubmit`,
        definition,
        catalog,
      );
      issues.push(...chainResult.issues);
      stateRefs.push(...chainResult.stateRefs);
    }
  }

  const parentByChild = new Map<string, string>();
  for (const [elementId, rawElement] of elementEntries) {
    if (!isPlainObject(rawElement) || !Array.isArray(rawElement.children)) continue;
    for (const [index, child] of rawElement.children.entries()) {
      if (typeof child !== "string") continue;
      const childPath = `${elementsPath}.${elementId}.children.${index}`;
      if (!Object.hasOwn(elements, child)) {
        issues.push(issue(childPath, `child element "${child}" not found`));
        continue;
      }
      const previousParent = parentByChild.get(child);
      if (previousParent && previousParent !== elementId) {
        issues.push(
          issue(childPath, `element "${child}" is already a child of "${previousParent}"`),
        );
      } else {
        parentByChild.set(child, elementId);
      }
    }
  }

  if (options?.elementMode) {
    for (const [elementId, rawElement] of elementEntries) {
      if (!isPlainObject(rawElement)) continue;
      const repeatBindingPaths: string[] = [];
      collectRepeatBindingPaths(rawElement, `${elementsPath}.${elementId}`, repeatBindingPaths);
      if (repeatBindingPaths.length === 0) continue;

      let repeatedScope = Object.hasOwn(rawElement, "repeat");
      let parentId = parentByChild.get(elementId);
      const visitedParents = new Set<string>();
      while (!repeatedScope && parentId && !visitedParents.has(parentId)) {
        visitedParents.add(parentId);
        const parent = elements[parentId];
        repeatedScope = isPlainObject(parent) && Object.hasOwn(parent, "repeat");
        parentId = parentByChild.get(parentId);
      }
      if (!repeatedScope) {
        for (const bindingPath of repeatBindingPaths) {
          issues.push(
            issue(
              bindingPath,
              "$item and $index bindings are only allowed inside a repeated element",
            ),
          );
        }
      }
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (elementId: string): void => {
    if (visited.has(elementId)) return;
    visiting.add(elementId);
    const rawElement = elements[elementId];
    if (isPlainObject(rawElement) && Array.isArray(rawElement.children)) {
      for (const [index, child] of rawElement.children.entries()) {
        if (typeof child !== "string" || !Object.hasOwn(elements, child)) continue;
        if (visiting.has(child)) {
          issues.push(
            issue(
              `${elementsPath}.${elementId}.children.${index}`,
              `cycle references element "${child}"`,
            ),
          );
          continue;
        }
        visit(child);
      }
    }
    visiting.delete(elementId);
    visited.add(elementId);
  };
  for (const elementId of Object.keys(elements)) visit(elementId);

  const reachable = new Set<string>();
  const markReachable = (elementId: string): void => {
    if (reachable.has(elementId) || !Object.hasOwn(elements, elementId)) return;
    reachable.add(elementId);
    const rawElement = elements[elementId];
    if (!isPlainObject(rawElement) || !Array.isArray(rawElement.children)) return;
    for (const child of rawElement.children) {
      if (typeof child === "string") markReachable(child);
    }
  };
  if (typeof root === "string") markReachable(root);
  for (const elementId of Object.keys(elements)) {
    if (!reachable.has(elementId)) {
      issues.push(issue(`${elementsPath}.${elementId}`, "element is not reachable from root"));
    }
  }

  for (const ref of stateRefs) {
    const propMatch = /^\/props\/([^/]+)(?:\/.*)?$/.exec(ref.value);
    const userConfigRef = ref.value === "/user" || ref.value.startsWith("/user/");
    let stateIssue: AppValidationIssue | null;
    if (options?.elementMode && userConfigRef) {
      stateIssue = issue(
        ref.path,
        `${options.elementMode} elements cannot read /user state; read userConfig via a prop or bind it at page level`,
      );
    } else if (options?.elementMode && propMatch) {
      stateIssue = Object.hasOwn(options.elementProps ?? {}, propMatch[1]!)
        ? null
        : issue(ref.path, `state reference targets unknown element prop "${propMatch[1]}"`);
    } else if (options?.elementMode === "pure") {
      stateIssue = issue(
        ref.path,
        `pure element state reference "${ref.value}" escapes /props/<declared>; use a declared prop or switch the element to bound mode`,
      );
    } else {
      stateIssue = validateStateRef(ref, definition, formIds, uiIds, pageParams);
    }
    if (stateIssue) issues.push(stateIssue);
  }
  return dedupeIssues(issues);
}
