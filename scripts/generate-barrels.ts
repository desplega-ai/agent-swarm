#!/usr/bin/env bun
/**
 * generate-barrels.ts — Phase-1 monorepo bridge generator.
 *
 * Reads `packages.map.json` and emits, for each `@swarm/<pkg>`:
 *   - packages/<pkg>/package.json   (private source-only shim)
 *   - packages/<pkg>/index.ts       (barrel re-exporting the package's live src/ sources)
 *
 * The barrel makes `import { x } from "@swarm/<pkg>"` resolve to the real code that
 * still lives under src/ (no files move in Phase 1). Re-exports use RELATIVE paths
 * (`export * from "../../src/<path>"`).
 *
 * Collision handling (TS2308 under verbatimModuleSyntax):
 *   - A file whose exported names don't clash with already-emitted flat files -> `export *`.
 *   - A file that WOULD clash -> `export * as <ns>` (whole file namespaced; still importable).
 *   - Default exports (not carried by `export *`) -> `export { default as <Name> }`.
 *
 * Idempotent. Re-run after editing packages.map.json:  bun scripts/generate-barrels.ts
 */
import { Project, SyntaxKind } from "ts-morph";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const ROOT = process.cwd();
const MAP_PATH = join(ROOT, "packages.map.json");

type PkgDef = { layer: number; sources: string[]; notes?: string };
const rawMap = JSON.parse(readFileSync(MAP_PATH, "utf8")) as Record<string, unknown>;
const map: Record<string, PkgDef> = {};
for (const [k, v] of Object.entries(rawMap)) {
  if (v && typeof v === "object" && Array.isArray((v as PkgDef).sources)) map[k] = v as PkgDef;
}

// ---- ownership resolver (same algorithm the codemod uses) --------------------
type Entry = { kind: "file" | "dir"; path: string; pkg: string };
const entries: Entry[] = [];
for (const [pkg, def] of Object.entries(map)) {
  for (const s of def.sources) {
    entries.push({ kind: s.endsWith("/") ? "dir" : "file", path: s, pkg });
  }
}
function resolveOwner(rel: string): string | null {
  for (const e of entries) if (e.kind === "file" && e.path === rel) return e.pkg;
  let best: Entry | null = null;
  for (const e of entries) {
    if (e.kind === "dir" && rel.startsWith(e.path) && (!best || e.path.length > best.path.length)) best = e;
  }
  return best ? best.pkg : null;
}

// ---- file walk ---------------------------------------------------------------
const MODULE_EXT = /\.(ts|tsx)$/;
const SKIP = /\.(test|spec)\.(ts|tsx)$/;
function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "tests") continue;
      walk(full, acc);
    } else if (MODULE_EXT.test(name) && !name.endsWith(".d.ts") && !SKIP.test(name)) {
      acc.push(full);
    }
  }
  return acc;
}

const allFiles = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "templates"))];

// group owned files by package (relative posix paths)
const byPkg: Record<string, string[]> = {};
for (const abs of allFiles) {
  const rel = relative(ROOT, abs).split("\\").join("/");
  const owner = resolveOwner(rel);
  if (!owner) continue;
  (byPkg[owner] ||= []).push(rel);
}

// ---- export enumeration (syntactic, no type-checker) -------------------------
const project = new Project({
  skipAddingFilesFromTsConfig: true,
  skipFileDependencyResolution: true,
  compilerOptions: { allowJs: true, jsx: 4 /* react-jsx */ },
});

