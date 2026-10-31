#!/usr/bin/env bun
/**
 * Render the base prompt byte-identity cases with a checkout's `getBasePrompt`
 * and write them to src/tests/fixtures/base-prompt-baseline.json.
 *
 * Usage:
 *   bun scripts/capture-base-prompt-baseline.ts [checkoutDir]
 *
 * checkoutDir defaults to this repo. Pass a worktree of main to pin main's
 * bytes; rerun against this repo only when a prompt change is intended.
 */
import { resolve } from "node:path";
import {
  BASELINE_ARGS,
  BASELINE_DEPLOYMENTS,
  BASELINE_ENV_KEYS,
  baselineKey,
} from "../src/tests/fixtures/base-prompt-baseline-cases";

const checkout = resolve(process.argv[2] ?? resolve(import.meta.dir, ".."));
const { getBasePrompt } = (await import(
  resolve(checkout, "src/prompts/base-prompt.ts")
)) as typeof import("../src/prompts/base-prompt");

const baseline: Record<string, string> = {};
for (const [deployment, env] of Object.entries(BASELINE_DEPLOYMENTS)) {
  for (const [name, args] of Object.entries(BASELINE_ARGS)) {
    for (const key of BASELINE_ENV_KEYS) delete process.env[key];
    Object.assign(process.env, env);
    baseline[baselineKey(deployment, name)] = await getBasePrompt(args);
  }
}

const out = resolve(import.meta.dir, "../src/tests/fixtures/base-prompt-baseline.json");
await Bun.write(out, `${JSON.stringify(baseline, null, 2)}\n`);
console.log(`wrote ${Object.keys(baseline).length} prompts from ${checkout} to ${out}`);
