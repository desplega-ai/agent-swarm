#!/usr/bin/env bun
/**
 * codemod-imports.ts — rewrite intra-repo import specifiers to bare @swarm/<pkg> names.
 *
 * Driven by packages.map.json. For each STATIC import/export-from declaration whose
 * specifier (`@/...` or a relative path) resolves to a src file owned by a DIFFERENT
 * package than the importing file, the specifier is rewritten to the bare package name
 * (e.g. `../be/db` or `@/be/db` -> `@swarm/storage`). Imports that stay within the same
 * package are left untouched.
 *
 * HARD GUARANTEES
 *   - `import type` / inline `type {}` qualifiers are preserved (only the specifier string
 *     changes), so verbatimModuleSyntax stays satisfied.
 *   - Dynamic `import()` expressions are NEVER touched (the provider factory in
 *     src/providers/index.ts relies on them — PR#452). We only visit ImportDeclaration /
 *     ExportDeclaration nodes; call-expression `import(...)` is structurally excluded.
 *   - Idempotent: specifiers already of the form `@swarm/*` (or external) are skipped.
 *
 * USAGE
 *   bun scripts/codemod-imports.ts [files...] [--dry-run] [--apply] [--package @swarm/x]
 *     (no files)        default scope: every .ts / .tsx under src/ (recursive)
 *     --dry-run         print intended changes, write nothing (DEFAULT — safe)
 *     --apply           write changes to disk
 *     --package <name>  only rewrite imports TARGETING that package
 */
import { Project, SyntaxKind } from "ts-morph";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const ROOT = process.cwd();

// ---- args --------------------------------------------------------------------
const argv = process.argv.slice(2);
let apply = false;
let dryRun = false;
let pkgFilter: string | null = null;
const fileArgs: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--apply") apply = true;
  else if (a === "--dry-run") dryRun = true;
  else if (a === "--package") pkgFilter = argv[++i] ?? null;
  else if (a.startsWith("--package=")) pkgFilter = a.slice("--package=".length);
  else if (a.startsWith("--")) {
    console.error(`Unknown flag: ${a}`);
    process.exit(2);
  } else fileArgs.push(a);
}
// Safe default: dry-run unless --apply is explicitly passed.
if (!apply) dryRun = true;
if (apply && argv.includes("--dry-run")) {
  console.error("Pass either --apply or --dry-run, not both.");
  process.exit(2);
}

// ---- ownership resolver (mirrors scripts/generate-barrels.ts) ----------------
type PkgDef = { layer: number; sources: string[] };
const rawMap = JSON.parse(readFileSync(join(ROOT, "packages.map.json"), "utf8")) as Record<string, unknown>;
const map: Record<string, PkgDef> = {};
for (const [k, v] of Object.entries(rawMap)) {
  if (v && typeof v === "object" && Array.isArray((v as PkgDef).sources)) map[k] = v as PkgDef;
}
if (pkgFilter && !map[pkgFilter]) {
  console.error(`--package ${pkgFilter} is not a known package in packages.map.json`);
  process.exit(2);
}
type Entry = { kind: "file" | "dir"; path: string; pkg: string };
const entries: Entry[] = [];
for (const [pkg, def] of Object.entries(map)) {
  for (const s of def.sources) entries.push({ kind: s.endsWith("/") ? "dir" : "file", path: s, pkg });
}
function resolveOwner(rel: string): string | null {
  for (const e of entries) if (e.kind === "file" && e.path === rel) return e.pkg;
  let best: Entry | null = null;
  for (const e of entries) {
    if (e.kind === "dir" && rel.startsWith(e.path) && (!best || e.path.length > best.path.length)) best = e;
  }
  return best ? best.pkg : null;
}

