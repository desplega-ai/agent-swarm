import catalog from "./catalog.generated.json";
import { closestNames } from "./closest-names";
import expressionsReference from "./expressions-reference.md" with { type: "text" };

/**
 * What an agent may put in an app page, read from the generated catalog the
 * server validates against: a component index, one component's props, one
 * action's params, and the binding reference. Static per build, so each
 * answer is computed once per process.
 */

type CatalogEntry = { description: string; slots?: string[]; props?: unknown; params?: unknown };

const components = catalog.components as Record<string, CatalogEntry>;
const actions = catalog.actions as Record<string, CatalogEntry>;

/** Above this a component's props come back as a prop list with drill-down. */
const COMPONENT_BYTES_TARGET = 8_000;

const DROPPED_SCHEMA_KEYS = new Set(["$schema", "additionalProperties", "propertyNames"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Compact a draft-07 props schema: drop keys that carry no authoring
 * information (`$schema`, `additionalProperties`, `propertyNames`) and
 * collapse an `anyOf` whose branches are identical.
 */
function compactSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(compactSchema);
  if (!isPlainObject(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (DROPPED_SCHEMA_KEYS.has(key)) continue;
    if (key === "anyOf" && Array.isArray(value)) {
      const unique = [...new Map(value.map((b) => [JSON.stringify(compactSchema(b)), b])).values()];
      if (unique.length === 1) {
        Object.assign(out, compactSchema(unique[0]));
        continue;
      }
      out.anyOf = unique.map(compactSchema);
      continue;
    }
    out[key] = compactSchema(value);
  }
  return out;
}

/** One line per prop: its JSON type, `[]` for arrays, an enum's values, `!` when required. */
function propSummary(schema: Record<string, unknown>, required: boolean): string {
  const type = Array.isArray(schema.enum)
    ? schema.enum.map((value) => JSON.stringify(value)).join("|")
    : schema.type === "array"
      ? `${isPlainObject(schema.items) ? String(schema.items.type ?? "any") : "any"}[]`
      : String(schema.type ?? (schema.anyOf ? "union" : "any"));
  return required ? `${type}!` : type;
}

const answers = new Map<string, unknown>();
function cached<T>(key: string, build: () => T): T {
  if (!answers.has(key)) answers.set(key, build());
  return answers.get(key) as T;
}

export function catalogIndex(): {
  components: Record<string, [string, string[]?]>;
  actions: Record<string, string>;
} {
  return cached("index", () => ({
    components: Object.fromEntries(
      Object.entries(components).map(([name, entry]) => {
        const line = firstSentence(entry.description);
        return [name, entry.slots ? [line, entry.slots] : [line]];
      }),
    ),
    actions: Object.fromEntries(
      Object.entries(actions).map(([name, entry]) => [name, firstSentence(entry.description)]),
    ),
  }));
}

function firstSentence(text: string): string {
  const end = text.search(/[.:;](\s|$)/);
  const line = end > 0 ? text.slice(0, end + 1) : text;
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}

export type CatalogLookup<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; closest: string[] };

export function catalogComponent(
  name: string,
  prop?: string,
): CatalogLookup<Record<string, unknown>> {
  const entry = Object.hasOwn(components, name) ? components[name] : undefined;
  if (!entry) {
    return {
      ok: false,
      message: `unknown component "${name}"`,
      closest: closestNames(name, Object.keys(components), 3),
    };
  }
  const props = cached(`props:${name}`, () => compactSchema(entry.props)) as Record<
    string,
    unknown
  >;
  const properties = isPlainObject(props.properties) ? props.properties : {};
  const required = new Set(Array.isArray(props.required) ? (props.required as string[]) : []);
  if (prop !== undefined) {
    if (!Object.hasOwn(properties, prop)) {
      return {
        ok: false,
        message: `component "${name}" has no prop "${prop}"`,
        closest: closestNames(prop, Object.keys(properties), 3),
      };
    }
    return {
      ok: true,
      value: { component: name, prop, required: required.has(prop), schema: properties[prop] },
    };
  }
  return {
    ok: true,
    value: cached(`component:${name}`, () => {
      const full = {
        component: name,
        description: entry.description,
        ...(entry.slots ? { slots: entry.slots } : {}),
        props,
      };
      if (JSON.stringify(full).length <= COMPONENT_BYTES_TARGET) return full;
      // shortcut: a list plus per-prop drill-down; upgrade to a smarter schema dedupe if many components cross the target.
      return {
        component: name,
        description: entry.description,
        ...(entry.slots ? { slots: entry.slots } : {}),
        props: Object.fromEntries(
          Object.entries(properties).map(([key, value]) => [
            key,
            propSummary(isPlainObject(value) ? value : {}, required.has(key)),
          ]),
        ),
        detail: `Props too large to inline: read one with app-catalog { component: "${name}", prop: "<name>" }.`,
      };
    }),
  };
}

export function catalogAction(name: string): CatalogLookup<Record<string, unknown>> {
  const entry = Object.hasOwn(actions, name) ? actions[name] : undefined;
  if (!entry) {
    return {
      ok: false,
      message: `unknown action "${name}"`,
      closest: closestNames(name, Object.keys(actions), 3),
    };
  }
  return {
    ok: true,
    value: cached(`action:${name}`, () => ({
      action: name,
      description: entry.description,
      params: compactSchema(entry.params),
    })),
  };
}

export const CATALOG_TOPICS = ["expressions"] as const;
export type CatalogTopic = (typeof CATALOG_TOPICS)[number];

export function catalogTopic(_topic: CatalogTopic): string {
  return expressionsReference;
}
