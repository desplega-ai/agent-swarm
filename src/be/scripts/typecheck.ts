import ts from "typescript";

/**
 * Structured diagnostic record returned to API callers when typecheck fails.
 *
 * Mirrors the most useful subset of the TypeScript compiler diagnostic — file
 * path + line/col, the diagnostic code, the offending identifier (when the
 * diagnostic is about a name lookup), and an optional `suggestion` for "did
 * you mean…" hints surfaced by the compiler.
 */
export type ScriptDiagnostic = {
  severity: "error" | "warning" | "suggestion" | "message";
  code: number;
  message: string;
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  identifier?: string;
  suggestion?: string;
};

export type ScriptTypecheckResult =
  | { ok: true }
  | { ok: false; diagnostics: string[]; structured: ScriptDiagnostic[] };

export const SCRIPT_SDK_TYPES = `
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ScriptScope = "agent" | "global";
export type ScriptFsMode = "none" | "workspace-rw";

export interface Redacted<T> {
  readonly __redactedBrand?: T;
  toString(): "<redacted>";
  toJSON(): "<redacted>";
}

export interface RedactedStatic {
  value<T>(self: Redacted<T>): T;
  meta<T>(self: Redacted<T>): { type: "system" | "user"; isSecret: boolean };
  isSecret<T>(self: Redacted<T>): boolean;
}

export interface SwarmConfig {
  apiKey: Redacted<string>;
  agentId: Redacted<string>;
  mcpBaseUrl: Redacted<string>;
  get<T = string>(key: string): Redacted<T> | undefined;
}

export interface SwarmSdk {
  memory_search(args: { query: string; scope?: "all" | "agent" | "swarm"; limit?: number; source?: string }): Promise<unknown>;
  memory_get(args: { memoryId: string }): Promise<unknown>;
  memory_rate(args: { id: string; useful: boolean; note?: string }): Promise<unknown>;
  task_list(args?: Record<string, unknown>): Promise<unknown>;
  task_get(args: { taskId: string }): Promise<unknown>;
  task_storeProgress(args: Record<string, unknown>): Promise<unknown>;
  kv_get(args: { key: string; namespace?: string }): Promise<unknown>;
  kv_set(args: { key: string; value: unknown; namespace?: string; ttlSeconds?: number; valueType?: "string" | "json" | "integer" }): Promise<unknown>;
  kv_del(args: { key: string; namespace?: string }): Promise<unknown>;
  kv_incr(args: { key: string; by?: number; namespace?: string }): Promise<unknown>;
  kv_list(args?: { prefix?: string; namespace?: string; limit?: number }): Promise<unknown>;
  repo_list(args?: Record<string, unknown>): Promise<unknown>;
  schedule_list(args?: Record<string, unknown>): Promise<unknown>;
  script_search(args: { query?: string; scope?: ScriptScope; limit?: number }): Promise<unknown>;
  script_run(args: { name?: string; source?: string; args?: unknown; intent?: string; scope?: ScriptScope; fsMode?: ScriptFsMode }): Promise<unknown>;
}

export interface ScriptStdlib {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  fetchJson(input: string | URL | Request, init?: RequestInit): Promise<unknown>;
  grep(pattern: string, files?: string | string[]): Promise<string>;
  glob(pattern: string): Promise<string[]>;
  table(rows: Array<Record<string, unknown>>): string;
  Redacted: RedactedStatic;
}

export interface ScriptLogger extends Console {}

export interface ScriptContext {
  swarm: SwarmSdk & { config: SwarmConfig };
  stdlib: ScriptStdlib;
  logger: ScriptLogger;
}

// biome-ignore lint/suspicious/noExplicitAny: scripts may narrow their args type at the entrypoint.
export type ScriptMain = (args: any, ctx: ScriptContext) => unknown | Promise<unknown>;
`;

export const SCRIPT_STDLIB_TYPES = `
declare module "stdlib" {
  export interface Redacted<T> {
    readonly __redactedBrand?: T;
    toString(): "<redacted>";
    toJSON(): "<redacted>";
  }
  export const Redacted: {
    value<T>(self: Redacted<T>): T;
    meta<T>(self: Redacted<T>): { type: "system" | "user"; isSecret: boolean };
    isSecret<T>(self: Redacted<T>): boolean;
  };
  export function fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  export function fetchJson(input: string | URL | Request, init?: RequestInit): Promise<unknown>;
  export function grep(pattern: string, files?: string | string[]): Promise<string>;
  export function glob(pattern: string): Promise<string[]>;
  export function table(rows: Array<Record<string, unknown>>): string;
}

declare module "swarm-sdk" {
${SCRIPT_SDK_TYPES.replace(/^/gm, "  ")}
}
`;

