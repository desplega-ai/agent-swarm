# usage: music-refine.py <audio> <bpm_guess> <drop_guess>
# Fine tempo+phase over the window the reel uses (drop-16s .. drop+12s), snap drop to the nearest beat,
# and print the 0.5s RMS envelope of that window (to see the build, the drop, the tail).
import subprocess, sys
import numpy as np

SR = 22050
path, bpm0, d0 = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"], capture_output=True, check=True).stdout
x = np.frombuffer(raw, dtype=np.float32)
hop, win = 256, 1024
n = 1 + (len(x) - win) // hop
fr = np.lib.stride_tricks.as_strided(x, shape=(n, win), strides=(x.strides[0] * hop, x.strides[0]))
spec = np.log1p(10 * np.abs(np.fft.rfft(fr * np.hanning(win), axis=1)))
flux = np.concatenate([[0], np.maximum(0, np.diff(spec, axis=0)).sum(axis=1)])
flux = np.maximum(0, flux - np.convolve(flux, np.ones(32) / 32, mode="same"))
fps = SR / hop
a0, a1 = max(0, d0 - 16), min(len(x) / SR, d0 + 12)
idx = np.arange(len(flux))
best = None
for bpm in np.arange(bpm0 - 2, bpm0 + 2, 0.02):
    p = 60 / bpm
    for ph in np.arange(0, p, 0.004):
        bt = np.arange(a0 + ph, a1, p)
        s = np.interp(bt * fps, idx, flux).sum() / len(bt)
        if best is None or s > best[0]:
            best = (s, bpm, a0 + ph)
_, bpm, ph = best
p = 60 / bpm
k = round((d0 - ph) / p)
drop = ph + k * p
rms = np.sqrt((fr ** 2).mean(axis=1))
env = []
for t in np.arange(drop - 14 * 120 / bpm * bpm / 120, drop + 10.5, 0.5):
    i, j = int(t * fps), int((t + 0.5) * fps)
    env.append(int(rms[max(0, i):max(1, j)].mean() * 100) if j > 0 else 0)
print(f"{path} bpm={bpm:.2f} drop={drop:.3f}")
print(" pre :", env[:28])
print(" post:", env[28:])
