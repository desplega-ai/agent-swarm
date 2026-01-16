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
    /\/\/ Core tools[\s\S]*?(?=\/\/.*capability|if \(hasCapability)/
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
    /\/\/\s*([\w\s]+)\s*capability[\s\S]*?if\s*\(hasCapability\(["'](\w+(?:-\w+)*)["']\)\)\s*\{([\s\S]*?)\}/g
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
 * Parse a tool file to extract metadata
 */
async function parseToolFile(toolFileName: string): Promise<ToolInfo | null> {
  const filePath = path.join(TOOLS_DIR, `${toolFileName}.ts`);
  const content = await Bun.file(filePath).text();

  // Extract tool name from createToolRegistrar call
  const nameMatch = content.match(/createToolRegistrar\(server\)\(\s*["']([^"']+)["']/);
  if (!nameMatch) return null;

  const name = nameMatch[1];

  // Extract title
  const titleMatch = content.match(/title:\s*["']([^"']+)["']/);
  const title = titleMatch ? titleMatch[1] : formatTitle(name);

  // Extract description - handle multiline and various quote types
  let description = "";
  // Try to find description that ends before inputSchema, outputSchema, or annotations
  const descPatterns = [
    /description:\s*["'`]([\s\S]*?)["'`]\s*,\s*(?:inputSchema|outputSchema|annotations|_meta)/,
    /description:\s*["']([^"']+)["']/,
    /description:\s*`([^`]+)`/,
  ];

  for (const pattern of descPatterns) {
    const match = content.match(pattern);
    if (match) {
      description = match[1].replace(/\s+/g, " ").trim();
      break;
    }
  }

  // Parse schema fields
  const fields = parseSchemaFields(content);

  return { name, title, description, fields };
}

/**
 * Parse input schema fields from file content
 */
function parseSchemaFields(content: string): FieldInfo[] {
  const fields: FieldInfo[] = [];

  // Find inputSchema block
  const schemaStart = content.indexOf("inputSchema:");
  if (schemaStart === -1) return fields;

  // Find the z.object({ ... }) block
  const objectStart = content.indexOf("z.object({", schemaStart);
  if (objectStart === -1) return fields;

  // Extract the object content by counting braces
  let braceCount = 0;
  let inObject = false;
  let objectContent = "";
  let i = objectStart + "z.object(".length;

  while (i < content.length) {
    const char = content[i];
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
    const isEndOfField =
      (char === "," && depth === 0) || j === objectContent.length - 1;

    if (isEndOfField && currentField.trim()) {
      const field = parseField(currentField);
      if (field) fields.push(field);
      currentField = "";
    }
  }

  return fields;
}

/**
 * Parse a single field definition
 */
function parseField(fieldStr: string): FieldInfo | null {
  // Match field name and type chain
  const fieldMatch = fieldStr.match(/^\s*(\w+):\s*z\.([\s\S]+)/);
  if (!fieldMatch) return null;

  const [, name, typeChain] = fieldMatch;

  // Determine type
  let type = "unknown";
  if (typeChain.startsWith("string")) type = "string";
  else if (typeChain.startsWith("number")) type = "number";
  else if (typeChain.startsWith("boolean")) type = "boolean";
  else if (typeChain.startsWith("array")) type = "array";
  else if (typeChain.startsWith("uuid")) type = "uuid";
  else if (typeChain.startsWith("object")) type = "object";
  else if (typeChain.startsWith("record")) type = "object";
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

  // Extract description
  let description = "";
  const descMatch = typeChain.match(/\.describe\(["'`]([\s\S]*?)["'`]\)/);
  if (descMatch) {
    description = descMatch[1].replace(/\s+/g, " ").trim();
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
  return name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ") + " Tools";
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
    const info = await parseToolFile(fileName);
    if (info) {
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

  // Generate TOC
  for (const category of categories) {
    const anchor = category.title.toLowerCase().replace(/\s+/g, "-");
    markdown += `- [${category.title}](#${anchor})\n`;
    for (const toolName of category.tools) {
      markdown += `  - [${toolName}](#${toolName})\n`;
    }
  }

  markdown += "\n---\n\n";

  // Generate tool documentation by category
  for (const category of categories) {
    markdown += `## ${category.title}\n\n`;
    markdown += `*${category.description}*\n\n`;

    for (const toolName of category.tools) {
      const tool = toolInfoMap.get(toolName);
      if (tool) {
        markdown += generateToolMarkdown(tool);
      } else {
        console.warn(`Warning: No info found for tool "${toolName}"`);
        markdown += `### ${toolName}\n\n*Documentation not available*\n\n`;
      }
    }
  }

  // Check for uncategorized tools
  const categorizedTools = new Set(categories.flatMap((c) => c.tools));
  const uncategorized = [...toolInfoMap.keys()].filter(
    (name) => !categorizedTools.has(name)
  );

  if (uncategorized.length > 0) {
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