/**
 * Minimal ambient declarations for runtime globals the executor (Bun) actually
 * exposes. We intentionally avoid pulling in `lib.dom.d.ts` wholesale — the
 * runtime surface is much narrower than a browser, and the DOM lib would
 * mislead authors into thinking every browser global works.
 *
 * If you add to this list, verify the global is exposed by the eval-harness:
 *   `src/scripts-runtime/eval-harness.ts` runs user code under `bun run` in a
 *   subprocess with stripped env. Whatever Bun provides globally is available.
 */
export const SCRIPT_RUNTIME_GLOBALS = `
// === Console ===

interface Console {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  trace(...args: unknown[]): void;
  table(tabularData: unknown, properties?: ReadonlyArray<string>): void;
  group(...args: unknown[]): void;
  groupCollapsed(...args: unknown[]): void;
  groupEnd(): void;
  assert(condition?: boolean, ...args: unknown[]): void;
  count(label?: string): void;
  countReset(label?: string): void;
  dir(obj: unknown, options?: unknown): void;
  dirxml(...args: unknown[]): void;
  time(label?: string): void;
  timeEnd(label?: string): void;
  timeLog(label?: string, ...args: unknown[]): void;
  clear(): void;
}

declare var console: Console;

// === Fetch / Web ===

type HeadersInit = Headers | Record<string, string> | Array<[string, string]>;
interface Headers {
  append(name: string, value: string): void;
  delete(name: string): void;
  get(name: string): string | null;
  has(name: string): boolean;
  set(name: string, value: string): void;
  forEach(callback: (value: string, key: string, parent: Headers) => void): void;
  entries(): IterableIterator<[string, string]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
}
declare var Headers: { new (init?: HeadersInit): Headers; prototype: Headers };

type BodyInit = string | ArrayBuffer | ArrayBufferView | Blob | FormData | URLSearchParams | ReadableStream<Uint8Array> | null;

interface Blob {
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  slice(start?: number, end?: number, contentType?: string): Blob;
  stream(): ReadableStream<Uint8Array>;
}
declare var Blob: { new (parts?: Array<BlobPart>, options?: { type?: string }): Blob; prototype: Blob };
type BlobPart = string | ArrayBuffer | ArrayBufferView | Blob;

interface FormData {
  append(name: string, value: string | Blob, filename?: string): void;
  delete(name: string): void;
  get(name: string): string | Blob | null;
  getAll(name: string): Array<string | Blob>;
  has(name: string): boolean;
  set(name: string, value: string | Blob, filename?: string): void;
  forEach(callback: (value: string | Blob, key: string, parent: FormData) => void): void;
  entries(): IterableIterator<[string, string | Blob]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string | Blob>;
  [Symbol.iterator](): IterableIterator<[string, string | Blob]>;
}
declare var FormData: { new (): FormData; prototype: FormData };

interface ReadableStream<R = unknown> {
  readonly locked: boolean;
  cancel(reason?: unknown): Promise<void>;
  getReader(): { read(): Promise<{ done: boolean; value?: R }>; releaseLock(): void; cancel(reason?: unknown): Promise<void> };
  [Symbol.asyncIterator](): AsyncIterableIterator<R>;
}

interface RequestInit {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit;
  signal?: AbortSignal | null;
  credentials?: string;
  redirect?: "follow" | "error" | "manual";
  cache?: string;
  mode?: string;
  referrer?: string;
  referrerPolicy?: string;
  integrity?: string;
  keepalive?: boolean;
}

interface Request {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
  readonly signal: AbortSignal;
  clone(): Request;
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;
  formData(): Promise<FormData>;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
declare var Request: { new (input: string | URL | Request, init?: RequestInit): Request; prototype: Request };

interface ResponseInit {
  status?: number;
  statusText?: string;
  headers?: HeadersInit;
}

interface Response {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly url: string;
  readonly redirected: boolean;
  readonly type: string;
  readonly body: ReadableStream<Uint8Array> | null;
  clone(): Response;
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;
  formData(): Promise<FormData>;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
declare var Response: {
  new (body?: BodyInit, init?: ResponseInit): Response;
  prototype: Response;
  json(data: unknown, init?: ResponseInit): Response;
  redirect(url: string | URL, status?: number): Response;
  error(): Response;
};

declare function fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;

// === URL ===

interface URLSearchParams {
  append(name: string, value: string): void;
  delete(name: string): void;
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string): boolean;
  set(name: string, value: string): void;
  sort(): void;
  toString(): string;
  forEach(callback: (value: string, key: string, parent: URLSearchParams) => void): void;
  entries(): IterableIterator<[string, string]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
  readonly size: number;
}
declare var URLSearchParams: {
  new (init?: string | string[][] | Record<string, string> | URLSearchParams): URLSearchParams;
  prototype: URLSearchParams;
};

interface URL {
  hash: string;
  host: string;
  hostname: string;
  href: string;
  toString(): string;
  readonly origin: string;
  password: string;
  pathname: string;
  port: string;
  protocol: string;
  search: string;
  readonly searchParams: URLSearchParams;
  username: string;
  toJSON(): string;
}
declare var URL: {
  new (url: string | URL, base?: string | URL): URL;
  prototype: URL;
  canParse(url: string | URL, base?: string): boolean;
  createObjectURL(obj: Blob): string;
  revokeObjectURL(url: string): void;
};

// === Abort ===

interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  throwIfAborted(): void;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}
declare var AbortSignal: {
  new (): AbortSignal;
  prototype: AbortSignal;
  abort(reason?: unknown): AbortSignal;
  timeout(milliseconds: number): AbortSignal;
  any(signals: AbortSignal[]): AbortSignal;
};

interface AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}
declare var AbortController: { new (): AbortController; prototype: AbortController };

// === Timers ===

declare function setTimeout(handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]): unknown;
declare function clearTimeout(handle: unknown): void;
declare function setInterval(handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]): unknown;
declare function clearInterval(handle: unknown): void;
declare function setImmediate(handler: (...args: unknown[]) => void, ...args: unknown[]): unknown;
declare function clearImmediate(handle: unknown): void;
declare function queueMicrotask(callback: () => void): void;

// === Encoding ===

declare function atob(data: string): string;
declare function btoa(data: string): string;

interface TextEncoder {
  readonly encoding: "utf-8";
  encode(input?: string): Uint8Array;
  encodeInto(source: string, destination: Uint8Array): { read: number; written: number };
}
declare var TextEncoder: { new (): TextEncoder; prototype: TextEncoder };

interface TextDecoder {
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  decode(input?: ArrayBuffer | ArrayBufferView, options?: { stream?: boolean }): string;
}
declare var TextDecoder: {
  new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): TextDecoder;
  prototype: TextDecoder;
};

declare function structuredClone<T>(value: T, options?: { transfer?: unknown[] }): T;

// === Crypto (Web) ===

interface SubtleCrypto {
  digest(algorithm: string | { name: string }, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer>;
  encrypt(algorithm: unknown, key: unknown, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer>;
  decrypt(algorithm: unknown, key: unknown, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer>;
  sign(algorithm: unknown, key: unknown, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer>;
  verify(algorithm: unknown, key: unknown, signature: ArrayBuffer | ArrayBufferView, data: ArrayBuffer | ArrayBufferView): Promise<boolean>;
  importKey(format: string, keyData: unknown, algorithm: unknown, extractable: boolean, keyUsages: string[]): Promise<unknown>;
  exportKey(format: string, key: unknown): Promise<ArrayBuffer | unknown>;
  generateKey(algorithm: unknown, extractable: boolean, keyUsages: string[]): Promise<unknown>;
  deriveBits(algorithm: unknown, baseKey: unknown, length: number): Promise<ArrayBuffer>;
  deriveKey(algorithm: unknown, baseKey: unknown, derivedKeyType: unknown, extractable: boolean, keyUsages: string[]): Promise<unknown>;
}

interface Crypto {
  readonly subtle: SubtleCrypto;
  randomUUID(): string;
  getRandomValues<T extends ArrayBufferView | null>(array: T): T;
}
declare var crypto: Crypto;

// === Node-compat surface ===
// Bun exposes these via its Node compatibility layer; scripts can rely on them.
// We type process.env as a string-or-undefined record — most env keys are
// stripped by the executor before user code runs, so callers should not assume
// any specific keys exist.

interface ProcessEnv {
  [key: string]: string | undefined;
}
interface Process {
  env: ProcessEnv;
  platform: string;
  arch: string;
  version: string;
  cwd(): string;
  hrtime(time?: [number, number]): [number, number];
}
declare var process: Process;

interface Buffer extends Uint8Array {
  toString(encoding?: string, start?: number, end?: number): string;
  write(text: string, encoding?: string): number;
  toJSON(): { type: "Buffer"; data: number[] };
  equals(other: Uint8Array): boolean;
  compare(other: Uint8Array): number;
  slice(start?: number, end?: number): Buffer;
  subarray(start?: number, end?: number): Buffer;
}
declare var Buffer: {
  new (size: number): Buffer;
  prototype: Buffer;
  from(input: string | ArrayBuffer | ArrayBufferView | number[], encoding?: string): Buffer;
  alloc(size: number, fill?: string | number | Buffer, encoding?: string): Buffer;
  allocUnsafe(size: number): Buffer;
  concat(list: ReadonlyArray<Uint8Array>, totalLength?: number): Buffer;
  isBuffer(obj: unknown): boolean;
  byteLength(string: string | ArrayBufferView, encoding?: string): number;
};

// globalThis tweak: TS infers an object-typed globalThis from lib.es5, which
// rejects assignments like \`globalThis.x = 1\`. Mirror lib.dom by allowing
// arbitrary index access — the runtime permits it.
interface Window {
  [key: string]: unknown;
}
`;

