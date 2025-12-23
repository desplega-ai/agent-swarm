import { useMemo, useRef } from "react";
import Box from "@mui/joy/Box";
import Typography from "@mui/joy/Typography";
import Chip from "@mui/joy/Chip";
import { useColorScheme } from "@mui/joy/styles";
import { formatRelativeTime } from "../lib/utils";
import { useAutoScroll } from "../hooks/useAutoScroll";
import type { SessionLog } from "../types/api";

interface SessionLogPanelProps {
  sessionLogs: SessionLog[] | undefined;
}

interface FormattedBlock {
  blockType: "text" | "tool" | "thinking" | "tool_result" | "summary";
  icon: string;
  label?: string;
  content: string;
  isError?: boolean;
}

interface FormattedLog {
  type: string;
  color: string;
  blocks: FormattedBlock[];
}

export default function SessionLogPanel({ sessionLogs }: SessionLogPanelProps) {
  const { mode } = useColorScheme();
  const isDark = mode === "dark";
  const scrollRef = useRef<HTMLDivElement>(null);

  const colors = {
    amber: isDark ? "#F5A623" : "#D48806",
    gold: isDark ? "#D4A574" : "#8B6914",
    rust: isDark ? "#A85454" : "#B54242",
    blue: "#3B82F6",
    purple: isDark ? "#9370DB" : "#6B5B95",
    tertiary: isDark ? "#8B7355" : "#6B5344",
  };

  // Sort logs by createdAt ascending (oldest first), then by lineNumber
  const sortedLogs = useMemo(() => sessionLogs
    ? [...sessionLogs].sort((a, b) => {
      const timeCompare = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      if (timeCompare !== 0) return timeCompare;
      return a.lineNumber - b.lineNumber;
    })
    : [], [sessionLogs]);

  // Auto-scroll when new logs arrive (respects user scroll position)
  useAutoScroll(scrollRef.current, [sortedLogs.length]);

  /** Truncate string with ellipsis */
  const truncate = (str: string, maxLen: number): string => {
    if (str.length <= maxLen) return str;
    return `${str.slice(0, maxLen - 3)}...`;
  };

  /** Format a tool name nicely - shorten MCP tool names */
  const formatToolName = (name: string): string => {
    if (name.startsWith("mcp__")) {
      const parts = name.split("__");
      return parts.length >= 3 ? `${parts[1]}:${parts[2]}` : name;
    }
    return name;
  };

  /** Format input parameters for tool calls */
  const formatToolInput = (input: Record<string, unknown>): string => {
    const entries = Object.entries(input);
    if (entries.length === 0) return "";

    const formatted = entries
      .slice(0, 3)
      .map(([k, v]) => {
        const value = typeof v === "string" ? truncate(v, 40) : truncate(JSON.stringify(v), 40);
        return `${k}=${value}`;
      })
      .join(", ");

    const suffix = entries.length > 3 ? `, +${entries.length - 3} more` : "";
    return `(${formatted}${suffix})`;
  };

  const formatLogLine = (content: string): FormattedLog => {
    try {
      const json = JSON.parse(content);

      switch (json.type) {
        case "system": {
          const subtype = json.subtype as string;
          let displayContent: string;
          let icon = "ℹ";

          if (subtype === "init") {
            icon = "●";
            displayContent = `Session started (${json.model}, ${json.tools?.length || 0} tools)`;
          } else if (subtype === "hook_response") {
            icon = "⚡";
            const stdout = json.stdout as string;
            displayContent = `Hook: ${json.hook_name}${stdout ? `\n${truncate(stdout, 200)}` : ""}`;
          } else {
            displayContent = json.message || json.content || JSON.stringify(json, null, 2);
          }

          return {
            type: subtype ? `system/${subtype}` : "system",
            color: colors.blue,
            blocks: [{ blockType: "text", icon, content: displayContent }],
          };
        }

        case "assistant": {
          const message = json.message as Record<string, unknown>;
          if (!message) {
            return {
              type: "assistant",
              color: colors.gold,
              blocks: [{ blockType: "text", icon: "◆", content: JSON.stringify(json, null, 2) }],
            };
          }

          const contentBlocks = message.content as Array<Record<string, unknown>>;
          if (!contentBlocks) {
            return {
              type: "assistant",
              color: colors.gold,
              blocks: [{ blockType: "text", icon: "◆", content: JSON.stringify(json, null, 2) }],
            };
          }

          const blocks: FormattedBlock[] = [];

          for (const block of contentBlocks) {
            if (block.type === "text") {
              blocks.push({
                blockType: "text",
                icon: "◆",
                content: block.text as string,
              });
            } else if (block.type === "tool_use") {
              const toolName = formatToolName((block.name as string) || "unknown");
              const input = (block.input as Record<string, unknown>) || {};
              blocks.push({
                blockType: "tool",
                icon: "▶",
                label: toolName,
                content: formatToolInput(input),
              });
            } else if (block.type === "thinking") {
              blocks.push({
                blockType: "thinking",
                icon: "💭",
                content: truncate((block.thinking as string) || "Thinking...", 300),
              });
            }
          }

          return {
            type: "assistant",
            color: colors.gold,
            blocks: blocks.length > 0 ? blocks : [{ blockType: "text", icon: "◆", content: JSON.stringify(json, null, 2) }],
          };
        }

        case "user": {
          const message = json.message as Record<string, unknown>;
          const blocks: FormattedBlock[] = [];

          const rawToolResult = json.tool_use_result;
          if (rawToolResult) {
            const toolResult = typeof rawToolResult === "string" ? rawToolResult : JSON.stringify(rawToolResult);
            const isError = toolResult.includes("Error") || toolResult.includes("error");
            blocks.push({
              blockType: "tool_result",
              icon: isError ? "✗" : "✓",
              content: truncate(toolResult, 500),
              isError,
            });
          } else if (message) {
            const contentBlocks = message.content as Array<Record<string, unknown>>;
            if (contentBlocks) {
              for (const block of contentBlocks) {
                if (block.type === "tool_result") {
                  const rawResult = block.content;
                  const result = typeof rawResult === "string" ? rawResult : rawResult ? JSON.stringify(rawResult) : "";
                  const isError = block.is_error as boolean;
                  blocks.push({
                    blockType: "tool_result",
                    icon: isError ? "✗" : "✓",
                    content: truncate(result, 500),
                    isError,
                  });
                }
              }
            }
          }

          return {
            type: "tool_result",
            color: colors.purple,
            blocks: blocks.length > 0 ? blocks : [{ blockType: "text", icon: "←", content: JSON.stringify(json, null, 2) }],
          };
        }

        case "result": {
          const isError = json.is_error as boolean;
          const duration = json.duration_ms as number;
          const cost = json.total_cost_usd as number;
          const numTurns = json.num_turns as number;
          const result = json.result as string;

          const durationStr = duration ? `${(duration / 1000).toFixed(1)}s` : "";
          const costStr = cost ? `$${cost.toFixed(4)}` : "";
          const summary = `Done (${json.subtype}, ${numTurns} turns, ${durationStr}, ${costStr})`;

          const blocks: FormattedBlock[] = [
            {
              blockType: "summary",
              icon: isError ? "✗" : "✓",
              content: summary,
              isError,
            },
          ];

          if (result) {
            blocks.push({
              blockType: "text",
              icon: "",
              content: truncate(result, 500),
            });
          }

          return {
            type: "result",
            color: isError ? colors.rust : colors.amber,
            blocks,
          };
        }

        case "error": {
          const error = (json.error as string) || (json.message as string) || JSON.stringify(json);
          return {
            type: "error",
            color: colors.rust,
            blocks: [{ blockType: "text", icon: "✗", content: error, isError: true }],
          };
        }

        default:
          return {
            type: json.type || "unknown",
            color: colors.tertiary,
            blocks: [{ blockType: "text", icon: "?", content: JSON.stringify(json, null, 2) }],
          };
      }
    } catch {
      return {
        type: "raw",
        color: colors.tertiary,
        blocks: [{ blockType: "text", icon: "", content }],
      };
    }
  };

  const getBlockStyles = (block: FormattedBlock, typeColor: string) => {
    switch (block.blockType) {
      case "tool":
        return {
          bgcolor: isDark ? "rgba(147, 112, 219, 0.1)" : "rgba(107, 91, 149, 0.08)",
          borderLeft: `2px solid ${colors.purple}`,
          pl: 1,
        };
      case "thinking":
        return {
          bgcolor: isDark ? "rgba(59, 130, 246, 0.1)" : "rgba(59, 130, 246, 0.08)",
          borderLeft: `2px solid ${colors.blue}`,
          pl: 1,
          fontStyle: "italic",
          opacity: 0.8,
        };
      case "tool_result":
        return {
          bgcolor: block.isError
            ? (isDark ? "rgba(168, 84, 84, 0.1)" : "rgba(181, 66, 66, 0.08)")
            : (isDark ? "rgba(76, 175, 80, 0.1)" : "rgba(56, 142, 60, 0.08)"),
          borderLeft: `2px solid ${block.isError ? colors.rust : colors.amber}`,
          pl: 1,
        };
      case "summary":
        return {
          fontWeight: 600,
          color: block.isError ? colors.rust : colors.amber,
        };
      default:
        return {
          color: typeColor,
        };
    }
  };

  if (!sessionLogs || sessionLogs.length === 0) {
    return (
      <Box sx={{ p: 2, height: "100%", overflow: "auto" }}>
        <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
          No session logs available
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      ref={scrollRef}
      sx={{
        flex: 1,
        overflow: "auto",
        p: 2,
        height: "100%",
      }}
    >
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {sortedLogs.map((log) => {
          const formatted = formatLogLine(log.content);
          return (
            <Box
              key={log.id}
              sx={{
                bgcolor: "background.level1",
                p: 1.5,
                borderRadius: 1,
                border: "1px solid",
                borderColor: "neutral.outlinedBorder",
              }}
            >
              <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.75 }}>
                <Chip
                  size="sm"
                  variant="soft"
                  sx={{
                    fontFamily: "code",
                    fontSize: "0.6rem",
                    color: formatted.color,
                    bgcolor: isDark ? "rgba(100, 100, 100, 0.15)" : "rgba(150, 150, 150, 0.12)",
                    textTransform: "uppercase",
                  }}
                >
                  {formatted.type}
                </Chip>
                <Typography sx={{ fontFamily: "code", fontSize: "0.6rem", color: "text.tertiary" }}>
                  {formatRelativeTime(log.createdAt)}
                </Typography>
              </Box>
              <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
                {formatted.blocks.map((block, idx) => (
                  <Box
                    key={idx}
                    sx={{
                      display: "flex",
                      alignItems: "flex-start",
                      fontFamily: "code",
                      fontSize: "0.7rem",
                      borderRadius: 0.5,
                      py: 0.5,
                      ...getBlockStyles(block, formatted.color),
                    }}
                  >
                    {block.icon && (
                      <Typography
                        component="span"
                        sx={{
                          mr: 0.75,
                          fontFamily: "code",
                          fontSize: "0.7rem",
                          color: block.isError ? colors.rust : formatted.color,
                          flexShrink: 0,
                        }}
                      >
                        {block.icon}
                      </Typography>
                    )}
                    {block.blockType === "tool" ? (
                      <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "baseline" }}>
                        <Typography
                          component="span"
                          sx={{
                            fontFamily: "code",
                            fontSize: "0.7rem",
                            color: colors.purple,
                            fontWeight: 600,
                          }}
                        >
                          {block.label}
                        </Typography>
                        {block.content && (
                          <Typography
                            component="span"
                            sx={{
                              fontFamily: "code",
                              fontSize: "0.65rem",
                              color: "text.tertiary",
                              ml: 0.5,
                            }}
                          >
                            {block.content}
                          </Typography>
                        )}
                      </Box>
                    ) : (
                      <Typography
                        component="span"
                        sx={{
                          fontFamily: "code",
                          fontSize: "0.7rem",
                          color: block.isError ? colors.rust : (block.blockType === "thinking" ? "text.tertiary" : "text.secondary"),
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                        }}
                      >
                        {block.content}
                      </Typography>
                    )}
                  </Box>
                ))}
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
