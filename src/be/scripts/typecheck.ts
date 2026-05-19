import ts from "typescript";

export type ScriptTypecheckResult = { ok: true } | { ok: false; diagnostics: string[] };

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
  fetch(input: string | URL | Request, init?: RequestInit): Promise<unknown>;
  grep(pattern: string, files?: string | string[]): Promise<string>;
  glob(pattern: string): Promise<string[]>;
  table(rows: Array<Record<string, unknown>>): string;
  Redacted: RedactedStatic;
}

export interface ScriptLogger {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

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
  export function fetch(input: string | URL | Request, init?: RequestInit): Promise<unknown>;
  export function grep(pattern: string, files?: string | string[]): Promise<string>;
  export function glob(pattern: string): Promise<string[]>;
  export function table(rows: Array<Record<string, unknown>>): string;
}

declare module "swarm-sdk" {
${SCRIPT_SDK_TYPES.replace(/^/gm, "  ")}
}
`;

const USER_FILE = "/virtual/user-script.ts";
const CHECK_FILE = "/virtual/check.ts";
const SDK_FILE = "/virtual/swarm-sdk.d.ts";
const STDLIB_FILE = "/virtual/stdlib.d.ts";

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
      return ts.resolveModuleName(moduleName, containingFile, options, host).resolvedModule;
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

export function typecheckScript(source: string): ScriptTypecheckResult {
  const options: ts.CompilerOptions = {
    allowImportingTsExtensions: true,
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
    [
      CHECK_FILE,
      `import run from "./user-script";
import type { ScriptMain } from "swarm-sdk";
const _scriptMain: ScriptMain = run;
void _scriptMain;
`,
    ],
  ]);

  const host = createCompilerHost(files, options);
  const program = ts.createProgram([USER_FILE, CHECK_FILE, SDK_FILE, STDLIB_FILE], options, host);
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

  return { ok: false, diagnostics: formatted.split("\n\n").filter(Boolean) };
}
