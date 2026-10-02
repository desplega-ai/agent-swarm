# usage: music-analyze.py <audio> -> tempo, beat phase, drop candidates (json on stdout)
# Drop = a beat where the next 4 bars carry much more low-end + total energy than the previous 4 bars.
import json, subprocess, sys
import numpy as np

SR = 22050
path = sys.argv[1]
raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"], capture_output=True, check=True).stdout
x = np.frombuffer(raw, dtype=np.float32)
dur = len(x) / SR

hop, win = 512, 2048
n = 1 + (len(x) - win) // hop
frames = np.lib.stride_tricks.as_strided(x, shape=(n, win), strides=(x.strides[0] * hop, x.strides[0]))
spec = np.abs(np.fft.rfft(frames * np.hanning(win), axis=1))
logs = np.log1p(spec * 10)
flux = np.maximum(0, np.diff(logs, axis=0)).sum(axis=1)
flux = np.concatenate([[0], flux])
flux = flux - np.convolve(flux, np.ones(16) / 16, mode="same")
flux = np.maximum(flux, 0)
fps = SR / hop
freqs = np.fft.rfftfreq(win, 1 / SR)
low = spec[:, freqs < 150].sum(axis=1)
rms = np.sqrt((frames ** 2).mean(axis=1))

# tempo: autocorrelation of onset envelope, 90..160 bpm, with half/double resolution
ac = np.correlate(flux, flux, mode="full")[len(flux) - 1:]
best = None
for bpm in np.arange(90, 160.01, 0.1):
    lag = 60 / bpm * fps
    s = sum(np.interp(lag * k, np.arange(len(ac)), ac) for k in (1, 2, 4)) / 3
    if best is None or s > best[1]:
        best = (bpm, s)
bpm = float(best[0])
period = 60 / bpm
# phase
tt = np.arange(len(flux)) / fps
bestp = None
for ph in np.arange(0, period, 0.005):
    beats = np.arange(ph, dur, period)
    s = np.interp(beats * fps, np.arange(len(flux)), flux).sum()
    if bestp is None or s > bestp[1]:
        bestp = (ph, s)
phase = float(bestp[0])
beats = np.arange(phase, dur, period)

def seg(arr, a, b):
    ia, ib = int(max(0, a) * fps), int(min(dur, b) * fps)
    return float(arr[ia:ib].mean()) if ib > ia else 0.0

bar = 4 * period
cands = []
for b in beats:
    if b < 2 * bar or b > dur - 2 * bar:
        continue
    pre_l, post_l = seg(low, b - 2 * bar, b), seg(low, b, b + 2 * bar)
    pre_r, post_r = seg(rms, b - 2 * bar, b), seg(rms, b, b + 2 * bar)
    score = np.log((post_l + 1e-6) / (pre_l + 1e-6)) + np.log((post_r + 1e-6) / (pre_r + 1e-6))
    cands.append((float(score), float(b), post_r / (pre_r + 1e-9), post_l / (pre_l + 1e-9)))
cands.sort(reverse=True)
top = []
for c in cands:
    if all(abs(c[1] - t["t"]) > 2 * bar for t in top):
        top.append({"t": round(c[1], 3), "score": round(c[0], 2), "rmsx": round(c[2], 2), "lowx": round(c[3], 2)})
    if len(top) == 6:
        break
# energy curve per 2s for eyeballing
curve = [round(seg(rms, t, t + 2) * 100, 1) for t in np.arange(0, dur, 2)]
print(json.dumps({"file": path, "dur": round(dur, 2), "bpm": round(bpm, 2), "phase": round(phase, 3), "drops": top, "rms2s": curve}))
