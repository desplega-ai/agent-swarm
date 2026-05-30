// Parse raw session_logs (/tmp/demo-logs.json) -> normalized demo dataset for the mockups.
// Generated artifact: writes mockups/session-logs/demo-data.js (window.DEMO_LOGS).
const RAW = "/tmp/demo-logs.json";
const OUT = "/Users/taras/Documents/code/agent-swarm/mockups/session-logs/demo-data.js";
const MAX_ENTRIES = 40;
const MAX_BODY = 1500;
const MAX_THINK = 900;
const MAX_TEXT = 4000;

const raw: any = await Bun.file(RAW).json();
const logs: any[] = raw.logs ?? raw;
logs.sort((a, b) =>
  a.createdAt === b.createdAt ? (a.lineNumber - b.lineNumber) : (a.createdAt < b.createdAt ? -1 : 1),
);

const fmtTime = (iso: string) => { try { return new Date(iso).toTimeString().slice(0, 8); } catch { return ""; } };
const trunc = (s: string, n: number) => (s && s.length > n ? s.slice(0, n).trimEnd() + " …" : s || "");

// --- anonymization: scrub PII from the public demo artifact ---
const FAKES = ["a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1","b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2","c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3","d4d4d4d4-4444-4444-8444-d4d4d4d4d4d4","e5e5e5e5-5555-4555-8555-e5e5e5e5e5e5","f6f6f6f6-6666-4666-8666-f6f6f6f6f6f6","07070707-7777-4777-8777-070707070707","18181818-8888-4888-8888-181818181818"];
const uuidMap: Record<string, string> = {}; let uuidN = 0;
const anonUuid = (u: string) => (uuidMap[u] = uuidMap[u] || FAKES[uuidN++ % FAKES.length]);
function anon(s: any): any {
  if (typeof s !== "string") return s;
  return s
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) => anonUuid(m.toLowerCase()))
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "dev@example.com")
    .replace(/tarasyarema/gi, "alexdev")
    .replace(/\bYarema\b/g, "Dev").replace(/\byarema\b/g, "dev")
    .replace(/\bTaras\b/g, "Alex").replace(/\btaras\b/g, "alex")
    .replace(/\bJackknife\b/gi, "Falcon")
    .replace(/\b2pac\b/gi, "dev");
}

function resultText(b: any): string {
  const c = b?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (x?.type === "text" ? x.text : x?.type === "image" ? "[image]" : JSON.stringify(x))).join("\n");
  if (c == null) return "";
  return JSON.stringify(c, null, 2);
}
function prettyMaybeJson(t: string): string {
  const s = (t || "").trim();
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try { return JSON.stringify(JSON.parse(s), null, 2); } catch {}
  }
  return t || "";
}
function preview(t: string): string {
  const s = (t || "").trim();
  if (s.startsWith("{") && s.endsWith("}")) { try { return "{ " + Object.keys(JSON.parse(s)).length + " keys }"; } catch {} }
  if (s.startsWith("[") && s.endsWith("]")) { try { return "[ " + JSON.parse(s).length + " items ]"; } catch {} }
  const lines = s.split("\n").filter(Boolean);
  if (lines.length > 1) return lines.length + " lines";
  return trunc(s.replace(/\s+/g, " "), 52) || "ok";
}
function classify(b: any) {
  const n: string = b.name || "";
  const inp = b.input || {};
  if (n.startsWith("mcp__")) {
    const p = n.split("__"); const server = p[1] || ""; const tool = p.slice(2).join("__");
    return { kind: "mcp", name: tool, server, title: server + "." + tool, detail: shortDetail(inp) };
  }
  if (n === "Bash") return { kind: "bash", name: "bash", server: "", title: "bash", detail: String(inp.command || "").split("\n")[0] };
  if (["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS"].includes(n))
    return { kind: "file", name: n, server: "", title: n, detail: String(inp.file_path || inp.path || inp.pattern || "") };
  if (["WebFetch", "WebSearch"].includes(n)) return { kind: "web", name: n, server: "", title: n, detail: String(inp.url || inp.query || "") };
  if (n === "Task") return { kind: "task", name: "Task", server: "", title: "Task", detail: String(inp.description || "") };
  return { kind: "other", name: n || "tool", server: "", title: n || "tool", detail: shortDetail(inp) };
}
function shortDetail(inp: any): string {
  if (!inp || typeof inp !== "object") return "";
  const keys = Object.keys(inp);
  if (!keys.length) return "";
  const k = keys[0];
  let v = inp[k];
  if (typeof v === "object") v = JSON.stringify(v);
  return trunc(String(k) + ": " + String(v).replace(/\s+/g, " "), 60);
}

