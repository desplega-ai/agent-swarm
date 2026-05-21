#!/usr/bin/env bun
/**
 * E2E demo recorder (v4) — segmented per-beat recording.
 *
 * Each beat is a separate WebM clip. After all beats, ffmpeg stitches them
 * into a single MP4, and the cursor tracks are merged with correct time offsets.
 *
 * Beats:
 *   1. navigate-people  — navigate to /people, wait for page load
 *   2. scan-list        — cursor scans the People list rows
 *   3. open-person      — click a person row → detail page
 *   4. linked-identities — hover over the identities section
 *   5. activity-timeline — cursor scans the activity events
 *
 * Usage:
 *   cd assets/release-recorder
 *   bun record-e2e.ts
 *
 * Output:
 *   raw/swarm-demo.mp4         — final stitched video (libx264, 1920×1080)
 *   raw/e2e-demo-cursor.json   — merged CursorTrack (schema v1)
 */

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import type { CursorEvent, CursorTrack } from "./src/cursor-track";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const get = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};

const RAW_DIR  = join(import.meta.dir, "raw");
const FINAL_MP4 = join(RAW_DIR, "swarm-demo.mp4");
const CURSOR_OUT = join(RAW_DIR, "e2e-demo-cursor.json");
const WIDTH  = Number(get("--width",  "1920"));
const HEIGHT = Number(get("--height", "1080"));
const THEME  = get("--theme", "light") as "light" | "dark";
const UI  = process.env.SWARM_UI_URL  ?? "http://localhost:5274";
const API = process.env.SWARM_API_URL ?? "http://localhost:3013";
const API_KEY = process.env.API_KEY ?? "123123";
const DB_PATH = join(import.meta.dir, "../../agent-swarm-db.sqlite");

mkdirSync(RAW_DIR, { recursive: true });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Beat state
// ---------------------------------------------------------------------------

interface BeatData {
  label: string;
  webmPath: string;
  events: CursorEvent[];
  durationMs: number; // measured via ffprobe after recording
}

const beats: BeatData[] = [];
let currentBeat: { label: string; webmPath: string; events: CursorEvent[]; startTs: number } | null = null;

function pushEvent(e: Omit<CursorEvent, "tsMs">) {
  const tsMs = currentBeat ? Date.now() - currentBeat.startTs : 0;
  const event: CursorEvent = { tsMs, ...e };
  if (currentBeat) {
    currentBeat.events.push(event);
  }
}

async function startBeat(label: string) {
  const webmPath = join(RAW_DIR, `beat-${label}.webm`);
  console.log(`\n🔴 Beat [${label}] → ${webmPath}`);
  await $`agent-browser record start ${webmPath}`;
  currentBeat = { label, webmPath, events: [], startTs: Date.now() };
  pushEvent({ x: WIDTH / 2, y: HEIGHT / 2, action: "move" });
  await sleep(400);
}

async function stopBeat() {
  if (!currentBeat) return;
  await sleep(300);
  await $`agent-browser record stop`;
  const wallMs = Date.now() - currentBeat.startTs;

  // Measure actual clip duration with ffprobe (more accurate than wall clock).
  let durationMs = wallMs;
  try {
    const dur = await $`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${currentBeat.webmPath}`.text();
    durationMs = Math.round(parseFloat(dur.trim()) * 1000);
  } catch {
    console.warn(`  ⚠ ffprobe failed — using wall-clock duration (${wallMs}ms)`);
  }

  beats.push({ ...currentBeat, durationMs });
  console.log(`⏹  [${currentBeat.label}] done — ${(durationMs / 1000).toFixed(2)}s, ${currentBeat.events.length} cursor events`);
  currentBeat = null;
  await sleep(600); // brief pause between beats so WebM finalises
}

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

async function getCenter(selector: string): Promise<{ x: number; y: number }> {
  const json = await $`agent-browser get box ${selector}`.text();
  const box = JSON.parse(json.trim()) as { x: number; y: number; width: number; height: number };
  return {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
  };
}

