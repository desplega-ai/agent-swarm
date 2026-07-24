#!/usr/bin/env bun
/**
 * MCP Tools Documentation Generator
 *
 * This script dynamically discovers and parses tool files in src/tools/
 * and generates MCP.md documentation.
 *
 * Run with: bun run docs:mcp
 */

import { Glob } from "bun";
import path from "node:path";

const TOOLS_DIR = path.join(import.meta.dir, "../src/tools");
const SERVER_FILE = path.join(import.meta.dir, "../src/server.ts");
const OUTPUT_FILE = path.join(import.meta.dir, "../MCP.md");

interface ToolCategory {
  name: string;
  title: string;
  description: string;
  tools: string[];
  enabledByDefault: boolean;
}

interface ToolInfo {
  name: string;
  title: string;
  description: string;
  fields: FieldInfo[];
}

interface FieldInfo {
  name: string;
  type: string;
  required: boolean;
  default?: string;
  description: string;
}

/**
 * Parse the DEFAULT_CAPABILITIES array literal in server.ts. Commented-out
 * entries (`// "services",`) are the disabled-by-default set, so comment
 * lines are skipped.
 */
function parseDefaultCapabilities(serverContent: string): Set<string> {
  const defaults = new Set<string>();
  const arrMatch = serverContent.match(/const DEFAULT_CAPABILITIES[^=]*=\s*\[([\s\S]*?)\]\s*\.join/);
  if (!arrMatch) return defaults;
  for (const rawLine of arrMatch[1]!.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("//")) continue;
    const literal = line.match(/["']([\w-]+)["']/);
    if (literal) defaults.add(literal[1]!);
  }
  return defaults;
}

/**
 * Collect the contiguous `//` comment lines immediately above `idx`
 * (the start of a `if (hasCapability(...))` statement) as the category
 * description. Stops at the first blank or non-comment line.
 */
function commentAbove(serverContent: string, idx: number): string {
  const lines = serverContent.slice(0, idx).split("\n");
  // Last element is the indentation of the `if` line itself; skip it.
  lines.pop();
  const collected: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("//") || /^\/\/\s*-{3,}/.test(line)) break;
    collected.unshift(line.replace(/^\/\/\s?/, ""));
  }
  return collected.join(" ").trim();
}

// Titles that formatCategoryTitle would mangle (acronyms, product names).
const CATEGORY_TITLE_OVERRIDES: Record<string, string> = {
  mcp: "MCP Server Tools",
  kv: "KV Tools",
  agentmail: "AgentMail Tools",
  kapso: "Kapso (WhatsApp) Tools",
  "swarm-x": "Swarm X Tools",
};

/**
 * Dynamically discover tool categories from server.ts. Every tool group in
 * createServer() is gated by `if (hasCapability("<cap>"))`; whether the
 * capability is on by default comes from the DEFAULT_CAPABILITIES array.
 */
