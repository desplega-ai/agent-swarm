---
name: motion-design-video-analysis
description: Reverse-engineer a short motion-design / product-update video (animation technique, timing and easing, composition, transitions, likely tooling, vibe, audio) and produce a rebuild spec someone can build from. Default path is one call to google/gemini-3.8-flash over sampled frames, then a mandatory by-eye check of every claim. Use when asked how a marketing or product video was made, what its vibe is, or before replicating one (then continue with motion-design-replication).
metadata:
  type: procedure
---

# Motion-design video analysis

Turns a short (under ~1 min) motion-design clip into two things: an **analysis** (how it was made and how it feels) and a **rebuild spec** (numbers someone can build from without reopening the video). Validated on a 28.6 s product-update clip (Linear's "Loops updates") and reused as the judge on a replica of it.

The model is a fast first reader. You are the ground truth. Both models tested on the Linear clip confidently described a "flat 2D view that becomes 3D at 7.5s"; the frames show a 3D scene from t=0. Plan for that class of error.

## Prerequisites

- `ffmpeg` on PATH. Worker images have a full static build at `/usr/local/bin/ffmpeg` (has `fps`, `tile`, `scale`, `crop`, `hstack`; no `drawtext`, no `ffprobe`: read `ffmpeg -i` stderr, or run the community template's `setup.sh` to add ffprobe). The Remotion-bundled ffmpeg under `node_modules/@remotion/compositor-*` is stripped (no `fps`, `tile` or `hstack`); don't use it for analysis.
- Pixel maths: `python3 -m venv /tmp/venv && /tmp/venv/bin/pip install numpy pillow` (system pip is blocked by PEP 668; this venv install was run and works).
- An OpenRouter credential the script can use. In an Agent Swarm, bind it as an egress credential so the key never enters the script (the header `Authorization: Bearer [REDACTED:OPENROUTER_API_KEY]` resolves at egress in **ephemeral `script-run` only**, see Execution notes). Outside a swarm, any way of calling OpenRouter works.
- Getting bytes off agent-fs: `agent-fs download <path> -o <file>`. Viewer URLs serve an SPA shell, not the file; use `agent-fs signed-url <path> --json` when a script needs to fetch it. Upload binaries with `agent-fs write <path> --file <local>` (binary-safe).

## Step 1 — probe the file

```
ffmpeg -hide_banner -i in.mp4 2>&1 | grep -E "Duration|Stream"
```

Record container duration, resolution, fps, and whether an audio stream exists. These go straight into the rebuild spec.

## Step 2 — audio: verify, then exercise transcription for real

1. A stream existing proves nothing. Measure it: `ffmpeg -i in.mp4 -af volumedetect -f null -` and `-af "silencedetect=noise=-30dB:d=0.5"`.
2. "No voice" is a narrower claim than "no audio". A music/SFX bed with no speech is common (the Linear clip: AAC stereo, mean -21 dB, active 0–27.1s, no speech).
3. Always run the transcription call, even when you expect no speech: `ffmpeg -i in.mp4 -vn -ac 1 -ar 16000 -c:a pcm_s16le out.wav`, stage it, send it to `google/gemini-3.8-flash` as `{type:"input_audio", input_audio:{data:<b64>, format:"wav"}}`. Ask: is there speech; if yes, verbatim transcript with timestamps; if no, describe music (tempo, instrumentation, mood) and each SFX with its timestamp. SFX timestamps matter for the rebuild (they mark the beats).

## Step 3 — look at the whole clip yourself first

Before any model call, build contact sheets and read them:

```
ffmpeg -i in.mp4 -vf "fps=2,scale=480:270,tile=4x5:padding=4:color=red" sheet_%d.png
```

2 fps catches every cut and caption change in a ~30s clip. For each transition, pull a 10 fps window (`-ss <t-0.4> -t 1.2 -vf "fps=10,scale=320:180,tile=4x4"`) to see how it happens: hard cut, mask roll, blur cross, whip. Write a beat list from this (time, what changes). The model call is a second opinion on your beat list, not the source of it.

## Step 4 — default model call: google/gemini-3.8-flash over sampled frames

**Never send raw video.** Every raw-video attempt (base64 `video_url`) timed out on every model, including inside a durable run with `timeoutMs: 180000`; the effective cap stayed ~30s.

1. Sample ~12 frames across the clip: `ffmpeg -i in.mp4 -vf "fps=12/<duration>,scale=480:-1" f_%03d.jpg`. Add frames right before and after each cut you found in Step 3.
2. Base64 them into one JSON (`[{t, b64}]`), write it to agent-fs, get a signed URL.
3. In an ephemeral `script-run`, fetch the JSON, and send one request to `google/gemini-3.8-flash`: a structured prompt, then alternating `{type:"text", text:"t=<n>s"}` / `{type:"image_url", image_url:{url:"data:image/jpeg;base64,..."}}` parts.
4. Prompt for exactly these sections, each claim citing a timestamp: animation technique; timing & easing; composition & layout; transitions; likely tooling; vibe & aesthetic. Ask it to state whether the scene is 2D or 3D **at each timestamp** and what evidence it sees (perspective, foreshortening, blur that varies with depth). The per-timestamp answer makes the miss easy to spot in Step 5; it does **not** prevent it (re-run 2026-09-24 with exactly this question: still "2D" for 0.5–6.6s).

Reference numbers: Linear clip, 12 frames, 10.4s, $0.013; 13 frames with the per-timestamp prompt, 26.6s, $0.022. Keep it under ~14 frames at 480px or you hit the ~30s script cap.

### Optional — multi-model comparison

Only when the user asks which model to use, or the default call fails twice. Resolve IDs from the live catalogue (`GET https://openrouter.ai/api/v1/models`, filter `architecture.input_modalities` for `image`/`video`; users' remembered names are often off by a version). Run each candidate once over the same frame JSON. Record completed / latency / `usage.cost` / grounded-or-generic. Known results: `google/gemini-2.5-pro` matched flash at 2.3x cost and 28.9s; `qwen/qwen3.8-max-0902` handled 1 image but timed out on every 3/7/12-frame request (reproduced 3x).

## Step 5 — check every model claim against the frames (mandatory)

Make a table: claim → timestamp it cites → what the frame actually shows → keep / correct / drop. Open the frames (`Read` the PNG) for each row. Do not skip a claim because it sounds plausible.

What to test for, from the worked example:

- **Dimensionality.** Both models said the dial was "a flat 2D-style view" until 7.5s, then "3D". Wrong. At t=0 the arc is foreshortened, a second ring recedes, the "LOOP TRIGGER" letters are squashed vertically, and the dots nearer the camera are blurrier than the rim (depth of field). That is a 3D scene from frame 0. What changes at 7.5s is the **camera** (telephoto head-on → close oblique macro), not the dimensionality. Test for 3D with: foreshortened text or circles, parallel lines converging, blur that varies with depth, parallax between layers during a camera move.
- **Cuts vs moves.** Models call a hard cut an "orbital camera swing" or "seamless spatial transition". Check the 10 fps window: if one frame is shot A and the next is shot B, it's a cut (the Linear clip has hard cuts at 6.9s and 12.35s, hidden under a fast streak).
- **Caption transitions.** "Instantaneous typographic cuts" was really a ~5-frame vertical roll inside a mask. Only a 10 fps crop shows it.
- **Tooling.** Keep it as a hypothesis with its evidence, not a fact.

Put corrections in the analysis with the frame that proves them.

## Step 6 — write the analysis

Sections: Animation technique / Timing & easing / Composition & layout / Transitions / Likely tooling (with evidence) / Vibe & aesthetic / Audio (measured) / Claim check table (Step 5). Then the rebuild spec below. Raw model output goes in a collapsed section at the end. Deliver as markdown on agent-fs (comment-friendly), not a page, unless asked.

## Step 7 — the rebuild spec (required output section)

Someone should be able to build the piece from this section alone. Measure; don't eyeball when a number is cheap to get.

| Field | How to get it | Linear clip example |
|---|---|---|
| Canvas, fps, duration | Step 1 probe | 640x360 delivered (16:9, likely a 1080p master), 30 fps, 28.59s = 858 frames |
| Palette (hex) | luminance-banded sample of non-black pixels over ~7 frames (script below) + top 0.2% highlights | floor #070707, dial surface #111111–#181818, lines #343435, highlights #edeced. Pure monochrome, no accent |
| Type | read the frames; measure cap height as % of frame height | captions: wide monospace, caps, tracking ~+0.15em, ~3% of frame height, faint glow. Outro: geometric sans (Inter-style), 500, sentence case |
| Beat timing (frames @30) | from the 2 fps sheet + 10 fps windows | trigger captions roll at 33/93/138; streak launches ~189; cut 207; step captions 207/312; cut 371; step captions 371/420/480/526; fade ~574–592; feature lockup 597–657; tagline 660–744; wordmark ~766→end (858) |
| Easing (cubic-bezier) | step through 10 fps frames of one move, plot position vs time | streak legs ≈ (0.3,0.55,0.25,1) — fast launch, long settle; caption roll ≈ (0.33,0,0.1,1) over 5 frames; camera drift ≈ (0.35,0,0.65,1); outro settles ≈ (0.16,1,0.3,1) |
| Camera path | per shot: framing, lens feel, drift direction | shot 1 telephoto from beyond the dial centre looking at the far rim (rim convex, ticks fan toward camera), slow push-in; shot 2 close low oblique macro, slow lateral drift; shot 3 reverse oblique, slow drift, lifts and defocuses to black |
| DOF and blur | which depth is sharp per shot, where focus racks | shot 1 focus on the rim pip, inner rows soft; shots 2–3 very shallow, rack focus from the incoming streak to the node over ~40 / ~16 frames |
| Transitions | list each with frame and type | mask roll (captions), hard cut under a fast streak (x2), fade to black, soft-edge left→right wipe (wordmark), blur-rise cross (lockup → tagline), opacity fade, blur-in (final wordmark) |
| Audio | Step 2 | ambient synth pad, no beat, no voice; soft UI whooshes/ticks near beats; ~1.5s silent tail |

Palette sampler (writes nothing, prints hexes):

```python
# /tmp/venv/bin/python pal.py in.mp4 0.5 2 5 8 11 14 17
import subprocess, sys, numpy as np
v, ts = sys.argv[1], [float(t) for t in sys.argv[2:]]
grab = lambda t: np.frombuffer(subprocess.run(["ffmpeg","-v","error","-ss",str(t),"-i",v,"-frames:v","1","-vf","scale=640:360","-f","rawvideo","-pix_fmt","rgb24","-"],capture_output=True).stdout,np.uint8).reshape(-1,3)
px = np.concatenate([grab(t) for t in ts]).astype(float); px = px[px.sum(1) > 15]
order = np.argsort(px @ [0.2126,0.7152,0.0722])
print(["#%02x%02x%02x" % tuple(px[b].mean(0).astype(int)) for b in np.array_split(order, 8)],
      "top", "#%02x%02x%02x" % tuple(px[order[-len(order)//500:]].mean(0).astype(int)))
```

Also report **motion density**, because it is the easiest thing to get wrong in a rebuild:

- Frozen-frame fraction: sample at 160x90, mean |Δ| < 0.25/255 between consecutive samples counts as frozen. Report at 1 fps and at the native fps. Linear clip: 3/28 (10.7%) at 1 fps, 259/854 (30.3%) at 30 fps, mostly the outro cards plus a ~1s hold around 5s.
- Per-second median |Δ| at native fps. Linear clip: 0.3–0.8/255 through all three 3D shots (the camera never stops). A first replica drifted at 0.1–0.2 and measured 80% frozen at 30 fps while looking fine in stills.

## Execution notes for an Agent Swarm worker

- Do OpenRouter calls from ephemeral `script-run` with inline source, one model per call, payload small enough to finish in ~25s. In a durable `launch-script-run`, `ctx.stdlib.fetch` does not get credential-binding substitution ("Missing Authentication header"), and `ctx.step.swarmScript` doesn't fix it.
- Scripts can't read local paths. Stage frame JSON / audio on agent-fs and fetch a signed URL inside the script.
- Replicating the clip next? Use `motion-design-replication`; it takes this rebuild spec as its input.