// pass 1: index tool_results by id
const resById: Record<string, any> = {};
for (const l of logs) {
  let ev: any; try { ev = JSON.parse(l.content); } catch { continue; }
  if (ev?.type === "user" && Array.isArray(ev.message?.content))
    for (const b of ev.message.content) if (b?.type === "tool_result") resById[b.tool_use_id] = { b: b, at: l.createdAt };
}

// pass 2: build entries
const entries: any[] = [];
const hist: Record<string, number> = {};
let model = "claude-opus-4-8";
outer: for (const l of logs) {
  let ev: any; try { ev = JSON.parse(l.content); } catch { continue; }
  const time = fmtTime(l.createdAt); const iter = l.iteration ?? 0;
  if (ev?.type === "assistant" && Array.isArray(ev.message?.content)) {
    model = ev.message.model || model;
    for (const b of ev.message.content) {
      if (b.type === "text" && b.text?.trim())
        entries.push({ type: "text", role: "assistant", model: ev.message.model, iter, time, md: trunc(b.text, MAX_TEXT) });
      else if (b.type === "thinking" && b.thinking?.trim())
        entries.push({ type: "thinking", role: "assistant", model: ev.message.model, iter, time, text: trunc(b.thinking, MAX_THINK) });
      else if (b.type === "tool_use") {
        const res = resById[b.id]; const c = classify(b);
        const body = res ? resultText(res.b) : "";
        const durMs = res ? Math.max(0, Date.parse(res.at) - Date.parse(l.createdAt)) : 0;
        entries.push({
          type: "tool", role: "assistant", iter, time,
          kind: c.kind, name: c.name, server: c.server, title: c.title, detail: c.detail,
          input: trunc(prettyMaybeJson(JSON.stringify(b.input ?? {}, null, 2)), 700),
          preview: res ? preview(body) : "running…",
          body: trunc(prettyMaybeJson(body), MAX_BODY),
          ok: res ? !res.b.is_error : true, hasResult: !!res, durMs: durMs,
        });
      }
      if (entries.length >= MAX_ENTRIES) break outer;
    }
  } else if (ev?.type === "user" && Array.isArray(ev.message?.content)) {
    for (const b of ev.message.content)
      if (b.type === "text" && b.text?.trim() && !b.text.includes("<system-reminder>")) {
        entries.push({ type: "text", role: "user", iter, time, md: trunc(b.text, 1000) });
        if (entries.length >= MAX_ENTRIES) break outer;
      }
  }
}
for (const e of entries) hist[e.type] = (hist[e.type] || 0) + 1;

for (const e of entries) for (const k of ["md","text","body","input","detail","name","server","title","preview"]) (e as any)[k] = anon((e as any)[k]);
const payload = { meta: { model, taskId: anon(logs[0]?.taskId || ""), sessionId: anon(logs[0]?.sessionId || ""), total: entries.length }, entries };
await Bun.write(OUT, "/* GENERATED from /tmp/demo-logs.json by /tmp/parse-logs.ts — do not edit by hand */\nwindow.DEMO_LOGS = " + JSON.stringify(payload) + ";\n");

console.log("entries:", entries.length, "| types:", JSON.stringify(hist), "| model:", model);
console.log("tool kinds:", JSON.stringify(entries.filter((e) => e.type === "tool").reduce((a: any, e) => ((a[e.kind] = (a[e.kind] || 0) + 1), a), {})));
console.log("bytes:", (await Bun.file(OUT).text()).length);