const USER_FILE = "/virtual/user-script.ts";
const CHECK_FILE = "/virtual/check.ts";
const SDK_FILE = "/virtual/swarm-sdk.d.ts";
const STDLIB_FILE = "/virtual/stdlib.d.ts";
const RUNTIME_GLOBALS_FILE = "/virtual/runtime-globals.d.ts";

/**
 * Directory whose `node_modules` holds the type declarations for the bare
 * imports on the script allowlist (today just `zod`).
 *
 * In dev this is the repo root — `node_modules/zod` exists, resolution just
 * works. In the `bun build --compile` binary `node_modules` is NOT shipped, so
 * the Dockerfile stages the zod declaration files under `SCRIPT_TYPES_DIR`
 * (mirroring how `TS_LIB_DIR` stages the TypeScript libs). When that env var is
 * set, resolve bare imports from there instead.
 */
function scriptTypesBase(): string {
  const dir = process.env.SCRIPT_TYPES_DIR;
  if (dir) return `${dir}/index.ts`;
  return new URL("../../index.ts", import.meta.url).pathname;
}

function createCompilerHost(
  files: Map<string, string>,
  options: ts.CompilerOptions,
): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);

  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const normalized = fileName.replace(/\\/g, "/");
    const source = files.get(normalized);
    if (source !== undefined) {
      return ts.createSourceFile(normalized, source, languageVersion, true, ts.ScriptKind.TS);
    }
    return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };

  host.fileExists = (fileName) => {
    const normalized = fileName.replace(/\\/g, "/");
    return files.has(normalized) || ts.sys.fileExists(fileName);
  };

  host.readFile = (fileName) => {
    const normalized = fileName.replace(/\\/g, "/");
    return files.get(normalized) ?? ts.sys.readFile(fileName);
  };

  // Resolve external packages (e.g. "zod") from a real on-disk base rather than
  // the virtual path "/virtual/..." so TypeScript can find a real node_modules.
  const projectBase = scriptTypesBase();

  host.resolveModuleNames = (moduleNames, containingFile) =>
    moduleNames.map((moduleName) => {
      if (moduleName === "./user-script") {
        return { resolvedFileName: USER_FILE, extension: ts.Extension.Ts };
      }
      if (moduleName === "swarm-sdk") {
        return { resolvedFileName: SDK_FILE, extension: ts.Extension.Dts };
      }
      if (moduleName === "stdlib") {
        return { resolvedFileName: STDLIB_FILE, extension: ts.Extension.Dts };
      }
      // For external packages, resolve from project root so node_modules is found
      const base = containingFile.startsWith("/virtual/") ? projectBase : containingFile;
      return ts.resolveModuleName(moduleName, base, options, host).resolvedModule;
    });

  // In compiled binary mode, TypeScript's lib .d.ts files live alongside
  // typescript.js in /$bunfs/ — but .d.ts files are not embedded in the binary.
  // Redirect lib lookups to TS_LIB_DIR where the Dockerfile copies real copies.
  const tsLibDir = process.env.TS_LIB_DIR;
  if (tsLibDir) {
    host.getDefaultLibLocation = () => tsLibDir;
  }

  return host;
}

