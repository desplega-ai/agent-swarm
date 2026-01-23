import Box from "@mui/joy/Box";
import Card from "@mui/joy/Card";
import Drawer from "@mui/joy/Drawer";
import IconButton from "@mui/joy/IconButton";
import Link from "@mui/joy/Link";
import { useColorScheme } from "@mui/joy/styles";
import Textarea from "@mui/joy/Textarea";
import Tooltip from "@mui/joy/Tooltip";
import Typography from "@mui/joy/Typography";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatSmartTime } from "@/lib/utils";
import {
  useAgents,
  useChannels,
  useInfiniteMessages,
  usePostMessage,
  useThreadMessages,
} from "../hooks/queries";
import type { Agent, ChannelMessage } from "../types/api";

interface MentionInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onMentionsChange?: (mentions: string[]) => void;
  placeholder: string;
  agents: Agent[];
  inputStyles: object;
  sendButtonStyles: object;
  sendLabel: string;
  disabled?: boolean;
  colors: Record<string, string>;
  isDark: boolean;
}

const MentionInput = React.memo(function MentionInput({
  value,
  onChange,
  onSend,
  onMentionsChange,
  placeholder,
  agents,
  inputStyles,
  sendButtonStyles,
  sendLabel,
  disabled,
  colors,
  isDark,
}: MentionInputProps) {
  const [showMentionPopup, setShowMentionPopup] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionStartPos, setMentionStartPos] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mentions, setMentions] = useState<string[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  // Filter agents based on query
  const filteredAgents = useMemo(() => {
    if (!mentionQuery) return agents;
    const query = mentionQuery.toLowerCase();
    return agents.filter(
      (agent) =>
        agent.name.toLowerCase().includes(query) ||
        (agent.role && agent.role.toLowerCase().includes(query)),
    );
  }, [agents, mentionQuery]);

  // Reset selected index when filtered list changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredAgents.length]);

  // Notify parent of mention changes
  useEffect(() => {
    if (onMentionsChange) {
      onMentionsChange(mentions);
    }
  }, [mentions, onMentionsChange]);

  // Reset mentions when input is cleared
  useEffect(() => {
    if (!value) {
      setMentions([]);
    }
  }, [value]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    const cursorPos = e.target.selectionStart || 0;
    onChange(newValue);

    // Check if we should show mention popup
    // Find the last @ before cursor that isn't followed by a space
    const textBeforeCursor = newValue.slice(0, cursorPos);
    const lastAtIndex = textBeforeCursor.lastIndexOf("@");

    if (lastAtIndex >= 0) {
      const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1);
      // Show popup if @ is at start or preceded by space, and no space after @
      const charBeforeAt = lastAtIndex > 0 ? newValue[lastAtIndex - 1] : " ";
      if ((charBeforeAt === " " || lastAtIndex === 0) && !textAfterAt.includes(" ")) {
        setShowMentionPopup(true);
        setMentionQuery(textAfterAt);
        setMentionStartPos(lastAtIndex);
        return;
      }
    }

    setShowMentionPopup(false);
    setMentionQuery("");
  };

  const handleSelectAgent = (agent: Agent) => {
    // Replace @query with @agentName
    const beforeMention = value.slice(0, mentionStartPos);
    const afterMention = value.slice(mentionStartPos + 1 + mentionQuery.length);
    const newValue = `${beforeMention}@${agent.name} ${afterMention}`;

    onChange(newValue);
    setMentions((prev) => [...new Set([...prev, agent.id])]);
    setShowMentionPopup(false);
    setMentionQuery("");

    // Focus input
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showMentionPopup && filteredAgents.length > 0) {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % filteredAgents.length);
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + filteredAgents.length) % filteredAgents.length);
          break;
        case "Enter":
          e.preventDefault();
          if (filteredAgents[selectedIndex]) {
            handleSelectAgent(filteredAgents[selectedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          setShowMentionPopup(false);
          break;
        case "Tab":
          e.preventDefault();
          if (filteredAgents[selectedIndex]) {
            handleSelectAgent(filteredAgents[selectedIndex]);
          }
          break;
      }
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  // Close popup when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        setShowMentionPopup(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <Box sx={{ position: "relative", display: "flex", gap: 1.5, flex: 1, alignItems: "flex-end" }}>
      <Textarea
        slotProps={{
          textarea: {
            ref: inputRef,
          },
        }}
        placeholder={placeholder}
        value={value}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        minRows={1}
        maxRows={5}
        sx={{ ...inputStyles, flex: 1 }}
      />

      {/* Mention autocomplete popup */}
      {showMentionPopup && filteredAgents.length > 0 && (
        <Box
          ref={popupRef}
          sx={{
            position: "absolute",
            bottom: "100%",
            left: 0,
            right: 80,
            mb: 0.5,
            bgcolor: isDark ? "#1A130E" : "#FFFFFF",
            border: "1px solid",
            borderColor: colors.amberBorder,
            borderRadius: "8px",
            boxShadow: isDark ? "0 4px 20px rgba(0, 0, 0, 0.5)" : "0 4px 20px rgba(0, 0, 0, 0.15)",
            maxHeight: 200,
            overflow: "auto",
            zIndex: 1000,
          }}
        >
          {filteredAgents.map((agent, index) => (
            <Box
              key={agent.id}
              onClick={() => handleSelectAgent(agent)}
              sx={{
                px: 2,
                py: 1.5,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 1.5,
                bgcolor: index === selectedIndex ? colors.selectedBg : "transparent",
                borderBottom: index < filteredAgents.length - 1 ? "1px solid" : "none",
                borderColor: "neutral.outlinedBorder",
                transition: "background-color 0.1s ease",
                "&:hover": {
                  bgcolor: colors.hoverBg,
                },
              }}
            >
              {/* Status dot */}
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  bgcolor:
                    agent.status === "busy"
                      ? colors.amber
                      : agent.status === "idle"
                        ? colors.gold
                        : colors.dormant || "#6B5344",
                  boxShadow:
                    agent.status === "busy"
                      ? isDark
                        ? "0 0 6px rgba(245, 166, 35, 0.4)"
                        : "0 0 4px rgba(212, 136, 6, 0.3)"
                      : "none",
                }}
              />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <Typography
                    sx={{
                      fontFamily: "'Space Grotesk', sans-serif",
                      fontWeight: 600,
                      fontSize: "0.85rem",
                      color: agent.isLead ? colors.honey : colors.amber,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {agent.name}
                  </Typography>
                  {agent.isLead && (
                    <Typography
                      sx={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: "0.55rem",
                        fontWeight: 700,
                        color: colors.honey,
                        bgcolor: isDark ? "rgba(255, 184, 77, 0.15)" : "rgba(184, 115, 0, 0.1)",
                        px: 0.75,
                        py: 0.2,
                        borderRadius: "4px",
                        border: "1px solid",
                        borderColor: isDark ? "rgba(255, 184, 77, 0.3)" : "rgba(184, 115, 0, 0.25)",
                        letterSpacing: "0.05em",
                      }}
                    >
                      LEAD
                    </Typography>
                  )}
                </Box>
                {agent.role && (
                  <Typography
                    sx={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: "0.7rem",
                      color: "text.tertiary",
                    }}
                  >
                    {agent.role}
                  </Typography>
                )}
              </Box>
            </Box>
          ))}
        </Box>
      )}

      <Box component="button" onClick={onSend} disabled={disabled} sx={sendButtonStyles}>
        {sendLabel}
      </Box>
    </Box>
  );
});

