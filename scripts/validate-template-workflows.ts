#!/usr/bin/env bun
// Validates all workflow templates embedded in templates/workflows/*\/content.md.
//
// Each content.md contains exactly one fenced json code block with the workflow
// definition. This script extracts and validates each definition against
// the same schema used by the create-workflow API endpoint, then runs
// the structural DAG checks from src/workflows/definition.ts.
//
// Exit code 0 = all valid. Exit code 1 = at least one invalid.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowDefinitionSchema } from "../apps/swarm/src/types";
import { validateDefinition } from "../apps/swarm/src/workflows/definition";

const TEMPLATES_DIR = join(import.meta.dir, "..", "templates", "workflows");

const KNOWN_EXECUTOR_TYPES = new Set([
  "agent-task",
  "script",
  "swarm-script",
  "raw-llm",
  "validate",
  "property-match",
]);

function extractJsonBlock(markdown: string, file: string): unknown {
  // Match the first fenced json block
  const match = markdown.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match || !match[1]) {
    throw new Error(`No fenced json block found in ${file}`);
  }
  try {
    return JSON.parse(match[1]);
  } catch (err) {
    throw new Error(`JSON parse error in ${file}: ${(err as Error).message}`);
  }
}

let hasErrors = false;

const dirs = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

for (const slug of dirs) {
  const contentPath = join(TEMPLATES_DIR, slug, "content.md");
  let raw: string;
  try {
    raw = readFileSync(contentPath, "utf-8");
  } catch {
    console.error(`[SKIP] ${slug}: no content.md`);
    continue;
  }

  let parsed: unknown;
  try {
    parsed = extractJsonBlock(raw, contentPath);
  } catch (err) {
    console.error(`[FAIL] ${slug}: ${(err as Error).message}`);
    hasErrors = true;
    continue;
  }

  // Extract the `nodes` array (the workflow definition body).
  // Templates embed the full create-workflow payload shape (with name, description,
  // triggerSchema at the top level) rather than just the `definition` sub-object.
  // We normalise here: if there's a top-level `nodes` key, wrap it into the
  // `definition` shape that WorkflowDefinitionSchema expects.
  const obj = parsed as Record<string, unknown>;
  const definitionData: unknown =
    "nodes" in obj ? { nodes: obj.nodes, onNodeFailure: obj.onNodeFailure } : obj;

  const parseResult = WorkflowDefinitionSchema.safeParse(definitionData);
  if (!parseResult.success) {
    console.error(`[FAIL] ${slug}: schema validation failed`);
    for (const issue of parseResult.error.issues) {
      console.error(`       ${issue.path.join(".")} — ${issue.message}`);
    }
    hasErrors = true;
    continue;
  }

  const def = parseResult.data;

  // Run structural DAG checks (next refs, entry nodes, reachability, input sources).
  // We skip registry-based type validation here and do it ourselves below,
  // so we can use the plain KNOWN_EXECUTOR_TYPES set without constructing a full
  // ExecutorRegistry (which requires server-side dependencies).
  const { valid, errors } = validateDefinition(def);

  // Check all node types against the known built-in executor types.
  for (const node of def.nodes) {
    if (!KNOWN_EXECUTOR_TYPES.has(node.type)) {
      errors.push(
        `Node "${node.id}" uses unknown executor type "${node.type}". ` +
          `Known types: ${[...KNOWN_EXECUTOR_TYPES].join(", ")}`,
      );
    }
  }

  if (!valid || errors.length > 0) {
    console.error(`[FAIL] ${slug}: DAG validation failed`);
    for (const err of errors) {
      console.error(`       ${err}`);
    }
    hasErrors = true;
    continue;
  }

  console.log(`[OK]   ${slug}`);
}

if (hasErrors) {
  console.error("\nWorkflow template validation FAILED. Fix the errors above.");
  process.exit(1);
} else {
  console.log(`\nAll ${dirs.length} workflow templates are valid.`);
}
