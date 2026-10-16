// build-loom.mjs: steps.json + raw recording -> narrated qa-loom.mp4 (+ qa-loom.ass, work/).
// Usage: node build-loom.mjs <steps.json> <raw.webm> <outDir>   (bun works too)
// Env: ELEVENLABS_API_KEY (required), SPEED=1.33, VOICE=21m00Tcm4TlvDq8ikWAM,
//      MODEL=eleven_turbo_v2_5, FONT="DejaVu Sans"
// Needs: Node 18+ (global fetch, top-level await) and ffmpeg built with libass (`ass` filter).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [stepsPath, raw, outArg] = process.argv.slice(2);
if (!stepsPath || !raw || !outArg) {
  throw new Error("usage: node build-loom.mjs <steps.json> <raw.webm> <outDir>");
}
const out = resolve(outArg);
const SPEED = Number(process.env.SPEED ?? 1.33);
const VOICE = process.env.VOICE ?? "21m00Tcm4TlvDq8ikWAM";
const MODEL = process.env.MODEL ?? "eleven_turbo_v2_5";
const FONT = process.env.FONT ?? "DejaVu Sans";
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) throw new Error("ELEVENLABS_API_KEY is not set");
mkdirSync(join(out, "work"), { recursive: true });
const W = (f) => join(out, "work", f);