function resolveModuleFile(fromAbs: string, spec: string): string | null {
  let baseDir: string;
  if (spec.startsWith("@/")) baseDir = join(ROOT, "src");
  else if (spec.startsWith(".")) baseDir = dirname(fromAbs);
  else return null; // external
  const rest = spec.startsWith("@/") ? spec.slice(2) : spec;
  const target = join(baseDir, rest);
  const cands = [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    join(target, "index.ts"),
    join(target, "index.tsx"),
  ];
  for (const c of cands) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

type Exports = { names: Set<string>; hasDefault: boolean };
const exportCache = new Map<string, Exports>();
function getExports(absFile: string, seen = new Set<string>()): Exports {
  const cached = exportCache.get(absFile);
  if (cached && seen.size === 0) return cached;
  if (seen.has(absFile)) return { names: new Set(), hasDefault: false };
  seen.add(absFile);
  const names = new Set<string>();
  let hasDefault = false;
  const sf = project.addSourceFileAtPathIfExists(absFile);
  if (!sf) return { names, hasDefault };

  const collect = (decls: { isExported(): boolean; isDefaultExport(): boolean; getName(): string | undefined }[]) => {
    for (const d of decls) {
      if (!d.isExported()) continue;
      if (d.isDefaultExport()) hasDefault = true;
      else {
        const n = d.getName();
        if (n) names.add(n);
      }
    }
  };
  collect(sf.getFunctions() as never);
  collect(sf.getClasses() as never);
  for (const i of sf.getInterfaces()) if (i.isExported() && !i.isDefaultExport()) names.add(i.getName());
  for (const t of sf.getTypeAliases()) if (t.isExported()) names.add(t.getName());
  for (const e of sf.getEnums()) if (e.isExported()) names.add(e.getName());
  for (const m of sf.getModules()) if (m.isExported() && m.getName()) names.add(m.getName().replace(/['"]/g, ""));
  for (const vs of sf.getVariableStatements()) {
    if (!vs.isExported()) continue;
    for (const d of vs.getDeclarations()) names.add(d.getName());
  }
  for (const ea of sf.getExportAssignments()) if (!ea.isExportEquals()) hasDefault = true;

  for (const ed of sf.getExportDeclarations()) {
    const named = ed.getNamedExports();
    const ns = ed.getNamespaceExport();
    const mod = ed.getModuleSpecifierValue();
    if (ns) {
      names.add(ns.getName());
    } else if (named.length > 0) {
      for (const ne of named) {
        const alias = ne.getAliasNode();
        names.add((alias ?? ne.getNameNode()).getText());
      }
    } else if (mod) {
      // bare `export * from "mod"` — recurse for relative/@ targets
      const target = resolveModuleFile(absFile, mod);
      if (target) {
        const sub = getExports(target, seen);
        for (const n of sub.names) names.add(n);
        // a re-export star does NOT carry the default through
      }
    }
  }
  const result = { names, hasDefault };
  if (seen.size === 1) exportCache.set(absFile, result);
  return result;
}

function pascal(s: string): string {
  return s
    .replace(/\.(ts|tsx)$/, "")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

// ---- emit --------------------------------------------------------------------
function barrelFor(pkg: string): string {
  const header = [
    `// AUTO-GENERATED by scripts/generate-barrels.ts — DO NOT EDIT BY HAND.`,
    `// Phase-1 monorepo bridge: re-exports ${pkg}'s live src/ sources so it is`,
    `// importable by package name before any files move. Regenerate after editing`,
    `// packages.map.json:  bun scripts/generate-barrels.ts`,
    ``,
  ];
  if (pkg === "@swarm/api-client") {
    return [
      ...header,
      `// NET-NEW package — to be GENERATED from openapi.json / the route registry in a`,
      `// later phase. Intentionally exports nothing real yet.`,
      `// TODO(phase>=2): generate a typed worker HTTP client and replace this placeholder.`,
      `export {};`,
      ``,
    ].join("\n");
  }
  const files = (byPkg[pkg] ?? []).slice().sort();
  if (files.length === 0) {
    return [...header, `// No src/ sources resolved for this package in Phase 1.`, `export {};`, ``].join("\n");
  }

  const lines: string[] = [...header];
  const claimedFlat = new Set<string>(); // names already exported flat
  const usedDefaultAlias = new Set<string>();

  for (const rel of files) {
    const abs = join(ROOT, rel);
    const importPath = `../../${rel.replace(MODULE_EXT, "")}`;
    const { names, hasDefault } = getExports(abs);

    const clashes = [...names].some((n) => claimedFlat.has(n));
    if (clashes) {
      // namespace the whole file to avoid TS2308
      let ns = pascal(rel.replace(/^src\//, "").replace(/^templates\//, "tpl/"));
      let n = ns;
      let i = 2;
      while (usedDefaultAlias.has(n)) n = ns + i++;
      usedDefaultAlias.add(n);
      lines.push(`export * as ${n} from "${importPath}";`);
    } else {
      lines.push(`export * from "${importPath}";`);
      for (const nm of names) claimedFlat.add(nm);
    }

    if (hasDefault) {
      let base = pascal(rel.split("/").slice(-2).join("-"));
      if (!base) base = "Default";
      let alias = base;
      let i = 2;
      while (usedDefaultAlias.has(alias) || claimedFlat.has(alias)) alias = base + i++;
      usedDefaultAlias.add(alias);
      claimedFlat.add(alias);
      lines.push(`export { default as ${alias} } from "${importPath}";`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

let count = 0;
for (const pkg of Object.keys(map)) {
  const shortName = pkg.replace("@swarm/", "");
  const dir = join(ROOT, "packages", shortName);
  mkdirSync(dir, { recursive: true });
  const pkgJson = {
    name: pkg,
    version: "0.0.0",
    private: true,
    type: "module",
    main: "index.ts",
  };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkgJson, null, 2)}\n`);
  writeFileSync(join(dir, "index.ts"), barrelFor(pkg));
  count++;
}
console.log(`Generated ${count} package shims under packages/`);
