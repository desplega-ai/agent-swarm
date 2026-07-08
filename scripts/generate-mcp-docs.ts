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
 * Dynamically discover tool categories from server.ts
 */
async function discoverCategories(): Promise<ToolCategory[]> {
  const serverContent = await Bun.file(SERVER_FILE).text();
  const categories: ToolCategory[] = [];

  // Extract core tools (always registered, no capability check)
  const coreTools: string[] = [];
  const coreMatch = serverContent.match(
    /\/\/ Core tools[\s\S]*?(?=\/\/.*capability|if \(hasCapability)/,
  );
  if (coreMatch) {
    const registerCalls = coreMatch[0].matchAll(/register(\w+)Tool\(server\)/g);
    for (const match of registerCalls) {
      const funcName = match[1];
      const toolName = camelToKebab(funcName);
      coreTools.push(toolName);
    }
  }
  categories.push({
    name: "core",
    title: "Core Tools",
    description: "Always available tools for basic swarm operations.",
    tools: coreTools,
  });

  // Extract capability-based tools
  const capabilityBlocks = serverContent.matchAll(
    /\/\/\s*([\w\s]+)\s*capability[\s\S]*?if\s*\(hasCapability\(["'](\w+(?:-\w+)*)["']\)\)\s*\{([\s\S]*?)\}/g,
  );

  for (const match of capabilityBlocks) {
    const [, commentDesc, capName, block] = match;
    const tools: string[] = [];

    const registerCalls = block.matchAll(/register(\w+)Tool\(server\)/g);
    for (const call of registerCalls) {
      const funcName = call[1];
      const toolName = camelToKebab(funcName);
      tools.push(toolName);
    }

    if (tools.length > 0) {
      categories.push({
        name: capName,
        title: formatCategoryTitle(capName),
        description: commentDesc.trim(),
        tools,
      });
    }
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
  let i = objectStart + "z.object(".length;

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
  return source.startsWith("z.object({", i) ? i : -1;
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

  // Parse all tool files
  const toolInfoMap = new Map<string, ToolInfo>();
  for (const fileName of allToolFiles) {
    const infos = await parseToolFile(fileName);
    for (const info of infos) {
      toolInfoMap.set(info.name, info);
    }
  }

  console.log(`Parsed ${toolInfoMap.size} tools`);

  // Generate markdown
  let markdown = `# MCP Tools Reference

> Auto-generated from source. Do not edit manually.
> Run \`bun run docs:mcp\` to regenerate.

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
    markdown += `*${category.description}*\n\n`;

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