function flattenMessage(messageText: string | ts.DiagnosticMessageChain): string {
  return ts.flattenDiagnosticMessageText(messageText, "\n");
}

function diagnosticSeverity(diag: ts.Diagnostic): ScriptDiagnostic["severity"] {
  switch (diag.category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "suggestion";
    default:
      return "message";
  }
}

function extractIdentifier(diag: ts.Diagnostic): string | undefined {
  if (!diag.file || diag.start === undefined) return undefined;
  const text = diag.file.text;
  const len = diag.length ?? 0;
  if (len === 0) return undefined;
  const slice = text.slice(diag.start, diag.start + len);
  // Heuristic: only return the identifier when the underlined span looks like
  // a plain identifier (no whitespace, no punctuation past the first token).
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(slice)) return slice;
  return undefined;
}

function extractSuggestion(message: string): string | undefined {
  // The TypeScript compiler embeds suggestions like "Did you mean 'foo'?" in
  // diagnostic messages. Surface that fragment so clients can render it.
  const match = message.match(/Did you mean ['"]([^'"]+)['"]\?/);
  return match?.[1];
}

function toStructured(diag: ts.Diagnostic): ScriptDiagnostic {
  const message = flattenMessage(diag.messageText);
  const file = diag.file?.fileName.replace(/\\/g, "/") ?? "<unknown>";
  let line = 0;
  let column = 0;
  let endLine: number | undefined;
  let endColumn: number | undefined;
  if (diag.file && diag.start !== undefined) {
    const { line: l, character: c } = diag.file.getLineAndCharacterOfPosition(diag.start);
    line = l + 1;
    column = c + 1;
    if (diag.length) {
      const end = diag.file.getLineAndCharacterOfPosition(diag.start + diag.length);
      endLine = end.line + 1;
      endColumn = end.character + 1;
    }
  }
  return {
    severity: diagnosticSeverity(diag),
    code: diag.code,
    message,
    file,
    line,
    column,
    endLine,
    endColumn,
    identifier: extractIdentifier(diag),
    suggestion: extractSuggestion(message),
  };
}

