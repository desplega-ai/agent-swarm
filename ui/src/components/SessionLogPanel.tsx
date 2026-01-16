import { useMemo, useRef, useState, useCallback } from "react";
import Box from "@mui/joy/Box";
import Typography from "@mui/joy/Typography";
import Chip from "@mui/joy/Chip";
import IconButton from "@mui/joy/IconButton";
import Tooltip from "@mui/joy/Tooltip";
import Button from "@mui/joy/Button";
import { useColorScheme } from "@mui/joy/styles";
import { formatRelativeTime } from "../lib/utils";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { generatePreview } from "../lib/contentPreview";
import JsonViewer from "./JsonViewer";
import type { SessionLog } from "../types/api";

interface SessionLogPanelProps {
  sessionLogs: SessionLog[] | undefined;
}

interface FormattedBlock {
  blockType: "text" | "tool" | "thinking" | "tool_result" | "summary" | "json";
  icon: string;
  label?: string;
  content: string;
  fullContent?: string; // Full content for expandable blocks
  isExpandable?: boolean;
  isError?: boolean;
  extraInfo?: string; // Additional info like "+5 more fields"
}

interface FormattedLog {
  type: string;
  color: string;
  blocks: FormattedBlock[];
}

/** Check if content is likely JSON */
const isJsonContent = (content: string): boolean => {
  const trimmed = content.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      return false;
    }
  }
  return false;
};

