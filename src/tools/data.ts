import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { agentFsClientFor } from "@/be/agent-fs-identity";
import { createEvent } from "@/be/events";
import { NO_AGENT_FS_IDENTITY, ObjectsError } from "@/be/primitives/objects";
import { createSheet } from "@/be/primitives/sheets/service";
import {
  AgentFsSqlError,
  type AgentFsSqlResult,
  type AgentFsSqlTable,
} from "@/fs/agent-fs-provider";
import { FilesError } from "@/fs/provider";
import { CARD_LIMITS, renderCard, TABLE_MAX_CELL_CHARS } from "@/integrations/cards";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

const MCP_DEFAULT_ROWS = 100;
const MCP_MAX_ROWS = 1_000;
const SCRIPT_DEFAULT_ROWS = 1_000;
const SCRIPT_MAX_ROWS = 10_000;
const CARD_CELL_CHARS = 1_000;
const PREVIEW_ROWS = 20;

// sqlite and .duckdb files carry their own catalog, which agent-fs opens before
// its sandbox lockdown; the swarm surface refuses them until that path is audited.
const REFUSED_FORMATS = new Set(["sqlite", "duckdb"]);
const REFUSED_EXTENSION = /\.(db|sqlite|sqlite3|duckdb)$/i;
// Same table-position rule as agent-fs (`FROM '/x.csv'`, `JOIN "/y.parquet"`), globs included.
const PATH_LITERAL = /\b(?:from|join)\s+(['"])([^'"]+\.[A-Za-z0-9]+(?:\.gz)?)\1/gi;
const GLOB = /[*?]/;
// DuckDB statements that only read. DESCRIBE, SHOW and SUMMARIZE parse as SELECTs.
const READ_STARTS = new Set([
  "select",
  "with",
  "from",
  "values",
  "table",
  "describe",
  "show",
  "summarize",
  "pivot",
  "unpivot",
]);
// A WITH clause can lead into a write (`WITH x AS (...) DELETE FROM t`).
const WRITE_WORDS = new Set(["insert", "update", "delete", "merge"]);
// DuckDB's lexer counts every byte >= 0x80 as an identifier character, in dollar tags
// (`$é$`) and names (`é$$`) alike. UTF-16 surrogates fall inside \u0080-\uffff too.
const IDENT_START = /[A-Za-z_\u0080-\uffff]/;
const IDENT_CHAR = /[\w$\u0080-\uffff]/;
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$/y;
const WORD = /[A-Za-z_\u0080-\uffff][\w$\u0080-\uffff]*/y;

/**
 * The first reason `sql` is not read-only, or null. Splits on top-level `;` and skips strings,
 * quoted identifiers and comments; anything it cannot scan to the end is refused.
 */
export function writeStatement(sql: string): string | null {
  const statements: string[][] = [[]];
  const ident = (ch: string | undefined) => ch !== undefined && IDENT_CHAR.test(ch);
  const match = (re: RegExp, at: number) => {
    re.lastIndex = at;
    return re.exec(sql)?.[0] ?? null;
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i] as string;
    const dollarTag = c === "$" && !ident(sql[i - 1]) ? match(DOLLAR_TAG, i) : null;
    if (sql.startsWith("--", i)) {
      // DuckDB ends a line comment at `\r` as well as `\n`.
      const end = sql.slice(i).search(/[\r\n]/);
      i = end === -1 ? sql.length : i + end + 1;
    } else if (sql.startsWith("/*", i)) {
      // DuckDB nests block comments: `/* /* */ ' */` is one comment, not a comment then a quote.
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.startsWith("/*", j)) depth++;
        else if (sql.startsWith("*/", j)) depth--;
        else {
          j++;
          continue;
        }
        j += 2;
      }
      if (depth > 0) return "an unterminated /* comment";
      i = j;
    } else if (c === "'" || c === '"') {
      // E'...' strings take backslash escapes; other strings and identifiers only double the quote.
      const escapes = c === "'" && /[eE]/.test(sql[i - 1] ?? "") && !ident(sql[i - 2]);
      let j = i + 1;
      for (; j < sql.length; j++) {
        if (escapes && sql[j] === "\\") j++;
        else if (sql[j] === c) {
          if (sql[j + 1] !== c) break;
          j++;
        }
      }
      if (j >= sql.length) return `an unterminated ${c} quote`;
      i = j + 1;
    } else if (dollarTag) {
      const end = sql.indexOf(dollarTag, i + dollarTag.length);
      if (end === -1) return `an unterminated ${dollarTag} string`;
      i = end + dollarTag.length;
    } else if (c === ";") {
      statements.push([]);
      i++;
    } else if (IDENT_START.test(c)) {
      const w = match(WORD, i) as string;
      statements.at(-1)?.push(w.toLowerCase());
      i += w.length;
    } else {
      i++;
    }
  }
  for (const words of statements) {
    const first = words[0];
    if (first !== undefined && !READ_STARTS.has(first)) return `\`${first.toUpperCase()}\``;
    const write = words.find((w) => WRITE_WORDS.has(w));
    if (write) return `\`${write.toUpperCase()}\``;
  }
  return null;
}

