# Video review

A page to leave comments on a video: ranges on a timeline, marks drawn on the picture, a JSON export. A person
reviews, an agent reads the export and makes the next cut.

Two versions live here:

| Version | Where the video is | Where the comments go | Folder |
|---|---|---|---|
| Local page | A file on your computer | The browser, then a JSON file that you give to your agent | this folder |
| Swarm app | agent-fs | A feedback file next to the video, and one swarm task for each round | [swarm/](swarm/) |

Guide: https://docs.agent-swarm.dev/docs/guides/video-review

## Local page

Open https://video-edit.agent-swarm.dev, or open `index.html` from a clone. One HTML file: no server, no build, no
dependency. The video and the comments never leave the browser. The public site counts visits with Plausible. A
clone or a `file://` copy makes no request to another origin.

1. Choose a video, or drop a file on the page. The video is read through a blob URL. It stays on your computer.
2. Set the frame rate before you choose the file (default 30, or `?fps=24` in the URL). It sets the length of one
   frame step. The times in the export are correct with any value.
3. Comment:
   - Timeline: drag in the empty area to make a range. Drag a range to move it. Drag its ends to trim it. Right
     click for options. Click the ruler to move the playhead. Cmd+scroll or pinch to zoom.
   - Picture: drag to draw (pen, arrow, box). A click plays or pauses.
   - Text box: it belongs to the selected comment. With no selection, the first letter or the first mark starts a
     new comment at the current frame. Cmd+Enter finishes the comment.
   - Keys: Space, arrows (frame, with Shift a second), up and down (previous and next comment), I and O (range in
     and out), P A B (tools), C (write), Delete, Esc, + - 0 (zoom), Cmd+Z. The Help button lists them.
4. "Download JSON" writes `<file name>-feedback-<version>.json`. "Copy JSON" puts the same text on the clipboard.
   Give it to your agent with the video.

The top bar has links to the guide, to the repository on GitHub and to agent-swarm.dev. Its last button changes
between the light theme and the dark theme, and the browser keeps the choice. Without a choice, the page follows
the setting of your system. `?theme=light` or `?theme=dark` in the URL comes before both.

Comments are saved in the browser (`localStorage`) under the file name and the version (`v1`, or `?version=`). A
file with the same name opens the same comments. Give each new cut a new file name or a new `?version=`, so it
starts with an empty list.

### Other ways to open a video

These work from `file://`, for a project that keeps its renders on disk:

```
open "index.html?src=../../out/render.mp4&version=v3&fps=24"
open "index.html?config=../my-project/review/config.js"
```

`config.js` lists the cuts of one project. A `src` is relative to the config file. Sources with the same `version`
share one timeline and one list of comments (the same cut with and without subtitles, for example).

```js
window.REVIEW = {
  project: "launch-film",        // key of the saved comments and name of the export file
  title: "Launch film review",
  fps: 24,
  sources: [                     // newest first: the first one opens
    { version: "v8", label: "v8 (1080p)", src: "../renders/film-v8.mp4" },
  ],
};
```

### Read an export

```
uv run --no-project --with pillow python -I render.py <feedback.json> [out-dir] [--video <path>]
```

It prints each comment with its time range and writes one frame for each comment with the marks drawn on it. It
needs `ffmpeg`. An export from a chosen file holds only the file name, so give the path with `--video`, or keep
the export next to the video. An agent that reads the marked frames sees what the words do not say.

### A skill for the agent that edits the video

[skill/SKILL.md](skill/SKILL.md) is the agent's side of the loop, as a skill a coding agent can load: what to ask
before a build, how to read a round, the checks before a render, how to present options, and what to say it could
not check.

### Export format

```json
{
  "tool": "video-review", "project": "film-v8", "version": "v1", "video": "film-v8.mp4", "src": "film-v8.mp4",
  "fps": 24, "frames": 1754, "exportedAt": "2026-11-20T16:37:25.478Z",
  "comments": [
    { "n": 1, "in": "0:21.00", "out": "0:21.00", "inFrame": 504, "outFrame": 504, "startSec": 21, "endSec": 21.042,
      "text": "Tag sits too near the edge.",
      "strokes": [{ "tool": "rect", "color": "#ff3b30", "width": 0.005, "frame": 504, "points": [[0.04, 0.076], [0.278, 0.254]] }] }
  ]
}
```

`inFrame` and `outFrame` are both inside the range. `startSec` is the start of the in frame and `endSec` is the end
of the out frame. A stroke has `tool` (`pen`, `arrow`, `rect`), `color`, `width` (a share of the picture width),
`frame` (where it was drawn) and `points` as shares of the picture: `[0,0]` is top left and `[1,1]` is bottom right.

### Limits

- Chrome, Brave and Edge. Not tested in Safari or Firefox.
- The browser must be able to play the file. MP4 (H.264) and WebM work. ProRes does not.
- The page cannot read the frame rate or the path of a chosen file.
- The export has the strokes as numbers, not as a picture. `render.py` draws them on the frame.

## Swarm app

[swarm/](swarm/) installs the same reviewer in your swarm as a Page plus a Swarm App. Videos come from agent-fs,
comments save next to the video, and **Send to swarm** makes one task for each review round. See
[swarm/README.md](swarm/README.md) for the install steps.

## How the public page deploys

https://video-edit.agent-swarm.dev serves this folder as a static site, in the same way as
[talks/2026-09-21-ai-builders-memory/](../../talks/2026-09-21-ai-builders-memory/README.md). `vercel.json` sets no
framework, no install and no build. The Vercel Git integration deploys a merge to `main`. No GitHub Action deploys it.

| Setting | Value |
| --- | --- |
| Project | `agent-swarm-video-review` (`prj_VIhT8nda7zN1u4kdyFuW0t5UJX7K`), team `desplega-labs` |
| Git repository | `desplega-ai/agent-swarm` |
| Production branch | `main` |
| `rootDirectory` | `examples/video-review` |
| Production domain | `video-edit.agent-swarm.dev` |

`rootDirectory`, the Git link and the domain are project settings, not `vercel.json` properties. Do not rename or
move this folder without a change to `rootDirectory` in the project.
