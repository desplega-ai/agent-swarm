import type { AppDefinition, AppValidationIssue } from "./definition";

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

const ELEMENT_KEYS = new Set(["type", "props", "children", "on", "visible", "repeat", "watch"]);
const UI_STATE_COMPONENTS = new Set(["SearchInput", "Select", "Tabs"]);

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
): SchemaValidationResult {
  const result: SchemaValidationResult = { issues: [], stateRefs: [] };
  if (typeof step.action !== "string") {
    result.issues.push(issue(appendPath(path, "action"), "must be a string"));
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
        if (!Object.hasOwn(definition.models[model]!.columns, column)) {
          result.issues.push(
            issue(
              appendPath(appendPath(paramsPath, "values"), column),
              `unknown column "${column}"`,
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
): AppValidationIssue | null {
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
  return exists ? null : issue(ref.path, `state reference targets unknown ${targetKind} "${name}"`);
}

export function validatePage(definition: AppDefinition, catalog: AppCatalog): AppValidationIssue[] {
  const issues: AppValidationIssue[] = [];
  const stateRefs: StateRef[] = [];
  const formIds = new Set<string>();
  const uiIds = new Set<string>();
  const page = definition.page;
  const root = page.root;
  const elements = page.elements;

  if (typeof root !== "string") issues.push(issue("page.root", "must be a string"));
  if (!isPlainObject(elements)) {
    issues.push(issue("page.elements", "must be a non-empty object"));
    return issues;
  }
  const elementEntries = Object.entries(elements);
  if (elementEntries.length === 0) {
    issues.push(issue("page.elements", "must be a non-empty object"));
    return issues;
  }
  if (typeof root === "string" && !Object.hasOwn(elements, root)) {
    issues.push(issue("page.root", `root element "${root}" not found`));
  }

  for (const [elementId, rawElement] of elementEntries) {
    const elementPath = appendPath("page.elements", elementId);
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

    if (Object.hasOwn(rawElement, "children")) {
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
      const bindingResult = validateSchema(
        rawElement[key],
        {},
        appendPath(elementPath, key),
        false,
      );
      issues.push(...bindingResult.issues);
      stateRefs.push(...bindingResult.stateRefs);
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
      const childPath = `page.elements.${elementId}.children.${index}`;
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
              `page.elements.${elementId}.children.${index}`,
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
      issues.push(issue(`page.elements.${elementId}`, "element is not reachable from root"));
    }
  }

  for (const ref of stateRefs) {
    const stateIssue = validateStateRef(ref, definition, formIds, uiIds);
    if (stateIssue) issues.push(stateIssue);
  }
  const seen = new Set<string>();
  return issues.filter(({ path, message }) => {
    const key = `${path}\0${message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
