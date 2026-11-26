#!/usr/bin/env bun
/**
 * Dump the prompts a person typed into local Claude Code and Codex sessions
 * into one redacted JSONL file. Use it as an extra corpus for voice or comms
 * work (rubrics, few-shot examples, judge holdouts).
 *
 * Usage:
 *   bun scripts/dump-local-agent-prompts.ts [flags]
 *
 *   --out <file>        Output file. Default: work/local-agent-prompts/<date>.jsonl (gitignored)
 *   --since <date>      Keep prompts typed on or after this ISO date
 *   --source <name>     claude | codex | all (default: all)
 *   --min-chars <n>     Drop shorter prompts (default: 2)
 *   --max-chars <n>     Drop longer prompts, which are mostly pastes (default: 1500)
 *   --claude-dir <dir>  Default: ~/.claude
 *   --codex-dir <dir>   Default: ~/.codex
 *   --upload <path>     After the dump, `agent-fs write <path> --file <out>`
 *
 * Sources:
 *   <claude-dir>/history.jsonl            prompt history of the CLI
 *   <claude-dir>/projects/<p>/<id>.jsonl  transcripts (covers SDK apps, which write no history)
 *   <codex-dir>/history.jsonl             prompt history of the CLI
 *   <codex-dir>/{sessions,archived_sessions}/**.jsonl  rollouts
 *
 * Only human turns are kept. Tool results, subagent sessions, harness
 * wrappers, compaction summaries, thread handoffs, `codex exec` runs and
 * `claude -p` runs are skipped. Pasted text is not expanded.
 *
 * Row: { source, origin, app, sessionId, project, createdAt, kind, register, text }
 * `kind` is always `cli-prompt` and `register` is always `agent-cli`: a person
 * writes to a coding agent in a shorter, more imperative style than to people,
 * so a consumer must be able to keep this corpus apart from chat messages.
 *
 * Redaction, per prompt:
 *   1. `scrubSecrets` (values of the local env, token shapes, gitleaks rules)
 *   2. key-shaped runs that no rule names become `[REDACTED:opaque]`
 *   3. URL query strings, emails and phone numbers are masked
 *   4. the home directory becomes `~`
 *   5. a prompt where `findSecretsIn` still matches is dropped
 * The redaction is pattern-based. The file still holds private prompts: put it
 * only in a place you control. The script prints counts, never prompt text.
 */

import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { findSecretsIn, scrubSecrets } from "../src/utils/secret-scrubber";

type Json = Record<string, unknown>;

interface PromptRow {
  source: "claude-code" | "codex";
  origin: "history" | "transcript";
  /** The app that drove the session (`cli`, `t3-code`, `Codex Desktop`, ...). */
  app: string | null;
  sessionId: string | null;
  project: string | null;
  createdAt: string;
  kind: "cli-prompt";
  register: "agent-cli";
  text: string;
}

type RowMeta = Pick<PromptRow, "source" | "origin" | "app" | "sessionId" | "project">;

const { values: flags } = parseArgs({
  options: {
    out: { type: "string" },
    since: { type: "string" },
    source: { type: "string", default: "all" },
    "min-chars": { type: "string", default: "2" },
    "max-chars": { type: "string", default: "1500" },
    "claude-dir": { type: "string", default: join(homedir(), ".claude") },
    "codex-dir": { type: "string", default: join(homedir(), ".codex") },
    upload: { type: "string" },
  },
});

const today = new Date().toISOString().slice(0, 10);
const outPath = flags.out ?? join("work", "local-agent-prompts", `${today}.jsonl`);
const sinceMs = flags.since ? Date.parse(flags.since) : 0;
const minChars = Number(flags["min-chars"]);
const maxChars = Number(flags["max-chars"]);
if (Number.isNaN(sinceMs) || Number.isNaN(minChars) || Number.isNaN(maxChars)) {
  console.error("Invalid --since, --min-chars or --max-chars value.");
  process.exit(1);
}
if (!["claude", "codex", "all"].includes(flags.source)) {
  console.error("--source must be claude, codex or all.");
  process.exit(1);
}

/** Claude Code entrypoints a person types into. `sdk-cli` (`claude -p`) is scripted. */
const CLAUDE_HUMAN_ENTRYPOINTS = new Set([
  "cli",
  "t3-code",
  "claude-desktop",
  "claude-vscode",
  "sdk-ts",
]);

/** Text the harness adds around or inside a human turn. */
const NOISE_BLOCKS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /\[Attached image "[^"]*" is saved at: [^\]]*\]/g,
  /\[Image: [^\]]*\]/g,
  /<image name=[^>]*>|<\/image>/g,
];