export default function SessionLogPanel({ sessionLogs }: SessionLogPanelProps) {
  const { mode } = useColorScheme();
  const isDark = mode === "dark";
  const scrollRef = useRef<HTMLDivElement>(null);

  // State for tracking which blocks are expanded
  const [expandedBlocks, setExpandedBlocks] = useState<Set<string>>(new Set());
  const [copiedBlock, setCopiedBlock] = useState<string | null>(null);

  const toggleBlock = useCallback((blockId: string) => {
    setExpandedBlocks(prev => {
      const next = new Set(prev);
      if (next.has(blockId)) {
        next.delete(blockId);
      } else {
        next.add(blockId);
      }
      return next;
    });
  }, []);

  const copyBlock = useCallback(async (content: string, blockId: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedBlock(blockId);
      setTimeout(() => setCopiedBlock(null), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }, []);

  const colors = {
    amber: isDark ? "#F5A623" : "#CC7A00",
    gold: isDark ? "#D4A574" : "#8B6914",
    rust: isDark ? "#A85454" : "#C41E3A",
    blue: isDark ? "#3B82F6" : "#1E40AF",
    purple: isDark ? "#9370DB" : "#6B46C1",
    tertiary: isDark ? "#8B7355" : "#44332B",
    text: {
      primary: isDark ? "inherit" : "#1A1A1A",
      secondary: isDark ? "inherit" : "#2D2D2D",
      tertiary: isDark ? "inherit" : "#4A4A4A",
    },
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
  const { isFollowing, scrollToBottom } = useAutoScroll(scrollRef.current, [sortedLogs.length]);

  /** Truncate string with ellipsis */
  const truncate = (str: string, maxLen: number): string => {
    if (str.length <= maxLen) return str;
    return `${str.slice(0, maxLen - 3)}...`;
  };

  /** Generate a human-readable summary from a JSON object */
  const generateJsonSummary = (obj: Record<string, unknown>, maxLen = 100): string => {
    // Check for common patterns and generate nice summaries
    if ('success' in obj && 'message' in obj) {
      // API response pattern
      const status = obj.success ? '✓' : '✗';
      return `${status} ${truncate(String(obj.message), maxLen - 2)}`;
    }
    if ('yourAgentId' in obj) {
      // Agent swarm response
      const status = obj.success ? '✓' : '✗';
      const msg = obj.message ? String(obj.message) : 'Agent operation';
      return `${status} ${truncate(msg, maxLen - 2)}`;
    }
    if ('oldTodos' in obj || 'todos' in obj) {
      // TodoWrite result
      const count = Array.isArray(obj.todos) ? obj.todos.length : (Array.isArray(obj.oldTodos) ? obj.oldTodos.length : 0);
      return `Todo list updated (${count} items)`;
    }

    // Generic object: list top-level keys
    const keys = Object.keys(obj).slice(0, 4);
    const suffix = Object.keys(obj).length > 4 ? `, +${Object.keys(obj).length - 4} more` : '';
    return `{${keys.join(', ')}${suffix}}`;
  };

  /** Try to unwrap double/triple escaped JSON strings */
  const unwrapEscapedJson = (content: string): string => {
    let current = content;
    let iterations = 0;
    const maxIterations = 3; // Prevent infinite loops

    while (iterations < maxIterations) {
      iterations++;
      if (typeof current === 'string') {
        const trimmed = current.trim();
        // Check if it's a JSON string that was escaped (starts and ends with quotes)
        if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
          try {
            const unescaped = JSON.parse(trimmed);
            if (typeof unescaped === 'string') {
              current = unescaped;
              continue;
            }
          } catch {
            break;
          }
        }
        // Try parsing as JSON object/array to validate
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            JSON.parse(trimmed);
            return current; // It's valid JSON, return as-is
          } catch {
            break;
          }
        }
      }
      break;
    }
    return current;
  };

  /** Try to parse and extract meaningful content from tool result */
  const parseToolResultContent = (content: string): { display: string; fullContent: string; isJson: boolean; summary?: string } => {
    // First, try to unwrap any escaped JSON
    const unwrapped = unwrapEscapedJson(content);

    try {
      const parsed = JSON.parse(unwrapped);

      // Handle Bash tool results: {"stdout":"...","stderr":"...","interrupted":...}
      if (typeof parsed === 'object' && parsed !== null) {
        if ('stdout' in parsed || 'stderr' in parsed) {
          const stdout = parsed.stdout as string || '';
          const stderr = parsed.stderr as string || '';
          const interrupted = parsed.interrupted as boolean;

          // Try to parse stdout as JSON (may be double-encoded)
          let displayStdout = stdout;
          let innerParsed: Record<string, unknown> | null = null;
          try {
            const unwrappedStdout = unwrapEscapedJson(stdout);
            innerParsed = JSON.parse(unwrappedStdout);
            displayStdout = JSON.stringify(innerParsed, null, 2);
          } catch {
            // stdout is not JSON, keep as-is
          }

          let display = '';
          if (displayStdout) {
            display = displayStdout;
          }
          if (stderr) {
            display += (display ? '\n\nSTDERR:\n' : '') + stderr;
          }
          if (interrupted) {
            display += (display ? '\n' : '') + '[interrupted]';
          }

          // Generate summary for JSON stdout
          const summary = innerParsed
            ? generateJsonSummary(innerParsed)
            : (stdout ? truncate(stdout.replace(/\n/g, ' '), 100) : '(empty output)');

          return {
            display: display || '(empty output)',
            fullContent: display || content,
            isJson: isJsonContent(displayStdout),
            summary,
          };
        }

        // For other JSON objects, create summary and pretty-print
        const summary = generateJsonSummary(parsed);
        return {
          display: JSON.stringify(parsed, null, 2),
          fullContent: JSON.stringify(parsed, null, 2),
          isJson: true,
          summary,
        };
      }

      return { display: unwrapped, fullContent: unwrapped, isJson: false };
    } catch {
      // Not valid JSON even after unwrapping
      return { display: unwrapped, fullContent: unwrapped, isJson: false };
    }
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
    // Try to unwrap potentially double-encoded JSON
    let actualContent = content;
    try {
      const parsed = JSON.parse(content);
      // If the parsed content is a string that looks like JSON, try parsing it again
      if (typeof parsed === 'string' && (parsed.trim().startsWith('{') || parsed.trim().startsWith('['))) {
        try {
          JSON.parse(parsed); // Validate it's valid JSON
          // Successfully unwrapped double-encoded JSON
          actualContent = parsed;
        } catch {
          // Not double-encoded, continue with original
        }
      }
    } catch {
      // Original content is not JSON, continue
    }

    try {
      const json = JSON.parse(actualContent);

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
              blocks: [{
                blockType: "json",
                icon: "◆",
                content: "Unrecognized message format",
                fullContent: JSON.stringify(json, null, 2),
                isExpandable: true,
              }],
            };
          }

          const contentBlocks = message.content as Array<Record<string, unknown>>;
          if (!contentBlocks) {
            return {
              type: "assistant",
              color: colors.gold,
              blocks: [{
                blockType: "json",
                icon: "◆",
                content: "Unrecognized message format",
                fullContent: JSON.stringify(json, null, 2),
                isExpandable: true,
              }],
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
              const formattedInput = formatToolInput(input);
              const fullInput = JSON.stringify(input, null, 2);
              const hasMultipleParams = Object.keys(input).length > 0;

              blocks.push({
                blockType: "tool",
                icon: "▶",
                label: toolName,
                content: formattedInput,
                fullContent: fullInput,
                isExpandable: hasMultipleParams,
              });
            } else if (block.type === "thinking") {
              const thinkingText = (block.thinking as string) || "Thinking...";
              const preview = generatePreview(thinkingText, 200);

              blocks.push({
                blockType: "thinking",
                icon: "💭",
                content: preview.preview,
                fullContent: thinkingText,
                isExpandable: preview.isTruncated,
                extraInfo: preview.extraInfo,
              });
            }
          }

          return {
            type: "assistant",
            color: colors.gold,
            blocks: blocks.length > 0 ? blocks : [{
              blockType: "json",
              icon: "◆",
              content: "Unrecognized message format",
              fullContent: JSON.stringify(json, null, 2),
              isExpandable: true,
            }],
          };
        }

        case "user": {
          const message = json.message as Record<string, unknown>;
          const blocks: FormattedBlock[] = [];

          const rawToolResult = json.tool_use_result;
          if (rawToolResult) {
            const toolResult = typeof rawToolResult === "string" ? rawToolResult : JSON.stringify(rawToolResult);
            const parsed = parseToolResultContent(toolResult);
            const isError = toolResult.includes("Error") || toolResult.includes("error");
            // Use summary if available, otherwise truncate the display
            const displayContent = parsed.summary || truncate(parsed.display, 300);

            blocks.push({
              blockType: "tool_result",
              icon: isError ? "✗" : "✓",
              content: displayContent,
              fullContent: parsed.fullContent,
              isExpandable: parsed.isJson || parsed.display.length > 100,
              isError,
            });
          } else if (message) {
            const contentBlocks = message.content as Array<Record<string, unknown>>;
            if (contentBlocks) {
              for (const block of contentBlocks) {
                if (block.type === "tool_result") {
                  const rawResult = block.content;
                  const result = typeof rawResult === "string" ? rawResult : rawResult ? JSON.stringify(rawResult) : "";
                  const parsed = parseToolResultContent(result);
                  const isError = block.is_error as boolean;
                  // Use summary if available, otherwise truncate the display
                  const displayContent = parsed.summary || truncate(parsed.display, 300);

                  blocks.push({
                    blockType: "tool_result",
                    icon: isError ? "✗" : "✓",
                    content: displayContent,
                    fullContent: parsed.fullContent,
                    isExpandable: parsed.isJson || parsed.display.length > 100,
                    isError,
                  });
                }
              }
            }
          }

          return {
            type: "tool_result",
            color: colors.purple,
            blocks: blocks.length > 0 ? blocks : [{
              blockType: "json",
              icon: "←",
              content: "Unrecognized tool result format",
              fullContent: JSON.stringify(json, null, 2),
              isExpandable: true,
            }],
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
            blocks: [{
              blockType: "json",
              icon: "?",
              content: "Unknown message type",
              fullContent: JSON.stringify(json, null, 2),
              isExpandable: true,
            }],
          };
      }
    } catch {
      // Check if content might still be parseable JSON that failed for other reasons
      if (isJsonContent(actualContent)) {
        try {
          const parsedData = JSON.parse(actualContent);
          // Generate a nice summary instead of just "JSON data"
          const summary = generateJsonSummary(parsedData);
          return {
            type: "data",
            color: colors.tertiary,
            blocks: [{
              blockType: "json",
              icon: "◇",
              content: summary,
              fullContent: JSON.stringify(parsedData, null, 2),
              isExpandable: true,
            }],
          };
        } catch {
          // Fall through to partial JSON handling
        }
      }

      // For non-JSON content, check if it looks like truncated/partial JSON
      const trimmed = actualContent.trim();
      const looksLikeJson = trimmed.includes('"') && (
        trimmed.includes(':') ||
        trimmed.includes('{') ||
        trimmed.includes('[')
      );

      if (looksLikeJson) {
        // Try to extract something meaningful from partial JSON
        // Look for common patterns like tool results or messages
        let summary = truncate(actualContent, 100);

        // Try to find and extract key information
        const toolResultMatch = actualContent.match(/"tool_use_id":\s*"([^"]+)"/);
        const messageMatch = actualContent.match(/"message":\s*"([^"]{0,50})/);
        const successMatch = actualContent.match(/"success":\s*(true|false)/);
        const yourAgentMatch = actualContent.match(/"yourAgentId":\s*"([^"]+)"/);

        if (yourAgentMatch && successMatch) {
          const status = successMatch[1] === 'true' ? '✓' : '✗';
          summary = `${status} Agent response (${yourAgentMatch[1].slice(0, 8)}...)`;
        } else if (toolResultMatch) {
          summary = `Tool result for ${toolResultMatch[1].slice(0, 20)}...`;
        } else if (messageMatch) {
          summary = `Message: ${messageMatch[1]}...`;
        }

        return {
          type: "log",
          color: colors.tertiary,
          blocks: [{
            blockType: "json",
            icon: "◇",
            content: summary,
            fullContent: actualContent,
            isExpandable: true,
          }],
        };
      }

      // Regular text content
      return {
        type: "log",
        color: colors.tertiary,
        blocks: [{
          blockType: "text",
          icon: "•",
          content: actualContent.length > 500 ? actualContent.slice(0, 500) + "..." : actualContent,
          fullContent: actualContent.length > 500 ? actualContent : undefined,
          isExpandable: actualContent.length > 500,
        }],
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
            ? (isDark ? "rgba(168, 84, 84, 0.15)" : "rgba(181, 66, 66, 0.12)")
            : (isDark ? "rgba(76, 175, 80, 0.1)" : "rgba(56, 142, 60, 0.08)"),
          borderLeft: block.isError ? `3px solid ${colors.rust}` : `2px solid ${colors.amber}`,
          pl: 1,
        };
      case "summary":
        return {
          fontWeight: 600,
          color: block.isError ? colors.rust : colors.amber,
        };
      case "json":
        return {
          bgcolor: isDark ? "rgba(100, 100, 100, 0.1)" : "rgba(150, 150, 150, 0.08)",
          borderLeft: `2px solid ${colors.tertiary}`,
          pl: 1,
        };
      default:
        return {
          color: typeColor,
        };
    }
  };

  if (!sessionLogs || sessionLogs.length === 0) {
    return (
      <Box sx={{
        p: 3,
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}>
        <Box sx={{
          textAlign: "center",
          p: 4,
          bgcolor: isDark ? "rgba(100, 100, 100, 0.08)" : "rgba(150, 150, 150, 0.06)",
          borderRadius: 2,
          border: "1px dashed",
          borderColor: isDark ? "rgba(100, 100, 100, 0.2)" : "rgba(150, 150, 150, 0.2)",
        }}>
          <Typography sx={{
            fontFamily: "code",
            fontSize: "0.8rem",
            color: colors.text.tertiary,
            mb: 0.5,
          }}>
            No session logs yet
          </Typography>
          <Typography sx={{
            fontFamily: "code",
            fontSize: "0.7rem",
            color: colors.text.tertiary,
            opacity: 0.7,
          }}>
            Logs will appear here when the task starts running
          </Typography>
        </Box>
      </Box>
    );
  }

  return (
    <Box sx={{ position: "relative", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* Follow button - shown when user scrolls up */}
      {!isFollowing && (
        <Box
          sx={{
            position: "absolute",
            bottom: 16,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 10,
          }}
        >
          <Button
            variant="solid"
            size="sm"
            onClick={scrollToBottom}
            sx={{
              fontFamily: "code",
              fontSize: "0.7rem",
              fontWeight: 600,
              letterSpacing: "0.03em",
              // Fully opaque solid background
              bgcolor: isDark ? "#1e4068" : "#2563eb",
              color: "#ffffff",
              border: "2px solid",
              borderColor: isDark ? "#3b82f6" : "#1e40af",
              boxShadow: isDark
                ? "0 4px 16px rgba(0, 0, 0, 0.8), 0 2px 4px rgba(0, 0, 0, 0.4)"
                : "0 4px 16px rgba(0, 0, 0, 0.35), 0 2px 4px rgba(0, 0, 0, 0.2)",
              "&:hover": {
                bgcolor: isDark ? "#2563eb" : "#1d4ed8",
                borderColor: isDark ? "#60a5fa" : "#1e3a8a",
              },
              gap: 0.5,
              px: 2,
              py: 0.75,
            }}
          >
            <span style={{ fontSize: "0.8rem" }}>↓</span>
            Follow
          </Button>
        </Box>
      )}

      <Box
        ref={scrollRef}
        sx={{
          flex: 1,
          overflow: "auto",
          p: 1.5,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {sortedLogs.map((log) => {
            const formatted = formatLogLine(log.content);
            return (
              <Box
                key={log.id}
                sx={{
                  bgcolor: isDark ? "rgba(30, 30, 35, 0.6)" : "rgba(255, 255, 255, 0.8)",
                  p: 1.5,
                  borderRadius: 1,
                  border: "1px solid",
                  borderColor: isDark ? "rgba(100, 100, 100, 0.15)" : "rgba(200, 200, 200, 0.3)",
                  transition: "border-color 0.15s ease",
                  "&:hover": {
                    borderColor: isDark ? "rgba(100, 100, 100, 0.25)" : "rgba(180, 180, 180, 0.4)",
                  },
                }}
              >
                <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.75 }}>
                  <Chip
                    size="sm"
                    variant="soft"
                    sx={{
                      fontFamily: "code",
                      fontSize: "0.6rem",
                      fontWeight: 600,
                      color: formatted.color,
                      bgcolor: isDark ? "rgba(100, 100, 100, 0.12)" : "rgba(150, 150, 150, 0.1)",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      height: 18,
                      minHeight: 18,
                    }}
                  >
                    {formatted.type}
                  </Chip>
                  <Tooltip title={new Date(log.createdAt).toLocaleString()} placement="top">
                    <Typography sx={{
                      fontFamily: "code",
                      fontSize: "0.65rem",
                      color: colors.text.tertiary,
                      opacity: 0.8,
                    }}>
                      {formatRelativeTime(log.createdAt)}
                    </Typography>
                  </Tooltip>
                </Box>
              <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
                {formatted.blocks.map((block, idx) => {
                  const blockId = `${log.id}-${block.blockType}-${idx}`;
                  const isExpanded = expandedBlocks.has(blockId);
                  const isCopied = copiedBlock === blockId;

                  return (
                    <Box
                      key={idx}
                      sx={{
                        display: "flex",
                        flexDirection: "column",
                        fontFamily: "code",
                        fontSize: "0.75rem",
                        borderRadius: 0.5,
                        py: 0.5,
                        ...getBlockStyles(block, formatted.color),
                      }}
                    >
                      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.5 }}>
                        {block.icon && (
                          <Typography
                            component="span"
                            sx={{
                              mr: 0.5,
                              fontFamily: "code",
                              fontSize: block.isError ? "0.8rem" : "0.75rem",
                              color: block.isError ? colors.rust : formatted.color,
                              flexShrink: 0,
                            }}
                          >
                            {block.icon}
                          </Typography>
                        )}

                        {block.blockType === "tool" ? (
                          <Box sx={{ flex: 1 }}>
                            <Box sx={{ display: "flex", alignItems: "baseline", gap: 0.5, flexWrap: "wrap" }}>
                              <Typography
                                component="span"
                                sx={{
                                  fontFamily: "code",
                                  fontSize: "0.75rem",
                                  color: colors.purple,
                                  fontWeight: 600,
                                }}
                              >
                                {block.label}
                              </Typography>
                              {!isExpanded && block.content && (
                                <Typography
                                  component="span"
                                  sx={{
                                    fontFamily: "code",
                                    fontSize: "0.7rem",
                                    color: colors.text.tertiary,
                                  }}
                                >
                                  {block.content}
                                </Typography>
                              )}
                              {block.isExpandable && (
                                <IconButton
                                  size="sm"
                                  variant="plain"
                                  onClick={() => toggleBlock(blockId)}
                                  sx={{
                                    fontSize: "0.65rem",
                                    minWidth: "auto",
                                    minHeight: "auto",
                                    ml: 0.5,
                                    color: colors.purple,
                                  }}
                                >
                                  {isExpanded ? "▼" : "▶"}
                                </IconButton>
                              )}
                            </Box>
                            {isExpanded && block.fullContent && (
                              <Box sx={{ mt: 1, mx: 0 }}>
                                <JsonViewer content={block.fullContent} maxHeight="300px" />
                              </Box>
                            )}
                          </Box>
                        ) : block.blockType === "json" ? (
                          <Box sx={{ flex: 1 }}>
                            <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                              <Typography
                                component="span"
                                sx={{
                                  fontFamily: "code",
                                  fontSize: "0.75rem",
                                  color: colors.text.tertiary,
                                  fontStyle: "italic",
                                }}
                              >
                                {block.content}
                              </Typography>
                              <IconButton
                                size="sm"
                                variant="plain"
                                onClick={() => toggleBlock(blockId)}
                                sx={{
                                  fontSize: "0.65rem",
                                  minWidth: "auto",
                                  minHeight: "auto",
                                  color: "text.tertiary",
                                }}
                              >
                                {isExpanded ? "▼" : "▶"}
                              </IconButton>
                            </Box>
                            {isExpanded && block.fullContent && (
                              <Box sx={{ mt: 1, mx: 0 }}>
                                <JsonViewer content={block.fullContent} maxHeight="400px" />
                              </Box>
                            )}
                          </Box>
                        ) : block.blockType === "tool_result" ? (
                          <Box sx={{ flex: 1 }}>
                            <Box sx={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 1 }}>
                              {!isExpanded ? (
                                <Typography
                                  component="div"
                                  sx={{
                                    fontFamily: "code",
                                    fontSize: block.isError ? "0.8rem" : "0.75rem",
                                    color: block.isError ? colors.rust : colors.text.secondary,
                                    whiteSpace: "pre-wrap",
                                    wordBreak: "break-word",
                                    flex: 1,
                                  }}
                                >
                                  {block.content}
                                  {block.isExpandable && block.extraInfo && (
                                    <Typography
                                      component="span"
                                      sx={{
                                        fontFamily: "code",
                                        fontSize: "0.65rem",
                                        color: colors.text.tertiary,
                                        fontStyle: "italic",
                                        ml: 0.5,
                                      }}
                                    >
                                      {` (${block.extraInfo})`}
                                    </Typography>
                                  )}
                                </Typography>
                              ) : (
                                <Box sx={{ flex: 1 }} />
                              )}
                              <Box sx={{ display: "flex", gap: 0.25, flexShrink: 0 }}>
                                {block.isExpandable && (
                                  <Tooltip title={isExpanded ? "Collapse" : "Expand"} placement="top">
                                    <IconButton
                                      size="sm"
                                      variant="plain"
                                      onClick={() => toggleBlock(blockId)}
                                      sx={{
                                        fontSize: "0.65rem",
                                        minWidth: "auto",
                                        minHeight: "auto",
                                        color: "text.tertiary",
                                        "&:hover": { color: "text.primary" },
                                      }}
                                    >
                                      {isExpanded ? "▼" : "▶"}
                                    </IconButton>
                                  </Tooltip>
                                )}
                                {(block.fullContent || block.content) && (
                                  <Tooltip title={isCopied ? "Copied!" : "Copy"} placement="top">
                                    <IconButton
                                      size="sm"
                                      variant="plain"
                                      onClick={() => copyBlock(block.fullContent || block.content, blockId)}
                                      sx={{
                                        fontSize: "0.65rem",
                                        minWidth: "auto",
                                        minHeight: "auto",
                                        color: isCopied ? colors.amber : "text.tertiary",
                                        "&:hover": { color: "text.primary" },
                                      }}
                                    >
                                      {isCopied ? "✓" : "⧉"}
                                    </IconButton>
                                  </Tooltip>
                                )}
                              </Box>
                            </Box>
                            {isExpanded && block.fullContent && (
                              <Box sx={{ mt: 1, mx: 0 }}>
                                {isJsonContent(block.fullContent) ? (
                                  <JsonViewer content={block.fullContent} maxHeight="400px" />
                                ) : (
                                  <Typography
                                    component="div"
                                    sx={{
                                      fontFamily: "code",
                                      fontSize: "0.75rem",
                                      color: block.isError ? colors.rust : colors.text.secondary,
                                      whiteSpace: "pre-wrap",
                                      wordBreak: "break-word",
                                      p: 1,
                                      bgcolor: isDark ? "rgba(30, 30, 30, 0.5)" : "rgba(250, 250, 250, 0.95)",
                                      border: "1px solid",
                                      borderColor: isDark ? "rgba(100, 100, 100, 0.3)" : "rgba(120, 120, 120, 0.5)",
                                      borderRadius: 1,
                                    }}
                                  >
                                    {block.fullContent}
                                  </Typography>
                                )}
                              </Box>
                            )}
                          </Box>
                        ) : (
                          <Box sx={{ flex: 1 }}>
                            <Box sx={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 1 }}>
                              <Typography
                                component="div"
                                sx={{
                                  fontFamily: "code",
                                  fontSize: block.isError ? "0.8rem" : "0.75rem",
                                  color: block.isError ? colors.rust : (block.blockType === "thinking" ? colors.text.tertiary : colors.text.secondary),
                                  whiteSpace: "pre-wrap",
                                  wordBreak: "break-word",
                                  flex: 1,
                                }}
                              >
                                {isExpanded && block.fullContent ? block.fullContent : block.content}
                                {block.isExpandable && !isExpanded && block.extraInfo && (
                                  <Typography
                                    component="span"
                                    sx={{
                                      fontFamily: "code",
                                      fontSize: "0.65rem",
                                      color: colors.text.tertiary,
                                      fontStyle: "italic",
                                      ml: 0.5,
                                    }}
                                  >
                                    {` (${block.extraInfo})`}
                                  </Typography>
                                )}
                              </Typography>
                              <Box sx={{ display: "flex", gap: 0.25, flexShrink: 0 }}>
                                {block.isExpandable && (
                                  <Tooltip title={isExpanded ? "Collapse" : "Expand"} placement="top">
                                    <IconButton
                                      size="sm"
                                      variant="plain"
                                      onClick={() => toggleBlock(blockId)}
                                      sx={{
                                        fontSize: "0.65rem",
                                        minWidth: "auto",
                                        minHeight: "auto",
                                        color: "text.tertiary",
                                        "&:hover": { color: "text.primary" },
                                      }}
                                    >
                                      {isExpanded ? "▼" : "▶"}
                                    </IconButton>
                                  </Tooltip>
                                )}
                                {(block.fullContent || block.content) && (
                                  <Tooltip title={isCopied ? "Copied!" : "Copy"} placement="top">
                                    <IconButton
                                      size="sm"
                                      variant="plain"
                                      onClick={() => copyBlock(block.fullContent || block.content, blockId)}
                                      sx={{
                                        fontSize: "0.65rem",
                                        minWidth: "auto",
                                        minHeight: "auto",
                                        color: isCopied ? colors.amber : "text.tertiary",
                                        "&:hover": { color: "text.primary" },
                                      }}
                                    >
                                      {isCopied ? "✓" : "⧉"}
                                    </IconButton>
                                  </Tooltip>
                                )}
                              </Box>
                            </Box>
                          </Box>
                        )}
                      </Box>
                    </Box>
                  );
                })}
              </Box>
            </Box>
          );
        })}
        </Box>
      </Box>
    </Box>
  );
}
