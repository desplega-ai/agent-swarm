/**
 * Shared source scanner for the storage checks (Postgres brief checks 12, 13
 * and 15). Parses TypeScript with the compiler API, so comments never count
 * and string pieces are read exactly as written.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

export const ROOT = join(import.meta.dir, "../..");

const CODE = /\.(ts|tsx)$/;
const TEST = /(\.|_)(test|spec)\.tsx?$|\/tests?\//;

/** Non-test TypeScript files under `dirs` (relative to the repo root). */
export function listCodeFiles(dirs: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (name === "node_modules") continue;
      const rel = `${dir}/${name}`;
      const stat = statSync(join(ROOT, rel));
      if (stat.isDirectory()) walk(rel);
      else if (CODE.test(name) && !TEST.test(rel) && !name.endsWith(".d.ts")) out.push(rel);
    }
  };
  for (const dir of dirs) walk(dir);
  return out.sort();
}

export function parse(file: string): ts.SourceFile {
  const text = readFileSync(join(ROOT, file), "utf8");
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

export type Literal = {
  /** The literal text; template substitutions read as `?`. */
  text: string;
  line: number;
  /** The tag of a tagged template (`sql`), if any. */
  tag: string | null;
  node: ts.Node;
};

/** Every string and template literal in the file. */
export function literals(source: ts.SourceFile): Literal[] {
  const out: Literal[] = [];
  const lineOf = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = (node: ts.Node) => {
    if (ts.isTaggedTemplateExpression(node)) {
      out.push({
        text: templateText(node.template),
        line: lineOf(node),
        tag: node.tag.getText(source),
        node,
      });
      // Substitutions may hold nested tagged templates.
      if (ts.isTemplateExpression(node.template)) {
        for (const span of node.template.templateSpans) ts.forEachChild(span, visit);
      }
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent)) {
        out.push({ text: node.text, line: lineOf(node), tag: null, node });
      }
    } else if (ts.isTemplateExpression(node)) {
      out.push({ text: templateText(node), line: lineOf(node), tag: null, node });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function templateText(template: ts.TemplateLiteral): string {
  if (ts.isNoSubstitutionTemplateLiteral(template)) return template.text;
  return (
    template.head.text + template.templateSpans.map((span) => `?${span.literal.text}`).join("")
  );
}

/**
 * SQL statement shapes, uppercase keywords only. Prose rarely writes them in
 * capitals; the codebase always does.
 */
export const SQL_STATEMENT =
  /\b(SELECT\b[\s\S]*?\bFROM\b|INSERT\s+(OR\s+[A-Z]+\s+)?INTO\b|REPLACE\s+INTO\b|UPDATE\s+["\w]+\s+SET\b|DELETE\s+FROM\b|CREATE\s+(UNIQUE\s+|VIRTUAL\s+|TEMP\s+)?(TABLE|INDEX|TRIGGER|VIEW)\b|ALTER\s+TABLE\b|DROP\s+(TABLE|INDEX|TRIGGER|VIEW)\b|PRAGMA\s+[a-z_]+|BEGIN\s+IMMEDIATE\b|SAVEPOINT\s+\w)/;

export function rel(file: string): string {
  return relative(ROOT, join(ROOT, file));
}
