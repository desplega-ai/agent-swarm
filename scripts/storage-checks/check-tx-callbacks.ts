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
let callbacks = 0;

for (const file of files) {
  const source = parse(file);
  const lineOf = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const scanBody = (body: ts.Node, txLine: number) => {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const name = calleeName(node, source);
        if (DEFERRED.test(name)) return;
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

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && /(^|\.)transaction$/.test(calleeName(node, source))) {
      const callback = node.arguments[0];
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        callbacks += 1;
        scanBody(callback.body, lineOf(node));
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
  `check:tx-callbacks passed (${callbacks} transaction callbacks in ${files.length} files).`,
);
