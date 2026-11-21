#!/usr/bin/env bun
/**
 * Asserts that the native multi-agent tools the tool-mapping prompt names
 * (src/prompts/harness-native-tools.ts) still exist in the pinned harnesses.
 * A harness bump that renames or drops one fails here instead of leaving the
 * prompt pointing at a tool the model cannot see.
 *
 * - claude: the SDK's `BUILTIN_TOOL_NAMES`, minus the Dockerfile.worker deny list.
 * - codex: the `collaboration` namespace of `codex debug prompt-input`, run with
 *   the adapter's features and default model and a throwaway CODEX_HOME (offline, no auth).
 *
 * Usage: bun scripts/check-harness-native-tools.ts [--harness claude|codex]
 * Prints one JSON line per harness `{ ok, harness, missing, extra }`. Exit 1 on any missing name.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_TOOL_NAMES } from "@anthropic-ai/claude-agent-sdk";
import {
  mappedNativeToolNames,
  NATIVE_TOOL_MAP,
  type NativeToolHarness,
} from "../src/prompts/harness-native-tools";
import { CODEX_DEFAULT_MODEL } from "../src/providers/codex-models";

export type NativeToolCheck = {
  ok: boolean;
  harness: NativeToolHarness;
  missing: string[];
  extra: string[];
};

/**
 * `extra` lists live multi-agent tools with no mapping (informational): the
 * whole codex `collaboration` namespace, and claude built-ins that name an agent.
 */
export function checkNativeTools(
  harness: NativeToolHarness,
  liveNames: readonly string[],
  candidateExtras: readonly string[] = liveNames,
): NativeToolCheck {
  const mapped = mappedNativeToolNames(NATIVE_TOOL_MAP[harness]);
  const live = new Set(liveNames);
  const missing = mapped.filter((name) => !live.has(name));
  const extra = candidateExtras.filter((name) => live.has(name) && !mapped.includes(name));
  return { ok: missing.length === 0, harness, missing, extra };
}

/** Tool names from the `permissions.deny` list baked into Dockerfile.worker. */
export function dockerfileDeniedTools(dockerfileText: string): string[] {
  const match = dockerfileText.match(/"deny":\s*\[([^\]]*)\]/);
  return match ? [...match[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!) : [];
}

/** Tool names in the `collaboration` namespace of a `codex debug prompt-input` dump. */
export function codexCollaborationTools(promptInput: unknown): string[] {
  const items = Array.isArray(promptInput) ? promptInput : [];
  for (const item of items) {
    for (const ns of (item as { tools?: unknown[] }).tools ?? []) {
      const namespace = ns as { name?: string; tools?: { name?: string }[] };
      if (namespace.name === "collaboration") {
        return (namespace.tools ?? []).flatMap((tool) => (tool.name ? [tool.name] : []));
      }
    }
  }
  return [];
}

function liveClaudeCheck(dockerfileText: string): NativeToolCheck {
  const denied = new Set(dockerfileDeniedTools(dockerfileText));
  const live = BUILTIN_TOOL_NAMES.filter((name) => !denied.has(name));
  return checkNativeTools(
    "claude",
    live,
    live.filter((name) => /agent|message/i.test(name) && name !== "SendUserMessage"),
  );
}

async function liveCodexCheck(): Promise<NativeToolCheck> {
  const codexHome = await mkdtemp(join(tmpdir(), "codex-native-tools-"));
  try {
    // Mirrors the adapter's `features` (src/providers/codex-adapter.ts).
    const proc = Bun.spawn(
      [
        "node_modules/.bin/codex",
        "debug",
        "prompt-input",
        "-c",
        `model="${CODEX_DEFAULT_MODEL}"`,
        "-c",
        "features.apps=false",
        "-c",
        "features.hooks=true",
        "-c",
        "features.plugin_hooks=true",
      ],
      { env: { ...process.env, CODEX_HOME: codexHome }, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`codex debug prompt-input exited ${code}: ${stderr.trim()}`);
    return checkNativeTools("codex", codexCollaborationTools(JSON.parse(stdout)));
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const flag = process.argv.indexOf("--harness");
  const only = flag >= 0 ? process.argv[flag + 1] : undefined;
  if (only && !(only in NATIVE_TOOL_MAP)) {
    console.error(`--harness must be one of: ${Object.keys(NATIVE_TOOL_MAP).join(", ")}`);
    process.exit(2);
  }
  const results: NativeToolCheck[] = [];
  if (!only || only === "claude") {
    results.push(liveClaudeCheck(await Bun.file("Dockerfile.worker").text()));
  }
  if (!only || only === "codex") results.push(await liveCodexCheck());
  for (const result of results) console.log(JSON.stringify(result));
  if (results.some((result) => !result.ok)) {
    console.error(
      "A mapped native tool is gone. Update src/prompts/harness-native-tools.ts and the tool-mapping templates for the new harness version.",
    );
    process.exit(1);
  }
}