async function moveTo(selector: string, label?: string): Promise<{ x: number; y: number }> {
  const { x, y } = await getCenter(selector);
  await $`agent-browser mouse move ${x} ${y}`;
  pushEvent({ x, y, action: "move" });
  if (label) console.log(`  ↪ cursor → ${label} (${x}, ${y})`);
  return { x, y };
}

async function hover(selector: string, label?: string): Promise<{ x: number; y: number }> {
  const { x, y } = await getCenter(selector);
  await $`agent-browser mouse move ${x} ${y}`;
  pushEvent({ x, y, action: "hover" });
  if (label) console.log(`  ↪ hover  → ${label} (${x}, ${y})`);
  return { x, y };
}

async function clickEl(selector: string, label?: string): Promise<void> {
  const pos = await moveTo(selector, label);
  await sleep(280);
  await $`agent-browser mouse down`;
  await $`agent-browser mouse up`;
  pushEvent({ x: pos.x, y: pos.y, action: "click" });
}

async function rawMove(x: number, y: number, action: CursorEvent["action"] = "move") {
  await $`agent-browser mouse move ${x} ${y}`;
  pushEvent({ x, y, action });
}

async function linger(ms: number) {
  const stepMs = 700;
  const steps = Math.max(1, Math.floor(ms / stepMs));
  for (let i = 0; i < steps; i++) {
    await sleep(stepMs);
  }
}

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------