export function typecheckScript(source: string): ScriptTypecheckResult {
  const options: ts.CompilerOptions = {
    allowImportingTsExtensions: true,
    lib: ["lib.es2022.d.ts"],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    types: [],
  };

  const files = new Map<string, string>([
    [USER_FILE, source],
    [SDK_FILE, SCRIPT_SDK_TYPES],
    [STDLIB_FILE, SCRIPT_STDLIB_TYPES],
    [RUNTIME_GLOBALS_FILE, SCRIPT_RUNTIME_GLOBALS],
    [
      CHECK_FILE,
      `/// <reference path="./runtime-globals.d.ts" />
import run from "./user-script";
import type { ScriptMain } from "swarm-sdk";
const _scriptMain: ScriptMain = run;
void _scriptMain;
`,
    ],
  ]);

  const host = createCompilerHost(files, options);
  const program = ts.createProgram(
    [USER_FILE, CHECK_FILE, SDK_FILE, STDLIB_FILE, RUNTIME_GLOBALS_FILE],
    options,
    host,
  );
  const diagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ].filter((diagnostic) => {
    const fileName = diagnostic.file?.fileName.replace(/\\/g, "/");
    return fileName === USER_FILE || fileName === CHECK_FILE;
  });

  if (diagnostics.length === 0) return { ok: true };

  const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => "/virtual",
    getNewLine: () => "\n",
  });

  return {
    ok: false,
    diagnostics: formatted.split("\n\n").filter(Boolean),
    structured: diagnostics.map(toStructured),
  };
}
