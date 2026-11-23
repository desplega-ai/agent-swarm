/**
 * Driver imports that dependency-cruiser cannot see (Postgres brief check 11, D4).
 *
 * The Postgres driver is `Bun.SQL`: a named export of the built-in "bun" module
 * and a property of the `Bun` global. An import graph sees the module "bun",
 * never the `SQL` name, and never a global. This scan rejects
 * `import { SQL } from "bun"` and `Bun.SQL` outside packages/storage-postgres.
 * `check:dep-graph` runs it after depcruise, so check 11 rejects the driver in
 * both forms.
 */
import ts from "typescript";
import { listCodeFiles, parse } from "./scan";

/** Files outside the Postgres package that may use Bun.SQL. Reason on each line. */
const ALLOWED: Record<string, string> = {
  "src/be/sql-connections.ts":
    "user-configured external databases for scripts (ctx.sql), present at the base commit; never the swarm database",
};

const failures: string[] = [];
for (const file of listCodeFiles(["src", "packages"])) {
  if (file.startsWith("packages/storage-postgres/") || ALLOWED[file]) continue;
  const source = parse(file);
  const at = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "bun"
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const spec of bindings.elements) {
          if ((spec.propertyName ?? spec.name).text === "SQL") {
            failures.push(`${file}:${at(spec)} imports SQL from "bun"`);
          }
        }
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Bun" &&
      node.name.text === "SQL"
    ) {
      failures.push(`${file}:${at(node)} uses Bun.SQL`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

if (failures.length > 0) {
  console.error(
    `check:driver-imports failed (${failures.length}): Bun.SQL is used only by packages/storage-postgres (brief D4).`,
  );
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log("check:driver-imports passed.");
