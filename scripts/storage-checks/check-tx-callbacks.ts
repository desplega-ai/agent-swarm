/**
 * check:tx-callbacks (Postgres brief check 15, decision D6).
 *
 * A transaction callback may run more than once: Postgres retries it after a
 * serialization failure, and `--tx-replay` replays every first attempt. A side
 * effect inside the callback then happens twice, or happens for an attempt that
 * rolled back. This check rejects the known side effects written directly in a
 * callback body. Put them in `afterCommit(...)` (or `afterRollback(...)`),
 * whose arguments the check skips.
 *
 * It reads one function body: a side effect reached through another function
 * is out of its sight. `--tx-replay` catches those by execution.
 */
import ts from "typescript";
import { listCodeFiles, parse } from "./scan";

const SIDE_EFFECTS: [RegExp, string][] = [
  [/^fetch$/, "network call"],
  [/^(Bun\.spawn|Bun\.spawnSync|spawn|spawnSync|exec|execSync)$/, "process spawn"],
  [/^(setTimeout|setInterval|setImmediate|queueMicrotask)$/, "timer"],
  [/(^|\.)emit$|^emit[A-Z]\w*$|(^|\.)publish\w*$/, "event emit"],
  [/^telemetry\.\w+$/, "telemetry"],
  [/^ensure$/, "business-use event"],
  [
    /^(writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rm|rmSync|mkdir|mkdirSync|Bun\.write)$/,
    "file write",
  ],
  [/^send(Slack|Email|Message|Notification|Webhook)\w*$/, "outbound message"],
];

/**
 * Functions whose names look like a side effect but that only schedule one
 * through afterCommit themselves. Reason on each line (brief section 10).
 */
const DEFERS_INTERNALLY: Record<string, string> = {
  emitRunFinished:
    "src/be/db/workflow-runs.ts schedules the bus emit with getDbClient().afterCommit",
};

/** Calls whose function arguments run after the transaction, not inside it. */
const DEFERRED = /(^|\.)(afterCommit|afterRollback)$/;

function calleeName(call: ts.CallExpression, source: ts.SourceFile): string {
  return call.expression.getText(source).replace(/\s+/g, "").replace(/\?\./g, ".");
}

const files = listCodeFiles(["src", "packages/storage/src", "packages/storage-sqlite/src"]);
const failures: string[] = [];
const excuses: string[] = [];
let callbacks = 0;

for (const file of files) {
  const source = parse(file);
  const lineOf = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  /** Names declared inside `root` (parameters, variables, functions, catch bindings). */
  const declaredIn = (root: ts.Node): Set<string> => {
    const names = new Set<string>();
    const addBinding = (name: ts.BindingName) => {
      if (ts.isIdentifier(name)) names.add(name.text);
      else
        for (const element of name.elements)
          if (!ts.isOmittedExpression(element)) addBinding(element.name);
    };
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node))
        addBinding(node.name);
      else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name)
        names.add(node.name.text);
      ts.forEachChild(node, visit);
    };
    visit(root);
    return names;
  };

  /** The root identifier of `a`, `a.b`, `a[i]`; null for `this.x` and calls. */
  const rootName = (expr: ts.Expression): string | null => {
    let current: ts.Expression = expr;
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))
      current = current.expression;
    return ts.isIdentifier(current) ? current.text : null;
  };

  const MUTATORS = /^(push|unshift|splice|set|add|delete|clear)$/;
  const ASSIGN = new Set([
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.PlusEqualsToken,
    ts.SyntaxKind.MinusEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
  ]);

  const lines = source.getFullText().split("\n");
  /**
   * A reasoned exception: `// tx-replay-safe: <reason>` on the line above, or
   * on the same line. Use it only for state that the callback resets at its
   * start, so each attempt begins from the same value (brief section 10).
   */
  const excused = (node: ts.Node): boolean => {
    const line = lineOf(node);
    for (const text of [lines[line - 1], lines[line - 2]]) {
      const match = text?.match(/\/\/ tx-replay-safe:\s*(\S.*)$/);
      if (match) {
        excuses.push(`${file}:${line} ${match[1]}`);
        return true;
      }
    }
    return false;
  };

  const scanBody = (body: ts.Node, txLine: number, callback: ts.Node) => {
    const local = declaredIn(callback);
    const outer = (name: string | null) => name !== null && !local.has(name);
    const visit = (node: ts.Node) => {
      // State outside the callback that the callback changes: a replayed
      // attempt changes it twice (decision D6). Build the value inside the
      // callback and return it instead.
      if (
        ts.isBinaryExpression(node) &&
        ASSIGN.has(node.operatorToken.kind) &&
        outer(rootName(node.left as ts.Expression)) &&
        !excused(node)
      ) {
        failures.push(
          `${file}:${lineOf(node)} assigns ${node.left.getText(source)}, declared outside the transaction callback at line ${txLine}: return the value from the callback instead`,
        );
      }
      if (
        (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken) &&
        outer(rootName(node.operand)) &&
        !excused(node)
      ) {
        failures.push(
          `${file}:${lineOf(node)} updates ${node.operand.getText(source)}, declared outside the transaction callback at line ${txLine}: return the value from the callback instead`,
        );
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        MUTATORS.test(node.expression.name.text) &&
        outer(rootName(node.expression.expression)) &&
        !/^(Object|Array|JSON|Math|console)$/.test(rootName(node.expression.expression) ?? "") &&
        !excused(node)
      ) {
        failures.push(
          `${file}:${lineOf(node)} mutates ${node.expression.getText(source)}, declared outside the transaction callback at line ${txLine}: return the value from the callback instead`,
        );
      }
      if (ts.isCallExpression(node)) {
        const name = calleeName(node, source);
        if (DEFERRED.test(name)) return;
        // A nested function runs when called; its own body is scanned only if
        // it is itself a transaction callback.
        if (DEFERS_INTERNALLY[name]) {
          ts.forEachChild(node, visit);
          return;
        }
        for (const [pattern, kind] of SIDE_EFFECTS) {
          if (pattern.test(name)) {
            failures.push(
              `${file}:${lineOf(node)} ${kind} ${name}() inside the transaction callback at line ${txLine}: move it to afterCommit`,
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(body);
  };

  // A callback passed by name (`.transaction(claimStep)`) is scanned when the
  // same file declares it as a function.
  const namedFunctions = new Map<string, ts.FunctionLikeDeclaration>();
  const collect = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      namedFunctions.set(node.name.text, node);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      namedFunctions.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && /(^|\.)transaction$/.test(calleeName(node, source))) {
      const argument = node.arguments[0];
      const callback =
        argument && ts.isIdentifier(argument) ? namedFunctions.get(argument.text) : argument;
      if (
        callback?.body &&
        (ts.isArrowFunction(callback) ||
          ts.isFunctionExpression(callback) ||
          ts.isFunctionDeclaration(callback))
      ) {
        callbacks += 1;
        scanBody(callback.body, lineOf(node), callback);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

if (failures.length > 0) {
  console.error(`check:tx-callbacks failed (${failures.length}):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(
  `check:tx-callbacks passed (${callbacks} transaction callbacks in ${files.length} files, ${excuses.length} tx-replay-safe exceptions).`,
);
for (const excuse of excuses) console.log(`  tx-replay-safe ${excuse}`);
