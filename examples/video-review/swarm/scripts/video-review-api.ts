import type { ScriptContext } from "swarm-sdk";

// Video Review backend (app script action `api`). install.sh fills the __X__ values below.
// Needs swarm config secret AGENT_FS_API_KEY: an agent-fs API key with read/write on DRIVE.

const ORG = "__FS_ORG__";        // agent-fs org id of the drive your swarm mounts
const DRIVE = "__FS_DRIVE__";    // agent-fs drive id (the swarm's default drive, also mounted at /afs)
const FS_API = "__FS_API__";     // agent-fs API base URL
const LIVE = "__FS_LIVE__";      // agent-fs web UI base URL, used for feedback-file links
const DASH = "__DASH__";         // your swarm dashboard base URL
const EXTS = ["mp4", "webm", "mov", "m4v"];

/** `/a/./b//c.mp4` -> `/a/b/c.mp4`; rejects `..` and relative paths. */
function cleanPath(p: unknown): string {
  if (typeof p !== "string" || !p.startsWith("/")) throw new Error("path must be an absolute agent-fs path");
  const parts = p.split("/").filter((s) => s && s !== ".");
  if (parts.some((s) => s === "..")) throw new Error("path must not contain ..");
  return "/" + parts.join("/");
}

/** Feedback file convention: `<video-dir>/.review/<video-stem>.feedback.json`. */
function feedbackPathFor(video: string): string {
  const i = video.lastIndexOf("/");
  const dir = video.slice(0, i) || "";
  const name = video.slice(i + 1);
  const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
  return `${dir}/.review/${stem}.feedback.json`;
}

const liveUrl = (p: string) => `${LIVE}/file/~/${ORG}/${DRIVE}${p.split("/").map(encodeURIComponent).join("/")}`;

export default async function run(rawArgs: any, ctx: ScriptContext) {
  const a = rawArgs ?? {};
  const key: any = await ctx.swarm.config.get("AGENT_FS_API_KEY");
  const ops = async (body: Record<string, unknown>) => {
    const r = await ctx.stdlib.fetch(`${FS_API}/orgs/${ORG}/ops`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.stdlib.Redacted.value(key)}`, "content-type": "application/json" },
      body: JSON.stringify({ driveId: DRIVE, ...body }),
    } as any);
    const j: any = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`agent-fs ${body.op} ${r.status}: ${j?.message ?? ""}`);
    return j;
  };
  const appId: string | undefined = a.app?.id;
  const reviewBase = a.pageId ? `${DASH}/pages/${a.pageId}?path=` : null;

  if (a.op === "list") {
    const globs = await Promise.all(EXTS.map((e) => ops({ op: "glob", pattern: `**/*.${e}` }).catch(() => ({ matches: [] }))));
    const seen = new Set<string>();
    const videos: any[] = [];
    for (const g of globs) {
      for (const m of g?.matches ?? []) {
        let path: string;
        try { path = cleanPath(m.path); } catch { continue; }
        if (path.includes("/.review/") || seen.has(path)) continue;
        seen.add(path);
        videos.push({ path, size: m.size ?? null, modifiedAt: m.modifiedAt ?? null });
      }
    }
    videos.sort((x, y) => String(y.modifiedAt).localeCompare(String(x.modifiedAt)));
    // Which videos already have a review: the app rows mirror every feedback file.
    const reviews: Record<string, any> = {};
    if (appId) {
      const res: any = await ctx.swarm.app_rows_list({ appId, model: "review", limit: 1000 } as any);
      for (const r of (res?.data ?? res)?.rows ?? []) reviews[r.path] = { comments: r.comments, open: r.open, rounds: r.rounds, updatedAt: r.updatedAt };
    }
    return { videos, reviews };
  }

  const path = cleanPath(a.path);
  const fbPath = feedbackPathFor(path);

  if (a.op === "open") {
    const [stat, signed] = await Promise.all([
      ops({ op: "stat", path }),
      ops({ op: "signed-url", path, expiresIn: 3600 }),
    ]);
    let feedback: any = null;
    if (await ctx.fs.exists("/afs" + fbPath)) {
      try { feedback = JSON.parse(await ctx.fs.readFile("/afs" + fbPath)); } catch { feedback = null; }
    }
    return {
      video: { path, name: path.split("/").pop(), size: stat.size, modifiedAt: stat.modifiedAt, etag: stat.etag, url: signed.url, expiresAt: signed.expiresAt, liveUrl: liveUrl(path) },
      feedback,
      feedbackPath: fbPath,
      feedbackLiveUrl: liveUrl(fbPath),
    };
  }

  if (a.op === "save") {
    const doc = a.doc;
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.comments)) throw new Error("doc.comments must be an array");
    // shortcut: last-writer check on updatedAt, not a CAS; enough for one reviewer per video.
    if (!a.force && (await ctx.fs.exists("/afs" + fbPath))) {
      let current: any = null;
      try { current = JSON.parse(await ctx.fs.readFile("/afs" + fbPath)); } catch {}
      if (current && current.updatedAt && current.updatedAt !== a.baseUpdatedAt) return { conflict: true, feedback: current };
    }
    const now = new Date().toISOString();
    const caller = a.caller ?? {};
    const out = {
      ...doc,
      tool: "video-review",
      schema: 1,
      video: path,
      feedbackFile: fbPath,
      updatedAt: now,
      updatedBy: caller.name ?? caller.id ?? caller.kind ?? null,
    };
    const dir = fbPath.slice(0, fbPath.lastIndexOf("/"));
    if (!(await ctx.fs.exists("/afs" + dir))) await ctx.fs.mkdir("/afs" + dir);
    await ctx.fs.writeFile("/afs" + fbPath, JSON.stringify(out, null, 1));

    if (appId) {
      const iters: any[] = Array.isArray(out.iterations) ? out.iterations : [];
      const last = iters[iters.length - 1];
      const values = {
        path,
        name: path.split("/").pop(),
        folder: path.slice(0, path.lastIndexOf("/")) || "/",
        comments: out.comments.length,
        open: out.comments.filter((c: any) => c.sentIn == null).length,
        rounds: iters.length,
        lastTaskUrl: last?.taskId ? `${DASH}/tasks/${last.taskId}` : null,
        sessionUrl: out.thread?.rootTaskId ? `${DASH}/sessions/${out.thread.rootTaskId}` : null,
        lastSentAt: last?.sentAt ?? null,
        reviewUrl: reviewBase ? reviewBase + encodeURIComponent(path) : null,
        feedbackUrl: liveUrl(fbPath),
        editedBy: out.updatedBy,
      };
      const res: any = await ctx.swarm.app_rows_list({ appId, model: "review", equals: { path }, limit: 1 } as any);
      const row = ((res?.data ?? res)?.rows ?? [])[0];
      if (row) await ctx.swarm.app_row_patch({ appId, model: "review", rowId: row.id, values } as any);
      else await ctx.swarm.app_row_create({ appId, model: "review", values } as any);
    }
    return { updatedAt: now, feedbackPath: fbPath };
  }

  throw new Error(`unknown op: ${a.op}`);
}
