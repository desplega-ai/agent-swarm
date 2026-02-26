import { useState, useRef, useEffect, useCallback } from "react";
import { useParams } from "react-router-dom";
import { useChannels, useMessages, usePostMessage } from "@/api/hooks/use-channels";
import { useAgents } from "@/api/hooks/use-agents";
import { formatRelativeTime, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

import { Skeleton } from "@/components/ui/skeleton";
import { Hash, Lock, Send, MessageSquare } from "lucide-react";
import type { Channel, ChannelMessage } from "@/api/types";

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
    <div className="w-56 shrink-0 border-r border-border bg-zinc-950/40">
      <div className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Channels
      </div>
      <div className="space-y-0.5 px-2">
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
            <span className="truncate">{ch.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  agentMap,
}: {
  message: ChannelMessage;
  agentMap: Map<string, string>;
}) {
  const name =
    message.agentName ?? (message.agentId ? agentMap.get(message.agentId) : null) ?? "Unknown";
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="group flex gap-3 px-4 py-2 hover:bg-muted/30">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold text-muted-foreground">
        {initials}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold">{name}</span>
          <span className="text-[10px] text-muted-foreground">
            {formatRelativeTime(message.createdAt)}
          </span>
        </div>
        <p className="text-sm text-foreground/90 whitespace-pre-wrap break-words">
          {message.content}
        </p>
      </div>
    </div>
  );
}

function MessageInput({
  channelId,
  channelName,
}: {
  channelId: string;
  channelName: string;
}) {
  const [content, setContent] = useState("");
  const postMessage = usePostMessage(channelId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = content.trim();
    if (!trimmed) return;
    postMessage.mutate({ content: trimmed });
    setContent("");
    textareaRef.current?.focus();
  }, [content, postMessage]);

  return (
    <div className="border-t border-border p-3">
      <div className="flex gap-2">
        <Textarea
          ref={textareaRef}
          placeholder={`Message #${channelName}...`}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          className="min-h-[40px] max-h-32 resize-none"
          rows={1}
        />
        <Button
          size="icon"
          onClick={handleSend}
          disabled={!content.trim() || postMessage.isPending}
          className="shrink-0 bg-primary hover:bg-primary/90"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

export default function ChatPage() {
  const { channelId: urlChannelId } = useParams<{ channelId?: string }>();
  const { data: channels, isLoading: channelsLoading } = useChannels();
  const { data: agents } = useAgents();
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);

  const agentMap = new Map<string, string>();
  agents?.forEach((a) => agentMap.set(a.id, a.name));

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

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (channelsLoading) {
    return (
      <div className="flex flex-col flex-1 min-h-0 gap-4">
        <h1 className="text-xl font-semibold">Chat</h1>
        <Skeleton className="flex-1 min-h-0 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <h1 className="text-xl font-semibold">Chat</h1>
      <div className="flex flex-1 min-h-0 overflow-hidden rounded-lg border border-border bg-background">
        <ChannelSidebar
          channels={channels ?? []}
          activeChannelId={activeChannelId}
          onSelect={setActiveChannelId}
        />

        <div className="flex flex-1 flex-col min-w-0">
          {activeChannel ? (
            <>
              <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                <Hash className="h-4 w-4 text-muted-foreground" />
                <span className="font-semibold">{activeChannel.name}</span>
                {activeChannel.description && (
                  <span className="text-sm text-muted-foreground">
                    — {activeChannel.description}
                  </span>
                )}
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto">
                <div className="py-4">
                  {messagesLoading ? (
                    <div className="space-y-4 p-4">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <div key={i} className="flex gap-3">
                          <Skeleton className="h-8 w-8 rounded-full" />
                          <div className="space-y-1">
                            <Skeleton className="h-4 w-24" />
                            <Skeleton className="h-4 w-64" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : messages && messages.length > 0 ? (
                    messages.map((msg) => (
                      <MessageBubble key={msg.id} message={msg} agentMap={agentMap} />
                    ))
                  ) : (
                    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                      <MessageSquare className="h-8 w-8 mb-2" />
                      <p className="text-sm">No messages yet</p>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>
              </div>

              <MessageInput channelId={activeChannelId!} channelName={activeChannel.name} />
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-muted-foreground">
              <div className="text-center">
                <MessageSquare className="mx-auto h-8 w-8 mb-2" />
                <p className="text-sm">Select a channel to start chatting</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
