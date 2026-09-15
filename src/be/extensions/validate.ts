import { isSafeBundlePath } from "../../extensions/bundle-path";
import { EXTENSION_TYPE_DEFINITIONS } from "../../extensions/contract-types.generated";
import { checkImportAllowlist } from "../../scripts-runtime/import-allowlist";
import { type ExtensionManifest, ExtensionManifestSchema } from "../../types";
import {
  SCRIPT_SDK_TYPES,
  SCRIPT_STDLIB_MODULE_TYPES,
  typecheckWithAmbient,
} from "../scripts/typecheck";

export type BundleValidationResult =
  | { ok: true; manifest: ExtensionManifest }
  | { ok: false; diagnostics: string[] };

export async function validateBundle(input: {
  manifest: unknown;
  files: Record<string, string>;
}): Promise<BundleValidationResult> {
  const parsedManifest = ExtensionManifestSchema.safeParse(input.manifest);
  const pathDiagnostics = Object.keys(input.files)
    .filter((path) => !isSafeBundlePath(path))
    .map((path) => `Unsafe bundle file path: ${JSON.stringify(path)}`);
  if (!parsedManifest.success) {
    return {
      ok: false,
      diagnostics: [
        ...pathDiagnostics,
        ...parsedManifest.error.issues.map(
          (issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`,
        ),
      ],
    };
  }
  if (pathDiagnostics.length > 0) return { ok: false, diagnostics: pathDiagnostics };

  const manifest = parsedManifest.data;
  if (manifest.runtime === "worker") {
    return { ok: false, diagnostics: ['runtime "worker" is not supported in v1'] };
  }

  for (const asset of ["skills", "workflows", "schedules"] as const) {
    if ((manifest.assets[asset]?.length ?? 0) > 0) {
      return { ok: false, diagnostics: [`assets.${asset} is not supported in v1`] };
    }
  }

  const hookPath = manifest.assets.hooks;
  if (!(hookPath in input.files)) {
    return {
      ok: false,
      diagnostics: [`assets.hooks "${hookPath}" does not name a file in files`],
    };
  }
  const extraPaths = Object.keys(input.files).filter((path) => path !== hookPath);
  if (extraPaths.length > 0) {
    return {
      ok: false,
      diagnostics: [
        `Only the hooks asset is supported in v1. Unexpected files: ${extraPaths.join(", ")}`,
      ],
    };
  }

  const source = input.files[hookPath]!;
  const imports = checkImportAllowlist(source, {
    allowedBare: ["swarm-extension", "zod", "stdlib"],
    allowRelative: false,
    strictDynamic: true,
  });
  if (!imports.ok) return { ok: false, diagnostics: [imports.diagnostic] };

  const typecheck = await typecheckWithAmbient({
    source,
    modules: {
      "swarm-extension": EXTENSION_TYPE_DEFINITIONS,
      "swarm-sdk": SCRIPT_SDK_TYPES,
      stdlib: SCRIPT_STDLIB_MODULE_TYPES,
    },
    checkFile: `/// <reference path="./runtime-globals.d.ts" />
import * as hooks from "./user-script";
import type { SwarmExtension } from "swarm-extension";
import type { ZodTypeAny } from "zod";
const manifest = ${JSON.stringify(manifest)} as const;
type Manifest = typeof hooks extends { config: infer Config extends ZodTypeAny }
  ? typeof manifest & { config: Config }
  : typeof manifest;
const _extension: SwarmExtension<Manifest> = hooks.default;
type ConfigIsValid = typeof hooks extends { config: infer Config }
  ? Config extends ZodTypeAny ? true : false
  : true;
const _configIsValid: ConfigIsValid = true;
void _extension;
void _configIsValid;
`,
  });
  if (!typecheck.ok) {
    return {
      ok: false,
      diagnostics: typecheck.structured.map(
        (diagnostic) =>
          `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} TS${diagnostic.code}: ${diagnostic.message}`,
      ),
    };
  }

  return { ok: true, manifest };
}
