// CI gate: statement-position floating-promise checker via the TypeScript
// compiler API. Runs in the merge gate next to check-db-boundary.sh.
//
// Catches: `someAsyncFn();` as a bare statement (result discarded, not awaited),
// the regression class the async-DB refactor creates and that neither tsc nor
// biome (type-inference bails on src/be/db.ts) can see.
// Outside transaction scopes, deliberately NOT flagged: `await f()`, `void f()` (explicit opt-out),
// `.then(...)/.catch(...)/.finally(...)` chains (pre-existing idiom).
// Transaction callbacks and reachable DB helpers use the stricter ownership analysis.
import * as path from "node:path";
import ts from "typescript";
import { checkTransactionPromises } from "./db-promise-analysis";

const repoRoot = path.resolve(import.meta.dir, "..");
const configPath = path.join(repoRoot, process.argv[2] ?? "tsconfig.json");
const parsed = ts.getParsedCommandLineOfConfigFile(
  configPath,
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    },
  },
);
if (!parsed) throw new Error("failed to parse tsconfig");

const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();

function isThenable(type: ts.Type): boolean {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
  const then = type.getProperty("then");
  if (!then) return false;
  const declaration = then.valueDeclaration ?? then.declarations?.[0];
  if (!declaration) return false;
  const thenType = checker.getTypeOfSymbolAtLocation(then, declaration);
  return thenType.getCallSignatures().length > 0;
}

const SKIP_TAIL = new Set(["then", "catch", "finally"]);

type Violation = { file: string; line: number; text: string; dbLayer: boolean };
const violations: Violation[] = [];

for (const sf of program.getSourceFiles()) {
  const rel = path.relative(repoRoot, sf.fileName);
  if (sf.isDeclarationFile || !rel.startsWith("src/") || rel.startsWith("src/tests/")) continue;

  const visit = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      const callee = call.expression;
      const tailName = ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      if (!tailName || !SKIP_TAIL.has(tailName)) {
        const type = checker.getTypeAtLocation(call);
        if (isThenable(type)) {
          let dbLayer = false;
          const sig = checker.getResolvedSignature(call);
          const decl = sig?.getDeclaration();
          if (decl) {
            const declFile = path.relative(repoRoot, decl.getSourceFile().fileName);
            dbLayer =
              declFile.startsWith("src/be/") ||
              declFile.startsWith("src/http/") ||
              declFile === "src/be/db.ts";
          }
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
          violations.push({
            file: rel,
            line: line + 1,
            text: node.getText().slice(0, 90).replace(/\n/g, " "),
            dbLayer,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

for (const finding of checkTransactionPromises(program)) {
  const sf = finding.node.getSourceFile();
  violations.push({
    file: path.relative(repoRoot, sf.fileName),
    line: sf.getLineAndCharacterOfPosition(finding.node.getStart()).line + 1,
    text: `${finding.reason} ${finding.node.getText().slice(0, 90).replace(/\n/g, " ")}`,
    dbLayer: true,
  });
}

const dbOnes = violations.filter((v) => v.dbLayer);
console.log(`floating promise statements (non-test src/): ${violations.length}`);
console.log(`  of which callee declared in src/be|src/http (db layer): ${dbOnes.length}`);
for (const v of violations.slice(0, 40)) {
  console.log(`${v.dbLayer ? "DB " : "   "}${v.file}:${v.line}  ${v.text}`);
}
if (violations.length > 40) console.log(`... and ${violations.length - 40} more`);
process.exitCode = violations.length > 0 ? 1 : 0;
