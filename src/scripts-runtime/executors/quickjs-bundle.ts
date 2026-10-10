import { SourceMapReader } from "./sourcemap";

/**
 * Bundles a user script for the quickjs executor. QuickJS runs plain
 * JavaScript only, so Bun strips the types and inlines the imports into one
 * IIFE. The bundle sets `globalThis.__swarm_module` to the module namespace.
 *
 * Bare imports:
 *  - `zod` is inlined from its ESM sources, so Bun tree-shakes it. Each run
 *    evaluates only the zod code that the script uses.
 *  - `stdlib` and `swarm-sdk` resolve to small virtual modules that read the
 *    sandbox globals the quickjs runner installs.
 */

export const USER_SCRIPT_FILE = "user-script.ts";
const VIRTUAL_DIR = "/swarm-virtual";
const ENTRY_PATH = `${VIRTUAL_DIR}/entry.ts`;
const USER_PATH = `${VIRTUAL_DIR}/${USER_SCRIPT_FILE}`;

const STDLIB_MODULE = `const s = globalThis.__swarm_stdlib;
export const fetch = s.fetch;
export const fetchJson = s.fetchJson;
export const glob = s.glob;
export const grep = s.grep;
export const table = s.table;
export const Redacted = s.Redacted;
`;

const SWARM_SDK_MODULE = `export function createSwarmSdk() {
  return globalThis.__swarm_ctx.swarm;
}
`;

export type QuickJSBundle =
  | { ok: true; code: string; map: SourceMapReader | undefined }
  | { ok: false; diagnostic: string };

type BuildConfigWithFiles = Parameters<typeof Bun.build>[0] & { files: Record<string, string> };

let zodEntryCache: string | null | undefined;

/**
 * Prefer zod's real ESM sources, which tree-shake well. The prebuilt
 * `zod.bundle.js` of the API image barely tree-shakes (~340 KB against ~87 KB
 * for z.object + z.string().email()), so it is only the last fallback.
 */
export async function resolveZodEntry(): Promise<string | null> {
  if (zodEntryCache !== undefined) return zodEntryCache;
  const runtimeDir = process.env.SCRIPT_RUNTIME_DIR;
  const candidates: Array<() => string | undefined> = [
    () => (runtimeDir ? `${runtimeDir}/zod-esm/index.js` : undefined),
    () => Bun.resolveSync("zod", import.meta.dir),
    () => (runtimeDir ? `${runtimeDir}/zod.bundle.js` : undefined),
  ];
  for (const candidate of candidates) {
    try {
      const path = candidate();
      if (path && (await Bun.file(path).exists())) {
        zodEntryCache = path;
        return path;
      }
    } catch {
      // Try the next candidate. Bun.resolveSync throws inside the compiled binary.
    }
  }
  zodEntryCache = null;
  return null;
}

const CACHE_LIMIT = 128;
const cache = new Map<string, QuickJSBundle>();

function remember(key: string, bundle: QuickJSBundle): QuickJSBundle {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, bundle);
  return bundle;
}

export async function bundleForQuickJS(source: string): Promise<QuickJSBundle> {
  const key = Bun.hash(source).toString(36);
  const cached = cache.get(key);
  if (cached) {
    // Refresh the LRU position.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const zodEntry = await resolveZodEntry();
  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: [ENTRY_PATH],
      // In-memory sources (Bun >= 1.3). The pinned bun-types predate the option.
      files: {
        [ENTRY_PATH]: `import * as m from "./${USER_SCRIPT_FILE}";\nglobalThis.__swarm_module = m;\n`,
        [USER_PATH]: source,
      },
      format: "iife",
      target: "browser",
      sourcemap: "external",
      // Less source for QuickJS to parse on every run. Identifiers stay, so
      // stack frames keep their function names; the source map keeps lines.
      minify: { whitespace: true, syntax: true, identifiers: false },
      plugins: [
        {
          name: "swarm-script-imports",
          setup(build) {
            build.onResolve({ filter: /^(stdlib|swarm-sdk)$/ }, (args) => ({
              path: args.path,
              namespace: "swarm-virtual",
            }));
            build.onLoad({ filter: /.*/, namespace: "swarm-virtual" }, (args) => ({
              contents: args.path === "stdlib" ? STDLIB_MODULE : SWARM_SDK_MODULE,
              loader: "js",
            }));
            build.onResolve({ filter: /^zod$/ }, () => {
              if (!zodEntry) {
                throw new Error("zod is not available to the quickjs executor in this deployment");
              }
              return { path: zodEntry };
            });
          },
        },
      ],
    } as BuildConfigWithFiles);
  } catch (error) {
    // Bun.build throws an AggregateError for syntax and resolve errors.
    const messages =
      error instanceof AggregateError
        ? error.errors.map((entry) => String(entry?.message ?? entry))
        : [error instanceof Error ? error.message : String(error)];
    return { ok: false, diagnostic: messages.join("\n") };
  }

  if (!result.success) {
    return {
      ok: false,
      diagnostic: result.logs.map((log) => String(log.message ?? log)).join("\n"),
    };
  }

  const output = result.outputs.find((artifact) => artifact.kind === "entry-point");
  if (!output) return { ok: false, diagnostic: "quickjs bundle produced no entry point" };
  const code = await output.text();
  const mapArtifact = result.outputs.find((artifact) => artifact.kind === "sourcemap");
  const map = mapArtifact ? new SourceMapReader(JSON.parse(await mapArtifact.text())) : undefined;
  return remember(key, { ok: true, code, map });
}
