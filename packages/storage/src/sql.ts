import type { DbParam } from "./client";
import type { Dialect } from "./dialect";

/**
 * Portable SQL text.
 *
 * Repositories write statements with the `sql` tag. The tag keeps the text and
 * the values apart until a dialect renders them: `?` placeholders for SQLite,
 * `$n` for Postgres. Nothing rewrites SQL text at run time: a part that differs
 * between engines is a `DialectFragment` that each dialect writes itself.
 *
 * Identifier rule (decision D8): every identifier that contains an uppercase
 * letter is written double-quoted in the text (`"createdAt"`), which both
 * engines accept. `check:sql-portability` enforces it.
 */

const LIST = Symbol("sqlList");
const IDENT = Symbol("sqlIdent");
const FRAGMENT = Symbol("dialectFragment");

type SqlList = { readonly [LIST]: readonly DbParam[] };
type SqlIdent = { readonly [IDENT]: string };

/** SQL text that a dialect writes for itself (a function, now, upsert, ...). */
export type DialectFragment = { readonly [FRAGMENT]: (dialect: Dialect) => SqlQuery };

export type SqlValue = DbParam | SqlQuery | SqlList | SqlIdent | DialectFragment;

export type RenderedSql = { text: string; params: DbParam[] };

export class SqlQuery {
  constructor(
    readonly strings: readonly string[],
    readonly values: readonly SqlValue[],
  ) {}

  render(dialect: Dialect): RenderedSql {
    const params: DbParam[] = [];
    const slot = (value: DbParam): string => {
      params.push(value);
      return dialect.placeholder(params.length);
    };
    const walk = (query: SqlQuery): string => {
      let text = query.strings[0] ?? "";
      query.values.forEach((value, index) => {
        text += renderValue(value, dialect, walk, slot);
        text += query.strings[index + 1] ?? "";
      });
      return text;
    };
    return { text: walk(this), params };
  }

  /** True when the query has no text (an empty optional clause). */
  isEmpty(): boolean {
    return this.values.length === 0 && this.strings.every((part) => part.trim() === "");
  }
}

function renderValue(
  value: SqlValue,
  dialect: Dialect,
  walk: (query: SqlQuery) => string,
  slot: (value: DbParam) => string,
): string {
  if (value instanceof SqlQuery) return walk(value);
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
    if (LIST in value) return value[LIST].map(slot).join(", ");
    if (IDENT in value) return `"${value[IDENT]}"`;
    if (FRAGMENT in value) return walk(value[FRAGMENT](dialect));
  }
  return slot(value as DbParam);
}

/** `sql\`SELECT "taskId" FROM agent_tasks WHERE id = ${id}\`` */
export function sql(strings: TemplateStringsArray, ...values: SqlValue[]): SqlQuery {
  return new SqlQuery([...strings], values);
}

/** The empty fragment: renders to nothing. */
export const EMPTY: SqlQuery = new SqlQuery([""], []);

/** Expand an array into a placeholder list: `IN (${sqlList(ids)})`. Never empty. */
export function sqlList(values: readonly DbParam[]): SqlList {
  if (values.length === 0) throw new Error("sqlList needs at least one value");
  return { [LIST]: values };
}

/**
 * A table or column name chosen by code, never by input. Renders double-quoted,
 * so the name keeps its case on both engines.
 */
export function sqlIdent(name: string): SqlIdent {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Not a plain identifier: ${name}`);
  return { [IDENT]: name };
}

/** SQL that each dialect writes for itself. */
export function dialectFragment(build: (dialect: Dialect) => SqlQuery): DialectFragment {
  return { [FRAGMENT]: build };
}

/** Join fragments with a separator, skipping empty ones: `sqlJoin(conditions, sql\` AND \`)`. */
export function sqlJoin(parts: readonly SqlQuery[], separator: SqlQuery): SqlQuery {
  const kept = parts.filter((part) => !part.isEmpty());
  if (kept.length === 0) return EMPTY;
  const strings: string[] = [""];
  const values: SqlValue[] = [];
  kept.forEach((part, index) => {
    if (index > 0) {
      values.push(separator);
      strings.push("");
    }
    values.push(part);
    strings.push("");
  });
  return new SqlQuery(strings, values);
}

/** `WHERE a AND b`, or nothing when there is no condition. */
export function sqlWhere(conditions: readonly SqlQuery[]): SqlQuery {
  const joined = sqlJoin(conditions, sql` AND `);
  return joined.isEmpty() ? EMPTY : sql` WHERE ${joined}`;
}
