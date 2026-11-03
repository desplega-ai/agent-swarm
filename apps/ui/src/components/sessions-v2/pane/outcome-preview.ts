// The one plain line a worker row shows for its outcome (`WorkerStep`).
//
// Relative imports only: `bun:test` runs this from the repo root.

import type { AgentTask } from "../../../api/types";
import { type JsonContainer, parseJsonOutput } from "../../../lib/json-output";
import { markdownPreview } from "../../../lib/markdown-preview";
import { promptTitle } from "../../../lib/prompt-display";
import { plural } from "../../../lib/sessions-v2";

/** Fields a person reads first in a structured output. */
const LEAD_KEYS = ["summary", "result", "message", "status", "title"];

/** A GitHub PR or issue URL as "PR #2589" or "Issue #12", another URL as its host and path tail. */
function shortUrl(value: string): string | null {
  if (!/^https?:\/\/\S+$/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const github = /^\/[^/]+\/[^/]+\/(pull|issues)\/(\d+)/.exec(url.pathname);
  if (url.hostname === "github.com" && github) {
    return `${github[1] === "pull" ? "PR" : "Issue"} #${github[2]}`;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const tail = parts.at(-1);
  if (!tail) return url.hostname;
  return `${url.hostname}/${parts.length > 1 ? "…/" : ""}${tail}`;
}

/**
 * A structured output as "result: Approved · pr: PR #2589 · diffLines: 1 ·
 * files: 3 items": the human fields first, then strings, numbers, booleans,
 * and array counts. Empty when nothing is left (`{}`, `[]`).
 */
function jsonLine(data: JsonContainer): string {
  if (Array.isArray(data)) return data.length > 0 ? plural(data.length, "item") : "";
  const keys = Object.keys(data);
  const ordered = [
    ...LEAD_KEYS.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !LEAD_KEYS.includes(key)),
  ];
  const fields: string[] = [];
  for (const key of ordered) {
    const value = data[key];
    if (Array.isArray(value)) fields.push(`${key}: ${plural(value.length, "item")}`);
    else if (typeof value === "string" && value.trim()) {
      fields.push(`${key}: ${shortUrl(value.trim()) ?? value.trim()}`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      fields.push(`${key}: ${value}`);
    }
  }
  return fields.join(" · ");
}

/** One top-level field with a string, number, boolean, or null value, then "," or "}" or the cut. */
const LEADING_FIELD =
  /\s*"((?:[^"\\]|\\.)*)"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)\s*(,|}|$)/y;

/**
 * The leading top-level fields of a JSON object that the preview cut ends
 * early. The scan stops at the first nested value, at a value the cut broke,
 * or at the end of the object. Null when it finds no field.
 */
function leadingJsonFields(text: string): Record<string, unknown> | null {
  const fields: Record<string, unknown> = {};
  LEADING_FIELD.lastIndex = 1;
  for (let match = LEADING_FIELD.exec(text); match; match = LEADING_FIELD.exec(text)) {
    try {
      fields[JSON.parse(`"${match[1]}"`)] = JSON.parse(match[2] ?? "");
    } catch {
      break;
    }
    if (match[3] !== ",") break;
  }
  return Object.keys(fields).length > 0 ? fields : null;
}

/** What the preview line reads. */
export type PreviewSource = Pick<
  AgentTask,
  "status" | "output" | "failureReason" | "progress" | "task"
>;

/** The preview reads at most this much of a text: one line never needs more. */
const PREVIEW_INPUT = 2048;

/** The start of a text, trimmed and cut to `PREVIEW_INPUT`. */
const head = (text: string | undefined) => text?.trim().slice(0, PREVIEW_INPUT) ?? "";

/**
 * The outcome as one line: the output, the failure, or the progress of open
 * work. A JSON object the cut breaks keeps its leading fields. Raw text only
 * when no field is found.
 */
function outcomeLine(task: PreviewSource): string {
  const text = head(
    task.status === "completed"
      ? task.output
      : task.status === "failed" || task.status === "cancelled"
        ? task.failureReason
        : task.progress,
  );
  const json = parseJsonOutput(text);
  if (json) return jsonLine(json);
  const fields = text.startsWith("{") ? leadingJsonFields(text) : null;
  return (fields && jsonLine(fields)) || text;
}

/** A bare git SHA (40 or 64 hex digits) as its first 8. */
const SHA = /\b([0-9a-f]{8})(?:[0-9a-f]{56}|[0-9a-f]{32})\b/gi;

/**
 * The row's one plain line: the outcome, else the progress (an empty
 * structured output can leave the result there), else the task's first line.
 * An open row shows the task's first line: the outcome is in full below it.
 * Capped, so the button's accessible name stays short.
 */
export function outcomePreview(task: PreviewSource, open: boolean): string {
  const line = open
    ? promptTitle(task.task)
    : outcomeLine(task) || head(task.progress) || promptTitle(task.task);
  return markdownPreview(line).replace(SHA, "$1").slice(0, 300);
}
