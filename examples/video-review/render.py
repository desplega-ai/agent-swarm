"""Read a review export from index.html: print the comments and write one marked frame per comment.

Usage:
  uv run --no-project --with pillow python -I render.py <feedback.json> [out-dir] [--video <path>]

The frame is the one where the first mark was drawn, or the in frame when the comment has no marks.
The export holds the path of the video. A relative path is tried from the export's folder, then from this folder.
An export from a chosen file (the public page) holds only the file name: give the path with --video, or keep the
export next to the video.
Default out-dir: out/review/<project>/<version>/
Needs ffmpeg on PATH.
"""
import io
import json
import os
import subprocess
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
WIDTH = 1280   # width of a marked frame; the height follows the shape of the video

args = sys.argv[1:]
given = None
if "--video" in args:
    i = args.index("--video")
    if i + 1 >= len(args):
        sys.exit("--video needs a path")
    given = args[i + 1]
    del args[i:i + 2]
if not args:
    sys.exit(__doc__)
sys.argv = [sys.argv[0]] + args

data = json.load(open(sys.argv[1]))
fps = data["fps"]
src = given or data["src"]
if src.startswith("file://"):
    from urllib.parse import unquote, urlparse
    src = unquote(urlparse(src).path)
candidates = [src] if os.path.isabs(src) else [os.path.join(os.path.dirname(os.path.abspath(sys.argv[1])), src), os.path.join(HERE, src)]
video = next((os.path.normpath(c) for c in candidates if os.path.exists(c)), None)
if not video:
    sys.exit("video not found: %s. Give its path with --video <path>." % src)
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join("out", "review", str(data.get("project", "video")), str(data.get("version", "x")))
out = os.path.normpath(out)
os.makedirs(out, exist_ok=True)


def frame(f):
    # -ss before -i keeps the first frame at or after the time, so aim just before the frame's own time
    t = max(0.0, f / fps - 0.002)
    png = subprocess.run(["ffmpeg", "-v", "error", "-ss", "%.4f" % t, "-i", video, "-frames:v", "1",
                          "-vf", "scale=%d:-2" % WIDTH, "-f", "image2pipe", "-vcodec", "png", "-"],
                         check=True, capture_output=True).stdout
    return Image.open(io.BytesIO(png)).convert("RGB")


def mark(d, s, W, H):
    p = [(x * W, y * H) for x, y in s["points"]]
    lw = max(2, round(s["width"] * W))
    for colour, extra in (((0, 0, 0), max(2, round(lw * 0.9))), (s["color"], 0)):
        w = lw + extra
        if s["tool"] == "rect":
            (x0, y0), (x1, y1) = p[0], p[-1]
            d.line([(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0), (x1, y0)], fill=colour, width=w, joint="curve")
        elif s["tool"] == "arrow":
            import math
            (x0, y0), (x1, y1) = p[0], p[-1]
            ang, h = math.atan2(y1 - y0, x1 - x0), max(lw * 4, 14)
            d.line([(x0, y0), (x1, y1)], fill=colour, width=w)
            for side in (-0.45, 0.45):
                d.line([(x1 - h * math.cos(ang + side), y1 - h * math.sin(ang + side)), (x1, y1)], fill=colour, width=w)
        else:
            d.line(p if len(p) > 1 else p * 2, fill=colour, width=w, joint="curve")


print("%s, %d comments, exported %s" % (data["video"], len(data["comments"]), data.get("exportedAt", "?")))
for c in data["comments"]:
    f = c["strokes"][0]["frame"] if c["strokes"] else c["inFrame"]
    im = frame(f)
    d = ImageDraw.Draw(im)
    for s in c["strokes"]:
        mark(d, s, *im.size)
    name = "%02d_f%04d.jpg" % (c["n"], f)
    im.save(os.path.join(out, name), quality=88)
    span = c["in"] if c["inFrame"] == c["outFrame"] else "%s to %s" % (c["in"], c["out"])
    print("\n#%d  %s  (frames %d-%d, %d marks)  %s" % (c["n"], span, c["inFrame"], c["outFrame"], len(c["strokes"]), name))
    print("    " + (c["text"] or "(drawing only)").replace("\n", "\n    "))
print("\nframes in " + out)
