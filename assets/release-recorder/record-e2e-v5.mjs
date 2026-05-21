#!/usr/bin/env node
/**
 * E2E demo recorder v5 — Playwright-based segmented recording.
 *
 * Fixes v4's repetitive beats by:
 *   1. Seeding Ada Sandoval (4 linked identities + 12 activity events) before recording.
 *   2. Navigating to genuinely different parts of the UI for each beat.
 *   3. Different zoom framing per beat via cursor placement.
 *
 * Beats:
 *   1. navigate-people  — full People list (10 varied people, statuses, roles)
 *   2. scan-list        — close-up scan of individual rows
 *   3. open-person      — Ada Sandoval profile (avatar, name, role badge, notes)
 *   4. linked-identities — identities panel (Slack/GitHub/Linear/GitLab badges)
 *   5. activity-timeline — scrollable events table (12 varied events)
 *
 * Usage:
 *   cd assets/release-recorder
 *   node record-e2e-v5.mjs
 *
 * Output:
 *   raw/swarm-demo.mp4         — final stitched video (libx264, 1920×1080)
 *   raw/e2e-demo-cursor.json   — merged CursorTrack (schema v1)
 */

import { chromium } from '/opt/global-deps/node_modules/playwright/index.mjs';
import { execFileSync } from 'child_process';
import { writeFileSync, mkdirSync, renameSync, existsSync, readdirSync, unlinkSync, statSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_DIR    = join(__dirname, 'raw');
const FINAL_MP4  = join(RAW_DIR, 'swarm-demo.mp4');
const CURSOR_OUT = join(RAW_DIR, 'e2e-demo-cursor.json');
const FFMPEG     = process.env.FFMPEG_BIN ?? 'ffmpeg';
const WIDTH  = 1920;
const HEIGHT = 1080;
const UI  = process.env.SWARM_UI_URL  ?? 'http://localhost:5274';
const API = process.env.SWARM_API_URL ?? 'http://localhost:3013';
const API_KEY = process.env.API_KEY ?? '123123';
const ADA_ID = '7f944e82787b481bb78d4c20d12b1fa3'; // seeded via seed-people.ts

mkdirSync(RAW_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Preflight checks
// ---------------------------------------------------------------------------

console.log('🎬 E2E demo recorder v5 (Playwright, segmented)\n');
console.log(`   viewport: ${WIDTH}×${HEIGHT}`);

const health = await fetch(`${API}/health`).then(r => r.json()).catch(() => null);
if (!health?.status) {
  console.error(`✗ API not reachable at ${API}`); process.exit(1);
}
console.log(`  API: ${API} ✓ (v${health.version})`);

const uiCode = await fetch(UI).then(r => r.status).catch(() => 0);
if (uiCode !== 200) {
  console.error(`✗ UI not reachable at ${UI} (got ${uiCode})`); process.exit(1);
}
console.log(`  UI: ${UI} ✓\n`);

// ---------------------------------------------------------------------------
// localStorage inject — run once per new page to configure the connection
// ---------------------------------------------------------------------------

const CONN_CONFIG = JSON.stringify({
  connections: [{ id: 'demo-conn', name: 'local', apiUrl: API, apiKey: API_KEY }],
  activeId: 'demo-conn',
});
const USER_KEY = `swarm:v1:${API}:current-user`;

async function injectLocalStorage(page, userId = ADA_ID) {
  await page.evaluate(({ connConfig, userKey, userId }) => {
    localStorage.setItem('agent-swarm-connections', connConfig);
    localStorage.setItem(userKey, userId);
    localStorage.setItem('agent-swarm-mode', 'light');
    document.documentElement.classList.remove('dark');
    document.documentElement.style.colorScheme = 'light';
  }, { connConfig: CONN_CONFIG, userKey: USER_KEY, userId });
}

// ---------------------------------------------------------------------------
// Beat recording
// ---------------------------------------------------------------------------

/**
 * Record one beat.
 *  - Creates a fresh Playwright browser context with recordVideo.
 *  - Navigates to the beat's start URL, injects auth.
 *  - Runs the `fn(page, track)` choreography.
 *  - Closes the context (finalises the webm).
 *  - Renames the auto-named webm to `raw/beat-{label}.webm`.
 * Returns `{ label, webmPath, events, durationMs }`.
 */
async function recordBeat(label, startUrl, fn) {
  console.log(`\n🔴 Recording beat [${label}]`);

  const browser = await chromium.launch({
    headless: true,
    executablePath: '/opt/playwright/chromium-1208/chrome-linux64/chrome',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--force-color-profile=srgb',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    recordVideo: { dir: RAW_DIR, size: { width: WIDTH, height: HEIGHT } },
  });

  const page = await context.newPage();
  const beatEvents = [];
  const beatStart = Date.now();

  function track(x, y, action = 'move') {
    beatEvents.push({ tsMs: Date.now() - beatStart, x, y, action });
  }

  async function moveTo(x, y, opts = {}) {
    await page.mouse.move(x, y, { steps: opts.steps ?? 8 });
    track(x, y, opts.action ?? 'move');
  }

  async function click(x, y) {
    await moveTo(x, y, { steps: 5, action: 'move' });
    await sleep(200);
    await page.mouse.down();
    await page.mouse.up();
    track(x, y, 'click');
    await sleep(200);
  }

  // ---- Navigate + inject auth ----
  await page.goto(`${UI}/`);
  await sleep(300);
  await injectLocalStorage(page, ADA_ID);
  await sleep(200);
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  await sleep(2000); // let AG-Grid render

  // ---- Force light theme after each navigation ----
  await page.evaluate(() => {
    localStorage.setItem('agent-swarm-mode', 'light');
    document.documentElement.classList.remove('dark');
    document.documentElement.style.colorScheme = 'light';
  });
  await sleep(300);

  // ---- Run beat choreography ----
  track(WIDTH / 2, HEIGHT / 2, 'move');
  await fn(page, moveTo, click, track);
  await sleep(600); // hold at end

  // ---- Close and finalise ----
  const videoPath = await page.video()?.path();
  await page.close();
  await context.close();
  await browser.close();
  await sleep(800); // wait for webm to flush

  // Rename the auto-named webm
  const destPath = join(RAW_DIR, `beat-${label}.webm`);
  if (videoPath && existsSync(videoPath)) {
    if (existsSync(destPath)) unlinkSync(destPath);
    renameSync(videoPath, destPath);
  } else {
    // fallback: find newest webm in RAW_DIR
    const webms = readdirSync(RAW_DIR)
      .filter(f => f.endsWith('.webm') && !f.startsWith('beat-'))
      .map(f => ({ f, mtime: new Date(statSync(join(RAW_DIR, f)).mtime) }))
      .sort((a, b) => b.mtime - a.mtime);
    if (webms.length > 0) {
      if (existsSync(destPath)) unlinkSync(destPath);
      renameSync(join(RAW_DIR, webms[0].f), destPath);
    }
  }

  // Measure duration via ffprobe (use FFMPEG binary's built-in probe if available)
  let durationMs = Date.now() - beatStart;
  const ffprobePath = FFMPEG.replace('ffmpeg-linux', 'ffprobe-linux');
  try {
    const dur = execFileSync(ffprobePath, [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', destPath,
    ]).toString().trim();
    durationMs = Math.round(parseFloat(dur) * 1000);
  } catch {
    // ffprobe not available — fall back to querying via ffmpeg
    try {
      const out = execFileSync(FFMPEG, [
        '-v', 'quiet', '-i', destPath, '-f', 'null', '-',
      ], { stdio: ['ignore', 'ignore', 'pipe'] }).toString();
      const m = out.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      if (m) durationMs = Math.round((+m[1] * 3600 + +m[2] * 60 + +parseFloat(m[3])) * 1000);
    } catch { /* wall-clock fallback */ }
  }

  console.log(`⏹  [${label}] done — ${(durationMs / 1000).toFixed(2)}s, ${beatEvents.length} events`);
  return { label, webmPath: destPath, events: beatEvents, durationMs };
}

// ---------------------------------------------------------------------------
// Beat choreographies
// ---------------------------------------------------------------------------

const beats = [];

// Target: ~22s total across all 5 beats to fit the 22.5s Remotion demo window.
// Each beat ~4-5s.

// ── Beat 1: People list — establishing shot (~4s) ─────────────────────────
// Shows: full People grid (10 varied people), page heading
beats.push(await recordBeat('navigate-people', `${UI}/people`, async (page, moveTo, click, track) => {
  try { await page.waitForSelector('.ag-row', { timeout: 6000 }); } catch {}
  await sleep(700);
  // Wide pan: left → heading → right
  await moveTo(Math.round(WIDTH * 0.15), Math.round(HEIGHT * 0.09));
  await sleep(220);
  await moveTo(Math.round(WIDTH * 0.45), Math.round(HEIGHT * 0.09));
  await sleep(280);
  await moveTo(Math.round(WIDTH * 0.70), Math.round(HEIGHT * 0.09));
  await sleep(220);
  // Sweep down to first row
  await moveTo(Math.round(WIDTH * 0.35), Math.round(HEIGHT * 0.23));
  await sleep(300);
  await moveTo(Math.round(WIDTH * 0.60), Math.round(HEIGHT * 0.20));
  await sleep(250);
}));

// ── Beat 2: Scan list — close-up row hover (~5s) ─────────────────────────
// Shows: individual rows highlighted — different names/roles/statuses
beats.push(await recordBeat('scan-list', `${UI}/people`, async (page, moveTo, click, track) => {
  try { await page.waitForSelector('.ag-row', { timeout: 6000 }); } catch {}
  await sleep(600);
  const nameColX = Math.round(WIDTH * 0.22);
  // Scan 5 rows, 330ms each
  for (const fraction of [0.32, 0.40, 0.48, 0.56, 0.64]) {
    const rowY = Math.round(HEIGHT * fraction);
    await moveTo(nameColX, rowY);
    await sleep(200);
    await moveTo(Math.round(WIDTH * 0.55), rowY);
    await sleep(150);
    await moveTo(nameColX, rowY);
    await sleep(180);
  }
  await moveTo(Math.round(WIDTH * 0.35), Math.round(HEIGHT * 0.40));
  await sleep(250);
}));

// ── Beat 3: Open Ada — profile detail view (~4s) ─────────────────────────
// Shows: Ada Sandoval's profile (avatar, "Ada Sandoval", admin badge, notes, timezone)
beats.push(await recordBeat('open-person', `${UI}/people`, async (page, moveTo, click, track) => {
  try { await page.waitForSelector('.ag-row', { timeout: 6000 }); } catch {}
  await sleep(500);
  const firstRowY = Math.round(HEIGHT * 0.32);
  await moveTo(Math.round(WIDTH * 0.22), firstRowY);
  await sleep(220);
  await click(Math.round(WIDTH * 0.22), firstRowY);

  try {
    await page.waitForURL(`**/people/**`, { timeout: 5000 });
  } catch {
    await page.goto(`${UI}/people/${ADA_ID}`, { waitUntil: 'domcontentloaded' });
  }
  await sleep(1400);
  await page.evaluate(() => {
    localStorage.setItem('agent-swarm-mode', 'light');
    document.documentElement.classList.remove('dark');
    document.documentElement.style.colorScheme = 'light';
  });
  await sleep(200);

  // Hover over profile header area
  await moveTo(Math.round(WIDTH * 0.12), Math.round(HEIGHT * 0.18));
  await sleep(280);
  await moveTo(Math.round(WIDTH * 0.28), Math.round(HEIGHT * 0.18));
  await sleep(280);
  await moveTo(Math.round(WIDTH * 0.28), Math.round(HEIGHT * 0.25));
  await sleep(300);
}));

// ── Beat 4: Linked identities — badges panel (~4.5s) ─────────────────────
// Shows: Slack / GitHub / Linear / GitLab identity badges in the right rail
beats.push(await recordBeat('linked-identities', `${UI}/people/${ADA_ID}`, async (page, moveTo, click, track) => {
  await sleep(1400);
  await page.evaluate(() => {
    localStorage.setItem('agent-swarm-mode', 'light');
    document.documentElement.classList.remove('dark');
    document.documentElement.style.colorScheme = 'light';
  });
  await sleep(200);

  const identX = Math.round(WIDTH * 0.72);
  await moveTo(identX, Math.round(HEIGHT * 0.28));
  await sleep(300);
  // Scan 4 identity badges
  for (const fraction of [0.35, 0.43, 0.51, 0.59]) {
    const y = Math.round(HEIGHT * fraction);
    await moveTo(identX, y);
    await sleep(280);
    await moveTo(Math.round(WIDTH * 0.84), y);
    await sleep(160);
    await moveTo(identX, y);
    await sleep(160);
  }
  await moveTo(Math.round(WIDTH * 0.62), Math.round(HEIGHT * 0.44));
  await sleep(250);
}));

// ── Beat 5: Activity timeline — events feed scan (~5s) ───────────────────
// Shows: 12 varied events (identity_added, budget_changed, profile_changed, status_changed)
beats.push(await recordBeat('activity-timeline', `${UI}/people/${ADA_ID}`, async (page, moveTo, click, track) => {
  await sleep(1400);
  await page.evaluate(() => {
    localStorage.setItem('agent-swarm-mode', 'light');
    document.documentElement.classList.remove('dark');
    document.documentElement.style.colorScheme = 'light';
  });
  await sleep(200);

  // Scroll down to reveal the events table
  await page.evaluate(() => window.scrollBy(0, 480));
  await sleep(400);

  const eventsX = Math.round(WIDTH * 0.42);
  await moveTo(eventsX, Math.round(HEIGHT * 0.26));
  await sleep(250);

  // Scan 5 event rows
  for (const fraction of [0.33, 0.41, 0.49, 0.57, 0.65]) {
    const rowY = Math.round(HEIGHT * fraction);
    await moveTo(Math.round(WIDTH * 0.26), rowY);
    await sleep(220);
    await moveTo(eventsX, rowY);
    await sleep(220);
    await moveTo(Math.round(WIDTH * 0.65), rowY);
    await sleep(160);
    await moveTo(eventsX, rowY);
    await sleep(160);
  }
  await moveTo(Math.round(WIDTH * 0.45), Math.round(HEIGHT * 0.68));
  await sleep(300);
}));

// ---------------------------------------------------------------------------
// Stitch beats → final MP4
// ---------------------------------------------------------------------------

console.log(`\n🎞  Stitching ${beats.length} beats → ${FINAL_MP4}`);

const inputFlags = beats.flatMap(b => ['-i', b.webmPath]);
const filterInputs = beats.map((_, i) => `[${i}:v]`).join('');
const filterConcat = `${filterInputs}concat=n=${beats.length}:v=1[out]`;

execFileSync(FFMPEG, [
  '-y', ...inputFlags,
  '-filter_complex', filterConcat,
  '-map', '[out]',
  '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
  '-pix_fmt', 'yuv420p', '-an', FINAL_MP4,
], { stdio: 'inherit' });

const sizeMb = (statSync(FINAL_MP4).size / 1024 / 1024).toFixed(1);
console.log(`  ✓ ${FINAL_MP4} (${sizeMb} MB)`);

// ---------------------------------------------------------------------------
// Merge cursor tracks with time offsets
// ---------------------------------------------------------------------------

const allEvents = [];
let offsetMs = 0;
for (const beat of beats) {
  for (const e of beat.events) {
    allEvents.push({ ...e, tsMs: e.tsMs + offsetMs });
  }
  offsetMs += beat.durationMs;
}

writeFileSync(CURSOR_OUT, JSON.stringify({
  version: '1',
  durationMs: offsetMs,
  viewport: { width: WIDTH, height: HEIGHT },
  theme: 'light',
  events: allEvents,
}, null, 2));
console.log(`  ✓ ${CURSOR_OUT} (${allEvents.length} events, ${(offsetMs / 1000).toFixed(1)}s)`);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n📊 Beat summary:');
let cumMs = 0;
for (const b of beats) {
  console.log(`   [${b.label}] ${(b.durationMs / 1000).toFixed(2)}s  ${b.events.length} events  offset=${(cumMs / 1000).toFixed(2)}s`);
  cumMs += b.durationMs;
}
console.log(`   Total: ${(offsetMs / 1000).toFixed(2)}s\n`);

console.log('✅ Done.\n');
console.log('Next steps:');
console.log(`  1. cp ${FINAL_MP4} assets/video-source/public/swarm-demo.mp4`);
console.log(`  2. cp ${CURSOR_OUT} assets/video-source/src/cursor-track.json`);
console.log(`  3. cd assets/video-source && npx remotion render src/index.ts SwarmDemo out/swarm-demo-v5.mp4`);