async function apiPost(path: string, body: unknown) {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${path}: HTTP ${r.status} ${await r.text().catch(() => "")}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

console.log(`🎬 E2E demo recorder v4 (segmented)`);
console.log(`   viewport: ${WIDTH}×${HEIGHT}  theme: ${THEME}`);

const health = await fetch(`${API}/health`)
  .then((r) => r.json())
  .catch(() => null) as { status?: string; version?: string } | null;
if (!health?.status) {
  console.error(`✗ API not reachable at ${API} — run bin/reset-demo-stack.sh first`);
  process.exit(1);
}
console.log(`  API: ${API} ✓ (v${health.version})`);

const uiCode = await $`curl -sf -o /dev/null -w "%{http_code}" ${UI}`.text().catch(() => "0");
if (!uiCode.trim().startsWith("2")) {
  console.error(`✗ UI not reachable at ${UI}`);
  process.exit(1);
}
console.log(`  UI: ${UI} ✓`);

const db = new Database(DB_PATH);
console.log(`  DB: ${DB_PATH} ✓\n`);

// ---------------------------------------------------------------------------
// Pre-create demo user
// ---------------------------------------------------------------------------

const demoSuffix = Math.random().toString(36).slice(2, 10);
const demoUserId = `demo-user-${demoSuffix}`;
const nowTs = new Date().toISOString();
db.run("INSERT INTO users (id, name, email, createdAt, lastUpdatedAt) VALUES (?,?,?,?,?)", [
  demoUserId, "Alice Chen", `alice-${demoSuffix}@swarm.local`, nowTs, nowTs,
]);

console.log("⚙  Pre-creating demo task...");
const created = await apiPost("/api/tasks", {
  task: "Analyze PR #513 — security review for the release-recorder pipeline",
  priority: 80,
  tags: ["security", "review"],
  source: "api",
}) as { id: string };
const taskId = created.id;
console.log(`  task id: ${taskId}\n`);

// ---------------------------------------------------------------------------
// Browser setup — viewport + light theme (once, outside beat loop)
// ---------------------------------------------------------------------------

await $`agent-browser set viewport ${WIDTH} ${HEIGHT}`;

// Navigate to UI and inject connection config
await $`agent-browser open ${UI}`;
await sleep(1500);

const connConfig = JSON.stringify({
  connections: [{ id: "demo-conn", name: "local", apiUrl: API, apiKey: API_KEY }],
  activeId: "demo-conn",
});
const userKey = `swarm:v1:${API}:current-user`;
await $`agent-browser eval ${[
  `localStorage.setItem('agent-swarm-connections', '${connConfig}')`,
  `localStorage.setItem('${userKey}', '${demoUserId}')`,
].join(";")}`;
await sleep(200);

if (THEME === "light") {
  await $`agent-browser set media light`;
  await $`agent-browser eval ${[
    `localStorage.setItem('agent-swarm-mode', 'light')`,
    `document.documentElement.classList.remove('dark')`,
    `document.documentElement.style.colorScheme = 'light'`,
  ].join(";")}`;
  await sleep(200);
}

// ---------------------------------------------------------------------------
// EXIT-trap — stop any in-flight recording on crash
// ---------------------------------------------------------------------------

process.on("exit", () => {
  if (currentBeat) {
    try { Bun.spawnSync(["agent-browser", "record", "stop"]); } catch { /* best-effort */ }
  }
});
for (const sig of ["SIGINT", "SIGTERM"] as NodeJS.Signals[]) {
  process.on(sig, () => process.exit(1));
}

// ---------------------------------------------------------------------------
// Beat 1: Navigate to /people
// ---------------------------------------------------------------------------

await startBeat("navigate-people");

await $`agent-browser open ${UI}/people`;
await sleep(1800);

if (THEME === "light") {
  await $`agent-browser eval ${[
    `localStorage.setItem('agent-swarm-mode', 'light')`,
    `document.documentElement.classList.remove('dark')`,
    `document.documentElement.style.colorScheme = 'light'`,
  ].join(";")}`;
  await sleep(400);
}

// Cursor moves toward the People page heading
await rawMove(Math.round(WIDTH * 0.5), Math.round(HEIGHT * 0.16), "hover");
await linger(1800);

await stopBeat();

// ---------------------------------------------------------------------------
// Beat 2: Scan the People list
// ---------------------------------------------------------------------------

await startBeat("scan-list");

// Cursor drifts down the list scanning rows
for (let i = 0; i < 4; i++) {
  const px = Math.round(WIDTH * (0.25 + Math.random() * 0.1));
  const py = Math.round(HEIGHT * (0.30 + i * 0.08));
  await rawMove(px, py, "hover");
  await sleep(500);
}

// Hover over the first row to highlight it
try {
  await hover(".ag-row-first .ag-cell, [data-rowindex='0'] .ag-cell", "first row");
  await sleep(400);
} catch {
  await rawMove(Math.round(WIDTH * 0.35), Math.round(HEIGHT * 0.38), "hover");
  await sleep(400);
}

await linger(1500);
await stopBeat();

// ---------------------------------------------------------------------------
// Beat 3: Click a person → open detail page
// ---------------------------------------------------------------------------

await startBeat("open-person");

// Move cursor to first row before clicking
try {
  await clickEl(".ag-row-first .ag-cell:first-child, [data-rowindex='0'] .ag-cell:first-child", "open person");
  await sleep(1600);
} catch {
  // Fall back to direct navigation
  await $`agent-browser open ${UI}/people/${demoUserId}`;
  await sleep(1600);
  await rawMove(Math.round(WIDTH * 0.35), Math.round(HEIGHT * 0.22), "hover");
}

// Cursor hovers over the profile area
await rawMove(Math.round(WIDTH * 0.33), Math.round(HEIGHT * 0.20), "hover");
await sleep(400);
await rawMove(Math.round(WIDTH * 0.33), Math.round(HEIGHT * 0.24), "hover");
await linger(1800);

await stopBeat();

// ---------------------------------------------------------------------------
// Beat 4: Linked identities section
// ---------------------------------------------------------------------------

await startBeat("linked-identities");

try {
  await hover("[data-testid='identities-section'], [class*='identit']", "identities section");
} catch {
  // Cursor moves toward right-rail identities area
  await rawMove(Math.round(WIDTH * 0.82), Math.round(HEIGHT * 0.36), "hover");
  await sleep(300);
  await rawMove(Math.round(WIDTH * 0.82), Math.round(HEIGHT * 0.44), "hover");
}

await linger(2200);
await stopBeat();

// ---------------------------------------------------------------------------
// Beat 5: Activity timeline
// ---------------------------------------------------------------------------

await startBeat("activity-timeline");

try {
  await hover("[data-testid='events-table'] .ag-row, .ag-row[row-index='0']", "activity event row");
} catch {
  // Cursor scans down the events table
  for (let i = 0; i < 3; i++) {
    const py = Math.round(HEIGHT * (0.48 + i * 0.07));
    await rawMove(Math.round(WIDTH * 0.45), py, "hover");
    await sleep(500);
  }
}

await linger(2000);

// Final drift toward centre before cut
await rawMove(Math.round(WIDTH * 0.45), Math.round(HEIGHT * 0.5), "move");
await sleep(600);

await stopBeat();

// ---------------------------------------------------------------------------
// Close DB
// ---------------------------------------------------------------------------

db.close();

// ---------------------------------------------------------------------------
// Stitch beats → final MP4 via ffmpeg filter_complex concat
// ---------------------------------------------------------------------------

console.log(`\n🎞  Stitching ${beats.length} beats → ${FINAL_MP4}`);

if (beats.length === 0) {
  console.error("✗ No beats recorded — aborting.");
  process.exit(1);
}

// Build filter_complex concat string: [0:v][1:v]...[N:v]concat=n=N:v=1[out]
const inputFlags = beats.flatMap((b) => ["-i", b.webmPath]);
const filterInputs = beats.map((_, i) => `[${i}:v]`).join("");
const filterConcat = `${filterInputs}concat=n=${beats.length}:v=1[out]`;

await $`ffmpeg -y ${inputFlags} -filter_complex ${filterConcat} -map [out] -c:v libx264 -preset fast -crf 22 -pix_fmt yuv420p -an ${FINAL_MP4}`;

const sizeMb = (await Bun.file(FINAL_MP4).arrayBuffer()).byteLength / 1024 / 1024;
console.log(`  ✓ ${FINAL_MP4} (${sizeMb.toFixed(1)} MB)`);

// ---------------------------------------------------------------------------
// Merge cursor tracks with correct time offsets
// ---------------------------------------------------------------------------

const allEvents: CursorEvent[] = [];
let offsetMs = 0;
for (const beat of beats) {
  for (const e of beat.events) {
    allEvents.push({ ...e, tsMs: e.tsMs + offsetMs });
  }
  offsetMs += beat.durationMs;
}

const cursorTrack: CursorTrack = {
  version: "1",
  durationMs: offsetMs,
  viewport: { width: WIDTH, height: HEIGHT },
  theme: THEME,
  events: allEvents,
};

writeFileSync(CURSOR_OUT, JSON.stringify(cursorTrack, null, 2));
console.log(`  ✓ ${CURSOR_OUT} (${allEvents.length} events, ${(offsetMs / 1000).toFixed(1)}s)`);

// ---------------------------------------------------------------------------
// Print summary
// ---------------------------------------------------------------------------

console.log(`\n📊 Beat summary:`);
let cumMs = 0;
for (const b of beats) {
  console.log(`   [${b.label}] ${(b.durationMs / 1000).toFixed(2)}s  ${b.events.length} events  offset=${(cumMs / 1000).toFixed(2)}s`);
  cumMs += b.durationMs;
}
console.log(`   Total: ${(offsetMs / 1000).toFixed(2)}s`);

console.log(`\n✅ Done.`);
console.log(`\nNext steps:`);
console.log(`  1. Copy final video to Remotion public dir:`);
console.log(`     cp ${FINAL_MP4} assets/video-source/public/swarm-demo.mp4`);
console.log(`  2. Copy cursor track:`);
console.log(`     cp ${CURSOR_OUT} assets/video-source/src/cursor-track.json`);
console.log(`  3. Render v4:`);
console.log(`     cd assets/video-source && npx remotion render src/index.ts SwarmDemo out/swarm-demo-v4.mp4`);
