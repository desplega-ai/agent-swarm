import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { z } from "zod";
import { insertExtensionRun, setExtensionState } from "../be/extensions/db";
import { writeBareImportShim } from "../scripts-runtime/executors/native";
import type { Extension, ExtensionManifest } from "../types";
import { ExtensionManifestSchema } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { isSafeBundlePath } from "./bundle-path";
import type { ApiCtx, ExtensionApi, HooksModule, SwarmEventMap } from "./contract";

const EXTENSIONS_TMP_PARENT = `${tmpdir()}/swarm-extensions`;
export const EXTENSIONS_TMP_ROOT = `${EXTENSIONS_TMP_PARENT}/${process.pid}`;

export type ExtensionHandler = {
  event: keyof SwarmEventMap;
  handler: (event: never, ctx: ApiCtx) => unknown | Promise<unknown>;
  priority: number;
};

export type LoadableExtension = {
  record: Extension;
  manifest: ExtensionManifest;
  files: Record<string, string>;
};

export type LoadedExtension = LoadableExtension & {
  handlers: ExtensionHandler[];
  configSchema?: z.ZodTypeAny;
  config: Record<string, unknown>;
  sourcePath: string;
  dispose: () => Promise<void>;
};

export class ExtensionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionConfigError";
  }
}

const successfulDirectoryByName = new Map<string, string>();

function isZodSchema(value: unknown): value is z.ZodTypeAny {
  return (
    typeof value === "object" &&
    value !== null &&
    "safeParseAsync" in value &&
    typeof value.safeParseAsync === "function"
  );
}

async function writeRuntimeShims(directory: string): Promise<void> {
  const runtimeDir = process.env.SCRIPT_RUNTIME_DIR;
  if (runtimeDir) {
    await Promise.all([
      writeBareImportShim(directory, "stdlib", pathToFileURL(`${runtimeDir}/stdlib.bundle.js`)),
      writeBareImportShim(directory, "zod", pathToFileURL(`${runtimeDir}/zod.bundle.js`)),
      writeBareImportShim(
        directory,
        "swarm-extension",
        pathToFileURL(`${runtimeDir}/extensions-contract.bundle.js`),
      ),
    ]);
    return;
  }

  const zodEntry = Bun.resolveSync("zod", import.meta.dir);
  await Promise.all([
    writeBareImportShim(
      directory,
      "stdlib",
      new URL("../scripts-runtime/stdlib/index.ts", import.meta.url),
    ),
    writeBareImportShim(directory, "zod", pathToFileURL(zodEntry)),
    writeBareImportShim(
      directory,
      "swarm-extension",
      new URL("./contract-runtime.ts", import.meta.url),
    ),
  ]);
}

async function persistLoadError(record: Extension, error: unknown): Promise<void> {
  const message = scrubSecrets(error instanceof Error ? error.message : String(error));
  try {
    await insertExtensionRun({
      extensionId: record.id,
      version: record.activeVersion,
      event: "load",
      action: "load-error",
      message,
    });
    await setExtensionState(record.id, { status: "error", lastError: message });
  } catch (persistError) {
    console.error(
      "[extensions] Failed to persist load error:",
      scrubSecrets(persistError instanceof Error ? persistError.message : String(persistError)),
    );
  }
}

export async function cleanExtensionTmpRoot(): Promise<void> {
  await removeExtensionTmpRoot();
  const siblings = new Bun.Glob("*");
  await Bun.$`mkdir -p ${EXTENSIONS_TMP_PARENT}`.quiet();
  for await (const name of siblings.scan({ cwd: EXTENSIONS_TMP_PARENT, onlyFiles: false })) {
    if (!/^[1-9]\d*$/.test(name)) continue;
    try {
      process.kill(Number(name), 0);
    } catch {
      await Bun.$`rm -rf ${EXTENSIONS_TMP_PARENT}/${name}`.quiet();
    }
  }
}

export async function removeExtensionTmpRoot(): Promise<void> {
  await Bun.$`rm -rf ${EXTENSIONS_TMP_ROOT}`.quiet();
  successfulDirectoryByName.clear();
}

export async function loadExtension(input: LoadableExtension): Promise<LoadedExtension> {
  const { record } = input;
  const directory = `${EXTENSIONS_TMP_ROOT}/${record.name}/${record.contentHash}`;

  try {
    const bundlePath = (path: string): string => {
      const filePath = resolve(directory, path);
      if (!isSafeBundlePath(path) || !filePath.startsWith(`${directory}/`)) {
        throw new Error(`Unsafe bundle file path: ${JSON.stringify(path)}`);
      }
      return filePath;
    };
    const sourcePath = bundlePath(input.manifest.assets.hooks);
    const files = Object.entries(input.files).map(
      ([path, content]) => [bundlePath(path), content] as const,
    );
    await Bun.$`mkdir -p ${directory}`.quiet();
    for (const [filePath, content] of files) {
      const parent = filePath.slice(0, filePath.lastIndexOf("/"));
      await Bun.$`mkdir -p ${parent}`.quiet();
      await Bun.write(filePath, content);
    }
    await writeRuntimeShims(directory);

    const mod = (await import(sourcePath)) as Partial<HooksModule>;
    if (typeof mod.default !== "function") {
      throw new Error("Extension hooks must export a default function");
    }
    if (mod.config !== undefined && !isZodSchema(mod.config)) {
      throw new ExtensionConfigError("Extension config export must be a Zod schema");
    }

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(record.configJson) as Record<string, unknown>;
    } catch {
      throw new ExtensionConfigError("Extension configJson must contain a JSON object");
    }
    if (mod.config) {
      const parsed = await mod.config.safeParseAsync(config);
      if (!parsed.success) {
        throw new ExtensionConfigError(`Extension config is invalid: ${parsed.error.message}`);
      }
      config = parsed.data as Record<string, unknown>;
    }

    const handlers: ExtensionHandler[] = [];
    const api: ExtensionApi = {
      on(event, handler, opts) {
        handlers.push({
          event,
          handler: handler as ExtensionHandler["handler"],
          priority: opts?.priority ?? record.priority,
        });
      },
    };
    mod.default(api);

    const previousDirectory = successfulDirectoryByName.get(record.name);
    if (previousDirectory && previousDirectory !== directory) {
      await Bun.$`rm -rf ${previousDirectory}`.quiet();
    }
    successfulDirectoryByName.set(record.name, directory);

    return {
      ...input,
      handlers,
      configSchema: mod.config,
      config,
      sourcePath,
      // Bun retains the imported module in its registry and cannot unload it.
      // Disposal removes only the source directory from disk.
      dispose: async () => {
        await Bun.$`rm -rf ${directory}`.quiet();
      },
    };
  } catch (error) {
    await persistLoadError(record, error);
    throw error;
  }
}

export function parseStoredManifest(record: Extension): ExtensionManifest {
  return ExtensionManifestSchema.parse(JSON.parse(record.manifestJson));
}