// Helper to format date for dividers
function formatDateDivider(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const messageDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (messageDate.getTime() === today.getTime()) {
    return `Today (${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })})`;
  }

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (messageDate.getTime() === yesterday.getTime()) {
    return `Yesterday (${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })})`;
  }

  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: messageDate.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

// Get date key for grouping (YYYY-MM-DD)
function getDateKey(dateStr: string): string {
  const date = new Date(dateStr);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

interface DateDividerProps {
  date: string;
  isDark: boolean;
  colors: Record<string, string>;
}

function DateDivider({ date, isDark, colors }: DateDividerProps) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        px: 2,
        py: 1.5,
        my: 1,
      }}
    >
      <Box
        sx={{
          flex: 1,
          height: 1,
          bgcolor: isDark ? "rgba(212, 165, 116, 0.2)" : "rgba(139, 105, 20, 0.15)",
        }}
      />
      <Typography
        sx={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: "0.7rem",
          fontWeight: 600,
          color: colors.gold,
          letterSpacing: "0.03em",
          whiteSpace: "nowrap",
        }}
      >
        {formatDateDivider(date)}
      </Typography>
      <Box
        sx={{
          flex: 1,
          height: 1,
          bgcolor: isDark ? "rgba(212, 165, 116, 0.2)" : "rgba(139, 105, 20, 0.15)",
        }}
      />
    </Box>
  );
}

interface MessageItemProps {
  message: ChannelMessage;
  isDark: boolean;
  colors: Record<string, string>;
  onOpenThread?: () => void;
  threadCount?: number;
  isThreadView?: boolean;
  onAgentClick?: (agentId: string) => void;
  onTaskClick?: (taskId: string) => void;
  isSelected?: boolean;
  agentsByName?: Map<string, string>; // name -> id mapping for @mentions
  isLeadAgent?: boolean; // Whether the message sender is the lead agent
}

