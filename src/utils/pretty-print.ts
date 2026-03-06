/**
 * Pretty print utilities for Claude CLI output
 */

// ANSI color codes
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",

  // Foreground colors
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",

  // Bright colors
  brightBlack: "\x1b[90m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
  brightWhite: "\x1b[97m",

  // Background colors
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
  bgCyan: "\x1b[46m",
};

const c = colors;

/** Truncate string with ellipsis */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 3)}...`;
}

/** Format a tool name nicely */
function formatToolName(name: string): string {
  // Shorten MCP tool names
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return parts.length >= 3 ? `${parts[1]}:${parts[2]}` : name;
  }
  return name;
}

/** Format input parameters for tool calls */
function formatToolInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input);
  if (entries.length === 0) return "";

  const formatted = entries
    .map(([k, v]) => {
      const value = typeof v === "string" ? truncate(v, 50) : JSON.stringify(v);
      return `${c.dim}${k}=${c.reset}${truncate(String(value), 60)}`;
    })
    .join(", ");

  return ` (${formatted})`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
}

function readToolName(value: Record<string, unknown>): string {
  const toolCall = asRecord(value.toolCall);
  const candidate =
    (typeof value.name === "string" ? value.name : null) ||
    (typeof value.toolName === "string" ? value.toolName : null) ||
    (toolCall && typeof toolCall.name === "string" ? toolCall.name : null) ||
    "unknown";
  return formatToolName(candidate);
}

function readToolInput(value: Record<string, unknown>): Record<string, unknown> {
  const toolCall = asRecord(value.toolCall);
  return (
    asRecord(value.input) ||
    asRecord(value.toolInput) ||
    asRecord(value.args) ||
    (toolCall ? asRecord(toolCall.input) : null) ||
    {}
  );
}

function printAssistantText(prefix: string, text: string): void {
  console.log(`${prefix} ${c.green}◆${c.reset} ${c.bold}Assistant:${c.reset}`);
  const lines = text.split("\n");
  for (const l of lines.slice(0, 5)) {
    console.log(`${prefix}    ${truncate(l, 100)}`);
  }
  if (lines.length > 5) {
    console.log(`${prefix}    ${c.dim}... (${lines.length - 5} more lines)${c.reset}`);
  }
}

function printToolCall(prefix: string, toolName: string, input: Record<string, unknown>): void {
  console.log(
    `${prefix} ${c.magenta}▶${c.reset} Tool: ${c.magenta}${toolName}${c.reset}${formatToolInput(input)}`,
  );
}

function printResult(prefix: string, text: string, isError = false): void {
  const icon = isError ? `${c.red}✗${c.reset}` : `${c.green}✓${c.reset}`;
  console.log(`${prefix} ${icon} Result: ${truncate(text, 100)}`);
}

function prettyPrintPiMessage(message: Record<string, unknown>, prefix: string): void {
  const role = typeof message.role === "string" ? message.role : "";
  const content = asRecordArray(message.content);

  if (role === "assistant") {
    for (const block of content) {
      const blockType = typeof block.type === "string" ? block.type : "";
      if (blockType === "text") {
        const text = typeof block.text === "string" ? block.text : "";
        if (text) printAssistantText(prefix, text);
        continue;
      }

      if (blockType === "toolCall" || blockType === "tool_use" || blockType === "toolUse") {
        const toolName = readToolName(block);
        const input = readToolInput(block);
        printToolCall(prefix, toolName, input);
      }
    }
    return;
  }

  if (role === "toolResult" || role === "user" || role === "tool") {
    for (const block of content) {
      const blockType = typeof block.type === "string" ? block.type : "";
      if (blockType === "tool_result" || blockType === "toolResult") {
        const rawResult = block.content ?? block.result ?? block.output;
        const result =
          typeof rawResult === "string" ? rawResult : rawResult ? JSON.stringify(rawResult) : "";
        const isError = Boolean(block.is_error ?? block.isError);
        if (result) printResult(prefix, result, isError);
      }
    }
  }
}

/** Pretty print a single JSON line from Claude output */
export function prettyPrintLine(line: string, role: string): void {
  try {
    if (!line.trim()) return;

    let json: Record<string, unknown>;
    try {
      json = JSON.parse(line.trim());
    } catch {
      // Raw output - just print it
      console.log(`${c.dim}[${role}]${c.reset} ${line.trim()}`);
      return;
    }

    const type = json.type as string;
    const prefix = `${c.dim}[${role}]${c.reset}`;

    switch (type) {
      case "turn_start":
      case "turn_end":
      case "message_start":
      case "message_update":
      case "agent_start":
      case "tool_execution_update":
        // Pi emits high-frequency lifecycle deltas; suppress these for readability.
        return;

      case "system": {
        const subtype = json.subtype as string;
        if (subtype === "init") {
          const model = json.model as string;
          const tools = json.tools as string[];
          console.log(
            `${prefix} ${c.cyan}●${c.reset} ${c.bold}Session started${c.reset} ${c.dim}(${model}, ${tools?.length || 0} tools)${c.reset}`,
          );
        } else if (subtype === "hook_response") {
          const hookName = json.hook_name as string;
          const stdout = json.stdout as string;
          console.log(`${prefix} ${c.yellow}⚡${c.reset} Hook: ${c.yellow}${hookName}${c.reset}`);
          if (stdout) {
            const lines = stdout.split("\n").filter((l) => l.trim());
            for (const l of lines.slice(0, 3)) {
              console.log(`${prefix}    ${c.dim}${truncate(l, 80)}${c.reset}`);
            }
            if (lines.length > 3) {
              console.log(`${prefix}    ${c.dim}... (${lines.length - 3} more lines)${c.reset}`);
            }
          }
        } else {
          const msg = (json.message as string) || (json.content as string) || "";
          console.log(
            `${prefix} ${c.cyan}ℹ${c.reset} System${subtype ? ` (${subtype})` : ""}: ${truncate(msg, 100)}`,
          );
        }
        break;
      }

      case "assistant": {
        const message = json.message as Record<string, unknown>;
        if (!message) break;

        const content = message.content as Array<Record<string, unknown>>;
        if (!content) break;

        for (const block of content) {
          if (block.type === "text") {
            const text = block.text as string;
            printAssistantText(prefix, text);
          } else if (block.type === "tool_use") {
            const toolName = formatToolName((block.name as string) || "unknown");
            const input = (block.input as Record<string, unknown>) || {};
            printToolCall(prefix, toolName, input);
          } else if (block.type === "thinking") {
            const thinking = block.thinking as string;
            console.log(`${prefix} ${c.blue}💭${c.reset} ${c.dim}Thinking...${c.reset}`);
            if (thinking) {
              console.log(`${prefix}    ${c.dim}${truncate(thinking, 80)}${c.reset}`);
            }
          }
        }
        break;
      }

      case "user": {
        const message = json.message as Record<string, unknown>;
        const rawToolResult = json.tool_use_result;
        const toolResult =
          typeof rawToolResult === "string"
            ? rawToolResult
            : rawToolResult
              ? JSON.stringify(rawToolResult)
              : null;

        if (toolResult) {
          const isError = toolResult.includes("Error") || toolResult.includes("error");
          printResult(prefix, toolResult, isError);
        } else if (message) {
          const content = message.content as Array<Record<string, unknown>>;
          if (content) {
            for (const block of content) {
              if (block.type === "tool_result") {
                const rawResult = block.content;
                const result =
                  typeof rawResult === "string"
                    ? rawResult
                    : rawResult
                      ? JSON.stringify(rawResult)
                      : "";
                const isError = block.is_error as boolean;
                printResult(prefix, result, isError);
              }
            }
          }
        }
        break;
      }

      case "result": {
        const subtype = json.subtype as string;
        const isError = json.is_error as boolean;
        const duration = json.duration_ms as number;
        const cost = json.total_cost_usd as number;
        const numTurns = json.num_turns as number;
        const result = json.result as string;

        const icon = isError ? `${c.red}✗${c.reset}` : `${c.green}✓${c.reset}`;
        const durationStr = duration ? `${(duration / 1000).toFixed(1)}s` : "";
        const costStr = cost ? `$${cost.toFixed(4)}` : "";

        console.log(
          `${prefix} ${icon} ${c.bold}Done${c.reset} ${c.dim}(${subtype}, ${numTurns} turns, ${durationStr}, ${costStr})${c.reset}`,
        );

        if (result) {
          const lines = result.split("\n").filter((l) => l.trim());
          for (const l of lines.slice(0, 3)) {
            console.log(`${prefix}    ${truncate(l, 100)}`);
          }
          if (lines.length > 3) {
            console.log(`${prefix}    ${c.dim}... (${lines.length - 3} more lines)${c.reset}`);
          }
        }
        break;
      }

      case "message_end": {
        const message = asRecord(json.message);
        if (message) {
          prettyPrintPiMessage(message, prefix);
        }
        break;
      }

      case "tool_execution_start": {
        const toolName = readToolName(json);
        const input = readToolInput(json);
        printToolCall(prefix, toolName, input);
        break;
      }

      case "tool_execution_end": {
        const error = json.error;
        if (typeof error === "string" && error.trim()) {
          printResult(prefix, error, true);
          break;
        }

        const result = json.result ?? json.output ?? json.stdout;
        if (typeof result === "string" && result.trim()) {
          printResult(prefix, result, false);
        }
        break;
      }

      case "provider_error": {
        const error = (json.error as string) || (json.message as string) || JSON.stringify(json);
        console.log(`${prefix} ${c.red}✗ Error:${c.reset} ${truncate(error, 100)}`);
        break;
      }

      case "error": {
        const error = (json.error as string) || (json.message as string) || JSON.stringify(json);
        console.log(`${prefix} ${c.red}✗ Error:${c.reset} ${truncate(error, 100)}`);
        break;
      }

      default: {
        // Unknown type - print a summary
        console.log(`${prefix} ${c.dim}[${type}]${c.reset} ${truncate(JSON.stringify(json), 100)}`);
      }
    }
  } catch (_err) {
    // Never let pretty-print crash the runner - just log raw line
    console.log(`${c.dim}[${role}]${c.reset} ${line}`);
  }
}

/** Pretty print stderr output */
export function prettyPrintStderr(text: string, role: string): void {
  const prefix = `${c.dim}[${role}]${c.reset}`;
  console.error(`${prefix} ${c.red}stderr:${c.reset} ${truncate(text.trim(), 100)}`);
}
