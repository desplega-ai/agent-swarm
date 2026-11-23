// Author-time helper: list abstract members of each Base*Repository and emit
// Postgres subclasses whose unimplemented members throw.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const root = process.argv[2]!;
const repoDir = `${root}/packages/storage/src/repositories`;
const outDir = `${root}/packages/storage-postgres/src/repositories`;
mkdirSync(outDir, { recursive: true });
const summary: string[] = [];
const builtinsAll = new Set([
  "Promise",
  "Record",
  "Set",
  "Map",
  "Array",
  "Readonly",
  "ReadonlyArray",
  "ReadonlySet",
  "Partial",
  "Pick",
  "Omit",
  "Date",
  "Uint8Array",
  "Buffer",
  "Exclude",
  "Extract",
  "NonNullable",
  "ReturnType",
  "T",
]);
for (const file of readdirSync(repoDir).filter((f) => f.endsWith(".ts") && f !== "index.ts")) {
  const text = readFileSync(`${repoDir}/${file}`, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  sf.forEachChild((node) => {
    if (!ts.isClassDeclaration(node) || !node.name?.text.startsWith("Base")) return;
    const base = node.name.text;
    const pgName = base.replace(/^Base/, "Postgres");
    const members: string[] = [];
    for (const m of node.members) {
      const mods = ts.getModifiers(m) ?? [];
      if (!mods.some((x) => x.kind === ts.SyntaxKind.AbstractKeyword)) continue;
      if (!ts.isMethodDeclaration(m)) continue;
      const isProtected = mods.some((x) => x.kind === ts.SyntaxKind.ProtectedKeyword);
      const sig = m
        .getText(sf)
        .replace(/^\s*(protected\s+)?abstract\s+/, "")
        .replace(/;\s*$/, "");
      members.push(
        `  ${isProtected ? "protected " : ""}${sig} {\n    return notOnPostgresYet("${pgName}.${(m.name as ts.Identifier).getText(sf)}");\n  }`,
      );
    }
    const domain = file.replace(/\.ts$/, "");
    const out = `${outDir}/${domain}.ts`;
    summary.push(`${domain}: ${members.length}`);
    if (existsSync(out)) {
      // Append stubs for abstract members the Postgres class does not define yet.
      let current = readFileSync(out, "utf8");
      const missing = members.filter((m) => {
        const name = m.match(/^\s*(?:protected )?(\w+)/)?.[1] ?? "";
        return !new RegExp(`\\n\\s*(?:protected |async |override )*${name}\\s*[(<]`).test(current);
      });
      if (missing.length === 0) return;
      const end = current.lastIndexOf("}");
      current = `${current.slice(0, end).trimEnd()}\n\n${missing.join("\n\n")}\n}\n`;
      if (!current.includes(`from "./not-yet"`)) {
        current = `import { notOnPostgresYet } from "./not-yet";\n${current}`;
      }
      const needed = [
        ...new Set(missing.flatMap((m) => m.match(/\b[A-Z][A-Za-z0-9_]*\b/g) ?? [])),
      ].filter(
        (id) =>
          !builtinsAll.has(id) &&
          id !== pgName &&
          id !== base &&
          !new RegExp(`\\b${id}\\b`).test(readFileSync(out, "utf8")),
      );
      if (needed.length)
        current = `import type { ${needed.sort().join(", ")} } from "@desplega/storage";\n${current}`;
      writeFileSync(out, current);
      summary.push(`${domain}: +${missing.length} appended`);
      return;
    }
    const builtins = new Set([
      "Promise",
      "Record",
      "Set",
      "Map",
      "Array",
      "Readonly",
      "ReadonlyArray",
      "ReadonlySet",
      "Partial",
      "Pick",
      "Omit",
      "Date",
      "Uint8Array",
      "Buffer",
      "Exclude",
      "Extract",
      "NonNullable",
      "ReturnType",
    ]);
    const used = new Set<string>();
    for (const m of members)
      for (const id of m.match(/\b[A-Z][A-Za-z0-9_]*\b/g) ?? [])
        if (!builtins.has(id) && id !== pgName && id !== base) used.add(id);
    const typeImports = [...used].sort();
    const importLine = typeImports.length
      ? `import { ${base}, ${typeImports.map((t) => `type ${t}`).join(", ")} } from "@desplega/storage";`
      : `import { ${base} } from "@desplega/storage";`;
    const body = members.length
      ? `${importLine}\nimport { notOnPostgresYet } from "./not-yet";\n\nexport class ${pgName} extends ${base} {\n${members.join("\n\n")}\n}\n`
      : `import { ${base} } from "@desplega/storage";\n\nexport class ${pgName} extends ${base} {}\n`;
    writeFileSync(out, body);
  });
}
console.log(summary.join("\n"));