const TableBinding = z.union([
  z.string().min(1),
  z.object({ path: z.string().min(1), format: z.string().min(1).optional() }),
]);

const dataShape = {
  yourAgentId: z.string().optional(),
  columns: z
    .array(z.looseObject({ name: z.string().optional(), type: z.string().optional() }))
    .optional(),
  rows: z.array(z.record(z.string(), z.unknown())).optional(),
  rowCount: z.number().optional(),
  truncated: z.boolean().optional(),
  files: z.array(z.record(z.string(), z.unknown())).optional(),
  elapsedMs: z.number().optional(),
  output: z.string().optional(),
  card: z.record(z.string(), z.unknown()).optional(),
  sheet: z.record(z.string(), z.unknown()).optional(),
  errorCode: z.string().optional(),
};

type Output = "rows" | "card" | "sheet";

/** Every drive path the query reads: `tables` values and FROM/JOIN path literals. */
export function boundPaths(sql: string, tables: Record<string, AgentFsSqlTable> | undefined) {
  const bound = Object.values(tables ?? {}).map((t) =>
    typeof t === "string" ? { path: t } : { path: t.path, format: t.format },
  );
  const literals = [...sql.matchAll(PATH_LITERAL)].map((m) => m[2] as string);
  return { bound, literals: [...new Set(literals)] };
}

/** A cell as text for a card: JSON for objects, cut to CARD_CELL_CHARS. */
function cellText(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  return text.length > CARD_CELL_CHARS ? `${text.slice(0, CARD_CELL_CHARS - 1)}…` : text;
}

/** A sheet cell: scalars as is, objects as JSON, and text starting with `=` kept literal (not a formula). */
function sheetCell(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > 1 && text.startsWith("=") ? `'${text}` : text;
}

/** A uiSpec-ready card holding the first rows as a Table, inside Slack's caps; null when nothing fits. */
export function cardFor(result: AgentFsSqlResult): Record<string, unknown> | null {
  const columns = result.columns.slice(0, CARD_LIMITS.tableColumns).map((c) => c.name);
  if (columns.length === 0) return null;
  const rows: string[][] = [];
  let chars = columns.reduce((n, c) => n + c.length, 0);
  for (const row of result.rows.slice(0, CARD_LIMITS.tableRows - 1)) {
    const cells = columns.map((c) => cellText(row[c]));
    const size = cells.reduce((n, c) => n + c.length, 0);
    if (chars + size > TABLE_MAX_CELL_CHARS) break;
    chars += size;
    rows.push(cells);
  }
  const spec = {
    root: "card",
    elements: {
      card: { type: "Card", props: { title: "Query result" }, children: ["table"] },
      table: { type: "Table", props: { headers: columns, rows }, children: [] },
    },
  };
  return "card" in renderCard(spec) ? spec : null;
}

function preview(result: AgentFsSqlResult): string | undefined {
  if (result.columns.length === 0) return undefined;
  const names = result.columns.map((c) => c.name);
  const line = (cells: string[]) => `| ${cells.map((c) => c.replace(/[|\n]/g, " ")).join(" | ")} |`;
  return [
    line(names),
    line(names.map(() => "---")),
    ...result.rows.slice(0, PREVIEW_ROWS).map((row) => line(names.map((n) => cellText(row[n])))),
  ].join("\n");
}

