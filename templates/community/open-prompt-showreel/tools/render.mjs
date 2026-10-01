// Renders a frame-addressable canvas reel (reel.html) to stills or to an mp4.
//
//   node render.mjs --reel reel.html --w 1920 --h 1080 --facts facts.json --logo logo.png \
//     --fonts SG=fonts/SpaceGrotesk.ttf,JB=fonts/JetBrainsMono.ttf --out stills/r1 --at 12,45,100
//   node render.mjs --reel reel.html --w 1920 --h 1080 --facts facts.json --logo logo.png \
//     --fonts SG=...,JB=... --music music.json --out out/reel-1920x1080.mp4
//
// reel.html contract: window.boot(facts, fonts, logoDataUrl) loads fonts + logo and stashes the
// facts; window.frame(f) draws frame f as a pure function of f and returns a PNG data URL.
// `--music` takes a JSON file { credit, wav? }; its fields land in facts.music and, if wav is set,
// that file is muxed in as the audio track. Without `wav` the video is silent (a warning says so).
// Exits non-zero when ffmpeg fails or the page throws; the output directory is created.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1];
}
for (const k of ["reel", "w", "h", "facts", "logo", "fonts", "out"]) {
  if (!args[k]) throw new Error(`missing --${k}`);
}
const [w, h, fps, frames] = [+args.w, +args.h, +(args.fps ?? 30), +(args.frames ?? 720)];

// playwright is baked into the worker image under /opt/global-deps-full; fall back to a local install.
const roots = [
  process.env.PLAYWRIGHT_ROOT,
  "/opt/global-deps-full/node_modules/",
  `${process.cwd()}/node_modules/`,
];
let chromium;
for (const root of roots.filter(Boolean)) {
  try {
    ({ chromium } = createRequire(root.replace(/\/?$/, "/"))("playwright"));
    break;
  } catch {}
}
if (!chromium) throw new Error("playwright not found; run setup.sh or set PLAYWRIGHT_ROOT");

const music = args.music ? JSON.parse(readFileSync(args.music, "utf8")) : null;
const facts = { ...JSON.parse(readFileSync(args.facts, "utf8")), ...(music ? { music } : {}) };
const logo = `data:image/png;base64,${readFileSync(args.logo).toString("base64")}`;
const fonts = args.fonts.split(",").map((p) => {
  const [name, file] = p.split("=");
  return [name, readFileSync(file).toString("base64")];
});

// Spawns ffmpeg, pipes `frames` PNGs from `grab` into it, and resolves only when ffmpeg exits 0 with
// every frame written. Failure handlers are attached before the first write, and a child that dies
// also unblocks a writer that is waiting for `drain`.
const encode = async (grab) => {
  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  const input = ["-f", "image2pipe", "-framerate", String(fps), "-i", "-"];
  const audio = music?.wav ? ["-i", music.wav, "-map", "0:v", "-map", "1:a"] : [];
  const video = [
    ...["-c:v", "libx264", "-preset", "slow", "-crf", "16"],
    ...["-pix_fmt", "yuv420p", "-profile:v", "high"],
  ];
  const tail = music?.wav ? ["-c:a", "aac", "-b:a", "192k", "-shortest"] : [];
  const ff = spawn(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      ...input,
      ...audio,
      ...video,
      ...tail,
      "-movflags",
      "+faststart",
      args.out,
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  let ended = null;
  const gone = new Promise((done) => {
    const finish = (result) => {
      // A failed spawn emits "error" and then "close" (code -2); keep the first, which says why.
      if (ended) return;
      ended = result;
      done(result);
    };
    ff.once("error", (error) => finish({ error }));
    ff.once("close", (code, signal) => finish({ code, signal }));
  });
  // EPIPE after ffmpeg dies is a symptom; the exit status below is the error that gets reported.
  ff.stdin.on("error", () => {});

  let written = 0;
  const t0 = Date.now();
  try {
    for (let f = 0; f < frames && !ended; f++) {
      const png = await grab(f);
      if (ended) break;
      if (!ff.stdin.write(png)) {
        await Promise.race([new Promise((r) => ff.stdin.once("drain", r)), gone]);
      }
      written++;
      if (f % 120 === 0) console.error(`frame ${f} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    if (!ended) ff.stdin.end();
    await gone;
  } finally {
    if (!ended) {
      ff.stdin.destroy();
      ff.kill("SIGKILL");
    }
  }
  const fail = (why) => {
    rmSync(args.out, { force: true });
    throw new Error(why);
  };
  if (ended.error) fail(`could not run ffmpeg: ${ended.error.message}`);
  if (ended.code !== 0) fail(`ffmpeg exited with ${ended.signal ?? `code ${ended.code}`}`);
  if (written < frames) {
    fail(
      `ffmpeg stopped after ${written} of ${frames} frames (is the --music wav shorter than the video?)`,
    );
  }
};

if (music?.wav && !existsSync(music.wav)) throw new Error(`--music wav not found: ${music.wav}`);
if (music && !music.wav && !args.at) {
  console.error(`warning: ${args.music} has no "wav" field, rendering a silent video`);
}

const browser = await chromium.launch({ args: ["--disable-gpu-vsync"] });
try {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on("console", (m) => console.error("[page]", m.text()));
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.goto(`file://${resolve(args.reel)}?w=${w}&h=${h}`);
  console.error(
    JSON.stringify(await page.evaluate(([a, b, c]) => window.boot(a, b, c), [facts, fonts, logo])),
  );

  const grab = async (f) =>
    Buffer.from((await page.evaluate((n) => window.frame(n), f)).split(",")[1], "base64");

  if (args.at) {
    mkdirSync(args.out, { recursive: true });
    for (const f of args.at.split(",").map(Number)) {
      writeFileSync(`${args.out}/f${String(f).padStart(3, "0")}.png`, await grab(f));
    }
  } else {
    await encode(grab);
  }
} catch (e) {
  console.error(`render failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