// -loglevel error keeps ffmpeg's banner and progress output out of the logs.
const ff = (...args) => {
  try {
    execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (e) {
    throw new Error(`ffmpeg failed: ${String(e.stderr).slice(0, 400)}`);
  }
};
const ENC = [
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-crf",
  "23",
  "-pix_fmt",
  "yuv420p",
  "-r",
  "30",
  "-video_track_timescale",
  "15360",
];
// Keep the aspect ratio: letterbox or pillarbox into 1920x1080, never stretch (mobile viewports).
const FIT =
  "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=white";

const { steps } = JSON.parse(readFileSync(stepsPath, "utf8"));
const concat = [];
const cues = [];
const audio = [];
let T = 0; // running output timeline, in seconds

for (const [i, s] of steps.entries()) {
  const visualAt = s.visualAt ?? s.start;
  const segLen = (s.end - s.start) / SPEED;
  const v = (visualAt - s.start) / SPEED; // voice and subtitles start when the screen renders

  // 1. TTS with character timestamps, one request per step. Cached per narration text,
  //    so a re-run after a style tweak costs no ElevenLabs characters.
  const mp3 = W(`audio-${i + 1}.mp3`);
  const alPath = W(`audio-${i + 1}.json`);
  let cached = existsSync(alPath) ? JSON.parse(readFileSync(alPath, "utf8")) : null;
  if (cached?.text !== s.narration) {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/with-timestamps`,
      {
        method: "POST",
        headers: { "xi-api-key": KEY, "content-type": "application/json" },
        body: JSON.stringify({ text: s.narration, model_id: MODEL }),
      },
    );
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const tts = await res.json();
    // audio_base64 is large: write it straight to disk, never print it.
    writeFileSync(mp3, Buffer.from(tts.audio_base64, "base64"));
    cached = { text: s.narration, alignment: tts.alignment };
    writeFileSync(alPath, JSON.stringify(cached));
  }
  const al = cached.alignment;
  const aDur = al.character_end_times_seconds.at(-1);

  // 2. Sped-up segment. Freeze the last frame when the narration outlasts it.
  const seg = W(`seg-${i + 1}.mp4`);
  ff(
    "-ss",
    String(s.start),
    "-t",
    String(s.end - s.start),
    "-i",
    raw,
    "-an",
    "-vf",
    `setpts=(PTS-STARTPTS)/${SPEED},${FIT},fps=30`,
    ...ENC,
    seg,
  );
  concat.push(seg);
  const need = v + aDur + 0.35;
  let len = segLen;
  if (need > segLen) {
    const png = W(`last-${i + 1}.png`);
    ff("-sseof", "-0.2", "-i", seg, "-update", "1", "-frames:v", "1", png);
    const pad = W(`pad-${i + 1}.mp4`);
    const padLen = (need - segLen).toFixed(3);
    ff("-loop", "1", "-framerate", "30", "-t", padLen, "-i", png, "-vf", FIT, ...ENC, pad);
    concat.push(pad);
    len = need;
  }
  audio.push({ mp3, delayMs: Math.round((T + v) * 1000) });

  // 3. Subtitle cues from the same alignment, so voice and subtitles cannot drift.
  //    At most 6 words per cue, break on punctuation, merge orphans under 3 words.
  const words = [];
  let cur = null;
  al.characters.forEach((ch, k) => {
    if (/\s/.test(ch)) {
      if (cur) words.push(cur);
      cur = null;
      return;
    }
    if (!cur) cur = { text: "", t0: al.character_start_times_seconds[k] };
    cur.text += ch;
    cur.t1 = al.character_end_times_seconds[k];
  });
  if (cur) words.push(cur);
  const groups = [];
  let g = [];
  for (const w of words) {
    g.push(w);
    if (g.length >= 6 || /[.,;:!?]$/.test(w.text)) {
      groups.push(g);
      g = [];
    }
  }
  if (g.length) groups.push(g);
  for (let k = groups.length - 1; k > 0; k--) {
    if (groups[k].length < 3) {
      groups[k - 1].push(...groups[k]);
      groups.splice(k, 1);
    }
  }
  for (const grp of groups) {
    cues.push({
      t0: T + v + grp[0].t0,
      t1: T + v + grp.at(-1).t1 + 0.1,
      text: grp.map((w) => w.text).join(" "),
    });
  }
  T += len;
}

// 4. Concat with the concat demuxer. The concat filter in one big filtergraph can
//    truncate the video stream.
writeFileSync(W("concat.txt"), concat.map((f) => `file '${f}'`).join("\n"));
ff("-f", "concat", "-safe", "0", "-i", W("concat.txt"), "-c", "copy", W("video.mp4"));

// 5. ASS subtitles: one small line, bottom centre, dark box. libass ignores the
//    BackColour alpha with BorderStyle=3, so the box is solid #303030.
const ts = (t) => {
  const cs = Math.round(t * 100);
  const h = Math.floor(cs / 360000);
  const m = String(Math.floor(cs / 6000) % 60).padStart(2, "0");
  const sec = String(Math.floor(cs / 100) % 60).padStart(2, "0");
  return `${h}:${m}:${sec}.${String(cs % 100).padStart(2, "0")}`;
};
for (let k = 0; k < cues.length - 1; k++) cues[k].t1 = Math.min(cues[k].t1, cues[k + 1].t0);
const dialogue = cues
  .map((c) => `Dialogue: 0,${ts(c.t0)},${ts(c.t1)},Default,,0,0,0,,${c.text}`)
  .join("\n");
const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${FONT},38,&H00FFFFFF,&H00FFFFFF,&H303030,&H00000000,0,0,0,0,100,100,0,0,3,2,0,2,40,40,30,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${dialogue}
`;
const assPath = join(out, "qa-loom.ass");
writeFileSync(assPath, ass);

// 6. Mux: delay each step's audio to where its screen renders, mix, burn subtitles.
//    normalize=0 stops amix from dividing the volume by the number of inputs.
const inputs = audio.flatMap((a) => ["-i", a.mp3]);
const delays = audio.map((a, k) => `[${k + 1}:a]adelay=${a.delayMs}:all=1[a${k}]`).join(";");
const labels = audio.map((_, k) => `[a${k}]`).join("");
const mix = `${labels}amix=inputs=${audio.length}:normalize=0:duration=longest[a]`;
ff(
  "-i",
  W("video.mp4"),
  ...inputs,
  "-filter_complex",
  `${delays};${mix};[0:v]ass=${assPath}[v]`,
  "-map",
  "[v]",
  "-map",
  "[a]",
  ...ENC,
  "-c:a",
  "aac",
  "-b:a",
  "128k",
  "-movflags",
  "+faststart",
  "-t",
  T.toFixed(3),
  join(out, "qa-loom.mp4"),
);
const chars = steps.reduce((n, s) => n + s.narration.length, 0);
console.log(
  JSON.stringify({ durationS: +T.toFixed(2), steps: steps.length, cues: cues.length, chars }),
);