export const registerDataQueryTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "data-query",
    {
      title: "Query drive files with SQL",
      annotations: { readOnlyHint: false, idempotentHint: false },
      description:
        "Read-only DuckDB SQL over tabular files on your agent-fs drive (csv, tsv, parquet, json, ndjson, xlsx; `.gz` too), as your own agent-fs identity. Name a file in table position (`SELECT region, sum(amount) FROM '/shared/x/sales.csv' GROUP BY 1`) or bind it in `tables`. `DESCRIBE SELECT * FROM '<path>'` shows a schema. Aggregate in SQL rather than pulling rows. `card: true` also returns a uiSpec-ready card table (first 100 rows, 20 columns); `sheet: {path}` saves the result as a new sheet. Not for the swarm DB (use db-query). Limits: 30 s, 256 MB per file, 1,000 rows per call (10,000 from scripts).",
      inputSchema: z.object({
        sql: z.string().min(1).max(20_000).describe("One read-only DuckDB query."),
        tables: z
          .record(z.string(), TableBinding)
          .optional()
          .describe("Table name -> drive path, or {path, format} to override format detection."),
        maxRows: z
          .number()
          .int()
          .positive()
          .max(SCRIPT_MAX_ROWS)
          .optional()
          .describe(
            `Rows to return: default ${MCP_DEFAULT_ROWS} (scripts ${SCRIPT_DEFAULT_ROWS}), at most ${MCP_MAX_ROWS} (scripts ${SCRIPT_MAX_ROWS}).`,
          ),
        driveId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Another drive in your org that your key can read. Default: your default drive.",
          ),
        card: z
          .boolean()
          .optional()
          .describe("Also return `card`, a uiSpec spec with the result as a Table."),
        sheet: z
          .object({
            path: z.string().min(1).describe("New `.sheet.json` path; create-only."),
            title: z.string().max(200).optional(),
            tab: z.string().min(1).max(31).optional(),
          })
          .optional()
          .describe("Save the result as a new sheet: a header row, then the rows."),
        origin: z
          .string()
          .max(40)
          .optional()
          .describe(
            "Label for the usage event, e.g. `workflow`, `e2e` or `qa`. Default: the call path.",
          ),
      }),
      outputSchema: swarmToolOutputSchema(dataShape),
    },
    async (input, requestInfo) => {
      const started = Date.now();
      const agentId = requestInfo.agentId;
      const fromScript = requestInfo.callOrigin === "script-sdk";
      const maxRowsCap = fromScript ? SCRIPT_MAX_ROWS : MCP_MAX_ROWS;
      const maxRows = input.maxRows ?? (fromScript ? SCRIPT_DEFAULT_ROWS : MCP_DEFAULT_ROWS);
      const output: Output = input.sheet ? "sheet" : input.card ? "card" : "rows";
      const { bound, literals } = boundPaths(input.sql, input.tables);
      const paths = [...bound.map((b) => b.path), ...literals];

      const finish = async (
        status: "ok" | "error",
        result: AgentFsSqlResult | undefined,
        errorCode?: string,
      ) => {
        try {
          await createEvent({
            category: "api",
            event: "data.query",
            status,
            source: "api",
            agentId,
            taskId: requestInfo.sourceTaskId,
            durationMs: Date.now() - started,
            numericValue: result?.rowCount,
            // Never the SQL text: it can carry customer values.
            data: {
              origin: input.origin ?? (fromScript ? "script" : requestInfo.callOrigin),
              callOrigin: requestInfo.callOrigin,
              tables: paths.map((p) => p.replace(/^\/+/, "")),
              formats: result?.files.map((f) => f.format) ?? [],
              maxRows,
              truncated: result?.truncated ?? false,
              elapsedMs: result?.elapsedMs,
              output,
              ...(errorCode ? { errorCode } : {}),
            },
          });
        } catch (error) {
          // The usage event must never fail the query it describes.
          console.error("[data-query] event write failed:", error);
        }
      };
      const refuse = async (message: string, errorCode: string, result?: AgentFsSqlResult) => {
        await finish("error", result, errorCode);
        return toolErr(message, { data: { yourAgentId: agentId, errorCode } });
      };

      if (maxRows > maxRowsCap) {
        return refuse(
          `maxRows: at most ${maxRowsCap} from ${fromScript ? "scripts" : "MCP"}.`,
          "VALIDATION_ERROR",
        );
      }
      const write = writeStatement(input.sql);
      if (write) {
        return refuse(
          `data-query is read-only: it runs only SELECT, WITH ... SELECT, DESCRIBE, SUMMARIZE and SHOW, and this query has ${write}. Double-quote a column named like a keyword ("delete").`,
          "READ_ONLY",
        );
      }
      const refused =
        bound.find((b) => b.format && REFUSED_FORMATS.has(b.format.toLowerCase())) ??
        bound.find((b) => REFUSED_EXTENSION.test(b.path)) ??
        literals.map((path) => ({ path })).find((b) => REFUSED_EXTENSION.test(b.path));
      if (refused) {
        return refuse(
          `${refused.path}: sqlite and duckdb files are not readable through data-query yet; export the table to csv or parquet.`,
          "FORMAT_REFUSED",
        );
      }
      if (input.sheet && !input.sheet.path.endsWith(".sheet.json")) {
        return refuse("sheet.path must end in `.sheet.json`.", "VALIDATION_ERROR");
      }

      const client = agentId ? await agentFsClientFor(agentId) : undefined;
      if (!client) return refuse(NO_AGENT_FS_IDENTITY, "NO_AGENT_FS_IDENTITY");
      const scope = {
        orgId: client.identity.orgId,
        driveId: input.driveId ?? client.identity.driveId,
      };

      let result: AgentFsSqlResult;
      try {
        // agent-fs reports a missing path literal as a blocked read, so check each one first.
        for (const path of literals.filter((p) => !GLOB.test(p))) {
          try {
            await client.provider.currentVersion({ taskId: "", name: "", key: path, ...scope });
          } catch (error) {
            if (error instanceof FilesError && error.code === "NotFound") {
              return refuse(
                `File not found: ${path}. Check the path with \`agent-fs ls\`.`,
                "NOT_FOUND",
              );
            }
            throw error;
          }
        }
        result = await client.provider.sql(
          { query: input.sql, tables: input.tables, maxRows },
          scope,
        );
      } catch (error) {
        if (error instanceof AgentFsSqlError) {
          return refuse(error.message, error.agentFsCode ?? error.code.toUpperCase());
        }
        if (error instanceof FilesError) return refuse(error.message, error.code.toUpperCase());
        throw error;
      }

      const data: Record<string, unknown> = { yourAgentId: agentId, ...result, output };
      let note = "";
      if (input.card) {
        const card = cardFor(result);
        if (card) data.card = card;
        else
          note +=
            " No card: the result has no columns or its first row is too wide for a card table.";
      }
      if (input.sheet) {
        const headers = result.columns.map((c) => c.name);
        try {
          data.sheet = await createSheet({
            agentId,
            path: input.sheet.path,
            title: input.sheet.title,
            tabs: [
              {
                name: input.sheet.tab ?? "Sheet1",
                rows: [
                  headers.map(sheetCell),
                  ...result.rows.map((row) => headers.map((h) => sheetCell(row[h]))),
                ],
              },
            ],
          });
        } catch (error) {
          if (error instanceof ObjectsError || error instanceof FilesError) {
            return refuse(
              `The query ran, but the sheet was not created: ${error.message}`,
              "SHEET_REFUSED",
              result,
            );
          }
          throw error;
        }
      }
      await finish("ok", result);
      const sheet = data.sheet as { object?: { path?: string }; link?: string | null } | undefined;
      return toolOk(
        `${result.rowCount} row(s)${result.truncated ? " (truncated)" : ""} from ${result.files.length} file(s) in ${result.elapsedMs} ms.${
          sheet ? ` Saved sheet ${sheet.object?.path}${sheet.link ? ` (${sheet.link})` : ""}.` : ""
        }${note}`,
        { details: preview(result), data },
      );
    },
  );
};
