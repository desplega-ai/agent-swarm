/**
 * Read-only code viewer (mockup, UI audit 2026-11-06).
 *
 * Two sizing modes, picked by the viewport:
 * - desktop (`md` up): fills its flex parent and scrolls inside, so a page
 *   that does not scroll gets exactly one scroll area;
 * - phone: grows to the full source height and lets the PAGE scroll. No
 *   scroll box inside the page scroll, no clipped lines, and long lines wrap
 *   by default (the wrap toggle turns it off for column-aligned code).
 *
 * The toolbar (title, wrap, copy) sticks under the page's sticky tabs on a
 * phone, so the controls stay reachable 300 lines down.
 */

import { Check, Copy, WrapText } from "lucide-react";
import { Highlight, themes } from "prism-react-renderer";
import { useState } from "react";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useIsPhone } from "@/hooks/use-mobile";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

const TAB_WIDTH = 4;
/** Extra indent for wrapped continuation lines, past the line's own indent. */
const HANG = 2;

/**
 * Hanging indent for a wrapped line: the first visual line keeps its own
 * leading whitespace (it is still in the text, so copy is unchanged), and
 * every continuation line starts HANG characters right of that indent instead
 * of at the gutter edge.
 */
function hangingIndent(line: { content: string }[]) {
  const text = line.map((token) => token.content).join("");
  const lead = /^[\t ]*/.exec(text)?.[0] ?? "";
  const indent = lead.replaceAll("\t", " ".repeat(TAB_WIDTH)).length + HANG;
  return { paddingLeft: `${indent}ch`, textIndent: `-${indent}ch`, tabSize: TAB_WIDTH };
}

export function CodeViewer({
  source,
  language = "tsx",
  title = "Source",
  label,
  className,
  stickyTop = "top-11",
}: {
  source: string;
  language?: string;
  title?: string;
  /** Small caps tag beside the title, e.g. "typescript" or "v3". */
  label?: string;
  className?: string;
  /** Phone: where the toolbar sticks (under the sticky tabs). */
  stickyTop?: string;
}) {
  const isPhone = useIsPhone();
  const { theme } = useTheme();
  const { copied, copy } = useCopyToClipboard();
  const [wrap, setWrap] = useState(isPhone);
  const lineCount = source.replace(/\n$/, "").split("\n").length;

  return (
    <div
      data-slot="code-viewer"
      className={cn(
        "flex flex-col rounded-lg border bg-card",
        isPhone ? "" : "min-h-0 overflow-hidden",
        className,
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between gap-2 border-b bg-card px-3 py-1.5",
          isPhone && `sticky ${stickyTop} z-10 rounded-t-lg`,
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-sm font-semibold">{title}</h2>
          {label ? (
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {label}
            </span>
          ) : null}
          <span className="text-xs text-muted-foreground">· {lineCount} lines</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setWrap((w) => !w)}
            aria-pressed={wrap}
            aria-label={wrap ? "Disable line wrap" : "Wrap long lines"}
            className={cn(
              "inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted-foreground/15 hover:text-foreground",
              wrap && "bg-muted-foreground/15 text-foreground",
            )}
          >
            <WrapText className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => copy(source)}
            aria-label={copied ? "Copied" : "Copy source"}
            className={cn(
              "inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted-foreground/15 hover:text-foreground",
              copied && "text-status-success-strong",
            )}
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          </button>
        </div>
      </div>
      <div className={cn(isPhone ? "overflow-x-auto" : "min-h-0 flex-1 overflow-auto")}>
        <Highlight
          code={source.replace(/\n$/, "")}
          language={language}
          theme={theme === "dark" ? themes.vsDark : themes.github}
        >
          {({ tokens, getLineProps, getTokenProps }) => (
            <pre
              className={cn(
                "m-0 py-2 font-mono text-xs leading-relaxed",
                wrap ? "min-w-full" : "w-max min-w-full",
              )}
              style={{ background: "transparent" }}
            >
              {tokens.map((line, i) => (
                <div key={i} className={cn("flex pr-3", wrap && "items-start")}>
                  <span className="w-9 shrink-0 select-none pr-2 text-right text-muted-foreground/40">
                    {i + 1}
                  </span>
                  <span
                    {...getLineProps({ line })}
                    className={cn(
                      "flex-1",
                      wrap ? "min-w-0 whitespace-pre-wrap break-words" : "whitespace-pre",
                    )}
                    style={wrap ? hangingIndent(line) : undefined}
                  >
                    {line.map((token, k) => (
                      <span key={k} {...getTokenProps({ token })} />
                    ))}
                  </span>
                </div>
              ))}
            </pre>
          )}
        </Highlight>
      </div>
    </div>
  );
}
