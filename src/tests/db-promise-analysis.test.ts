import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { checkTransactionPromises } from "../../scripts/db-promise-analysis";

const librarySources = new Map<string, ts.SourceFile>();

const cases: [string, string, boolean, string?, string?][] = [
  ["imported awaited helper", "await imported(tx);", true],
  ["imported floated helper", "void imported(tx);", false],
  ["imported helper discard", "await badImported(tx);", false],
  [
    "memoized callable",
    'function once(fn: () => Promise<void>) { let value: Promise<void> | undefined; return () => (value ??= fn()); } const read = once(async () => { await tx.run("sql"); }); await read();',
    true,
  ],
  ["awaited", 'await tx.run("sql");', true],
  ["returned", 'return tx.run("sql");', true],
  ["joined", 'await Promise.all([tx.run("sql"), client.run("sql")]);', true],
  ["settled", 'await Promise.allSettled([tx.run("sql")]);', true],
  ["stored join", 'const pending = tx.run("sql"); await pending;', true],
  [
    "stored array join",
    'const pending = [tx.run("sql"), client.run("sql")]; await Promise.all(pending);',
    true,
  ],
  ["returned chain", 'return tx.run("sql").finally(() => {}).catch(() => {});', true],
  ["awaited helper", 'async function helper() { await tx.run("sql"); } await helper();', true],
  ["ambient helper", 'async function helper() { return client.run("sql"); } await helper();', true],
  ["nested", 'await client.transaction(async inner => { await inner.run("sql"); });', true],
  ["joined callbacks", 'await Promise.all([1,2].map(async () => { await tx.run("sql"); }));', true],
  ["awaited array", 'await [tx.run("sql")];', false],
  ["returned array", 'return [tx.run("sql")];', false],
  ["awaited stored array", 'const pending = [tx.run("sql")]; await pending;', false],
  ["awaited map", 'await [1].map(async () => { await tx.run("sql"); });', false],
  ["returned map", 'return [1].map(async () => { await tx.run("sql"); });', false],
  ["bare", 'tx.run("sql");', false],
  ["void", 'void tx.run("sql");', false],
  ["then", 'tx.run("sql").then(() => {});', false],
  ["catch", 'tx.run("sql").catch(() => {});', false],
  ["finally", 'void tx.run("sql").finally(() => {});', false],
  ["stored abandoned", 'const pending = tx.run("sql");', false],
  ["conditional join", 'const pending = tx.run("sql"); if (Math.random()) await pending;', false],
  ["conditional creation", 'return Math.random() ? tx.run("sql") : Promise.resolve();', true],
  ...[
    "Math.random() && await pending;",
    "Math.random() || await pending;",
    "Math.random() ? await pending : undefined;",
    "return Math.random() ? pending : Promise.resolve();",
    "await Promise.all(Math.random() ? [pending] : []);",
    "await Promise.allSettled(Math.random() ? [pending] : []);",
    "const fallback: number | undefined = Math.random() ? 1 : undefined; fallback ?? await pending;",
    "let done = false; done &&= (await pending, true);",
    "const callback: ((value: void) => void) | undefined = Math.random() ? () => {} : undefined; callback?.(await pending);",
    "const { value = await pending } = { value: 1 };",
    "const [value = await pending] = [1];",
    "let value: number | void; ({ value = await pending } = { value: 1 });",
    "let value: number | void; ({ value: value = await pending } = { value: 1 });",
    "let value: number | void; [value = await pending] = [1];",
  ].map((join): [string, string, boolean, string] => [
    `stored conditional consumption: ${join}`,
    `async function helper() { await Promise.resolve(); await client.run("sql"); } const pending = helper(); ${join}`,
    false,
    "Await, return, or join transaction work. Detached work is unsupported.",
  ]),
  [
    "early return",
    'const pending = tx.run("sql"); if (Math.random()) return; await pending;',
    false,
  ],
  ["hidden helper", 'async function helper() { await tx.run("sql"); } void helper();', false],
  ["helper abandonment", 'async function helper() { void tx.run("sql"); } await helper();', false],
  ["ambient abandonment", 'async function helper() { await client.run("sql"); } helper();', false],
  [
    "nested abandonment",
    'void client.transaction(async inner => { await inner.run("sql"); });',
    false,
  ],
  ["timer", 'setTimeout(async () => { await tx.run("sql"); }, 0);', false],
  ["forEach", '[1].forEach(async () => { await tx.run("sql"); });', false],
  ["race", 'await Promise.race([tx.run("sql")]);', false],
  ["dynamic executor", "opaque(tx);", false],
  ["executor storage", "const escaped = { tx };", false],
  ["method alias", 'const run = tx.run; void run("sql");', false],
  [
    "hidden callback discard",
    'function invoke(fn: () => Promise<void>) { void fn(); } invoke(async () => { await tx.run("sql"); });',
    false,
  ],
  ["awaited opaque callback", 'await opaque(async () => { await tx.run("sql"); });', false],
  [
    "lazy factory discard",
    'function factory() { void tx.run("sql"); return () => {}; } const lazy = factory();',
    false,
  ],
  [
    "constructor callback",
    'await new Promise<void>(resolve => { void tx.run("sql"); resolve(); });',
    false,
  ],
  [
    "constructor helper",
    'async function helper() { await tx.run("sql"); } new Promise(() => helper());',
    false,
  ],
  ["returned executor closure", 'return async () => { await tx.run("sql"); };', false],
  [
    "awaited executor closure",
    'return await (async () => { await tx.run("sql"); });',
    false,
    "Do not return transaction executors or DB helpers from their scope.",
  ],
  [
    "awaited factory closure",
    'async function factory() { return async () => { await tx.run("sql"); }; } return await factory();',
    false,
    "Do not return transaction executors or DB helpers from their scope.",
  ],
  ["returned awaited statement", 'return await tx.run("sql");', true],
  ...[
    'return await (Math.random() ? async () => { await tx.run("sql"); } : async () => {});',
    'return await (Math.random() ? async () => { await tx.run("sql"); } : undefined);',
    'return Math.random() ? async () => { await tx.run("sql"); } : undefined;',
    'async function factory() { return Math.random() ? async () => { await tx.run("sql"); } : async () => {}; } return await factory();',
    'async function factory() { return Math.random() ? async () => { await tx.run("sql"); } : undefined; } return await factory();',
    'async function work() { await tx.run("sql"); } return await (Math.random() ? work : async () => {});',
    'async function work() { await tx.run("sql"); } return await (Math.random() && work);',
    'async function work() { await tx.run("sql"); } return await (Math.random() || work);',
    'async function work() { await tx.run("sql"); } const fallback = Math.random() ? 1 : undefined; return await (fallback ?? work);',
    'return await ((async () => { await tx.run("sql"); }) satisfies (() => Promise<void>));',
  ].map((body): [string, string, boolean, string] => [
    `returned closure alternative: ${body}`,
    body,
    false,
    "Do not return transaction executors or DB helpers from their scope.",
  ]),
  ["conditional plain result", 'await tx.run("sql"); return Math.random() ? 1 : 2;', true],
  [
    "stored assignment join",
    'const pending = tx.run("sql"); let result: void; result = await pending;',
    true,
  ],
  [
    "configured shorthand callback discard",
    'await invokeConfigured("ordinary argument");',
    false,
    "Await, return, or join transaction work. Detached work is unsupported.",
    `type Dependencies = {write: (value: string) => Promise<void>};
let dependencies: Dependencies;
function configure(value: Dependencies) { dependencies = value; }
async function write(value: string) { void client.run(value).catch(() => {}); }
configure({write});
async function invokeConfigured(value: string) { await dependencies.write(value); }`,
  ],
  ...[true, false].map((joined): [string, string, boolean, string?, string?] => [
    `configured ambient helper ${joined ? "joined" : "discarded"}`,
    'await invokeConfigured("ordinary argument");',
    joined,
    joined ? undefined : "Await, return, or join transaction work. Detached work is unsupported.",
    `type Dependencies = {write: (value: string) => Promise<void>};
let dependencies: Dependencies;
function configure(value: Dependencies) { dependencies = value; }
async function implementation(value: string) { ${joined ? "await" : "void"} client.run(value).catch(() => {}); }
configure({write: value => implementation(value)});
async function invokeConfigured(value: string) { await dependencies.write(value); }`,
  ]),
  [
    "returned factory closure",
    'function factory() { return async () => { await tx.run("sql"); }; } return factory();',
    false,
  ],
  [
    "helper stores executor",
    "const box: {tx?: unknown} = {}; function stash() { box.tx = tx; } stash();",
    false,
  ],
  ["helper returns executor", "function reveal() { return tx; } return reveal();", false],
  [
    "object callback",
    'const object = { work: async () => { await tx.run("sql"); } }; await object.work();',
    false,
  ],
  [
    "object method closure",
    'const object = { async work() { await tx.run("sql"); } }; opaque(object);',
    false,
  ],
  [
    "class method closure",
    'class Work { async run() { await tx.run("sql"); } } opaque(new Work());',
    false,
  ],
  [
    "assigned callback",
    'let work: () => Promise<void>; work = async () => { await tx.run("sql"); }; await work();',
    false,
  ],
  ["hook client work", 'client.afterCommit(async () => { await client.run("sql"); });', true],
  ["hook executor capture", 'client.afterCommit(async () => { await tx.run("sql"); });', false],
  [
    "hook helper capture",
    'async function helper() { await tx.run("sql"); } client.afterCommit(helper);',
    false,
  ],
  ["opaque map callback", 'declareMap.map(async () => { await tx.run("sql"); });', false],
  [
    "shadowed join",
    'const Promise = { all: (_: unknown[]) => globalThis.Promise.resolve() }; await Promise.all([tx.run("sql")]);',
    false,
  ],
  ["erased callback executor", 'const db: any = tx; void db.run("sql");', false],
  [
    "erased ambient client helper",
    'async function helper() { const db: any = getClient(); void db.run("sql"); } await helper();',
    false,
  ],
  [
    "erased helper parameter",
    'async function helper(db: any) { await db.run("sql"); } await helper(tx);',
    false,
  ],
  [
    "erased captured client helper",
    'async function helper() { const db: any = client; void db.run("sql"); } await helper();',
    false,
  ],
  ["awaited method alias", 'const run = tx.run; await run("sql");', false],
  ["destructured executor", 'const { run } = tx; await run("sql");', false],
  ["background outside scope", 'await tx.run("sql");', true],
];
const declarations = `export interface DbExecutor { run(sql: string): Promise<void>; }
export interface DbClient extends DbExecutor {
 transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T>;
 afterCommit(fn: () => void | Promise<void>): void;
}`;

