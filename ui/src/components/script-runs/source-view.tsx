import { Check, Copy, WrapText } from "lucide-react";
import { Highlight, themes } from "prism-react-renderer";
import { useEffect, useMemo, useRef, useState } from "react";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";
import type { SourceAnchor, StepBlock } from "./source-map";
import { stepTypeMeta } from "./step-shared";

type Region =
  | { kind: "step"; blockIndex: number; stepType: string }
  | { kind: "input" }
  | { kind: "output" };

interface SourceViewProps {
  source: string;
  blocks: StepBlock[];
  inputAnchor: SourceAnchor | null;
  outputAnchor: SourceAnchor | null;
  selectedBlock: number | null;
  selectedAnchor: "input" | "output" | null;
  onSelectBlock: (index: number | null) => void;
  onSelectAnchor: (anchor: "input" | "output" | null) => void;
  className?: string;
}

const ANCHOR_STYLE = {
  input: {
    bg: "bg-status-info/10",
    rail: "border-l-status-info",
    edge: "border-status-info/50",
    label: "input",
    tag: "text-status-info-strong",
  },
  output: {
    bg: "bg-status-success/10",
    rail: "border-l-status-success",
    edge: "border-status-success/50",
    label: "output",
    tag: "text-status-success-strong",
  },
} as const;

/**
 * Read-only source viewer. Overlays each `ctx.step.*` call site (typed colors)
 * plus the run's input (args signature) and output (return) as clickable,
 * scrollable regions linked to the timeline sidebar.
 */
export function SourceView({
  source,
  blocks,
  inputAnchor,
  outputAnchor,
  selectedBlock,
  selectedAnchor,
  onSelectBlock,
  onSelectAnchor,
  className,
}: SourceViewProps) {
  const { theme } = useTheme();
  const { copied, copy } = useCopyToClipboard();
  const [wrap, setWrap] = useState(false);

  const lineInfo = useMemo(() => {
    const map = new Map<
      number,
      { region: Region; isStart: boolean; isEnd: boolean; key: string }
    >();
    const put = (startLine: number, endLine: number, region: Region, key: string) => {
      for (let ln = startLine; ln <= endLine; ln++) {
        if (!map.has(ln)) {
          map.set(ln, { region, isStart: ln === startLine, isEnd: ln === endLine, key });
        }
      }
    };
    blocks.forEach((b, i) => {
      put(
        b.startLine,
        b.endLine,
        { kind: "step", blockIndex: i, stepType: b.stepType },
        `step:${i}`,
      );
    });
    if (inputAnchor) put(inputAnchor.startLine, inputAnchor.endLine, { kind: "input" }, "input");
    if (outputAnchor)
      put(outputAnchor.startLine, outputAnchor.endLine, { kind: "output" }, "output");
    return map;
  }, [blocks, inputAnchor, outputAnchor]);

  const refs = useRef(new Map<string, HTMLDivElement>());
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = selectedAnchor ?? (selectedBlock !== null ? `step:${selectedBlock}` : null);
    if (!key) return;
    const row = refs.current.get(key);
    const container = scrollRef.current;
    if (!row || !container) return;
    const offset = row.getBoundingClientRect().top - container.getBoundingClientRect().top;
    const target = container.scrollTop + offset - container.clientHeight * 0.3;
    container.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }, [selectedBlock, selectedAnchor]);

  const isSelected = (region: Region): boolean => {
    if (region.kind === "step") return region.blockIndex === selectedBlock;
    return selectedAnchor === region.kind;
  };

  const onRegionClick = (region: Region, selected: boolean) => {
    if (region.kind === "step") onSelectBlock(selected ? null : region.blockIndex);
    else onSelectAnchor(selected ? null : region.kind);
  };

  return (
    <div
      className={cn("flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card", className)}
    >
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Source</h2>
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            typescript
          </span>
          {blocks.length > 0 && (
            <span className="text-xs text-muted-foreground">
              · {blocks.length} step {blocks.length === 1 ? "block" : "blocks"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setWrap((w) => !w)}
            aria-label={wrap ? "Disable line wrap" : "Enable line wrap"}
            aria-pressed={wrap}
            title={wrap ? "Disable line wrap" : "Wrap long lines"}
            className={cn(
              "inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted-foreground/15 hover:text-foreground",
              wrap && "bg-muted-foreground/15 text-foreground",
            )}
          >
            <WrapText className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => copy(source)}
            aria-label={copied ? "Copied" : "Copy source"}
            className={cn(
              "inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted-foreground/15 hover:text-foreground",
              copied && "text-status-success-strong",
            )}
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <Highlight
          code={source.replace(/\n$/, "")}
          language="tsx"
          theme={theme === "dark" ? themes.vsDark : themes.github}
        >
          {({ tokens, getLineProps, getTokenProps }) => (
            <pre
              className={cn(
                "m-0 py-2 font-mono text-xs leading-relaxed",
                // No-wrap: grow to the longest line (w-max) so row highlights/edges
                // span the full scroll width when scrolled right. min-w-full keeps
                // them filling the viewport when every line is short.
                wrap ? "min-w-full" : "w-max min-w-full",
              )}
            >
              {tokens.map((line, i) => {
                const info = lineInfo.get(i);
                const region = info?.region;
                const selected = region ? isSelected(region) : false;
                const meta = region?.kind === "step" ? stepTypeMeta(region.stepType) : null;
                const anchor = region && region.kind !== "step" ? ANCHOR_STYLE[region.kind] : null;
                const edge = meta?.edge ?? anchor?.edge;
                return (
                  <div
                    key={i}
                    ref={
                      info?.isStart
                        ? (el) => {
                            if (el) refs.current.set(info.key, el);
                          }
                        : undefined
                    }
                    onClick={region ? () => onRegionClick(region, selected) : undefined}
                    className={cn(
                      "flex border-l-2 border-l-transparent pr-3 transition-colors",
                      wrap && "items-start",
                      region && "cursor-pointer",
                      meta?.codeBg,
                      meta?.rail,
                      anchor?.bg,
                      anchor?.rail,
                      info?.isStart && edge && `border-t ${edge}`,
                      info?.isEnd && edge && `border-b ${edge}`,
                      selected && "bg-primary/10 ring-1 ring-inset ring-primary/40",
                      region && !selected && "hover:brightness-110",
                    )}
                  >
                    <span className="w-10 shrink-0 select-none pr-3 text-right text-muted-foreground/40">
                      {i + 1}
                    </span>
                    <span
                      {...getLineProps({ line })}
                      className={cn(
                        "flex-1",
                        wrap ? "min-w-0 whitespace-pre-wrap break-words" : "whitespace-pre",
                      )}
                    >
                      {line.map((token, k) => (
                        <span key={k} {...getTokenProps({ token })} />
                      ))}
                    </span>
                    {anchor && info?.isStart && (
                      <span
                        className={cn(
                          "ml-2 shrink-0 self-center rounded-sm border border-border px-1 text-[9px] font-semibold uppercase tracking-wider",
                          anchor.tag,
                        )}
                      >
                        {anchor.label}
                      </span>
                    )}
                  </div>
                );
              })}
            </pre>
          )}
        </Highlight>
      </div>
    </div>
  );
}