/** A turn that starts like this was written by a harness or an agent, not typed. */
const MACHINE_PREFIX =
  /^(?:<[a-z][\w-]*[\s>]|\[Request interrupted|\[Historical user|Context handoff \(|This session is being continued|Caveat: |Continue from where you left off|# AGENTS\.md instructions|Act as the |Update on pull request #|\[T3 Code: |Note: the T3 server|Background command completed|\[assistant-quote-|Unknown slash command)/;

const URL_QUERY = /(https?:\/\/[^\s?#]+)\?[^\s)\]>"']+/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** A run long enough to hold a key. `maskOpaque` decides per run. */
const TOKEN = /[\w+=.-]{16,}/g;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PHONE = /\+\d[\d ().-]{7,}\d|\b\d{3}[ -]\d{3}[ -]\d{3,4}\b/g;

const stats = {
  filesRead: 0,
  candidates: 0,
  kept: 0,
  machine: 0,
  length: 0,
  beforeSince: 0,
  duplicate: 0,
  residualSecret: 0,
  redacted: 0,
};
const rows = new Map<string, PromptRow>();

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function obj(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function parse(line: string): Json | null {
  try {
    return obj(JSON.parse(line));
  } catch {
    return null;
  }
}

/** Repo name for a cwd. A worktree path (`.../worktrees/<repo>/<name>`) maps to its repo. */
function projectOf(cwd: string | null): string | null {
  if (!cwd) return null;
  const worktree = cwd.match(/\/worktrees\/([^/]+)\//);
  return worktree?.[1] ?? basename(cwd);
}

/**
 * Mask key-shaped text that no vendor rule names: a `_`, `.` or `-` separated
 * segment of 16 or more characters with a digit in it (hex digests, JWT parts,
 * prefixed keys such as `sk_x_<random>`). UUIDs stay: they are record ids.
 * Words, slugs and dated file names have short or digit-free segments.
 */
function maskOpaque(text: string): string {
  return text.replace(TOKEN, (token) => {
    if (UUID.test(token)) return token;
    const opaque = token.split(/[_.-]/).some((part) => part.length >= 16 && /\d/.test(part));
    return opaque ? "[REDACTED:opaque]" : token;
  });
}

function redact(text: string): string {
  return maskOpaque(scrubSecrets(text))
    .replace(URL_QUERY, "$1?[query]")
    .replace(EMAIL, "[email]")
    .replace(PHONE, "[phone]")
    .replaceAll(homedir(), "~");
}

function add(meta: RowMeta, tsMs: number, raw: string): void {
  stats.candidates++;
  let text = raw;
  for (const block of NOISE_BLOCKS) text = text.replace(block, "");
  text = text.trim();
  if (MACHINE_PREFIX.test(text)) {
    stats.machine++;
    return;
  }
  if (text.length < minChars || text.length > maxChars) {
    stats.length++;
    return;
  }
  if (!Number.isFinite(tsMs) || tsMs < sinceMs) {
    stats.beforeSince++;
    return;
  }
  const clean = redact(text);
  const residual = findSecretsIn(clean);
  if (residual.knownValues.length > 0 || residual.gitleaksRules.length > 0) {
    stats.residualSecret++;
    return;
  }
  if (clean !== text) stats.redacted++;
  const seen = rows.get(clean);
  if (seen) {
    stats.duplicate++;
    if (Date.parse(seen.createdAt) <= tsMs) return;
  }
  rows.set(clean, {
    ...meta,
    createdAt: new Date(tsMs).toISOString(),
    kind: "cli-prompt",
    register: "agent-cli",
    text: clean,
  });
}

/** Stream a file line by line. Transcripts reach hundreds of MB with multi-MB lines. */
async function* readLines(path: string): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let parts: string[] = [];
  for await (const chunk of Bun.file(path).stream()) {
    const piece = decoder.decode(chunk, { stream: true });
    let start = 0;
    for (let nl = piece.indexOf("\n"); nl !== -1; nl = piece.indexOf("\n", start)) {
      parts.push(piece.slice(start, nl));
      yield parts.join("");
      parts = [];
      start = nl + 1;
    }
    if (start < piece.length) parts.push(piece.slice(start));
  }
  if (parts.length > 0) yield parts.join("");
}

/** Files under `dir` that match `pattern` and changed since `--since`. */
async function filesIn(dir: string, pattern: string): Promise<string[]> {
  const found: string[] = [];
  try {
    for await (const rel of new Bun.Glob(pattern).scan({ cwd: dir })) {
      const path = join(dir, rel);
      if (Bun.file(path).lastModified >= sinceMs) found.push(path);
    }
  } catch {
    // A missing directory means that tool is not installed here.
  }
  return found;
}

/** The text blocks of a message `content` (string or block array). Null on a tool result. */
function textOf(content: unknown, blockType: string): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const item of content) {
    const block = obj(item);
    if (!block) continue;
    if (block.type === "tool_result") return null;
    if (block.type === blockType) texts.push(str(block.text) ?? "");
  }
  return texts.join("\n");
}

async function claudeHistory(dir: string): Promise<void> {
  const path = join(dir, "history.jsonl");
  if (!(await Bun.file(path).exists())) return;
  stats.filesRead++;
  for await (const line of readLines(path)) {
    const entry = parse(line);
    const display = str(entry?.display);
    if (!entry || !display || display.startsWith("!")) continue;
    // `/command args`: the args are typed text, the command name is not.
    const text = display.replace(/^\/[\w:-]+(?:\s+|$)/, "");
    add(
      {
        source: "claude-code",
        origin: "history",
        app: "cli",
        sessionId: str(entry.sessionId),
        project: projectOf(str(entry.project)),
      },
      Number(entry.timestamp),
      text,
    );
  }
}

async function claudeTranscripts(dir: string): Promise<void> {
  // Depth 2 only: subagent transcripts live in `<project>/<session>/subagents/`.
  for (const path of await filesIn(join(dir, "projects"), "*/*.jsonl")) {
    stats.filesRead++;
    for await (const line of readLines(path)) {
      if (!line.includes('"type":"user"') || line.includes('"toolUseResult"')) continue;
      const entry = parse(line);
      if (!entry || entry.type !== "user") continue;
      if (entry.isSidechain || entry.isMeta || entry.isCompactSummary) continue;
      if (entry.promptSource === "system") continue;
      const app = str(entry.entrypoint);
      if (app && !CLAUDE_HUMAN_ENTRYPOINTS.has(app)) continue;
      let text = textOf(obj(entry.message)?.content, "text");
      if (text === null) continue;
      if (text.includes("<command-name>")) {
        text = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] ?? "";
      }
      add(
        {
          source: "claude-code",
          origin: "transcript",
          app,
          sessionId: str(entry.sessionId),
          project: projectOf(str(entry.cwd)),
        },
        Date.parse(str(entry.timestamp) ?? ""),
        text,
      );
    }
  }
}

async function codexHistory(dir: string): Promise<void> {
  const path = join(dir, "history.jsonl");
  if (!(await Bun.file(path).exists())) return;
  stats.filesRead++;
  for await (const line of readLines(path)) {
    const entry = parse(line);
    const text = str(entry?.text);
    if (!entry || !text) continue;
    add(
      {
        source: "codex",
        origin: "history",
        app: "cli",
        sessionId: str(entry.session_id),
        project: null,
      },
      Number(entry.ts) * 1000,
      text,
    );
  }
}

/** True when every content item of a Codex user message has `user` provenance. */
function codexTypedByUser(payload: Json): boolean {
  const meta = obj(payload.internal_chat_message_metadata_passthrough);
  const items = meta?.content_item_metadata;
  if (!Array.isArray(items) || items.length === 0) return false;
  return items.every((item) => obj(obj(item)?.provenance)?.type === "user");
}

async function codexRollouts(dir: string): Promise<void> {
  const paths = [
    ...(await filesIn(join(dir, "sessions"), "**/*.jsonl")),
    ...(await filesIn(join(dir, "archived_sessions"), "**/*.jsonl")),
  ];
  for (const path of paths) {
    stats.filesRead++;
    let meta: Json | null = null;
    for await (const line of readLines(path)) {
      if (!meta) {
        meta = obj(parse(line)?.payload) ?? {};
        // `exec` runs take scripted prompts. An object source is a subagent thread.
        if (meta.source === "exec" || obj(meta.source)) break;
        continue;
      }
      if (!line.includes('"role":"user"')) continue;
      const entry = parse(line);
      const payload = obj(entry?.payload);
      if (!entry || !payload || entry.type !== "response_item" || payload.role !== "user") continue;
      if (!codexTypedByUser(payload)) continue;
      const text = textOf(payload.content, "input_text");
      if (text === null) continue;
      add(
        {
          source: "codex",
          origin: "transcript",
          app: str(meta.originator),
          sessionId: str(meta.id),
          project: projectOf(str(meta.cwd)),
        },
        Date.parse(str(entry.timestamp) ?? ""),
        text,
      );
    }
  }
}

if (flags.source !== "codex") {
  await claudeHistory(flags["claude-dir"]);
  await claudeTranscripts(flags["claude-dir"]);
}
if (flags.source !== "claude") {
  await codexHistory(flags["codex-dir"]);
  await codexRollouts(flags["codex-dir"]);
}

const sorted = [...rows.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
stats.kept = sorted.length;
await mkdir(dirname(outPath), { recursive: true });
await Bun.write(outPath, sorted.map((row) => `${JSON.stringify(row)}\n`).join(""));
await chmod(outPath, 0o600);

const perOrigin: Record<string, number> = {};
for (const row of sorted) {
  const key = `${row.source}/${row.origin}`;
  perOrigin[key] = (perOrigin[key] ?? 0) + 1;
}
console.log(`Wrote ${sorted.length} prompts to ${outPath} (${Bun.file(outPath).size} bytes).`);
console.log(
  JSON.stringify(
    { ...stats, perOrigin, from: sorted[0]?.createdAt, to: sorted.at(-1)?.createdAt },
    null,
    2,
  ),
);

if (flags.upload) {
  const message = `Local Claude Code and Codex prompts, redacted (${sorted.length} rows)`;
  await Bun.$`agent-fs write ${flags.upload} --file ${outPath} -m ${message}`;
  console.log(`Uploaded to agent-fs: ${flags.upload}`);
}
