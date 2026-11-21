/**
 * Author-time translation of the SQLite expressions in the head schema
 * (CHECK constraints, partial-index predicates, index expressions, column
 * defaults) to Postgres. Each rule is explicit; anything else throws, so the
 * generator fails with the table and column instead of guessing.
 *
 * This runs only inside the baseline generator and the parity check. The API
 * server never translates SQL text (brief section 4).
 */
import {
  closeParen,
  type PgClass,
  splitTopLevel,
  type TimestampFormat,
  type Tok,
  tokenize,
} from "./sqlite-head";

export function qi(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function ql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export type ColumnContext = Map<string, { cls: PgClass; format?: TimestampFormat }>;

/** `to_char` forms that give the two SQLite timestamp text formats from a timestamptz. */
export const PG_NOW_TEXT: Record<TimestampFormat, string> = {
  "iso-ms-z": `to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
  space: `to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`,
};
export const PG_RANDOM_HEX32 = `replace(gen_random_uuid()::text, '-', '')`;
export const PG_EPOCH_MS_NOW = `(floor(extract(epoch FROM statement_timestamp()) * 1000))::bigint`;

const KEYWORDS = new Set([
  "AND",
  "OR",
  "NOT",
  "IN",
  "IS",
  "NULL",
  "LIKE",
  "GLOB",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "BETWEEN",
  "CAST",
  "AS",
  "TRUE",
  "FALSE",
  "DISTINCT",
  "FROM",
]);

type Out = { sql: string; column: string | null };

/**
 * Translates one SQLite expression. `ctx` holds the columns of the table the
 * expression belongs to, with their Postgres class.
 */
export function translateExpr(sqliteExpr: string, ctx: ColumnContext, where: string): string {
  const toks = tokenize(sqliteExpr);
  return translateTokens(toks, ctx, where).sql;
}

function fail(where: string, msg: string): never {
  throw new Error(`${where}: ${msg}`);
}

function isBoolLiteral(t: Tok | undefined): t is Tok {
  return t !== undefined && t.k === "num" && (t.v === "0" || t.v === "1");
}

function translateTokens(toks: Tok[], ctx: ColumnContext, where: string): Out {
  const parts: string[] = [];
  let lastColumn: string | null = null;
  let single = true;
  const colClass = (name: string) => ctx.get(name)?.cls;

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as Tok;
    const next = toks[i + 1];
    if (i > 0) single = false;

    // Function call.
    if (t.k === "id" && next?.k === "op" && next.v === "(" && !KEYWORDS.has(t.v.toUpperCase())) {
      const end = closeParen(toks, i + 1);
      const argToks = toks.slice(i + 2, end);
      const tail = toks.slice(end + 1);
      parts.push(translateCall(t.v, argToks, tail, ctx, where));
      if (end !== toks.length - 1) single = false;
      i = end;
      continue;
    }
    if (t.k === "id" && t.v.toUpperCase() === "CAST" && next?.v === "(") {
      const end = closeParen(toks, i + 1);
      const inner = toks.slice(i + 2, end);
      const asAt = inner.findIndex((x) => x.k === "id" && x.v.toUpperCase() === "AS");
      if (asAt < 0) fail(where, "CAST without AS");
      const target = inner
        .slice(asAt + 1)
        .map((x) => x.v.toUpperCase())
        .join(" ");
      const pgType =
        target === "INTEGER"
          ? "bigint"
          : target === "TEXT"
            ? "text"
            : target === "REAL"
              ? "double precision"
              : fail(where, `CAST to ${target}`);
      parts.push(`CAST(${translateTokens(inner.slice(0, asAt), ctx, where).sql} AS ${pgType})`);
      i = end;
      continue;
    }
    // Column reference.
    if (t.k === "qid" || (t.k === "id" && !KEYWORDS.has(t.v.toUpperCase()))) {
      if (!ctx.has(t.v)) fail(where, `unknown column or word "${t.v}"`);
      lastColumn = t.v;
      parts.push(qi(t.v));
      // flag = 0/1, flag != 0/1, flag IN (0, 1)
      if (colClass(t.v) === "boolean") {
        const op = toks[i + 1];
        if (op?.k === "op" && ["=", "==", "!=", "<>"].includes(op.v)) {
          const lit = toks[i + 2];
          if (isBoolLiteral(lit)) {
            parts.push(op.v === "==" ? "=" : op.v, lit.v === "1" ? "true" : "false");
            i += 2;
            single = false;
            continue;
          }
        }
        const notIn = isWordTok(toks[i + 1], "NOT") ? 1 : 0;
        if (isWordTok(toks[i + 1 + notIn], "IN") && toks[i + 2 + notIn]?.v === "(") {
          const open = i + 2 + notIn;
          const end = closeParen(toks, open);
          const items = splitTopLevel(toks.slice(open + 1, end));
          if (items.every((it) => it.length === 1 && isBoolLiteral(it[0]))) {
            parts.push(
              `${notIn ? "NOT " : ""}IN (${items.map((it) => (it[0]?.v === "1" ? "true" : "false")).join(", ")})`,
            );
            i = end;
            single = false;
            continue;
          }
        }
      }
      continue;
    }
    if (t.k === "str") {
      parts.push(ql(t.v));
      continue;
    }
    if (t.k === "num") {
      parts.push(t.v);
      continue;
    }
    if (t.k === "op") {
      parts.push(t.v === "==" ? "=" : t.v);
      continue;
    }
    // Keywords.
    const kw = t.v.toUpperCase();
    if (kw === "IS") {
      const n1 = toks[i + 1];
      if (isWordTok(n1, "NOT")) {
        if (isWordTok(toks[i + 2], "NULL")) {
          parts.push("IS NOT NULL");
          i += 2;
        } else {
          parts.push("IS DISTINCT FROM");
          i += 1;
        }
      } else if (isWordTok(n1, "NULL")) {
        parts.push("IS NULL");
        i += 1;
      } else {
        parts.push("IS NOT DISTINCT FROM");
      }
      continue;
    }
    if (kw === "GLOB") {
      const pat = toks[i + 1];
      if (pat?.k !== "str" || !/^[^*?[\]]*\*$/.test(pat.v)) {
        fail(where, "GLOB with a pattern other than '<literal prefix>*'");
      }
      const prefix = pat.v.slice(0, -1).replace(/[\\%_]/g, (m) => `\\${m}`);
      parts.push("LIKE", ql(`${prefix}%`));
      i += 1;
      continue;
    }
    if (kw === "LIKE") {
      const pat = toks[i + 1];
      if (pat?.k !== "str" || pat.v.includes("\\")) fail(where, "LIKE with a non-literal pattern");
      if (isWordTok(toks[i + 2], "ESCAPE")) fail(where, "LIKE ... ESCAPE");
      // SQLite LIKE folds ASCII case; ILIKE on a C-ctype database folds ASCII only too.
      parts.push("ILIKE", ql(pat.v));
      i += 1;
      continue;
    }
    parts.push(kw);
  }
  return { sql: joinParts(parts), column: single ? lastColumn : null };
}

/** Joins translated pieces with single spaces, none inside parentheses or before commas. */
function joinParts(parts: string[]): string {
  let out = "";
  parts.forEach((p, i) => {
    const prev = parts[i - 1];
    const tight = i === 0 || prev === "(" || p === ")" || p === ",";
    out += tight ? p : ` ${p}`;
  });
  return out;
}

function isWordTok(t: Tok | undefined, word: string): boolean {
  return t !== undefined && t.k === "id" && t.v.toUpperCase() === word;
}

function translateCall(
  rawName: string,
  argToks: Tok[],
  tail: Tok[],
  ctx: ColumnContext,
  where: string,
): string {
  const name = rawName.toLowerCase();
  const rawArgs = argToks.length === 0 ? [] : splitTopLevel(argToks);
  const args = rawArgs.map((a) => translateTokens(a, ctx, where));
  const sqls = args.map((a) => a.sql);
  const argClass = (n: number) => {
    const col = args[n]?.column;
    return col ? ctx.get(col)?.cls : undefined;
  };
  switch (name) {
    case "length":
    case "lower":
    case "upper":
    case "coalesce":
    case "nullif":
    case "abs":
      return `${name}(${sqls.join(", ")})`;
    case "trim":
    case "ltrim":
    case "rtrim":
      if (sqls.length !== 1) fail(where, `${name} with ${sqls.length} arguments`);
      return `${name}(${sqls[0]})`;
    case "substr": {
      const start = rawArgs[1];
      if (!start || start.length !== 1 || start[0]?.k !== "num") {
        fail(where, "substr with a non-literal start");
      }
      return `substr(${sqls.join(", ")})`;
    }
    case "instr":
      return `strpos(${sqls.join(", ")})`;
    case "json_valid":
      if (sqls.length !== 1) fail(where, "json_valid arity");
      // A jsonb value is valid JSON by construction. json_valid(NULL) is NULL on
      // SQLite; `x IS NOT NULL OR NULL` keeps that (NULL for NULL, else true).
      return argClass(0) === "jsonb"
        ? `(${sqls[0]} IS NOT NULL OR NULL::boolean)`
        : `(${sqls[0]} IS JSON)`;
    case "json_type": {
      if (sqls.length !== 1) fail(where, "json_type with a path");
      // Only `json_type(x) = 'array' | 'object'`: those names match on both engines.
      const cmp = tail[0];
      const lit = tail[1];
      if (cmp?.v !== "=" || lit?.k !== "str" || !["array", "object"].includes(lit.v)) {
        fail(where, "json_type compared to something other than 'array'/'object'");
      }
      return argClass(0) === "jsonb"
        ? `jsonb_typeof(${sqls[0]})`
        : `jsonb_typeof((${sqls[0]})::jsonb)`;
    }
    case "json_extract": {
      const path = rawArgs[1];
      if (sqls.length !== 2 || path?.length !== 1 || path[0]?.k !== "str") {
        fail(where, "json_extract with a non-literal path");
      }
      const m = /^\$((\.[A-Za-z_][A-Za-z0-9_]*)+)$/.exec(path[0].v);
      if (!m) fail(where, `json_extract path ${path[0].v}`);
      const keys = (m[1] as string).slice(1).split(".");
      const base = argClass(0) === "jsonb" ? sqls[0] : `(${sqls[0]})::jsonb`;
      // Text result: used only under IS [NOT] NULL in the head schema.
      return `(${base} #>> ${ql(`{${keys.join(",")}}`)})`;
    }
    default:
      fail(where, `function ${rawName}() has no translation rule`);
  }
}

