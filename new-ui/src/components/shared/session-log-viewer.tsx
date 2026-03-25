import {
  ArrowDown,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Terminal,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SessionLog } from "@/api/types";
import { Button } from "@/components/ui/button";
import { JsonTree } from "@/components/workflows/json-tree";
import { useAutoScroll } from "@/hooks/use-auto-scroll";
import { cn } from "@/lib/utils";

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
    let parsed: {
      type?: string;
      message?: { role?: string; content?: unknown; model?: string; id?: string };
    } | null = null;
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
            typeof block.content === "string" ? block.content : JSON.stringify(block.content);
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
      parsed.type === "assistant" || parsed.message.role === "assistant" ? "assistant" : "user";

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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(null);

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      navigator.clipboard.writeText(text);
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 1500);
    },
    [text],
  );

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="ml-auto text-muted-foreground/50 hover:text-muted-foreground transition-colors"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function ThinkingBubble({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = text.slice(0, 200) + (text.length > 200 ? "..." : "");

  return (
    <div className="rounded-md border border-border/50 border-l-2 border-l-primary/40 bg-muted/20 px-3 py-2">
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
        <Brain className="h-3 w-3 shrink-0 text-primary/60" />
        <span className="italic">Thinking...</span>
      </button>
      {open ? (
        <div className="mt-1 text-xs text-muted-foreground prose-chat prose-session-log">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">{preview}</p>
      )}
    </div>
  );
}

function ToolUseBubble({ name, input }: { name: string; input: unknown }) {
  const [open, setOpen] = useState(false);
  const inputStr = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  const isObject = typeof input === "object" && input !== null;

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
        <span className="font-mono text-[11px] font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded">
          {name}
        </span>
        <CopyButton text={inputStr} />
      </button>
      {open &&
        (isObject ? (
          <JsonTree data={input} defaultExpandDepth={2} maxHeight="192px" className="mt-2" />
        ) : (
          <pre className="mt-2 text-[11px] text-muted-foreground whitespace-pre-wrap break-all overflow-auto max-h-48">
            {inputStr}
          </pre>
        ))}
    </div>
  );
}

function ToolResultBubble({ content }: { content: string }) {
  const [open, setOpen] = useState(false);

  const parsedJson = useMemo(() => {
    try {
      const parsed = JSON.parse(content);
      return typeof parsed === "object" && parsed !== null ? parsed : null;
    } catch {
      return null;
    }
  }, [content]);

  const previewText = useMemo(() => {
    if (parsedJson) {
      const keys = Array.isArray(parsedJson) ? parsedJson.length : Object.keys(parsedJson).length;
      const label = Array.isArray(parsedJson) ? "items" : "keys";
      return `{ ${keys} ${label} }`;
    }
    const lines = content.split("\n");
    return lines.length > 3 ? `${lines.slice(0, 3).join("\n")}...` : content;
  }, [content, parsedJson]);

  const isLong = parsedJson !== null || content.split("\n").length > 3 || content.length > 200;

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
        <CopyButton text={content} />
      </button>
      {!open && isLong && (
        <pre className="mt-1 text-[11px] text-muted-foreground whitespace-pre-wrap break-all">
          {previewText}
        </pre>
      )}
      {!open && !isLong && (
        <pre className="mt-1 text-[11px] text-muted-foreground whitespace-pre-wrap break-all">
          {content}
        </pre>
      )}
      {open &&
        (parsedJson ? (
          <JsonTree data={parsedJson} defaultExpandDepth={1} maxHeight="256px" className="mt-2" />
        ) : (
          <pre className="mt-2 text-[11px] text-muted-foreground whitespace-pre-wrap break-all overflow-auto max-h-64">
            {content}
          </pre>
        ))}
    </div>
  );
}

function MessageBubble({ message }: { message: ParsedMessage }) {
  const isAssistant = message.role === "assistant";
  const isSystem = message.role === "system";

  return (
    <div
      className={cn(
        "px-4 py-2.5",
        isAssistant
          ? "border-l-2 border-l-primary/30"
          : isSystem
            ? "bg-muted/10"
            : "border-l-2 border-l-muted-foreground/20",
      )}
    >
      <div className="min-w-0 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold text-muted-foreground">
            {isAssistant ? "Agent" : isSystem ? "System" : "Tool"}
          </span>
          {message.model && (
            <span className="text-[9px] text-muted-foreground/40 font-mono">{message.model}</span>
          )}
          <span className="ml-auto text-[10px] text-muted-foreground/50 font-mono">
            {new Date(message.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
        </div>
        {message.content.map((block, i) => {
          const key = `${message.id}-${i}`;
          switch (block.type) {
            case "text":
              return (
                <div
                  key={key}
                  className="text-sm text-foreground prose-chat prose-session-log overflow-hidden break-words"
                >
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown>
                </div>
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
    <div className="flex items-center gap-3 px-4 py-2 bg-muted/30">
      <span className="text-[10px] font-semibold text-muted-foreground font-mono uppercase tracking-wider">
        Iteration {iteration}
      </span>
      <div className="h-px flex-1 bg-border/50" />
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

  // Pre-compute which messages start a new iteration
  const iterationStarts = useMemo(() => {
    const starts = new Set<string>();
    let prev = -1;
    for (const msg of messages) {
      if (msg.iteration !== prev) {
        starts.add(msg.id);
        prev = msg.iteration;
      }
    }
    return starts;
  }, [messages]);

  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border border-border bg-background overflow-hidden",
        className,
      )}
    >
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
              return (
                <div key={msg.id}>
                  {iterationStarts.has(msg.id) && <IterationDivider iteration={msg.iteration} />}
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
