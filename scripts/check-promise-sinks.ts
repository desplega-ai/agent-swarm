// CI gate: Promise-typed expressions landing in sinks that tsc accepts
// silently. Covers truthiness tests, `unknown`/`any` parameters (such as
// JSON.stringify and json(res, x)), template literals, spreads, and object
// literals. This is the missed-await class that neither tsc nor the
// statement-position checker (scripts/check-floating-promises.ts) can see.
// Runs in the merge gate next to check-db-boundary.sh.
import * as path from "node:path";
import ts from "typescript";

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
  const decl = then.valueDeclaration ?? then.declarations?.[0];
  if (!decl) return false;
  return checker.getTypeOfSymbolAtLocation(then, decl).getCallSignatures().length > 0;
}

const report: string[] = [];

function flag(node: ts.Node, why: string) {
  const sf = node.getSourceFile();
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
  report.push(
    `${path.relative(repoRoot, sf.fileName)}:${line + 1}  [${why}] ${node
      .getText()
      .slice(0, 90)
      .replace(/\n/g, " ")}`,
  );
}

function check(expr: ts.Expression, why: string) {
  if (ts.isAwaitExpression(expr)) return;
  if (isThenable(checker.getTypeAtLocation(expr))) flag(expr, why);
}

for (const sf of program.getSourceFiles()) {
  const rel = path.relative(repoRoot, sf.fileName);
  if (sf.isDeclarationFile || !rel.startsWith("src/")) continue;

  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) check(node.expression, "if");
    else if (ts.isWhileStatement(node) || ts.isDoStatement(node)) check(node.expression, "loop");
    else if (ts.isConditionalExpression(node)) check(node.condition, "ternary");
    else if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
      check(node.operand, "negation");
    else if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      check(node.left, "logical");
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const target = checker.getTypeAtLocation(node.left);
      if (target.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
        check(node.right, "assign to any/unknown");
    } else if (ts.isTemplateSpan(node)) check(node.expression, "template");
    else if (ts.isPropertyAssignment(node) && !ts.isComputedPropertyName(node.name)) {
      const contextual = checker.getContextualType(node.initializer);
      if (!contextual || !isThenable(contextual)) check(node.initializer, "object property");
    } else if (ts.isShorthandPropertyAssignment(node)) {
      const contextual = checker.getContextualType(node.name);
      if (!contextual || !isThenable(contextual)) check(node.name, "shorthand property");
    } else if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) {
      check(node.expression, "spread");
    } else if (ts.isArrayLiteralExpression(node)) {
      const contextual = checker.getContextualType(node);
      for (const el of node.elements) {
        if (ts.isSpreadElement(el)) continue;
        if (contextual && isThenable(checker.getTypeAtLocation(el))) continue;
        check(el, "array element");
      }
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const sig = checker.getResolvedSignature(node);
      const args = node.arguments ?? ts.factory.createNodeArray([]);
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (!arg || ts.isAwaitExpression(arg)) continue;
        const param = sig?.parameters[i];
        if (!param) continue;
        const pDecl = param.valueDeclaration ?? param.declarations?.[0];
        if (!pDecl) continue;
        const pType = checker.getTypeOfSymbolAtLocation(param, pDecl);
        if (!(pType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) continue;
        check(arg, "any/unknown param");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

console.log(`promise-in-unsafe-sink findings: ${report.length}`);
for (const line of report) console.log(line);
process.exitCode = report.length > 0 ? 1 : 0;