describe("transaction promise consumption corpus", () => {
  for (const [name, body, accepted, reason, setup] of cases) {
    test(name, () => {
      const source = `import type { DbClient } from './be/db-client';
import { imported, badImported } from './helper';
${setup ? "import { invokeConfigured } from './configured';" : ""}
declare const client: DbClient;
declare function getClient(): DbClient;
declare function opaque(value: unknown): void;
declare const declareMap: {map(fn: () => Promise<void>): Promise<void>};
void Promise.resolve().then(() => {});
client.afterCommit(async () => { await client.run('outside'); });
async function example() { await client.transaction(async tx => { ${body} }); }`;
      const files = new Map([
        ["/corpus/src/be/db-client.ts", declarations],
        [
          "/corpus/src/helper.ts",
          `import type { DbExecutor } from './be/db-client'; export async function imported(tx: DbExecutor) { await tx.run('sql'); } export async function badImported(tx: DbExecutor) { void tx.run('sql'); }`,
        ],
        ["/corpus/src/case.ts", source],
      ]);
      if (setup)
        files.set(
          "/corpus/src/configured.ts",
          `import type { DbClient } from './be/db-client'; declare const client: DbClient;
${setup}
export { invokeConfigured };`,
        );
      const options: ts.CompilerOptions = {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.Preserve,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true,
        skipLibCheck: true,
      };
      const host = ts.createCompilerHost(options);
      const read = host.readFile.bind(host);
      const exists = host.fileExists.bind(host);
      host.fileExists = (file) => files.has(file) || exists(file);
      host.readFile = (file) => files.get(file) ?? read(file);
      host.directoryExists = (dir) => dir.startsWith("/corpus") || ts.sys.directoryExists(dir);
      host.getSourceFile = (file, version) => {
        const cached = librarySources.get(file);
        if (cached) return cached;
        const text = host.readFile(file);
        if (text === undefined) return undefined;
        const sourceFile = ts.createSourceFile(file, text, version, true);
        if (!files.has(file)) librarySources.set(file, sourceFile);
        return sourceFile;
      };
      const program = ts.createProgram([...files.keys()], options, host);
      expect(
        program
          .getSemanticDiagnostics()
          .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
      ).toEqual([]);
      const findings = checkTransactionPromises(program);
      expect(findings.map((finding) => finding.reason).length === 0).toBe(accepted);
      if (reason) expect(findings.map((finding) => finding.reason)).toContain(reason);
    });
  }
});
