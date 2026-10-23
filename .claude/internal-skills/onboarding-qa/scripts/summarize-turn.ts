#!/usr/bin/env bun
/**
 * Summarize one inner-agent turn (Claude Code stream-json) for the persona loop.
 *
 *   bun summarize-turn.ts <turn.jsonl> [--env <file>]...
 *
 * Prints the reply, every tool call, and every tool error, scrubbed with the
 * repo's egress scrubber after registering each sensitive value from the given
 * env files. Writes the same text next to the transcript as `<n>.summary.md`.
 */
import { registerEnvSecrets, scrubSecrets } from "../../../../src/utils/secret-scrubber.ts";

type Block = {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};
type Line = {
  type: string;
  subtype?: string;
  model?: string;
  message?: { content?: Block[] | string };
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
};

const args = process.argv.slice(2);
const transcript = args[0];
if (!transcript) {
  console.error("usage: bun summarize-turn.ts <turn.jsonl> [--env <file>]...");
  process.exit(2);
}

for (let i = 1; i < args.length; i++) {
  if (args[i] !== "--env" || !args[i + 1]) continue;
  const file = Bun.file(args[++i]);
  if (!(await file.exists())) continue;
  const env: Record<string, string> = {};
  for (const raw of (await file.text()).split("\n")) {
    const match = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  registerEnvSecrets(env);
}

function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function describeInput(name: string, input: Record<string, unknown> = {}): string {
  const pick = input.command ?? input.file_path ?? input.url ?? input.query ?? input.pattern;
  if (typeof pick === "string") return pick;
  if (name === "TodoWrite") return "(todo list)";
  return JSON.stringify(input);
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join(" ");
  }
  return JSON.stringify(content ?? "");
}

const tools: string[] = [];
const toolNames = new Map<string, string>();
const errors: string[] = [];
let model = "";
let final: Line | undefined;
let lastText = "";

for (const raw of (await Bun.file(transcript).text()).split("\n")) {
  if (!raw.trim()) continue;
  let line: Line;
  try {
    line = JSON.parse(raw);
  } catch {
    continue;
  }
  if (line.type === "system" && line.subtype === "init") model = line.model ?? "";
  if (line.type === "result") final = line;
  const content = line.message?.content;
  if (!Array.isArray(content)) continue;
  for (const block of content) {
    if (block.type === "text" && block.text && line.type === "assistant") lastText = block.text;
    if (block.type === "tool_use" && block.name) {
      toolNames.set(block.id ?? "", block.name);
      tools.push(`${block.name}  ${oneLine(describeInput(block.name, block.input))}`);
    }
    if (block.type === "tool_result" && block.is_error) {
      const name = toolNames.get(block.tool_use_id ?? "") ?? "tool";
      errors.push(`${name}: ${oneLine(resultText(block.content), 240)}`);
    }
  }
}

const stderrFile = Bun.file(transcript.replace(/\.jsonl$/, ".err"));
const stderrTail = (await stderrFile.exists())
  ? (await stderrFile.text()).trim().split("\n").slice(-5).join("\n")
  : "";

const head = final
  ? `${Math.round((final.duration_ms ?? 0) / 1000)}s, ${tools.length} tool calls, ${errors.length} tool errors, $${(final.total_cost_usd ?? 0).toFixed(2)}, ${final.subtype}${final.is_error ? " (error)" : ""}, model ${model}`
  : `no result line yet (${tools.length} tool calls so far): the turn crashed or is still running`;
const out = [
  `turn ${transcript
    .split("/")
    .pop()
    ?.replace(/\.jsonl$/, "")}: ${head}`,
  "",
  "tools:",
  ...(tools.length ? tools.map((tool, i) => `  ${i + 1}. ${tool}`) : ["  (none)"]),
  "",
  "errors:",
  ...(errors.length ? errors.map((error) => `  - ${error}`) : ["  (none)"]),
  "",
  ...(stderrTail ? ["stderr tail:", stderrTail, ""] : []),
  "reply:",
  final?.result ?? lastText,
].join("\n");

const scrubbed = scrubSecrets(out);
await Bun.write(transcript.replace(/\.jsonl$/, ".summary.md"), scrubbed);
console.log(scrubbed);
