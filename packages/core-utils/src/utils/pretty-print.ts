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
      case "session_init": {
        const provider = json.provider as string;
        const variant = json.harnessVariant as string;
        const meta = json.harnessVariantMeta as Record<string, unknown> | undefined;
        const version = meta?.version ?? "";
        console.log(
          `${prefix} ${c.cyan}●${c.reset} ${c.bold}Session started${c.reset} ${c.dim}(${provider}${variant ? ` ${variant}` : ""}${version ? ` v${version}` : ""})${c.reset}`,
        );
        break;
      }

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
            console.log(`${prefix} ${c.green}◆${c.reset} ${c.bold}Assistant:${c.reset}`);
            // Print text with nice indentation, truncate long lines
            const lines = text.split("\n");
            for (const l of lines.slice(0, 5)) {
              console.log(`${prefix}    ${truncate(l, 100)}`);
            }
            if (lines.length > 5) {
              console.log(`${prefix}    ${c.dim}... (${lines.length - 5} more lines)${c.reset}`);
            }
          } else if (block.type === "tool_use") {
            const toolName = formatToolName((block.name as string) || "unknown");
            const input = (block.input as Record<string, unknown>) || {};
            console.log(
              `${prefix} ${c.magenta}▶${c.reset} Tool: ${c.magenta}${toolName}${c.reset}${formatToolInput(input)}`,
            );
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
          const icon = isError ? `${c.red}✗${c.reset}` : `${c.green}✓${c.reset}`;
          console.log(`${prefix} ${icon} Result: ${truncate(toolResult, 100)}`);
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
                const icon = isError ? `${c.red}✗${c.reset}` : `${c.green}✓${c.reset}`;
                console.log(`${prefix} ${icon} Result: ${truncate(result, 100)}`);
              }
            }
          }
        }
        break;
      }

      case "result": {
        // Claude CLI emits flat fields (subtype, num_turns, duration_ms, total_cost_usd).
        // Non-Claude adapters (opencode, pi) emit a nested `cost` object with
        // CostData fields. Handle both formats gracefully.
        const costObj = json.cost as Record<string, unknown> | undefined;
        const subtype = (json.subtype as string) ?? (json.isError ? "error" : "success");
        const isError = (json.is_error as boolean) ?? (json.isError as boolean) ?? false;
        const duration = (json.duration_ms as number) ?? (costObj?.durationMs as number);
        const costUsd = (json.total_cost_usd as number) ?? (costObj?.totalCostUsd as number);
        const numTurns = (json.num_turns as number) ?? (costObj?.numTurns as number | null);
        const result = (json.result as string) ?? (json.output as string);

        const icon = isError ? `${c.red}✗${c.reset}` : `${c.green}✓${c.reset}`;
        const durationStr = duration ? `${(duration / 1000).toFixed(1)}s` : "";
        const costStr = costUsd ? `$${costUsd.toFixed(4)}` : "";
        const turnsStr = numTurns != null ? `${numTurns} turns` : "";

        const details = [subtype, turnsStr, durationStr, costStr].filter(Boolean).join(", ");
        console.log(`${prefix} ${icon} ${c.bold}Done${c.reset} ${c.dim}(${details})${c.reset}`);

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