function MessageItem({
  message,
  isDark,
  colors,
  onOpenThread,
  threadCount,
  isThreadView,
  onAgentClick,
  onTaskClick,
  isSelected,
  agentsByName,
  isLeadAgent,
}: MessageItemProps) {
  const [copied, setCopied] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const hasReplies = threadCount && threadCount > 0;

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [message.content]);

  const toggleRaw = useCallback(() => {
    setShowRaw((prev) => !prev);
  }, []);

  // Custom markdown components to handle @mentions
  const markdownComponents = useMemo(() => {
    // Helper to render text with @mentions
    const renderTextWithMentions = (text: string): React.ReactNode => {
      if (!agentsByName || agentsByName.size === 0) {
        return text;
      }

      // Build regex for agent names (longest first)
      const agentNames = Array.from(agentsByName.keys()).sort((a, b) => b.length - a.length);
      if (agentNames.length === 0) return text;

      const escapedNames = agentNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const mentionPattern = new RegExp(`@(${escapedNames.join("|")})(?=\\s|$|[.,!?;:])`, "g");

      const parts: React.ReactNode[] = [];
      let lastIndex = 0;
      let match;
      let keyCounter = 0;

      while ((match = mentionPattern.exec(text)) !== null) {
        if (match.index > lastIndex) {
          parts.push(text.slice(lastIndex, match.index));
        }

        const mentionName = match[1] ?? "";
        const agentId = agentsByName.get(mentionName);

        if (agentId && onAgentClick) {
          parts.push(
            <Link
              key={`mention-${keyCounter++}`}
              component="button"
              onClick={(e) => {
                e.stopPropagation();
                onAgentClick(agentId);
              }}
              sx={{
                fontFamily: "inherit",
                fontWeight: 600,
                fontSize: "inherit",
                color: colors.amber,
                textDecoration: "none",
                cursor: "pointer",
                bgcolor: isDark ? "rgba(245, 166, 35, 0.1)" : "rgba(212, 136, 6, 0.08)",
                px: 0.5,
                borderRadius: "4px",
                "&:hover": {
                  textDecoration: "underline",
                  color: colors.honey,
                },
              }}
            >
              @{mentionName}
            </Link>,
          );
        } else {
          parts.push(
            <Box
              key={`mention-${keyCounter++}`}
              component="span"
              sx={{
                fontWeight: 600,
                color: colors.gold,
                bgcolor: isDark ? "rgba(212, 165, 116, 0.1)" : "rgba(139, 105, 20, 0.08)",
                px: 0.5,
                borderRadius: "4px",
              }}
            >
              @{mentionName}
            </Box>,
          );
        }

        lastIndex = match.index + match[0].length;
      }

      if (lastIndex < text.length) {
        parts.push(text.slice(lastIndex));
      }

      return parts.length > 0 ? parts : text;
    };

    return {
      // Handle task: links for navigating to tasks
      a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
        if (href?.startsWith("task:")) {
          const taskId = href.slice(5); // Remove "task:" prefix
          if (onTaskClick) {
            return (
              <Link
                component="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onTaskClick(taskId);
                }}
                sx={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: "0.85em",
                  color: colors.gold,
                  textDecoration: "none",
                  cursor: "pointer",
                  bgcolor: isDark ? "rgba(212, 165, 116, 0.1)" : "rgba(139, 105, 20, 0.08)",
                  px: 0.75,
                  py: 0.25,
                  borderRadius: "4px",
                  "&:hover": {
                    textDecoration: "underline",
                    bgcolor: isDark ? "rgba(212, 165, 116, 0.15)" : "rgba(139, 105, 20, 0.12)",
                  },
                }}
              >
                {children}
              </Link>
            );
          }
          // Non-clickable task reference
          return (
            <Box
              component="span"
              sx={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "0.85em",
                color: colors.gold,
                bgcolor: isDark ? "rgba(212, 165, 116, 0.1)" : "rgba(139, 105, 20, 0.08)",
                px: 0.75,
                py: 0.25,
                borderRadius: "4px",
              }}
            >
              {children}
            </Box>
          );
        }
        // Regular links - render normally
        return <a href={href}>{children}</a>;
      },
      // Process text nodes to handle @mentions
      p: ({ children }: { children?: React.ReactNode }) => {
        const processChildren = (child: React.ReactNode): React.ReactNode => {
          if (typeof child === "string") {
            return renderTextWithMentions(child);
          }
          if (Array.isArray(child)) {
            return child.map((c, i) => (
              <React.Fragment key={i}>{processChildren(c)}</React.Fragment>
            ));
          }
          return child;
        };
        return <p>{processChildren(children)}</p>;
      },
      li: ({ children }: { children?: React.ReactNode }) => {
        const processChildren = (child: React.ReactNode): React.ReactNode => {
          if (typeof child === "string") {
            return renderTextWithMentions(child);
          }
          if (Array.isArray(child)) {
            return child.map((c, i) => (
              <React.Fragment key={i}>{processChildren(c)}</React.Fragment>
            ));
          }
          return child;
        };
        return <li>{processChildren(children)}</li>;
      },
    };
  }, [agentsByName, onAgentClick, onTaskClick, colors, isDark]);

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        gap: 0.5,
        px: 1.5,
        py: 1,
        mx: 0.5,
        my: 0.25,
        borderRadius: "6px",
        border: "1px solid",
        borderColor: isSelected ? colors.amberBorder : "transparent",
        bgcolor: isSelected
          ? colors.selectedBg
          : isDark
            ? "rgba(26, 19, 14, 0.5)"
            : "rgba(255, 255, 255, 0.5)",
        transition: "all 0.2s ease",
        "&:hover": {
          bgcolor: isDark ? "rgba(245, 166, 35, 0.06)" : "rgba(212, 136, 6, 0.04)",
          "& .action-icons": {
            opacity: 1,
          },
        },
      }}
    >
      {/* Header row */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
        {/* Indicator - hexagon for lead, dot for others */}
        {isLeadAgent ? (
          <Box
            sx={{
              width: 10,
              height: 12,
              clipPath: "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)",
              bgcolor: colors.honey,
              flexShrink: 0,
              boxShadow: isDark
                ? "0 0 8px rgba(255, 184, 77, 0.5)"
                : "0 0 6px rgba(184, 115, 0, 0.4)",
            }}
          />
        ) : (
          <Box
            sx={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              bgcolor: message.agentId ? colors.amber : colors.blue,
              flexShrink: 0,
              boxShadow: message.agentId
                ? isDark
                  ? "0 0 6px rgba(245, 166, 35, 0.4)"
                  : "0 0 4px rgba(212, 136, 6, 0.3)"
                : "0 0 6px rgba(59, 130, 246, 0.4)",
            }}
          />
        )}

        {/* Agent name - clickable if agent */}
        {message.agentId && onAgentClick ? (
          <Link
            component="button"
            onClick={(e) => {
              e.stopPropagation();
              onAgentClick(message.agentId!);
            }}
            sx={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 600,
              fontSize: "0.85rem",
              color: isLeadAgent ? colors.honey : colors.amber,
              textDecoration: "none",
              cursor: "pointer",
              whiteSpace: "nowrap",
              "&:hover": {
                textDecoration: "underline",
                color: isLeadAgent ? "#FFD699" : colors.honey,
              },
            }}
          >
            {message.agentName || "Agent"}
          </Link>
        ) : (
          <Typography
            sx={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 600,
              fontSize: "0.85rem",
              color: message.agentId ? (isLeadAgent ? colors.honey : colors.amber) : colors.blue,
              whiteSpace: "nowrap",
            }}
          >
            {message.agentName || "Human"}
          </Typography>
        )}

        {/* Lead badge */}
        {isLeadAgent && (
          <Typography
            sx={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "0.55rem",
              fontWeight: 700,
              color: colors.honey,
              bgcolor: isDark ? "rgba(255, 184, 77, 0.15)" : "rgba(184, 115, 0, 0.1)",
              px: 0.75,
              py: 0.2,
              borderRadius: "4px",
              border: "1px solid",
              borderColor: isDark ? "rgba(255, 184, 77, 0.3)" : "rgba(184, 115, 0, 0.25)",
              letterSpacing: "0.05em",
            }}
          >
            LEAD
          </Typography>
        )}

        {/* Timestamp */}
        <Typography
          sx={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "0.7rem",
            color: "text.tertiary",
            letterSpacing: "0.02em",
          }}
        >
          {formatSmartTime(message.createdAt)}
        </Typography>

        {/* Spacer */}
        <Box sx={{ flex: 1 }} />

        {/* Reply count badge - clickable to open thread */}
        {!isThreadView && hasReplies && onOpenThread && (
          <Box
            component="button"
            onClick={onOpenThread}
            sx={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "0.65rem",
              fontWeight: 600,
              bgcolor: isDark ? "rgba(212, 165, 116, 0.15)" : "#FEF3C7",
              color: isDark ? "#D4A574" : "#B45309",
              border: "1px solid",
              borderColor: isDark ? "rgba(212, 165, 116, 0.3)" : "#FCD34D",
              borderRadius: "12px",
              px: 1.5,
              py: 0.25,
              cursor: "pointer",
              transition: "all 0.15s ease",
              "&:hover": {
                bgcolor: isDark ? "rgba(212, 165, 116, 0.25)" : "#FDE68A",
                borderColor: isDark ? "rgba(212, 165, 116, 0.5)" : "#FBBF24",
              },
            }}
          >
            {threadCount} {threadCount === 1 ? "reply" : "replies"}
          </Box>
        )}

        {/* Action icons - appear on hover */}
        <Box
          className="action-icons"
          sx={{ display: "flex", gap: 0.5, opacity: 0, transition: "opacity 0.2s ease" }}
        >
          {/* Toggle raw/markdown */}
          <Tooltip title={showRaw ? "Show formatted" : "Show raw"} placement="top">
            <IconButton
              size="sm"
              variant="plain"
              onClick={toggleRaw}
              sx={{
                color: showRaw ? colors.amber : "text.tertiary",
                fontSize: "0.75rem",
                fontFamily: "'JetBrains Mono', monospace",
                fontWeight: 600,
                width: 28,
                height: 28,
                "&:hover": {
                  color: colors.amber,
                  bgcolor: colors.hoverBg,
                },
              }}
            >
              {showRaw ? "MD" : "</>"}
            </IconButton>
          </Tooltip>

          {/* Copy button */}
          <Tooltip title={copied ? "Copied!" : "Copy message"} placement="top">
            <IconButton
              size="sm"
              variant="plain"
              onClick={handleCopy}
              sx={{
                color: copied ? "#22C55E" : "text.tertiary",
                fontSize: "0.9rem",
                width: 28,
                height: 28,
                "&:hover": {
                  color: copied ? "#22C55E" : colors.amber,
                  bgcolor: colors.hoverBg,
                },
              }}
            >
              {copied ? "✓" : "⧉"}
            </IconButton>
          </Tooltip>

          {/* Reply icon */}
          {!isThreadView && onOpenThread && (
            <Tooltip title="Open thread" placement="top">
              <IconButton
                size="sm"
                variant="plain"
                onClick={onOpenThread}
                sx={{
                  color: "text.tertiary",
                  fontSize: "1rem",
                  width: 28,
                  height: 28,
                  "&:hover": {
                    color: colors.amber,
                    bgcolor: colors.hoverBg,
                  },
                }}
              >
                ↩
              </IconButton>
            </Tooltip>
          )}
        </Box>
      </Box>

      {/* Message content */}
      {showRaw ? (
        <Typography
          component="div"
          sx={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "0.8rem",
            color: "text.primary",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            pl: 2.25,
            bgcolor: isDark ? "rgba(0, 0, 0, 0.2)" : "rgba(0, 0, 0, 0.03)",
            borderRadius: "6px",
            p: 1.5,
            ml: 2.25,
            mr: 1,
          }}
        >
          {message.content}
        </Typography>
      ) : (
        <Box
          sx={{
            pl: 2.25,
            fontFamily: "'Space Grotesk', sans-serif",
            fontSize: "0.85rem",
            color: "text.primary",
            lineHeight: 1.6,
            wordBreak: "break-word",
            "& p": {
              m: 0,
              mb: 0.5,
              "&:last-child": { mb: 0 },
            },
            "& h1, & h2, & h3, & h4, & h5, & h6": {
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 600,
              mt: 1,
              mb: 0.5,
              color: colors.amber,
            },
            "& h1": { fontSize: "1.25rem" },
            "& h2": { fontSize: "1.1rem" },
            "& h3": { fontSize: "1rem" },
            "& code": {
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "0.8rem",
              bgcolor: isDark ? "rgba(0, 0, 0, 0.3)" : "rgba(0, 0, 0, 0.06)",
              px: 0.5,
              py: 0.25,
              borderRadius: "4px",
            },
            "& pre": {
              bgcolor: isDark ? "rgba(0, 0, 0, 0.3)" : "rgba(0, 0, 0, 0.06)",
              borderRadius: "6px",
              p: 1.5,
              overflow: "auto",
              my: 1,
              "& code": {
                bgcolor: "transparent",
                p: 0,
              },
            },
            "& ul": {
              pl: 2.5,
              my: 0.5,
              listStyleType: "disc",
            },
            "& ol": {
              pl: 2.5,
              my: 0.5,
              listStyleType: "decimal",
            },
            "& li": {
              mb: 0.25,
              display: "list-item",
            },
            "& blockquote": {
              borderLeft: "3px solid",
              borderColor: colors.amber,
              pl: 1.5,
              ml: 0,
              my: 1,
              color: "text.secondary",
              fontStyle: "italic",
            },
            "& a": {
              color: colors.amber,
              textDecoration: "none",
              "&:hover": {
                textDecoration: "underline",
              },
            },
            "& table": {
              borderCollapse: "collapse",
              my: 1,
              fontSize: "0.8rem",
            },
            "& th, & td": {
              border: "1px solid",
              borderColor: "neutral.outlinedBorder",
              px: 1,
              py: 0.5,
            },
            "& th": {
              bgcolor: isDark ? "rgba(0, 0, 0, 0.2)" : "rgba(0, 0, 0, 0.04)",
              fontWeight: 600,
            },
            "& hr": {
              border: "none",
              borderTop: "1px solid",
              borderColor: "neutral.outlinedBorder",
              my: 1,
            },
            "& img": {
              maxWidth: "100%",
              borderRadius: "6px",
            },
          }}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {message.content}
          </ReactMarkdown>
        </Box>
      )}
    </Box>
  );
}