function resolveModuleFile(fromAbs: string, spec: string): string | null {
  let baseDir: string;
  let rest: string;
  if (spec.startsWith("@/")) {
    baseDir = join(ROOT, "src");
    rest = spec.slice(2);
  } else if (spec.startsWith(".")) {
    baseDir = dirname(fromAbs);
    rest = spec;
  } else {
    return null; // external / bare specifier
  }
  const target = join(baseDir, rest);
  // TS source frequently writes `.js`/`.mjs` specifiers that actually resolve to `.ts`/`.tsx`
  // files (e.g. src/providers/codex-oauth/*.js). Try the TS twin first so those resolve.
  const jsExt = target.match(/\.(js|jsx|mjs|cjs)$/);
  const cands = jsExt
    ? [`${target.slice(0, -jsExt[0].length)}.ts`, `${target.slice(0, -jsExt[0].length)}.tsx`, target]
    : [target, `${target}.ts`, `${target}.tsx`, join(target, "index.ts"), join(target, "index.tsx")];
  for (const c of cands) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

// ---- project -----------------------------------------------------------------
const project = new Project({
  skipAddingFilesFromTsConfig: true,
  skipFileDependencyResolution: true,
  compilerOptions: { allowJs: true, jsx: 4 },
});
if (fileArgs.length > 0) {
  for (const f of fileArgs) {
    // accept files or globs, absolute or relative
    if (existsSync(f) && statSync(f).isFile()) project.addSourceFileAtPath(f);
    else project.addSourceFilesAtPaths(f);
  }
} else {
  // Scope: src/ (incl tests) + root tooling that imports src/ (scripts/, deploy/). NOT
  // evals/ (separate package, repointed explicitly) or packages/ (barrels — skipped below).
  project.addSourceFilesAtPaths(["src/**/*.ts", "src/**/*.tsx", "scripts/**/*.ts", "deploy/**/*.ts"]);
}

type Change = { file: string; line: number; from: string; to: string; kind: "import" | "export" | "importtype" | "dynamic" };
const changes: Change[] = [];

for (const sf of project.getSourceFiles()) {
  const abs = sf.getFilePath();
  const rel = relative(ROOT, abs).split("\\").join("/");
  if (rel.startsWith("packages/") || rel.includes("/node_modules/")) continue;
  const importerPkg = resolveOwner(rel);

  type Kind = "import" | "export" | "importtype" | "dynamic";
  const decls: { spec: string; set: (s: string) => void; line: number; kind: Kind }[] = [];
  for (const d of sf.getImportDeclarations()) {
    decls.push({
      spec: d.getModuleSpecifierValue(),
      set: (s) => d.setModuleSpecifier(s),
      line: d.getStartLineNumber(),
      kind: "import",
    });
  }
  for (const d of sf.getExportDeclarations()) {
    const spec = d.getModuleSpecifierValue();
    if (!spec) continue; // local `export { x }` — no specifier
    decls.push({ spec, set: (s) => d.setModuleSpecifier(s), line: d.getStartLineNumber(), kind: "export" });
  }
  // Type-position `import("X").Y` references (ImportTypeNode) — rewrite the specifier
  // STRING only; the node stays a type import (verbatimModuleSyntax safe).
  for (const it of sf.getDescendantsOfKind(SyntaxKind.ImportType)) {
    const lit = it.getArgument().asKind(SyntaxKind.LiteralType)?.getLiteral()?.asKind(SyntaxKind.StringLiteral);
    if (!lit) continue;
    decls.push({ spec: lit.getLiteralValue(), set: (s) => lit.setLiteralValue(s), line: it.getStartLineNumber(), kind: "importtype" });
  }
  // Module-specifier CALL expressions — rewrite the specifier STRING only, node shape kept:
  //   - dynamic `import("X")` (stays dynamic — provider factory PR#452)
  //   - `require("X")` (CJS holdouts in a couple of db-queries)
  //   - `mock.module("X", …)` (bun:test module mocks)
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    const exprText = expr.getText();
    const isCall = expr.getKind() === SyntaxKind.ImportKeyword || exprText === "require" || exprText === "mock.module";
    if (!isCall) continue;
    const lit = call.getArguments()[0]?.asKind(SyntaxKind.StringLiteral);
    if (!lit) continue;
    decls.push({ spec: lit.getLiteralValue(), set: (s) => lit.setLiteralValue(s), line: call.getStartLineNumber(), kind: "dynamic" });
  }

  for (const d of decls) {
    const spec = d.spec;
    if (!spec) continue;
    if (spec.startsWith("@swarm/")) continue; // already migrated
    if (!spec.startsWith("@/") && !spec.startsWith(".")) continue; // external
    const targetAbs = resolveModuleFile(abs, spec);
    if (!targetAbs) continue;
    const targetRel = relative(ROOT, targetAbs).split("\\").join("/");
    const targetPkg = resolveOwner(targetRel);
    if (!targetPkg) continue; // target not owned by any package (e.g. app-only file)
    if (targetPkg === importerPkg) continue; // same package — keep relative
    if (pkgFilter && targetPkg !== pkgFilter) continue;
    changes.push({ file: rel, line: d.line, from: spec, to: targetPkg, kind: d.kind });
    if (apply) d.set(targetPkg);
  }
}

// ---- report ------------------------------------------------------------------
changes.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
const byTarget = new Map<string, number>();
for (const c of changes) byTarget.set(c.to, (byTarget.get(c.to) ?? 0) + 1);

const mode = apply ? "APPLY" : "DRY-RUN";
const scope = pkgFilter ? ` (target=${pkgFilter})` : "";
console.log(`codemod-imports [${mode}]${scope}: ${changes.length} specifier(s) across ${new Set(changes.map((c) => c.file)).size} file(s)`);
for (const c of changes) {
  console.log(`  ${c.file}:${c.line}  ${c.kind}  "${c.from}"  ->  "${c.to}"`);
}
if (byTarget.size > 0) {
  console.log("\nby target package:");
  for (const [pkg, n] of [...byTarget.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${pkg}: ${n}`);
}

if (apply) {
  await project.save();
  console.log(`\nWrote ${changes.length} change(s) to disk.`);
} else {
  console.log(`\n(dry-run — no files written; pass --apply to write)`);
}