/**
 * Translates a column DEFAULT. Returns null for "no default". Throws on a
 * default without a rule. On a column that stays `text`, a clock default keeps
 * the SQLite text format of its own form (strftime gives iso-ms-z,
 * datetime('now') and CURRENT_TIMESTAMP give the space format).
 */
export function translateDefault(dflt: string | null, cls: PgClass, where: string): string | null {
  if (dflt === null) return null;
  const d = dflt.trim();
  if (/^NULL$/i.test(d)) return null;
  const nowFormat: TimestampFormat | null = /^strftime\('%Y-%m-%dT%H:%M:%fZ', *'now'\)$/i.test(d)
    ? "iso-ms-z"
    : /^datetime\('now'\)$/i.test(d) || /^CURRENT_TIMESTAMP$/i.test(d)
      ? "space"
      : null;
  if (nowFormat) {
    if (cls === "timestamptz") return "statement_timestamp()";
    if (cls === "text") return PG_NOW_TEXT[nowFormat];
    fail(where, `clock default ${d} on a ${cls} column`);
  }
  if (/^lower\(hex\(randomblob\(16\)\)\)$/i.test(d)) {
    if (cls !== "text") fail(where, `random hex default on a ${cls} column`);
    return PG_RANDOM_HEX32;
  }
  if (/^CAST\(unixepoch\('subsec'\) \* 1000 AS INTEGER\)$/i.test(d)) {
    if (cls !== "epoch-ms" && cls !== "bigint") fail(where, `epoch default on a ${cls} column`);
    return PG_EPOCH_MS_NOW;
  }
  if (/^-?\d+(\.\d+)?$/.test(d)) {
    if (cls === "boolean") {
      if (d === "0") return "false";
      if (d === "1") return "true";
      fail(where, `boolean default ${d}`);
    }
    if (cls === "bigint" || cls === "epoch-ms") {
      if (!/^-?\d+$/.test(d)) fail(where, `fractional default ${d} on an integer column`);
      return d;
    }
    if (cls === "double") return d;
    fail(where, `numeric default ${d} on a ${cls} column`);
  }
  const str = /^'((?:[^']|'')*)'$/.exec(d);
  if (str) {
    const value = (str[1] as string).replaceAll("''", "'");
    if (cls === "text") return ql(value);
    if (cls === "jsonb") {
      try {
        JSON.parse(value);
      } catch {
        fail(where, `jsonb default ${d} is not JSON`);
      }
      return `${ql(value)}::jsonb`;
    }
    fail(where, `string default ${d} on a ${cls} column`);
  }
  fail(where, `default ${d} has no translation rule`);
}