interface ChatPanelProps {
  selectedChannelId?: string | null;
  selectedThreadId?: string | null;
  onSelectChannel?: (channelId: string | null) => void;
  onSelectThread?: (threadId: string | null) => void;
  onNavigateToAgent?: (agentId: string) => void;
  onNavigateToTask?: (taskId: string) => void;
}

export default function ChatPanel({
  selectedChannelId: controlledChannelId,
  selectedThreadId: controlledThreadId,
  onSelectChannel,
  onSelectThread,
  onNavigateToAgent,
  onNavigateToTask,
}: ChatPanelProps) {
  // Internal state for uncontrolled mode
  const [internalChannelId, setInternalChannelId] = useState<string | null>(null);
  const [internalThreadId, setInternalThreadId] = useState<string | null>(null);
  const [messageInput, setMessageInput] = useState("");
  const [threadMessageInput, setThreadMessageInput] = useState("");
  const [channelDrawerOpen, setChannelDrawerOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const previousNewestMessageIdRef = useRef<string | null>(null);
  const scrollPositionRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);

  // Use controlled or internal state
  const selectedChannelId =
    controlledChannelId !== undefined ? controlledChannelId : internalChannelId;
  const selectedThreadId = controlledThreadId !== undefined ? controlledThreadId : internalThreadId;

  const setSelectedChannelId = useCallback(
    (id: string | null) => {
      if (onSelectChannel) {
        onSelectChannel(id);
      } else {
        setInternalChannelId(id);
      }
    },
    [onSelectChannel],
  );

  const setSelectedThreadId = useCallback(
    (id: string | null) => {
      if (onSelectThread) {
        onSelectThread(id);
      } else {
        setInternalThreadId(id);
      }
    },
    [onSelectThread],
  );

  const { mode } = useColorScheme();
  const isDark = mode === "dark";

  const colors = useMemo(
    () => ({
      amber: isDark ? "#F5A623" : "#D48806",
      gold: isDark ? "#D4A574" : "#8B6914",
      honey: isDark ? "#FFB84D" : "#B87300",
      blue: "#3B82F6",
      dormant: isDark ? "#6B5344" : "#A89A7C",
      amberGlow: isDark ? "0 0 8px rgba(245, 166, 35, 0.5)" : "0 0 6px rgba(212, 136, 6, 0.3)",
      hoverBg: isDark ? "rgba(245, 166, 35, 0.05)" : "rgba(212, 136, 6, 0.05)",
      selectedBg: isDark ? "rgba(245, 166, 35, 0.1)" : "rgba(212, 136, 6, 0.08)",
      amberBorder: isDark ? "rgba(245, 166, 35, 0.3)" : "rgba(212, 136, 6, 0.25)",
      inputBg: isDark ? "rgba(13, 9, 6, 0.6)" : "rgba(255, 255, 255, 0.8)",
      inputBorder: isDark ? "#3A2D1F" : "#E5D9CA",
    }),
    [isDark],
  );

  const { data: channels, isLoading: channelsLoading } = useChannels();
  const {
    data: messages,
    isLoading: messagesLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteMessages(selectedChannelId || "");
  const { data: threadMessages } = useThreadMessages(
    selectedChannelId || "",
    selectedThreadId || "",
  );
  const postMessageMutation = usePostMessage(selectedChannelId || "");
  const { data: agents } = useAgents();
  const agentsList = useMemo(() => agents || [], [agents]);

  // Create name -> id mapping for @mention links
  const agentsByName = useMemo(() => {
    const map = new Map<string, string>();
    agents?.forEach((agent) => map.set(agent.name, agent.id));
    return map;
  }, [agents]);

  // Create set of lead agent IDs
  const leadAgentIds = useMemo(() => {
    const set = new Set<string>();
    agents?.forEach((agent) => {
      if (agent.isLead) set.add(agent.id);
    });
    return set;
  }, [agents]);

  // Track mentions for main and thread inputs
  const [messageMentions, setMessageMentions] = useState<string[]>([]);
  const [threadMentions, setThreadMentions] = useState<string[]>([]);

  const selectedChannel = channels?.find((c) => c.id === selectedChannelId);

  // Find thread message from messages
  const selectedThreadMessage = useMemo(() => {
    if (!selectedThreadId || !messages) return null;
    return messages.find((m) => m.id === selectedThreadId) || null;
  }, [selectedThreadId, messages]);

  // Auto-select first channel only if no channel is selected
  useEffect(() => {
    if (channels && channels.length > 0 && !selectedChannelId) {
      const firstChannel = channels[0];
      if (firstChannel) {
        setSelectedChannelId(firstChannel.id);
      }
    }
  }, [channels, selectedChannelId, setSelectedChannelId]);

  // Reset scroll tracking when channel changes
  useEffect(() => {
    previousNewestMessageIdRef.current = null;
    scrollPositionRef.current = null;
  }, [selectedChannelId]);

  // Get the newest message ID (last in the sorted array)
  const newestMessageId = messages?.[messages.length - 1]?.id ?? null;

  // Scroll to bottom only when a NEW message arrives AND user is near the bottom
  useEffect(() => {
    // If the newest message ID changed, a new message arrived
    if (newestMessageId && newestMessageId !== previousNewestMessageIdRef.current) {
      const isInitialLoad = previousNewestMessageIdRef.current === null;
      previousNewestMessageIdRef.current = newestMessageId;

      const container = messagesContainerRef.current;

      if (isInitialLoad) {
        // On initial load, scroll immediately without animation
        messagesEndRef.current?.scrollIntoView();
      } else if (container) {
        // Check if user is near the bottom (within 150px)
        const isNearBottom =
          container.scrollHeight - container.scrollTop - container.clientHeight < 150;

        if (isNearBottom) {
          // User is near bottom, scroll to show new message
          messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
        }
        // If user is scrolled up, don't auto-scroll - let them read in peace
      }
    }
  }, [newestMessageId]);

  // Preserve scroll position when loading older messages
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container || !scrollPositionRef.current) return;

    // Restore scroll position after older messages are prepended
    const { scrollTop, scrollHeight: oldScrollHeight } = scrollPositionRef.current;
    const newScrollHeight = container.scrollHeight;
    const heightDiff = newScrollHeight - oldScrollHeight;

    if (heightDiff > 0) {
      container.scrollTop = scrollTop + heightDiff;
    }

    scrollPositionRef.current = null;
  }, [messages]);

  // Scroll to bottom of thread when thread opens or messages change
  useEffect(() => {
    if (selectedThreadId && threadMessages) {
      setTimeout(() => {
        threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
      }, 100);
    }
  }, [selectedThreadId, threadMessages]);

  // Count replies per message
  const replyCounts = new Map<string, number>();
  messages?.forEach((msg) => {
    if (msg.replyToId) {
      replyCounts.set(msg.replyToId, (replyCounts.get(msg.replyToId) || 0) + 1);
    }
  });

  // Filter out threaded replies from main view (only show top-level messages)
  const topLevelMessages = messages?.filter((msg) => !msg.replyToId) || [];

  const handleSendMessage = useCallback(() => {
    if (!messageInput.trim() || !selectedChannelId) return;

    postMessageMutation.mutate({
      content: messageInput.trim(),
      mentions: messageMentions.length > 0 ? messageMentions : undefined,
    });
    setMessageInput("");
    setMessageMentions([]);
  }, [messageInput, selectedChannelId, postMessageMutation, messageMentions]);

  const handleSendThreadMessage = useCallback(() => {
    if (!threadMessageInput.trim() || !selectedChannelId || !selectedThreadMessage) return;

    postMessageMutation.mutate({
      content: threadMessageInput.trim(),
      replyToId: selectedThreadMessage.id,
      mentions: threadMentions.length > 0 ? threadMentions : undefined,
    });
    setThreadMessageInput("");
    setThreadMentions([]);
  }, [
    threadMessageInput,
    selectedChannelId,
    selectedThreadMessage,
    postMessageMutation,
    threadMentions,
  ]);

  const handleOpenThread = useCallback(
    (message: ChannelMessage) => {
      setSelectedThreadId(message.id);
    },
    [setSelectedThreadId],
  );

  const handleCloseThread = useCallback(() => {
    setSelectedThreadId(null);
  }, [setSelectedThreadId]);

  const handleAgentClick = useCallback(
    (agentId: string) => {
      if (onNavigateToAgent) {
        onNavigateToAgent(agentId);
      }
    },
    [onNavigateToAgent],
  );

  // Input styles shared between main and thread (memoized to prevent re-renders)
  const inputStyles = useMemo(
    () => ({
      flex: 1,
      fontFamily: "'Space Grotesk', sans-serif",
      fontSize: "16px", // 16px prevents iOS zoom on focus
      bgcolor: colors.inputBg,
      borderColor: colors.inputBorder,
      borderRadius: "8px",
      "--Textarea-focusedThickness": "2px",
      "--Textarea-focusedHighlight": colors.amber,
      "&:hover": {
        borderColor: isDark ? "#4A3A2F" : "#D1C5B4",
      },
      "&:focus-within": {
        borderColor: colors.amber,
        boxShadow: isDark
          ? "0 0 0 2px rgba(245, 166, 35, 0.15)"
          : "0 0 0 2px rgba(212, 136, 6, 0.1)",
      },
      "& textarea": {
        fontFamily: "'Space Grotesk', sans-serif",
        fontSize: "16px", // 16px prevents iOS zoom on focus
        color: isDark ? "#FFF8E7" : "#1A130E",
      },
      "& textarea::placeholder": {
        color: isDark ? "#8B7355" : "#8B7355",
        fontFamily: "'Space Grotesk', sans-serif",
      },
    }),
    [colors.inputBg, colors.inputBorder, colors.amber, isDark],
  );

  const sendButtonStyles = useMemo(
    () => ({
      fontFamily: "'Space Grotesk', sans-serif",
      fontSize: "0.9rem",
      fontWeight: 600,
      letterSpacing: "0.03em",
      px: 3,
      py: 1.5,
      minHeight: 44, // Good touch target size
      borderRadius: "8px",
      bgcolor: colors.amber,
      color: isDark ? "#1A130E" : "#FFFFFF",
      border: "none",
      cursor: "pointer",
      transition: "all 0.2s ease",
      "&:hover": {
        bgcolor: colors.honey,
        transform: "translateY(-1px)",
        boxShadow: isDark
          ? "0 4px 12px rgba(245, 166, 35, 0.3)"
          : "0 4px 12px rgba(212, 136, 6, 0.2)",
      },
      "&:active": {
        transform: "translateY(0)",
      },
      "&:disabled": {
        opacity: 0.5,
        cursor: "not-allowed",
        transform: "none",
        boxShadow: "none",
      },
    }),
    [colors.amber, colors.honey, isDark],
  );

  // Channel list content - reused in drawer and desktop sidebar
  const channelListContent = (
    <Box sx={{ flex: 1, overflow: "auto", p: 1 }}>
      {channelsLoading ? (
        <Typography
          sx={{
            fontFamily: "'Space Grotesk', sans-serif",
            fontSize: "0.8rem",
            color: "text.tertiary",
            p: 1.5,
          }}
        >
          Loading...
        </Typography>
      ) : !channels || channels.length === 0 ? (
        <Typography
          sx={{
            fontFamily: "'Space Grotesk', sans-serif",
            fontSize: "0.8rem",
            color: "text.tertiary",
            p: 1.5,
          }}
        >
          No channels
        </Typography>
      ) : (
        channels.map((channel) => (
          <Box
            key={channel.id}
            onClick={() => {
              setSelectedChannelId(channel.id);
              setSelectedThreadId(null);
              setChannelDrawerOpen(false);
            }}
            sx={{
              px: 1.5,
              py: 1.5,
              borderRadius: "6px",
              cursor: "pointer",
              bgcolor: selectedChannelId === channel.id ? colors.selectedBg : "transparent",
              border: "1px solid",
              borderColor: selectedChannelId === channel.id ? colors.amberBorder : "transparent",
              transition: "all 0.15s ease",
              mb: 0.5,
              minHeight: 44,
              display: "flex",
              alignItems: "center",
              "&:hover": {
                bgcolor: selectedChannelId === channel.id ? colors.selectedBg : colors.hoverBg,
              },
            }}
          >
            <Typography
              sx={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "0.8rem",
                fontWeight: selectedChannelId === channel.id ? 600 : 400,
                color: selectedChannelId === channel.id ? colors.amber : "text.secondary",
              }}
            >
              # {channel.name}
            </Typography>
          </Box>
        ))
      )}
    </Box>
  );

  return (
    <Card
      variant="outlined"
      sx={{
        p: 0,
        height: "100%",
        display: "flex",
        flexDirection: "row",
        overflow: "hidden",
        bgcolor: "background.surface",
        borderColor: "neutral.outlinedBorder",
        borderRadius: { xs: 0, md: "12px" },
        gap: 0,
      }}
    >
      {/* Mobile Channel Drawer */}
      <Drawer
        open={channelDrawerOpen}
        onClose={() => setChannelDrawerOpen(false)}
        sx={{
          display: { xs: "block", md: "none" },
          "& .MuiDrawer-content": {
            width: 280,
            bgcolor: isDark ? "#1A130E" : "#FDF8F3",
          },
        }}
      >
        <Box
          sx={{
            height: "100%",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Drawer header */}
          <Box
            sx={{
              px: 2,
              py: 1.5,
              borderBottom: "1px solid",
              borderColor: "neutral.outlinedBorder",
              bgcolor: "background.level1",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              minHeight: 56,
            }}
          >
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Box
                sx={{
                  width: 8,
                  height: 10,
                  clipPath: "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)",
                  bgcolor: colors.amber,
                  boxShadow: colors.amberGlow,
                }}
              />
              <Typography
                sx={{
                  fontFamily: "'Space Grotesk', sans-serif",
                  fontWeight: 600,
                  color: colors.amber,
                  letterSpacing: "0.05em",
                  fontSize: "0.85rem",
                }}
              >
                CHANNELS
              </Typography>
            </Box>
            <IconButton
              size="sm"
              variant="plain"
              onClick={() => setChannelDrawerOpen(false)}
              sx={{
                color: "text.tertiary",
                minWidth: 44,
                minHeight: 44,
                "&:hover": { color: "text.primary", bgcolor: colors.hoverBg },
              }}
            >
              ✕
            </IconButton>
          </Box>
          {channelListContent}
        </Box>
      </Drawer>

      {/* Desktop Channel List - Fixed width, hidden on mobile */}
      <Box
        sx={{
          width: 220,
          flexShrink: 0,
          borderRight: "1px solid",
          borderColor: "neutral.outlinedBorder",
          display: { xs: "none", md: "flex" },
          flexDirection: "column",
          overflow: "hidden",
          bgcolor: isDark ? "rgba(13, 9, 6, 0.3)" : "rgba(245, 237, 228, 0.5)",
        }}
      >
        {/* Channels header */}
        <Box
          sx={{
            px: 2,
            py: 1.5,
            borderBottom: "1px solid",
            borderColor: "neutral.outlinedBorder",
            bgcolor: "background.level1",
            height: 64,
            display: "flex",
            alignItems: "center",
          }}
        >
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Box
              sx={{
                width: 8,
                height: 10,
                clipPath: "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)",
                bgcolor: colors.amber,
                boxShadow: colors.amberGlow,
              }}
            />
            <Typography
              sx={{
                fontFamily: "'Space Grotesk', sans-serif",
                fontWeight: 600,
                color: colors.amber,
                letterSpacing: "0.05em",
                fontSize: "0.85rem",
              }}
            >
              CHANNELS
            </Typography>
          </Box>
        </Box>
        {channelListContent}
      </Box>

      {/* Messages Panel - Flex, equal split with thread, hidden when thread is open on mobile */}
      <Box
        sx={{
          flex: 1,
          display: {
            xs: selectedThreadMessage ? "none" : "flex",
            md: "flex",
          },
          flexDirection: "column",
          overflow: "hidden",
          minWidth: 0,
        }}
      >
        {/* Channel header with title and description */}
        <Box
          sx={{
            px: { xs: 1.5, md: 2.5 },
            py: 1.5,
            borderBottom: "1px solid",
            borderColor: "neutral.outlinedBorder",
            bgcolor: "background.level1",
            height: { xs: 56, md: 64 },
            display: "flex",
            alignItems: "center",
            gap: 1,
          }}
        >
          {/* Mobile hamburger menu */}
          <IconButton
            size="sm"
            variant="plain"
            onClick={() => setChannelDrawerOpen(true)}
            sx={{
              display: { xs: "flex", md: "none" },
              color: colors.amber,
              minWidth: 44,
              minHeight: 44,
              "&:hover": { bgcolor: colors.hoverBg },
            }}
          >
            ☰
          </IconButton>

          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              sx={{
                fontFamily: "'Space Grotesk', sans-serif",
                fontWeight: 600,
                fontSize: { xs: "0.9rem", md: "1rem" },
                color: "text.primary",
                mb: 0.25,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              # {selectedChannel?.name || "Select a channel"}
            </Typography>
            {selectedChannel?.description && (
              <Typography
                sx={{
                  fontFamily: "'Space Grotesk', sans-serif",
                  fontSize: "0.7rem",
                  color: "text.tertiary",
                  lineHeight: 1.4,
                  display: { xs: "none", sm: "block" },
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {selectedChannel.description}
              </Typography>
            )}
          </Box>
        </Box>

        {/* Messages list */}
        <Box
          ref={messagesContainerRef}
          sx={{
            flex: 1,
            overflow: "auto",
            py: 1,
            bgcolor: isDark ? "rgba(13, 9, 6, 0.2)" : "rgba(253, 248, 243, 0.5)",
          }}
        >
          {messagesLoading ? (
            <Typography
              sx={{
                fontFamily: "'Space Grotesk', sans-serif",
                fontSize: "0.85rem",
                color: "text.tertiary",
                p: 3,
              }}
            >
              Loading messages...
            </Typography>
          ) : topLevelMessages.length === 0 ? (
            <Box sx={{ p: 3, textAlign: "center" }}>
              <Typography
                sx={{
                  fontFamily: "'Space Grotesk', sans-serif",
                  fontSize: "0.9rem",
                  color: "text.tertiary",
                  mb: 1,
                }}
              >
                No messages yet
              </Typography>
              <Typography
                sx={{
                  fontFamily: "'Space Grotesk', sans-serif",
                  fontSize: "0.8rem",
                  color: "text.tertiary",
                }}
              >
                Start the conversation!
              </Typography>
            </Box>
          ) : (
            <>
              {/* Load more button */}
              {hasNextPage && (
                <Box sx={{ display: "flex", justifyContent: "center", py: 2 }}>
                  <Box
                    component="button"
                    onClick={() => {
                      // Save scroll position before loading older messages
                      const container = messagesContainerRef.current;
                      if (container) {
                        scrollPositionRef.current = {
                          scrollTop: container.scrollTop,
                          scrollHeight: container.scrollHeight,
                        };
                      }
                      fetchNextPage();
                    }}
                    disabled={isFetchingNextPage}
                    sx={{
                      fontFamily: "'Space Grotesk', sans-serif",
                      fontSize: "0.8rem",
                      fontWeight: 600,
                      color: colors.amber,
                      bgcolor: "transparent",
                      border: "1px solid",
                      borderColor: colors.amberBorder,
                      borderRadius: "6px",
                      px: 3,
                      py: 1,
                      cursor: isFetchingNextPage ? "wait" : "pointer",
                      transition: "all 0.2s ease",
                      opacity: isFetchingNextPage ? 0.6 : 1,
                      "&:hover": {
                        bgcolor: colors.hoverBg,
                        borderColor: colors.amber,
                      },
                    }}
                  >
                    {isFetchingNextPage ? "Loading..." : "Load older messages"}
                  </Box>
                </Box>
              )}

              {/* Messages with date dividers */}
              {(() => {
                let lastDateKey = "";
                return topLevelMessages.map((message) => {
                  const dateKey = getDateKey(message.createdAt);
                  const showDivider = dateKey !== lastDateKey;
                  lastDateKey = dateKey;
                  return (
                    <React.Fragment key={message.id}>
                      {showDivider && (
                        <DateDivider date={message.createdAt} isDark={isDark} colors={colors} />
                      )}
                      <MessageItem
                        message={message}
                        isDark={isDark}
                        colors={colors}
                        onOpenThread={() => handleOpenThread(message)}
                        threadCount={replyCounts.get(message.id)}
                        onAgentClick={handleAgentClick}
                        onTaskClick={onNavigateToTask}
                        isSelected={selectedThreadMessage?.id === message.id}
                        agentsByName={agentsByName}
                        isLeadAgent={message.agentId ? leadAgentIds.has(message.agentId) : false}
                      />
                    </React.Fragment>
                  );
                });
              })()}
              <div ref={messagesEndRef} />
            </>
          )}
        </Box>

        {/* Message input */}
        <Box
          sx={{
            p: { xs: 1.5, md: 2 },
            borderTop: "1px solid",
            borderColor: "neutral.outlinedBorder",
            bgcolor: "background.level1",
          }}
        >
          <MentionInput
            value={messageInput}
            onChange={setMessageInput}
            onSend={handleSendMessage}
            onMentionsChange={setMessageMentions}
            placeholder="Type a message... (use @ to mention)"
            agents={agentsList}
            inputStyles={inputStyles}
            sendButtonStyles={sendButtonStyles}
            sendLabel="Send"
            disabled={!messageInput.trim() || postMessageMutation.isPending}
            colors={colors}
            isDark={isDark}
          />
        </Box>
      </Box>

      {/* Thread Panel - Full screen on mobile, equal width on desktop */}
      {selectedThreadMessage && (
        <Box
          sx={{
            position: { xs: "fixed", md: "relative" },
            inset: { xs: 0, md: "auto" },
            zIndex: { xs: 1300, md: "auto" },
            flex: { xs: "none", md: 1 },
            width: { xs: "100%", md: "auto" },
            minWidth: 0,
            borderLeft: { xs: "none", md: "1px solid" },
            borderColor: "neutral.outlinedBorder",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            bgcolor: isDark ? "#1A130E" : "#FDF8F3",
          }}
        >
          {/* Thread header */}
          <Box
            sx={{
              px: { xs: 1.5, md: 2.5 },
              py: 1.5,
              borderBottom: "1px solid",
              borderColor: "neutral.outlinedBorder",
              bgcolor: "background.level1",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              height: { xs: 56, md: 64 },
            }}
          >
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              {/* Mobile back button */}
              <IconButton
                size="sm"
                variant="plain"
                onClick={handleCloseThread}
                sx={{
                  display: { xs: "flex", md: "none" },
                  color: colors.gold,
                  minWidth: 44,
                  minHeight: 44,
                  "&:hover": { bgcolor: colors.hoverBg },
                }}
              >
                ←
              </IconButton>
              <Box
                sx={{
                  width: 8,
                  height: 10,
                  clipPath: "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)",
                  bgcolor: colors.gold,
                  boxShadow: isDark
                    ? "0 0 6px rgba(212, 165, 116, 0.4)"
                    : "0 0 4px rgba(139, 105, 20, 0.3)",
                  display: { xs: "none", md: "block" },
                }}
              />
              <Typography
                sx={{
                  fontFamily: "'Space Grotesk', sans-serif",
                  fontWeight: 600,
                  fontSize: "0.85rem",
                  color: colors.gold,
                  letterSpacing: "0.05em",
                }}
              >
                THREAD
              </Typography>
            </Box>
            {/* Desktop close button */}
            <Tooltip title="Close thread" placement="bottom">
              <IconButton
                size="sm"
                variant="plain"
                onClick={handleCloseThread}
                sx={{
                  display: { xs: "none", md: "flex" },
                  color: "text.tertiary",
                  fontSize: "1.1rem",
                  "&:hover": {
                    color: "text.primary",
                    bgcolor: colors.hoverBg,
                  },
                }}
              >
                ✕
              </IconButton>
            </Tooltip>
          </Box>

          {/* Original message */}
          <Box
            sx={{
              borderBottom: "1px solid",
              borderColor: "neutral.outlinedBorder",
              bgcolor: isDark ? "rgba(245, 166, 35, 0.03)" : "rgba(212, 136, 6, 0.02)",
              maxHeight: "30vh",
              overflow: "auto",
            }}
          >
            <MessageItem
              message={selectedThreadMessage}
              isDark={isDark}
              colors={colors}
              isThreadView
              onAgentClick={handleAgentClick}
              onTaskClick={onNavigateToTask}
              agentsByName={agentsByName}
              isLeadAgent={
                selectedThreadMessage.agentId
                  ? leadAgentIds.has(selectedThreadMessage.agentId)
                  : false
              }
            />
          </Box>

          {/* Thread divider */}
          <Box sx={{ px: 2, py: 1.5, display: "flex", alignItems: "center", gap: 2 }}>
            <Box sx={{ flex: 1, height: 1, bgcolor: "neutral.outlinedBorder" }} />
            <Typography
              sx={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "0.65rem",
                color: "text.tertiary",
                letterSpacing: "0.05em",
              }}
            >
              {threadMessages?.length || 0}{" "}
              {(threadMessages?.length || 0) === 1 ? "REPLY" : "REPLIES"}
            </Typography>
            <Box sx={{ flex: 1, height: 1, bgcolor: "neutral.outlinedBorder" }} />
          </Box>

          {/* Thread replies */}
          <Box
            sx={{
              flex: 1,
              overflow: "auto",
              py: 0.5,
            }}
          >
            {threadMessages && threadMessages.length > 0 ? (
              <>
                {threadMessages.map((message) => (
                  <MessageItem
                    key={message.id}
                    message={message}
                    isDark={isDark}
                    colors={colors}
                    isThreadView
                    onAgentClick={handleAgentClick}
                    onTaskClick={onNavigateToTask}
                    agentsByName={agentsByName}
                    isLeadAgent={message.agentId ? leadAgentIds.has(message.agentId) : false}
                  />
                ))}
                <div ref={threadEndRef} />
              </>
            ) : (
              <Box sx={{ p: 3, textAlign: "center" }}>
                <Typography
                  sx={{
                    fontFamily: "'Space Grotesk', sans-serif",
                    fontSize: "0.85rem",
                    color: "text.tertiary",
                  }}
                >
                  No replies yet
                </Typography>
              </Box>
            )}
          </Box>

          {/* Thread message input */}
          <Box
            sx={{
              p: { xs: 1.5, md: 2 },
              borderTop: "1px solid",
              borderColor: "neutral.outlinedBorder",
              bgcolor: "background.level1",
            }}
          >
            <MentionInput
              value={threadMessageInput}
              onChange={setThreadMessageInput}
              onSend={handleSendThreadMessage}
              onMentionsChange={setThreadMentions}
              placeholder="Reply to thread... (use @ to mention)"
              agents={agentsList}
              inputStyles={inputStyles}
              sendButtonStyles={sendButtonStyles}
              sendLabel="Reply"
              disabled={!threadMessageInput.trim() || postMessageMutation.isPending}
              colors={colors}
              isDark={isDark}
            />
          </Box>
        </Box>
      )}
    </Card>
  );
}