async function discoverCategories(): Promise<ToolCategory[]> {
  const serverContent = await Bun.file(SERVER_FILE).text();
  const defaults = parseDefaultCapabilities(serverContent);
  const categories: ToolCategory[] = [];

  const ifRe = /if\s*\(hasCapability\(["']([\w-]+)["']\)\)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = ifRe.exec(serverContent)) !== null) {
    const capName = match[1]!;

    // Brace-match the block body (register calls may sit under nested comments
    // but never nested braces today; counting keeps this robust anyway).
    let i = ifRe.lastIndex;
    const bodyStart = i;
    let depth = 1;
    while (i < serverContent.length && depth > 0) {
      const c = serverContent[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    const block = serverContent.slice(bodyStart, i - 1);

    // Both singular (`registerFooTool`) and plural (`registerFooTools`)
    // registrars are captured; plural ones name a tool FILE that registers
    // several tools and are expanded against the parsed files in
    // generateDocs (e.g. registerScriptRunsTools → script-runs.ts's tools).
    const tools: string[] = [];
    for (const call of block.matchAll(/register(\w+?)Tools?\(server\)/g)) {
      tools.push(camelToKebab(call[1]!));
    }
    if (tools.length === 0) continue;

    const existing = categories.find((c) => c.name === capName);
    if (existing) {
      existing.tools.push(...tools);
      continue;
    }

    categories.push({
      name: capName,
      title: CATEGORY_TITLE_OVERRIDES[capName] ?? formatCategoryTitle(capName),
      description: commentAbove(serverContent, match.index),
      tools,
      enabledByDefault: defaults.has(capName),
    });
  }

  return categories;
}

/**
 * Discover all tool files in the tools directory (including subdirectories)
 */
async function discoverToolFiles(): Promise<string[]> {
  const glob = new Glob("**/*.ts");
  const files: string[] = [];

  for await (const file of glob.scan(TOOLS_DIR)) {
    // Skip utility files and index files
    if (file === "utils.ts" || file.endsWith("index.ts")) continue;
    files.push(file.replace(".ts", ""));
  }

  return files;
}

/**
 * Walk `source` starting at `startIdx` and parse a chain of one or more JS
 * string literals joined by `+`. Returns the concatenated decoded value plus
 * the index at which parsing stopped, or `null` if the cursor isn't pointing
 * at a string literal.
 *
 * Handles all three quote styles (`"`, `'`, `` ` ``) — the closing quote
 * must match the opening quote of THAT literal, so descriptions containing
 * inner quotes of a different style (`"Model ('haiku', 'sonnet')..."`) are
 * captured in full instead of being truncated at the first inner quote.
 *
 * Backslash escapes are decoded for common cases (`\n`, `\t`, `\r`, `\\`,
 * matching the opening quote) — anything else passes through as-is. Template
 * literals are treated as plain strings (no `${}` interpolation handling)
 * because no MCP tool description uses interpolation today.
 */
function parseStringLiteralChain(
  source: string,
  startIdx: number,
): { value: string; endIdx: number } | null {
  let i = startIdx;
  while (i < source.length && /\s/.test(source[i]!)) i++;

  let result = "";
  let parsedAtLeastOne = false;

  while (i < source.length) {
    const quote = source[i];
    if (quote !== '"' && quote !== "'" && quote !== "`") break;
    i++;

    while (i < source.length) {
      const c = source[i]!;
      if (c === "\\" && i + 1 < source.length) {
        const next = source[i + 1]!;
        if (next === "n") result += "\n";
        else if (next === "t") result += "\t";
        else if (next === "r") result += "\r";
        else if (next === "\\") result += "\\";
        else if (next === '"' || next === "'" || next === "`") result += next;
        else result += next;
        i += 2;
        continue;
      }
      if (c === quote) {
        i++;
        break;
      }
      result += c;
      i++;
    }
    parsedAtLeastOne = true;

    // Skip whitespace; if we see a `+`, look for another literal — otherwise
    // we're done.
    let j = i;
    while (j < source.length && /\s/.test(source[j]!)) j++;
    if (source[j] === "+") {
      i = j + 1;
      while (i < source.length && /\s/.test(source[i]!)) i++;
      // continue outer loop to read next literal
    } else {
      break;
    }
  }

  if (!parsedAtLeastOne) return null;
  return { value: result, endIdx: i };
}

/**
 * Convenience: parse a literal chain at `startIdx` and return the cleaned-up
 * single-line description, or empty string when no literal is found.
 */
function readDescriptionAt(source: string, startIdx: number): string {
  const parsed = parseStringLiteralChain(source, startIdx);
  if (!parsed) return "";
  return parsed.value.replace(/\s+/g, " ").trim();
}

/**
 * Look up the value of a top-level `const NAME = "..." (+ "...")*;` declaration
 * inside `content`. Returns the resolved string, or empty string when the
 * constant's RHS isn't a string-literal chain.
 */
function resolveStringConstant(constName: string, content: string): string {
  const re = new RegExp(`(?:const|let|var)\\s+${constName}(?:\\s*:\\s*[^=;]+)?\\s*=\\s*`);
  const match = re.exec(content);
  if (!match || match.index === undefined) return "";
  const startIdx = match.index + match[0].length;
  return readDescriptionAt(content, startIdx);
}

/**
 * Parse a tool file to extract metadata
 */
async function parseToolFile(toolFileName: string): Promise<ToolInfo[]> {
  const filePath = path.join(TOOLS_DIR, `${toolFileName}.ts`);
  const content = await Bun.file(filePath).text();
  const registrations = [...content.matchAll(/(?:createToolRegistrar\(server\)|register)\(\s*["']([^"']+)["']/g)];
  if (registrations.length === 0) return [];

  const infos: ToolInfo[] = [];
  for (let idx = 0; idx < registrations.length; idx++) {
    const match = registrations[idx]!;
    const name = match[1]!;
    const start = match.index ?? 0;
    const end = idx + 1 < registrations.length ? (registrations[idx + 1]!.index ?? content.length) : content.length;
    const snippet = content.slice(start, end);

    const titleMatch = snippet.match(/title:\s*["']([^"']+)["']/);
    const title = titleMatch ? titleMatch[1] : formatTitle(name);

    let description = "";
    const descKeyRegex = /description\s*:\s*(?=["'`])/g;
    let descKeyMatch: RegExpExecArray | null;
    while ((descKeyMatch = descKeyRegex.exec(snippet)) !== null) {
      const startIdx = descKeyMatch.index + descKeyMatch[0].length;
      const parsed = parseStringLiteralChain(snippet, startIdx);
      if (!parsed) continue;
      description = parsed.value.replace(/\s+/g, " ").trim();
      break;
    }

    const fields = parseSchemaFields(snippet, content);
    infos.push({ name, title, description, fields });
  }

  return infos;
}

/**
 * Parse input schema fields from file content. The full `content` is
 * threaded through so `parseField` can resolve `.describe(CONST_NAME)`
 * references back to their string-literal definitions.
 */
function parseSchemaFields(content: string, fullContent: string): FieldInfo[] {
  const fields: FieldInfo[] = [];

  // Find inputSchema block
  const schemaStart = content.indexOf("inputSchema:");
  if (schemaStart === -1) return fields;

  const schemaExprStart = schemaStart + "inputSchema:".length;
  let source = content;
  let objectStart = findSchemaObjectStart(content, schemaExprStart);
  if (objectStart === -1) {
    const schemaRefMatch = /^\s*([A-Za-z_$][\w$]*)/.exec(content.slice(schemaExprStart));
    if (schemaRefMatch) {
      objectStart = findSchemaConstantObjectStart(schemaRefMatch[1]!, fullContent);
      source = fullContent;
    }
  }
  if (objectStart === -1) return fields;

  // Extract the object content by counting braces
  let braceCount = 0;
  let inObject = false;
  let objectContent = "";
  let i = objectStart;

  while (i < source.length) {
    const char = source[i];
    if (char === "{") {
      braceCount++;
      inObject = true;
    }
    if (inObject) objectContent += char;
    if (char === "}") {
      braceCount--;
      if (braceCount === 0 && inObject) break;
    }
    i++;
  }

  if (!objectContent) return fields;

  // Remove outer braces and parse fields
  objectContent = objectContent.slice(1, -1);

  // Parse each field by tracking brace/paren depth
  let currentField = "";
  let depth = 0;

  for (let j = 0; j < objectContent.length; j++) {
    const char = objectContent[j];
    if (char === "(" || char === "{" || char === "[") depth++;
    if (char === ")" || char === "}" || char === "]") depth--;

    currentField += char;

    // Field ends when we hit a comma at depth 0, or end of content
    const isEndOfField = (char === "," && depth === 0) || j === objectContent.length - 1;

    if (isEndOfField && currentField.trim()) {
      const field = parseField(currentField, fullContent);
      if (field) fields.push(field);
      currentField = "";
    }
  }

  return fields;
}

function findSchemaObjectStart(source: string, startIdx: number): number {
  let i = startIdx;
  while (i < source.length && /\s/.test(source[i]!)) i++;
  const objectCall = /^z\s*\.\s*object\s*\(/.exec(source.slice(i));
  return objectCall ? i + objectCall[0].length : -1;
}

function findSchemaConstantObjectStart(constName: string, source: string): number {
  const re = new RegExp(`(?:const|let|var)\\s+${constName}(?:\\s*:\\s*[^=;]+)?\\s*=\\s*`);
  const match = re.exec(source);
  if (!match || match.index === undefined) return -1;
  return findSchemaObjectStart(source, match.index + match[0].length);
}

/**
 * Parse a single field definition. `fullContent` is the entire tool-file
 * source; it's used to resolve `.describe(CONST_NAME)` references back to the
 * string literal the constant holds.
 */
function parseField(fieldStr: string, fullContent: string): FieldInfo | null {
  // Match field name and type chain. Allow whitespace/newlines between `z` and
  // the first `.method(...)` so multi-line zod chains (e.g. `z\n  .string()`)
  // are parsed too.
  const fieldMatch = fieldStr.match(/^\s*(\w+):\s*([\s\S]+)/);
  if (!fieldMatch) return null;

  const [, name, rawTypeChain] = fieldMatch;
  const typeChain = rawTypeChain!.trim().replace(/^z\s*\.\s*/, "");

  // Determine type
  let type = "unknown";
  if (typeChain.startsWith("string")) type = "string";
  else if (typeChain.startsWith("number")) type = "number";
  else if (typeChain.startsWith("boolean")) type = "boolean";
  else if (typeChain.startsWith("array")) type = "array";
  else if (typeChain.startsWith("uuid")) type = "uuid";
  else if (typeChain.startsWith("object")) type = "object";
  else if (typeChain.startsWith("record")) type = "object";
  else if (typeChain.startsWith("providerSchema")) type = "string";
  else if (typeChain.startsWith("enum")) {
    const enumMatch = typeChain.match(/enum\(\[([\s\S]*?)\]/);
    if (enumMatch) {
      const values = enumMatch[1]
        .replace(/["']/g, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      type = values.join(" \\| ");
    }
  }

  // Check if optional or has default
  let required = true;
  let defaultValue: string | undefined;

  if (typeChain.includes(".optional()")) required = false;
  if (typeChain.includes(".default(")) {
    required = false;
    const defaultMatch = typeChain.match(/\.default\(([^)]+)\)/);
    if (defaultMatch) {
      defaultValue = defaultMatch[1].trim();
    }
  }

  // Extract description.
  //
  // Two shapes to handle:
  //   1) Inline string literal — possibly a chain of concatenated literals
  //      across multiple lines: `.describe("foo " + "bar")`.
  //   2) Constant reference: `.describe(SOME_CONSTANT)` where the constant
  //      is defined elsewhere in the same file as a string literal (or
  //      string-literal chain).
  //
  // The walker is quote-delimiter-aware: a `"`-delimited literal is closed
  // only by another `"`, so descriptions like
  //   `"Model to use ('haiku', 'sonnet', or 'opus')..."`
  // are captured in full. (Pre-fix regex used `["'\`]...["'\`]` which let
  // ANY quote close the literal, truncating at the first inner `'`.)
  let description = "";
  const describeOpen = typeChain.search(/\.describe\s*\(\s*/);
  if (describeOpen !== -1) {
    const openMatch = /\.describe\s*\(\s*/.exec(typeChain.slice(describeOpen))!;
    const argStart = describeOpen + openMatch[0].length;
    if (typeChain[argStart] === '"' || typeChain[argStart] === "'" || typeChain[argStart] === "`") {
      description = readDescriptionAt(typeChain, argStart);
    } else {
      // `.describe(CONSTANT)` — resolve UPPER_SNAKE identifiers from the
      // full file. Lower-case identifiers are deliberately ignored: they're
      // typically variables / computed values and resolving them would be
      // unsafe. Stick with the convention and bail otherwise.
      const tail = typeChain.slice(argStart);
      const constRefMatch = /^([A-Z_][A-Z0-9_]*)\s*\)/.exec(tail);
      if (constRefMatch) {
        description = resolveStringConstant(constRefMatch[1]!, fullContent);
      }
    }
  }

  return { name, type, required, default: defaultValue, description };
}

/**
 * Convert CamelCase to kebab-case
 */
function camelToKebab(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

/**
 * Format category name to title
 */
function formatCategoryTitle(name: string): string {
  return (
    name
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ") + " Tools"
  );
}

/**
 * Format tool name to title
 */
function formatTitle(name: string): string {
  return name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Generate markdown for a single tool
 */
function generateToolMarkdown(tool: ToolInfo): string {
  let md = `### ${tool.name}\n\n`;
  md += `**${tool.title}**\n\n`;

  if (tool.description) {
    md += `${tool.description}\n\n`;
  }

  if (tool.fields.length > 0) {
    md += `| Parameter | Type | Required | Default | Description |\n`;
    md += `|-----------|------|----------|---------|-------------|\n`;
    for (const field of tool.fields) {
      const req = field.required ? "Yes" : "No";
      const def = field.default ?? "-";
      const desc = field.description || "-";
      md += `| \`${field.name}\` | \`${field.type}\` | ${req} | ${def} | ${desc} |\n`;
    }
    md += "\n";
  } else {
    md += "*No parameters*\n\n";
  }

  return md;
}

/**
 * Main generation function
 */
async function generateDocs() {
  console.log("Discovering tool categories from server.ts...");
  const categories = await discoverCategories();

  console.log("Discovering tool files...");
  const allToolFiles = await discoverToolFiles();

  console.log(`Found ${allToolFiles.length} tool files`);
  console.log(`Found ${categories.length} categories:`);
  for (const cat of categories) {
    console.log(`  - ${cat.name}: ${cat.tools.length} tools`);
  }

  // Parse all tool files. fileToolsMap keys on the file's base name so plural
  // registrar entries (registerScriptRunsTools → "script-runs") can be
  // expanded to the tools that file actually registers.
  const toolInfoMap = new Map<string, ToolInfo>();
  const fileToolsMap = new Map<string, string[]>();
  for (const fileName of allToolFiles) {
    const infos = await parseToolFile(fileName);
    const baseName = fileName.split("/").pop()!;
    for (const info of infos) {
      toolInfoMap.set(info.name, info);
      fileToolsMap.set(baseName, [...(fileToolsMap.get(baseName) ?? []), info.name]);
    }
  }

  const toolExists = (name: string): boolean =>
    toolInfoMap.has(name) || toolInfoMap.has(name.replace(/-/g, "_"));

  // Expand plural-registrar placeholders into their file's tools.
  for (const category of categories) {
    category.tools = category.tools.flatMap((t) =>
      toolExists(t) ? [t] : (fileToolsMap.get(t) ?? [t]),
    );
  }

  console.log(`Parsed ${toolInfoMap.size} tools`);

  // Generate markdown
  const defaultOn = categories.filter((c) => c.enabledByDefault).map((c) => c.name);
  const defaultOff = categories.filter((c) => !c.enabledByDefault).map((c) => c.name);

  let markdown = `# MCP Tools Reference

> Auto-generated from source. Do not edit manually.
> Run \`bun run docs:mcp\` to regenerate.

## Capability Flags

Every tool group is gated by a capability flag on the API server. The set of
enabled capabilities comes from the \`CAPABILITIES\` env var (or the
\`CAPABILITIES\` global swarm-config entry); when unset, the defaults apply.
Setting \`CAPABILITIES\` **replaces** the whole list — it is not additive — so
include every capability you want, not just the extras.

Capability flags shape the **externally exposed MCP tool list only** — they
hide tools from agents, they are not feature kill-switches. The scripts SDK
bridge always builds a full-surface server (its surface is governed by the
SDK allowlist instead), and HTTP REST routes are generally not gated.

- Enabled by default: ${defaultOn.map((c) => `\`${c}\``).join(", ")}
- Disabled by default: ${defaultOff.map((c) => `\`${c}\``).join(", ")}

## Table of Contents

`;

  // TOC entries use the canonical tool name from the source registration
  // (kebab or snake) so the anchor matches the section heading the generator
  // emits below.
  const canonicalName = (toolName: string): string =>
    toolInfoMap.get(toolName)?.name ??
    toolInfoMap.get(toolName.replace(/-/g, "_"))?.name ??
    toolName;

  // Generate TOC
  for (const category of categories) {
    const anchor = category.title.toLowerCase().replace(/\s+/g, "-");
    markdown += `- [${category.title}](#${anchor})\n`;
    for (const toolName of category.tools) {
      const name = canonicalName(toolName);
      markdown += `  - [${name}](#${name})\n`;
    }
  }

  markdown += "\n---\n\n";

  // Tool names registered in source can use either kebab-case ("memory-search")
  // or snake_case ("memory_rate"); register-fn names always derive to kebab via
  // camelToKebab. Look up both variants so either casing finds its info.
  const lookupTool = (toolName: string): ToolInfo | undefined => {
    return toolInfoMap.get(toolName) ?? toolInfoMap.get(toolName.replace(/-/g, "_"));
  };

  // Generate tool documentation by category
  for (const category of categories) {
    markdown += `## ${category.title}\n\n`;
    if (category.description) {
      markdown += `*${category.description}*\n\n`;
    }
    markdown += category.enabledByDefault
      ? `Capability: \`${category.name}\` (enabled by default)\n\n`
      : `Capability: \`${category.name}\` — **disabled by default**; add \`${category.name}\` to \`CAPABILITIES\` to enable.\n\n`;

    for (const toolName of category.tools) {
      const tool = lookupTool(toolName);
      if (tool) {
        markdown += generateToolMarkdown(tool);
      } else {
        console.warn(`Warning: No info found for tool "${toolName}"`);
        markdown += `### ${toolName}\n\n*Documentation not available*\n\n`;
      }
    }
  }

  // Check for uncategorized tools
  const categorizedTools = new Set(
    categories.flatMap((c) => c.tools.flatMap((t) => [t, t.replace(/-/g, "_")])),
  );
  const uncategorized = [...toolInfoMap.keys()].filter((name) => !categorizedTools.has(name));

  if (uncategorized.length > 0) {
    markdown = markdown.replace(
      "\n---\n\n",
      `- [Other Tools](#other-tools)\n\n---\n\n`,
    );
    markdown += `## Other Tools\n\n`;
    markdown += `*Tools not assigned to a capability group*\n\n`;
    for (const toolName of uncategorized) {
      const tool = toolInfoMap.get(toolName);
      if (tool) {
        markdown += generateToolMarkdown(tool);
      }
    }
  }

  // Write to file
  await Bun.write(OUTPUT_FILE, markdown);
  console.log(`\nGenerated ${OUTPUT_FILE}`);
}

// Run
generateDocs().catch(console.error);
