import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import Box from "@mui/joy/Box";
import Typography from "@mui/joy/Typography";
import Input from "@mui/joy/Input";
import IconButton from "@mui/joy/IconButton";
import Card from "@mui/joy/Card";
import Link from "@mui/joy/Link";
import Tooltip from "@mui/joy/Tooltip";
import { useColorScheme } from "@mui/joy/styles";
import { useChannels, useMessages, useThreadMessages, usePostMessage, useAgents } from "../hooks/queries";
import type { ChannelMessage, Agent } from "../types/api";
import { formatSmartTime } from "@/lib/utils";

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

function MentionInput({
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
  const inputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  // Filter agents based on query
  const filteredAgents = useMemo(() => {
    if (!mentionQuery) return agents;
    const query = mentionQuery.toLowerCase();
    return agents.filter(
      (agent) =>
        agent.name.toLowerCase().includes(query) ||
        (agent.role && agent.role.toLowerCase().includes(query))
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

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
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
    <Box sx={{ position: "relative", display: "flex", gap: 1.5, flex: 1 }}>
      <Input
        ref={inputRef}
        placeholder={placeholder}
        value={value}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
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
            boxShadow: isDark
              ? "0 4px 20px rgba(0, 0, 0, 0.5)"
              : "0 4px 20px rgba(0, 0, 0, 0.15)",
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
                <Typography
                  sx={{
                    fontFamily: "'Space Grotesk', sans-serif",
                    fontWeight: 600,
                    fontSize: "0.85rem",
                    color: colors.amber,
                  }}
                >
                  {agent.name}
                </Typography>
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

      <Box
        component="button"
        onClick={onSend}
        disabled={disabled}
        sx={sendButtonStyles}
      >
        {sendLabel}
      </Box>
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
  isSelected?: boolean;
  agentsByName?: Map<string, string>; // name -> id mapping for @mentions
}

function MessageItem({
  message,
  isDark,
  colors,
  onOpenThread,
  threadCount,
  isThreadView,
  onAgentClick,
  isSelected,
  agentsByName,
}: MessageItemProps) {
  const [copied, setCopied] = useState(false);
  const hasReplies = threadCount && threadCount > 0;

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [message.content]);

  // Parse message content to make @mentions clickable
  const renderContent = useMemo(() => {
    if (!agentsByName || agentsByName.size === 0) {
      return message.content;
    }

    // Split by @mention pattern
    const mentionPattern = /@(\w+)/g;
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match;

    while ((match = mentionPattern.exec(message.content)) !== null) {
      // Add text before the mention
      if (match.index > lastIndex) {
        parts.push(message.content.slice(lastIndex, match.index));
      }

      const mentionName = match[1] ?? "";
      const agentId = agentsByName.get(mentionName);

      if (agentId && onAgentClick) {
        const clickAgentId = agentId; // capture for closure
        // Clickable mention
        parts.push(
          <Link
            key={`${match.index}-${mentionName}`}
            component="button"
            onClick={(e) => {
              e.stopPropagation();
              onAgentClick(clickAgentId);
            }}
            sx={{
              fontFamily: "'Space Grotesk', sans-serif",
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
                bgcolor: isDark ? "rgba(245, 166, 35, 0.15)" : "rgba(212, 136, 6, 0.12)",
              },
            }}
          >
            @{mentionName}
          </Link>
        );
      } else {
        // Non-linked mention (agent not found)
        parts.push(
          <Box
            key={`${match.index}-${mentionName}`}
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
          </Box>
        );
      }

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < message.content.length) {
      parts.push(message.content.slice(lastIndex));
    }

    return parts.length > 0 ? parts : message.content;
  }, [message.content, agentsByName, onAgentClick, colors, isDark]);

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
          : isDark ? "rgba(26, 19, 14, 0.5)" : "rgba(255, 255, 255, 0.5)",
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
        {/* Agent indicator dot */}
        <Box
          sx={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            bgcolor: message.agentId ? colors.amber : colors.blue,
            flexShrink: 0,
            boxShadow: message.agentId
              ? (isDark ? "0 0 6px rgba(245, 166, 35, 0.4)" : "0 0 4px rgba(212, 136, 6, 0.3)")
              : "0 0 6px rgba(59, 130, 246, 0.4)",
          }}
        />

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
              color: colors.amber,
              textDecoration: "none",
              cursor: "pointer",
              "&:hover": {
                textDecoration: "underline",
                color: colors.honey,
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
              color: message.agentId ? colors.amber : colors.blue,
            }}
          >
            {message.agentName || "Human"}
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
        <Box className="action-icons" sx={{ display: "flex", gap: 0.5, opacity: 0, transition: "opacity 0.2s ease" }}>
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
      <Typography
        component="div"
        sx={{
          fontFamily: "'Space Grotesk', sans-serif",
          fontSize: "0.85rem",
          color: "text.primary",
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          pl: 2.25,
        }}
      >
        {renderContent}
      </Typography>
    </Box>
  );
}

