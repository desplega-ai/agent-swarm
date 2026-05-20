#!/usr/bin/env bun
/**
 * Release recorder — drives agent-browser recording for each storyboard beat.
 *
 * Usage:
 *   cd assets/release-recorder
 *   bun run.ts
 *   bun run.ts --storyboard storyboard.sample.json
 *
 * For each beat in the storyboard:
 *   1. Resolve demo_script_id → scripts/<id>.ts
 *   2. Start agent-browser recording → raw/beat-<n>.webm
 *   3. Execute the demo flow (with ~500ms pauses for viewer clarity)
 *   4. Stop recording
 *
 * An EXIT-trap ensures `record stop` always runs on error or signal.
 */

import { dirname, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { $ } from "bun";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Beat {
  title: string;
  prNumber?: number;
  prUrl?: string;
  demo_script_id: string;
  vo_line: string;
}

interface Storyboard {
  version: string;
  summary: string;
  beats: Beat[];
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const sbIdx = args.indexOf("--storyboard");
const storyboardPath: string =
  sbIdx >= 0 ? (args[sbIdx + 1] ?? join(import.meta.dir, "storyboard.json")) : join(import.meta.dir, "storyboard.json");

if (!existsSync(storyboardPath)) {
  console.error(`storyboard not found: ${storyboardPath}`);
  console.error("Pass --storyboard <path> or copy storyboard.sample.json → storyboard.json");
  process.exit(1);
}

const storyboard: Storyboard = JSON.parse(await Bun.file(storyboardPath).text());
const rawDir = join(dirname(storyboardPath), "raw");
mkdirSync(rawDir, { recursive: true });

// ---------------------------------------------------------------------------
// EXIT-trap — always stop recording on process exit
// ---------------------------------------------------------------------------

let recordingActive = false;

process.on("exit", () => {
  if (recordingActive) {
    try {
      Bun.spawnSync(["agent-browser", "record", "stop"]);
    } catch {
      // best-effort
    }
  }
});

for (const sig of ["SIGINT", "SIGTERM"] as NodeJS.Signals[]) {
  process.on(sig, () => process.exit(1));
}

// ---------------------------------------------------------------------------
// Record each beat
// ---------------------------------------------------------------------------

console.log(`\n🎬 Release recorder v${storyboard.version}`);
console.log(`   ${storyboard.summary}`);
console.log(`   ${storyboard.beats.length} beat(s) → ${rawDir}\n`);

for (let i = 0; i < storyboard.beats.length; i++) {
  const beat = storyboard.beats[i];
  if (!beat) continue;
  const clipPath = join(rawDir, `beat-${i}.webm`);

  console.log(`▶ Beat ${i}: ${beat.title}`);
  console.log(`  script : ${beat.demo_script_id}`);
  console.log(`  output : beat-${i}.webm`);

  // Resolve demo script
  const scriptPath = join(import.meta.dir, "scripts", `${beat.demo_script_id}.ts`);
  if (!existsSync(scriptPath)) {
    console.error(`  ✗ demo script not found: ${scriptPath}`);
    process.exit(1);
  }

  // Dynamic import — Bun resolves .ts natively
  const mod = await import(scriptPath);
  const runDemo: () => Promise<void> = mod.default;

  // Start recording
  await $`agent-browser record start ${clipPath}`;
  recordingActive = true;

  try {
    await runDemo();
    console.log(`  ✓ done\n`);
  } catch (err) {
    console.error(`  ✗ demo script failed:`, err);
    throw err; // triggers exit → EXIT-trap stops recording
  } finally {
    await $`agent-browser record stop`;
    recordingActive = false;
  }
}

console.log(`✅ All clips recorded in ${rawDir}`);
console.log(`   Next: hand raw/*.webm to a video-use session for editing.`);
