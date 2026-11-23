#!/usr/bin/env bun
// One-shot author-time codemod for the Postgres engine work (ledger M1): rewrites
// `<x>.db.get|query(<literal SQL>, [params])` in e2e scenarios to the portable
// tagged-template form `<x>.db.get|query(sql\`... ${param} ...\`)`, and puts double
// quotes around each identifier with an uppercase letter (decision D8). It writes files
// in place and prints every call it could not convert, for a hand edit.
// Usage: bun scripts/codemods/e2e-portable-sql.ts [--check] <files...>
import ts from "typescript";

export function quoteMixedCaseIdentifiers(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "'" || ch === '"') {
      // Copy a quoted literal or quoted identifier verbatim ('' and "" escape themselves).
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === ch) {
          if (text[j + 1] === ch) j += 2;
          else break;
        } else j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch) && (i === 0 || !/[\w$.]/.test(text[i - 1]!) || text[i - 1] === ".")) {
      let j = i;
      while (j < text.length && /\w/.test(text[j]!)) j++;
      const word = text.slice(i, j);
      // Mixed case: at least one lowercase and one uppercase letter. SQL keywords in
      // capitals (SELECT) and lowercase names (agent_tasks) stay bare.
      out += /[a-z]/.test(word) && /[A-Z]/.test(word) ? `"${word}"` : word;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function placeholderSplit(text: string): string[] | null {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "?") {
      if (/\d/.test(text[i + 1] ?? "")) return null; // ?NNN numbered params: hand edit
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

const escapeTemplate = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

type Edit = { start: number; end: number; text: string };

// Scenario helpers that take (sql text, params) and pass them to ctx.db: [sql index, params index].
const WRAPPERS: Record<string, [number, number]> = { dbCount: [1, 2], webhookTasks: [2, 3] };

export function transform(
  fileName: string,
  source: string,
): { output: string; manual: string[]; changed: number } {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits: Edit[] = [];
  const manual: string[] = [];
  const visit = (node: ts.Node) => {
    const wrapper =
      ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        ? WRAPPERS[node.expression.text]
        : undefined;
    if (
      ts.isCallExpression(node) &&
      (wrapper ||
        (ts.isPropertyAccessExpression(node.expression) &&
          ["get", "query"].includes(node.expression.name.text) &&
          /(^|\.)db$/.test(node.expression.expression.getText(sf))))
    ) {
      const [sqlIndex, paramsIndex] = wrapper ?? [0, 1];
      const sqlArg = node.arguments[sqlIndex];
      const paramsArg = node.arguments[paramsIndex];
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      if (!sqlArg || (ts.isTaggedTemplateExpression(sqlArg) && sqlArg.tag.getText(sf) === "sql")) {
        // already converted
      } else if (ts.isStringLiteral(sqlArg) || ts.isNoSubstitutionTemplateLiteral(sqlArg)) {
        const parts = placeholderSplit(sqlArg.text);
        const params =
          paramsArg && ts.isArrayLiteralExpression(paramsArg)
            ? paramsArg.elements
            : paramsArg
              ? null
              : [];
        if (
          !parts ||
          !params ||
          params.some((p) => ts.isSpreadElement(p)) ||
          parts.length - 1 !== params.length
        ) {
          manual.push(`${fileName}:${line}`);
        } else {
          let text = "sql`";
          parts.forEach((part, k) => {
            text += escapeTemplate(quoteMixedCaseIdentifiers(part));
            if (k < params.length) text += `\${${params[k]!.getText(sf)}}`;
          });
          text += "`";
          edits.push({ start: sqlArg.getStart(sf), end: (paramsArg ?? sqlArg).getEnd(), text });
        }
      } else {
        manual.push(`${fileName}:${line}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  let output = source;
  for (const e of edits.sort((a, b) => b.start - a.start))
    output = output.slice(0, e.start) + e.text + output.slice(e.end);
  if (edits.length && !/import \{[^}]*\bsql\b[^}]*\} from "\.\.\/db"/.test(output)) {
    output = `import { sql } from "../db";\n${output}`;
  }
  return { output, manual, changed: edits.length };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  let total = 0;
  const allManual: string[] = [];
  for (const f of args.filter((a) => a !== "--check")) {
    const src = await Bun.file(f).text();
    const { output, manual, changed } = transform(f, src);
    total += changed;
    allManual.push(...manual);
    if (!check && output !== src) await Bun.write(f, output);
  }
  console.log(`converted ${total} calls; ${allManual.length} need a hand edit`);
  for (const m of allManual) console.log(`  manual: ${m}`);
}