interface ChatPanelProps {
  selectedChannelId?: string | null;
  selectedThreadId?: string | null;
  onSelectChannel?: (channelId: string | null) => void;
  onSelectThread?: (threadId: string | null) => void;
  onNavigateToAgent?: (agentId: string) => void;
}

export default function ChatPanel({
  selectedChannelId: controlledChannelId,
  selectedThreadId: controlledThreadId,
  onSelectChannel,
  onSelectThread,
  onNavigateToAgent,
}: ChatPanelProps) {
  // Internal state for uncontrolled mode
  const [internalChannelId, setInternalChannelId] = useState<string | null>(null);
  const [internalThreadId, setInternalThreadId] = useState<string | null>(null);
  const [messageInput, setMessageInput] = useState("");
  const [threadMessageInput, setThreadMessageInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);

  // Use controlled or internal state
  const selectedChannelId = controlledChannelId !== undefined ? controlledChannelId : internalChannelId;
  const selectedThreadId = controlledThreadId !== undefined ? controlledThreadId : internalThreadId;

  const setSelectedChannelId = useCallback((id: string | null) => {
    if (onSelectChannel) {
      onSelectChannel(id);
    } else {
      setInternalChannelId(id);
    }
  }, [onSelectChannel]);

  const setSelectedThreadId = useCallback((id: string | null) => {
    if (onSelectThread) {
      onSelectThread(id);
    } else {
      setInternalThreadId(id);
    }
  }, [onSelectThread]);

  const { mode } = useColorScheme();
  const isDark = mode === "dark";

  const colors = {
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
  };

  const { data: channels, isLoading: channelsLoading } = useChannels();
  const { data: messages, isLoading: messagesLoading } = useMessages(selectedChannelId || "");
  const { data: threadMessages } = useThreadMessages(
    selectedChannelId || "",
    selectedThreadId || ""
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

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
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
  }, [threadMessageInput, selectedChannelId, selectedThreadMessage, postMessageMutation, threadMentions]);

  const handleOpenThread = useCallback((message: ChannelMessage) => {
    setSelectedThreadId(message.id);
  }, [setSelectedThreadId]);

  const handleCloseThread = useCallback(() => {
    setSelectedThreadId(null);
  }, [setSelectedThreadId]);

  const handleAgentClick = useCallback((agentId: string) => {
    if (onNavigateToAgent) {
      onNavigateToAgent(agentId);
    }
  }, [onNavigateToAgent]);

  // Input styles shared between main and thread
  const inputStyles = {
    flex: 1,
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: "0.875rem",
    bgcolor: colors.inputBg,
    borderColor: colors.inputBorder,
    borderRadius: "8px",
    "--Input-focusedThickness": "2px",
    "--Input-focusedHighlight": colors.amber,
    "&:hover": {
      borderColor: isDark ? "#4A3A2F" : "#D1C5B4",
    },
    "&:focus-within": {
      borderColor: colors.amber,
      boxShadow: isDark ? "0 0 0 2px rgba(245, 166, 35, 0.15)" : "0 0 0 2px rgba(212, 136, 6, 0.1)",
    },
    "& input": {
      fontFamily: "'Space Grotesk', sans-serif",
      color: isDark ? "#FFF8E7" : "#1A130E",
    },
    "& input::placeholder": {
      color: isDark ? "#8B7355" : "#8B7355",
      fontFamily: "'Space Grotesk', sans-serif",
    },
  };

  const sendButtonStyles = {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: "0.8rem",
    fontWeight: 600,
    letterSpacing: "0.03em",
    px: 2.5,
    borderRadius: "8px",
    bgcolor: colors.amber,
    color: isDark ? "#1A130E" : "#FFFFFF",
    border: "none",
    transition: "all 0.2s ease",
    "&:hover": {
      bgcolor: colors.honey,
      transform: "translateY(-1px)",
      boxShadow: isDark ? "0 4px 12px rgba(245, 166, 35, 0.3)" : "0 4px 12px rgba(212, 136, 6, 0.2)",
    },
    "&:active": {
      transform: "translateY(0)",
    },
    "&:disabled": {
      opacity: 0.5,
      transform: "none",
      boxShadow: "none",
    },
  };

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
        borderRadius: "12px",
        gap: 0,
      }}
    >
      {/* Channel List - Fixed width */}
      <Box
        sx={{
          width: 220,
          flexShrink: 0,
          borderRight: "1px solid",
          borderColor: "neutral.outlinedBorder",
          display: "flex",
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

        {/* Channel list */}
        <Box sx={{ flex: 1, overflow: "auto", p: 1 }}>
          {channelsLoading ? (
            <Typography sx={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "0.8rem", color: "text.tertiary", p: 1.5 }}>
              Loading...
            </Typography>
          ) : !channels || channels.length === 0 ? (
            <Typography sx={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "0.8rem", color: "text.tertiary", p: 1.5 }}>
              No channels
            </Typography>
          ) : (
            channels.map((channel) => (
              <Box
                key={channel.id}
                onClick={() => {
                  setSelectedChannelId(channel.id);
                  setSelectedThreadId(null);
                }}
                sx={{
                  px: 1.5,
                  py: 1,
                  borderRadius: "6px",
                  cursor: "pointer",
                  bgcolor: selectedChannelId === channel.id ? colors.selectedBg : "transparent",
                  border: "1px solid",
                  borderColor: selectedChannelId === channel.id ? colors.amberBorder : "transparent",
                  transition: "all 0.15s ease",
                  mb: 0.5,
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
      </Box>

      {/* Messages Panel - Flex, equal split with thread */}
      <Box
        sx={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          minWidth: 0,
        }}
      >
        {/* Channel header with title and description */}
        <Box
          sx={{
            px: 2.5,
            py: 1.5,
            borderBottom: "1px solid",
            borderColor: "neutral.outlinedBorder",
            bgcolor: "background.level1",
            height: 64,
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
          }}
        >
          <Typography
            sx={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 600,
              fontSize: "1rem",
              color: "text.primary",
              mb: 0.25,
            }}
          >
            # {selectedChannel?.name || "Select a channel"}
          </Typography>
          {selectedChannel?.description && (
            <Typography
              sx={{
                fontFamily: "'Space Grotesk', sans-serif",
                fontSize: "0.75rem",
                color: "text.tertiary",
                lineHeight: 1.4,
              }}
            >
              {selectedChannel.description}
            </Typography>
          )}
        </Box>

        {/* Messages list */}
        <Box
          sx={{
            flex: 1,
            overflow: "auto",
            py: 1,
            bgcolor: isDark ? "rgba(13, 9, 6, 0.2)" : "rgba(253, 248, 243, 0.5)",
          }}
        >
          {messagesLoading ? (
            <Typography sx={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "0.85rem", color: "text.tertiary", p: 3 }}>
              Loading messages...
            </Typography>
          ) : topLevelMessages.length === 0 ? (
            <Box sx={{ p: 3, textAlign: "center" }}>
              <Typography sx={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "0.9rem", color: "text.tertiary", mb: 1 }}>
                No messages yet
              </Typography>
              <Typography sx={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "0.8rem", color: "text.tertiary" }}>
                Start the conversation!
              </Typography>
            </Box>
          ) : (
            <>
              {topLevelMessages.map((message) => (
                <MessageItem
                  key={message.id}
                  message={message}
                  isDark={isDark}
                  colors={colors}
                  onOpenThread={() => handleOpenThread(message)}
                  threadCount={replyCounts.get(message.id)}
                  onAgentClick={handleAgentClick}
                  isSelected={selectedThreadMessage?.id === message.id}
                  agentsByName={agentsByName}
                />
              ))}
              <div ref={messagesEndRef} />
            </>
          )}
        </Box>

        {/* Message input */}
        <Box
          sx={{
            p: 2,
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

      {/* Thread Panel - Equal width to messages */}
      {selectedThreadMessage && (
        <Box
          sx={{
            flex: 1,
            minWidth: 0,
            borderLeft: "1px solid",
            borderColor: "neutral.outlinedBorder",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            bgcolor: isDark ? "rgba(37, 28, 21, 0.3)" : "rgba(245, 237, 228, 0.3)",
          }}
        >
          {/* Thread header */}
          <Box
            sx={{
              px: 2.5,
              py: 1.5,
              borderBottom: "1px solid",
              borderColor: "neutral.outlinedBorder",
              bgcolor: "background.level1",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              height: 64,
            }}
          >
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Box
                sx={{
                  width: 8,
                  height: 10,
                  clipPath: "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)",
                  bgcolor: colors.gold,
                  boxShadow: isDark ? "0 0 6px rgba(212, 165, 116, 0.4)" : "0 0 4px rgba(139, 105, 20, 0.3)",
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
            <Tooltip title="Close thread" placement="bottom">
              <IconButton
                size="sm"
                variant="plain"
                onClick={handleCloseThread}
                sx={{
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
            }}
          >
            <MessageItem
              message={selectedThreadMessage}
              isDark={isDark}
              colors={colors}
              isThreadView
              onAgentClick={handleAgentClick}
              agentsByName={agentsByName}
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
              {threadMessages?.length || 0} {(threadMessages?.length || 0) === 1 ? "REPLY" : "REPLIES"}
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
                    agentsByName={agentsByName}
                  />
                ))}
                <div ref={threadEndRef} />
              </>
            ) : (
              <Box sx={{ p: 3, textAlign: "center" }}>
                <Typography sx={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "0.85rem", color: "text.tertiary" }}>
                  No replies yet
                </Typography>
              </Box>
            )}
          </Box>

          {/* Thread message input */}
          <Box
            sx={{
              p: 2,
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
