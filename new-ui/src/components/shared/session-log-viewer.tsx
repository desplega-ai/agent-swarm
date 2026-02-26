import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAutoScroll } from "@/hooks/use-auto-scroll";
import {
  ArrowDown,
  Bot,
  ChevronDown,
  ChevronRight,
  Terminal,
  User,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionLog } from "@/api/types";

// --- Parsed message types ---

interface TextBlock {
  type: "text";
  text: string;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock;

interface ParsedMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
  model?: string;
  iteration: number;
  timestamp: string;
}

// --- Parsing ---

function parseSessionLogs(logs: SessionLog[]): ParsedMessage[] {
  // Sort chronologically: by timestamp first, then lineNumber as tiebreaker
  // lineNumber represents parallel messages within the same turn (e.g. parallel tool calls)
  const sorted = [...logs].sort((a, b) => {
    const timeA = new Date(a.createdAt).getTime();
    const timeB = new Date(b.createdAt).getTime();
    if (timeA !== timeB) return timeA - timeB;
    return a.lineNumber - b.lineNumber;
  });

  const messages: ParsedMessage[] = [];

  for (const log of sorted) {
    let parsed: { type?: string; message?: { role?: string; content?: unknown; model?: string; id?: string } } | null =
      null;
    try {
      parsed = JSON.parse(log.content);
    } catch {
      // Non-JSON line — treat as system/raw text
      messages.push({
        id: log.id,
        role: "system",
        content: [{ type: "text", text: log.content }],
        iteration: log.iteration,
        timestamp: log.createdAt,
      });
      continue;
    }

    if (!parsed?.message?.content) continue;

    const rawContent = parsed.message.content;
    const blocks: ContentBlock[] = [];

    if (typeof rawContent === "string") {
      blocks.push({ type: "text", text: rawContent });
    } else if (Array.isArray(rawContent)) {
      for (const block of rawContent) {
        if (block.type === "text" && block.text) {
          blocks.push({ type: "text", text: block.text });
        } else if (block.type === "thinking" && block.thinking) {
          blocks.push({ type: "thinking", thinking: block.thinking });
        } else if (block.type === "tool_use") {
          blocks.push({
            type: "tool_use",
            id: block.id ?? "",
            name: block.name ?? "unknown",
            input: block.input,
          });
        } else if (block.type === "tool_result") {
          const text =
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content);
          blocks.push({
            type: "tool_result",
            tool_use_id: block.tool_use_id ?? "",
            content: text,
          });
        }
      }
    }

    if (blocks.length === 0) continue;

    const role =
      parsed.type === "assistant" || parsed.message.role === "assistant"
        ? "assistant"
        : "user";

    messages.push({
      id: log.id,
      role,
      content: blocks,
      model: parsed.message.model,
      iteration: log.iteration,
      timestamp: log.createdAt,
    });
  }

  return messages;
}

// --- Components ---

function ThinkingBubble({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = text.slice(0, 120) + (text.length > 120 ? "..." : "");

  return (
    <div className="rounded-md border border-border/50 bg-muted/30 px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors w-full text-left"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <span className="italic">Thinking...</span>
      </button>
      <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">
        {open ? text : preview}
      </p>
    </div>
  );
}

function ToolUseBubble({ name, input }: { name: string; input: unknown }) {
  const [open, setOpen] = useState(false);
  const inputStr = typeof input === "string" ? input : JSON.stringify(input, null, 2);

  return (
    <div className="rounded-md border border-border/50 bg-muted/30 px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs w-full text-left"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <Wrench className="h-3 w-3 shrink-0 text-primary" />
        <span className="font-medium text-primary">{name}</span>
      </button>
      {open && (
        <pre className="mt-2 text-[11px] text-muted-foreground whitespace-pre-wrap break-all overflow-auto max-h-48">
          {inputStr}
        </pre>
      )}
    </div>
  );
}

function ToolResultBubble({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  let display = content;
  try {
    const parsed = JSON.parse(content);
    display = JSON.stringify(parsed, null, 2);
  } catch {
    // keep as-is
  }
  const isLong = display.length > 200;
  const preview = isLong ? display.slice(0, 200) + "..." : display;

  return (
    <div className="rounded-md border border-border/50 bg-muted/30 px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors w-full text-left"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <Terminal className="h-3 w-3 shrink-0" />
        <span>Tool result</span>
      </button>
      {(open || !isLong) && (
        <pre className="mt-1 text-[11px] text-muted-foreground whitespace-pre-wrap break-all overflow-auto max-h-64">
          {open ? display : preview}
        </pre>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: ParsedMessage }) {
  const isAssistant = message.role === "assistant";
  const isSystem = message.role === "system";

  return (
    <div className={cn("flex gap-3 px-4 py-3", isAssistant ? "" : "bg-muted/20")}>
      <div
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full mt-0.5",
          isAssistant
            ? "bg-primary/15 text-primary"
            : isSystem
              ? "bg-muted text-muted-foreground"
              : "bg-muted text-muted-foreground",
        )}
      >
        {isAssistant ? (
          <Bot className="h-3.5 w-3.5" />
        ) : (
          <User className="h-3.5 w-3.5" />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold text-muted-foreground">
            {isAssistant ? "Agent" : isSystem ? "System" : "Tool"}
          </span>
          {message.model && (
            <span className="text-[10px] text-muted-foreground/60 font-mono">{message.model}</span>
          )}
          <span className="ml-auto text-[10px] text-muted-foreground/50 font-mono">
            {new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
        </div>
        {message.content.map((block, i) => {
          const key = `${message.id}-${i}`;
          switch (block.type) {
            case "text":
              return (
                <p key={key} className="text-sm text-foreground whitespace-pre-wrap break-words">
                  {block.text}
                </p>
              );
            case "thinking":
              return <ThinkingBubble key={key} text={block.thinking} />;
            case "tool_use":
              return <ToolUseBubble key={key} name={block.name} input={block.input} />;
            case "tool_result":
              return <ToolResultBubble key={key} content={block.content} />;
            default:
              return null;
          }
        })}
      </div>
    </div>
  );
}

function IterationDivider({ iteration }: { iteration: number }) {
  return (
    <div className="flex items-center gap-3 px-4 py-1.5">
      <div className="h-px flex-1 bg-border" />
      <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
        Iteration {iteration}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

// --- Main component ---

interface SessionLogViewerProps {
  logs: SessionLog[];
  className?: string;
}

export function SessionLogViewer({ logs, className }: SessionLogViewerProps) {
  const messages = useMemo(() => parseSessionLogs(logs), [logs]);

  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { isFollowing, scrollToBottom } = useAutoScroll(scrollEl, [logs]);

  // Group messages by iteration for dividers
  let lastIteration = -1;

  return (
    <div className={cn("flex flex-col rounded-lg border border-border bg-background overflow-hidden", className)}>
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/50">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Session Logs
        </span>
        {!isFollowing && (
          <Button
            size="sm"
            variant="ghost"
            onClick={scrollToBottom}
            className="gap-1 h-6 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowDown className="h-3 w-3" />
            Follow
          </Button>
        )}
      </div>
      <div
        ref={(el) => {
          scrollRef.current = el;
          setScrollEl(el);
        }}
        className="flex-1 min-h-0 overflow-auto"
      >
        {messages.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            No session data
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {messages.map((msg) => {
              const showDivider = msg.iteration !== lastIteration;
              lastIteration = msg.iteration;
              return (
                <div key={msg.id}>
                  {showDivider && <IterationDivider iteration={msg.iteration} />}
                  <MessageBubble message={msg} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
