#!/usr/bin/env bun
/**
 * Generate the public "what is collected" event table from the vendored
 * telemetry catalog, so the docs list exactly what the ingest accepts.
 *
 * Usage: bun run build:telemetry-docs   (rewrite the generated block)
 *        bun run check:telemetry-docs   (fail when the block is stale)
 *
 * Source: src/telemetry-contract/EVENTS.md (vendored from the proxy).
 * Target: the block between the BEGIN/END markers in reference/telemetry.mdx.
 * Only the `trigger_surface` and `agent-swarm` sections are published here.
 * Other products document themselves.
 *
 * `--check` is offline. It also fails when the page leaves an identity
 * `context` field undocumented.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const EVENTS_PATH = join(REPO_ROOT, "src", "telemetry-contract", "EVENTS.md");
const TYPES_PATH = join(REPO_ROOT, "src", "telemetry-contract", "types.gen.ts");
const DOC_PATH = join(
  REPO_ROOT,
  "docs-site",
  "content",
  "docs",
  "(documentation)",
  "reference",
  "telemetry.mdx",
);

export const BEGIN_MARKER =
  "{/* BEGIN GENERATED: telemetry-events (bun run build:telemetry-docs; do not edit) */}";
export const END_MARKER = "{/* END GENERATED: telemetry-events */}";

/** Sections of EVENTS.md that belong on the agent-swarm page, in file order. */
const PUBLISHED_SECTIONS = ["trigger_surface", "agent-swarm"];

/** Escape what MDX would parse as JSX or an expression, outside code spans. */
function mdxSafe(line: string): string {
  return line
    .split(/(`[^`]*`)/)
    .map((part, index) => {
      if (index % 2 === 1) return part; // inside a code span
      return part
        .replaceAll("<br>", "\u0000")
        .replaceAll("{", "\\{")
        .replaceAll("}", "\\}")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\u0000", "<br />");
    })
    .join("");
}

/** The publishable part of EVENTS.md, headings demoted one level, MDX-safe. */
export function renderEventsBlock(eventsMd: string): string {
  const lines = eventsMd.split("\n");
  const out: string[] = [];
  let publish = false;
  let sawHeading = false;
  for (const line of lines) {
    const heading = /^## `([^`]+)`\s*$/.exec(line);
    if (heading) {
      sawHeading = true;
      publish = PUBLISHED_SECTIONS.includes(heading[1] as string);
      if (publish) out.push(`### \`${heading[1]}\``);
      continue;
    }
    // Before the first section: the catalog title and intro paragraph.
    if (!sawHeading) {
      if (line.startsWith("<!--") || line.startsWith("# ")) continue;
      out.push(mdxSafe(line));
      continue;
    }
    if (publish) out.push(mdxSafe(line));
  }
  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

/** Keys of the `EventContext` schema in the vendored OpenAPI types. */
export function contextFieldNames(typesTs: string): string[] {
  const start = typesTs.indexOf("EventContext: {");
  if (start < 0) throw new Error("EventContext not found in types.gen.ts");
  const end = typesTs.indexOf("\n        };", start);
  const body = typesTs.slice(start, end);
  return [...body.matchAll(/^\s{12}([a-z_]+)\??:/gm)].map((m) => m[1] as string);
}

export function applyBlock(doc: string, block: string): string {
  const begin = doc.indexOf(BEGIN_MARKER);
  const end = doc.indexOf(END_MARKER);
  if (begin < 0 || end < 0 || end < begin) {
    throw new Error(`telemetry.mdx must contain ${BEGIN_MARKER} ... ${END_MARKER}`);
  }
  return `${doc.slice(0, begin + BEGIN_MARKER.length)}\n\n${block}\n${doc.slice(end)}`;
}

/** Context fields the page never mentions in backticks. */
export function undocumentedContextFields(doc: string, typesTs: string): string[] {
  return contextFieldNames(typesTs).filter((field) => !doc.includes(`\`${field}\``));
}

function main(): number {
  const check = process.argv.includes("--check");
  const doc = readFileSync(DOC_PATH, "utf8");
  const next = applyBlock(doc, renderEventsBlock(readFileSync(EVENTS_PATH, "utf8")));
  const missing = undocumentedContextFields(next, readFileSync(TYPES_PATH, "utf8"));

  if (check) {
    const problems: string[] = [];
    if (next !== doc) {
      problems.push(
        "the event table in telemetry.mdx is stale; run `bun run build:telemetry-docs`",
      );
    }
    if (missing.length > 0) {
      problems.push(`telemetry.mdx does not document context field(s): ${missing.join(", ")}`);
    }
    if (problems.length > 0) {
      for (const problem of problems) console.error(`check:telemetry-docs: ${problem}`);
      return 1;
    }
    console.log("Telemetry docs match the vendored catalog.");
    return 0;
  }

  if (next !== doc) writeFileSync(DOC_PATH, next);
  if (missing.length > 0) {
    console.error(`telemetry.mdx does not document context field(s): ${missing.join(", ")}`);
    return 1;
  }
  console.log(next === doc ? "Telemetry docs already up to date." : "Updated telemetry.mdx.");
  return 0;
}

if (import.meta.main) process.exit(main());
