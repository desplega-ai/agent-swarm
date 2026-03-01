import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  useChannels,
  useMessages,
  usePostMessage,
  useThreadMessages,
} from "@/api/hooks/use-channels";
import { useAgents } from "@/api/hooks/use-agents";
import { formatRelativeTime, cn } from "@/lib/utils";
import { useAutoScroll } from "@/hooks/use-auto-scroll";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Hash,
  Lock,
  Send,
  MessageSquare,
  Copy,
  Check,
  Code,
  Type,
  Reply,
  X,
} from "lucide-react";
import type { Channel, ChannelMessage } from "@/api/types";

// --- Channel sidebar ---

function ChannelSidebar({
  channels,
  activeChannelId,
  onSelect,
}: {
  channels: Channel[];
  activeChannelId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="w-48 shrink-0 border-r border-border bg-muted/30 overflow-y-auto h-full">
      <div className="p-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Channels
      </div>
      <div className="space-y-0.5 px-2 pb-2">
        {channels.map((ch) => (
          <button
            key={ch.id}
            type="button"
            onClick={() => onSelect(ch.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
              activeChannelId === ch.id
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {ch.type === "dm" ? (
              <Lock className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <Hash className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="truncate text-xs">{ch.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// --- Message bubble with markdown, raw, copy, thread ---

function MessageBubble({
  message,
  agentMap,
  threadCount,
  onOpenThread,
}: {
  message: ChannelMessage;
  agentMap: Map<string, string>;
  threadCount?: number;
  onOpenThread?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const name =
    message.agentName ?? (message.agentId ? agentMap.get(message.agentId) : null) ?? "Human";
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [message.content]);

  const hasReplies = threadCount && threadCount > 0;

  return (
    <div
      className={cn("group relative flex gap-3 px-4 py-2 hover:bg-muted/20", onOpenThread && "md:cursor-default cursor-pointer")}
      onClick={onOpenThread ? () => { if (window.innerWidth < 768) onOpenThread(); } : undefined}
    >
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground mt-0.5">
        {initials}
      </div>
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold">{name}</span>
          <span className="text-[10px] text-muted-foreground">
            {formatRelativeTime(message.createdAt)}
          </span>

          {/* Action buttons — visible on hover */}
          <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setShowRaw(!showRaw)}
                    className={cn(
                      "h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
                      showRaw && "text-primary",
                    )}
                  >
                    {showRaw ? <Type className="h-3 w-3" /> : <Code className="h-3 w-3" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {showRaw ? "Show formatted" : "Show raw"}
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  >
                    {copied ? (
                      <Check className="h-3 w-3 text-emerald-400" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {copied ? "Copied!" : "Copy"}
                </TooltipContent>
              </Tooltip>

              {onOpenThread && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={onOpenThread}
                      className="h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    >
                      <Reply className="h-3 w-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    Reply in thread
                  </TooltipContent>
                </Tooltip>
              )}
            </TooltipProvider>
          </div>
        </div>

        {/* Message content */}
        {showRaw ? (
          <pre className="mt-1 text-xs font-mono whitespace-pre-wrap break-words text-foreground/80 bg-muted/30 rounded-md p-2 overflow-x-auto">
            {message.content}
          </pre>
        ) : (
          <div className="mt-0.5 text-sm text-foreground/90 prose-chat overflow-hidden break-words">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {message.content}
            </ReactMarkdown>
          </div>
        )}

        {/* Thread reply count */}
        {hasReplies && (
          <button
            type="button"
            onClick={onOpenThread}
            className="mt-1 inline-flex items-center gap-1 text-[10px] font-semibold text-primary hover:underline"
          >
            <Reply className="h-3 w-3" />
            {threadCount} {threadCount === 1 ? "reply" : "replies"}
          </button>
        )}
      </div>
    </div>
  );
}

// --- Message input ---

function MessageInput({
  channelId,
  channelName,
  replyToId,
  placeholder,
}: {
  channelId: string;
  channelName?: string;
  replyToId?: string;
  placeholder?: string;
}) {
  const [content, setContent] = useState("");
  const postMessage = usePostMessage(channelId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = content.trim();
    if (!trimmed) return;
    postMessage.mutate({
      content: trimmed,
      replyToId,
    });
    setContent("");
    textareaRef.current?.focus();
  }, [content, postMessage, replyToId]);

  return (
    <div className="border-t border-border p-2 shrink-0">
      <div className="flex gap-2">
        <Textarea
          ref={textareaRef}
          placeholder={placeholder ?? `Message #${channelName ?? "channel"}...`}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          className="min-h-[36px] max-h-24 resize-none text-sm"
          rows={1}
        />
        <Button
          size="icon"
          onClick={handleSend}
          disabled={!content.trim() || postMessage.isPending}
          className="shrink-0 h-9 w-9 bg-primary hover:bg-primary/90"
        >
          <Send className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

// --- Thread panel ---

function ThreadPanel({
  channelId,
  parentMessage,
  agentMap,
  onClose,
}: {
  channelId: string;
  parentMessage: ChannelMessage;
  agentMap: Map<string, string>;
  onClose: () => void;
}) {
  const { data: threadMessages } = useThreadMessages(channelId, parentMessage.id);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  useAutoScroll(scrollEl, [threadMessages]);

  return (
    <div className="absolute inset-0 md:relative md:inset-auto md:w-80 shrink-0 border-l border-border flex flex-col min-h-0 bg-background z-10">
      {/* Thread header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Thread
        </span>
        <button
          type="button"
          onClick={onClose}
          className="h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Parent message */}
      <div className="border-b border-border/50">
        <MessageBubble message={parentMessage} agentMap={agentMap} />
      </div>

      {/* Thread replies */}
      <div ref={setScrollEl} className="flex-1 min-h-0 overflow-y-auto">
        {threadMessages && threadMessages.length > 0 ? (
          <div className="py-1">
            {threadMessages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} agentMap={agentMap} />
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <p className="text-xs">No replies yet</p>
          </div>
        )}
      </div>

      {/* Thread reply input */}
      <MessageInput
        channelId={channelId}
        replyToId={parentMessage.id}
        placeholder="Reply..."
      />
    </div>
  );
}

// --- Main chat page ---

export default function ChatPage() {
  const { channelId: urlChannelId } = useParams<{ channelId?: string }>();
  const { data: channels, isLoading: channelsLoading } = useChannels();
  const { data: agents } = useAgents();
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    agents?.forEach((a) => m.set(a.id, a.name));
    return m;
  }, [agents]);

  useEffect(() => {
    if (urlChannelId && channels?.some((c) => c.id === urlChannelId)) {
      setActiveChannelId(urlChannelId);
    } else if (!activeChannelId && channels && channels.length > 0) {
      setActiveChannelId(channels[0].id);
    }
  }, [channels, activeChannelId, urlChannelId]);

  const activeChannel = channels?.find((c) => c.id === activeChannelId);

  const { data: messages, isLoading: messagesLoading } = useMessages(activeChannelId ?? "", {
    limit: 200,
  });

  // Close thread when switching channels
  useEffect(() => {
    setSelectedThreadId(null);
  }, [activeChannelId]);

  // Count replies per top-level message
  const replyCounts = useMemo(() => {
    const counts = new Map<string, number>();
    messages?.forEach((msg) => {
      if (msg.replyToId) {
        counts.set(msg.replyToId, (counts.get(msg.replyToId) || 0) + 1);
      }
    });
    return counts;
  }, [messages]);

  // Only show top-level messages in main view
  const topLevelMessages = useMemo(
    () => messages?.filter((msg) => !msg.replyToId) ?? [],
    [messages],
  );

  // Find selected thread parent message
  const threadParent = useMemo(
    () => (selectedThreadId ? messages?.find((m) => m.id === selectedThreadId) ?? null : null),
    [selectedThreadId, messages],
  );

  // Auto-scroll for main messages
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  useAutoScroll(scrollEl, [topLevelMessages]);

  if (channelsLoading) {
    return (
      <div className="flex flex-col flex-1 min-h-0 gap-4">
        <h1 className="text-xl font-semibold">Chat</h1>
        <Skeleton className="flex-1 min-h-0 w-full rounded-lg" />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3 overflow-hidden">
      <div className="flex items-center gap-3 shrink-0">
        <h1 className="text-xl font-semibold">Chat</h1>

        {/* Mobile channel selector */}
        {channels && channels.length > 0 && (
          <div className="md:hidden flex-1">
            <Select
              value={activeChannelId ?? ""}
              onValueChange={(v) => setActiveChannelId(v)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select channel" />
              </SelectTrigger>
              <SelectContent>
                {channels.map((ch) => (
                  <SelectItem key={ch.id} value={ch.id}>
                    {ch.type === "dm" ? "🔒 " : "# "}{ch.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <div className="relative flex flex-1 min-h-0 min-w-0 overflow-hidden rounded-lg border border-border bg-background">
        {/* Channel sidebar — hidden on mobile */}
        <div className="hidden md:flex shrink-0">
          <ChannelSidebar
            channels={channels ?? []}
            activeChannelId={activeChannelId}
            onSelect={setActiveChannelId}
          />
        </div>

        {/* Main message area */}
        <div className="flex flex-1 flex-col min-w-0 min-h-0">
          {activeChannel ? (
            <>
              {/* Channel header */}
              <div className="flex items-center gap-2 border-b border-border px-4 py-2 shrink-0">
                <Hash className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-sm font-semibold truncate">{activeChannel.name}</span>
                {activeChannel.description && (
                  <span className="text-xs text-muted-foreground truncate hidden sm:inline">
                    — {activeChannel.description}
                  </span>
                )}
              </div>

              {/* Messages scroll area */}
              <div
                ref={setScrollEl}
                className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
              >
                {messagesLoading ? (
                  <div className="space-y-4 p-4">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <div key={i} className="flex gap-3">
                        <Skeleton className="h-7 w-7 rounded-full shrink-0" />
                        <div className="space-y-1">
                          <Skeleton className="h-3 w-20" />
                          <Skeleton className="h-3 w-48" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : topLevelMessages.length > 0 ? (
                  <div className="py-1">
                    {topLevelMessages.map((msg) => (
                      <MessageBubble
                        key={msg.id}
                        message={msg}
                        agentMap={agentMap}
                        threadCount={replyCounts.get(msg.id)}
                        onOpenThread={() => setSelectedThreadId(msg.id)}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                    <MessageSquare className="h-8 w-8 mb-2 opacity-40" />
                    <p className="text-xs">No messages yet</p>
                  </div>
                )}
              </div>

              {/* Message input */}
              <MessageInput
                channelId={activeChannelId!}
                channelName={activeChannel.name}
              />
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-muted-foreground">
              <div className="text-center">
                <MessageSquare className="mx-auto h-8 w-8 mb-2 opacity-40" />
                <p className="text-xs">Select a channel to start chatting</p>
              </div>
            </div>
          )}
        </div>

        {/* Thread panel (side panel) */}
        {threadParent && activeChannelId && (
          <ThreadPanel
            channelId={activeChannelId}
            parentMessage={threadParent}
            agentMap={agentMap}
            onClose={() => setSelectedThreadId(null)}
          />
        )}
      </div>
    </div>
  );
}
