import Editor from "@monaco-editor/react";
import type { ReactNode } from "react";
import { Streamdown } from "streamdown";
import { useTheme } from "@/hooks/use-theme";
import { normalizeNewlines } from "@/lib/utils";
import { CopyButton } from "./copy-button";

// Returns prettified JSON text if `text` parses to an object/array, else null.
function tryPrettyJson(text: string): string | null {
  const trimmed = text.trim();
  if (
    !(
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    )
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      return JSON.stringify(parsed, null, 2);
    }
  } catch {
    // not JSON
  }
  return null;
}

const MONACO_LINE_HEIGHT = 16;
const MONACO_PADDING = 12; // top + bottom + scrollbar slack

// Monaco's built-in language IDs are sometimes named differently from the
// markdown fence label. Normalize the common aliases so syntax highlighting
// kicks in for bash/sh/zsh, ts/tsx, yml, etc.
const LANGUAGE_ALIASES: Record<string, string> = {
  bash: "shell",
  sh: "shell",
  zsh: "shell",
  console: "shell",
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  yml: "yaml",
  py: "python",
  rb: "ruby",
};

function MonacoCodeBlock({ language, value }: { language: string; value: string }) {
  const { theme } = useTheme();
  const resolvedLanguage = LANGUAGE_ALIASES[language] ?? language;
  const lineCount = value.split("\n").length;
  // Size to fit all content; the parent container (tooltip / card / collapsible)
  // already provides a scroll boundary via its own max-h + overflow-auto.
  // Floor at 80 so a single-line snippet doesn't render a near-empty editor.
  const height = Math.max(80, lineCount * MONACO_LINE_HEIGHT + MONACO_PADDING);
  return (
    <div
      className="relative my-2 w-full border-y border-border overflow-hidden"
      data-monaco-block="markdown-view"
      style={{ height }}
    >
      <CopyButton value={value} />
      <Editor
        language={resolvedLanguage}
        theme={theme === "dark" ? "vs-dark" : "vs"}
        value={value}
        options={{
          readOnly: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          // Monaco's own scrollbars are disabled so the outer container is the
          // single source of scroll truth.
          scrollbar: { vertical: "hidden", horizontal: "auto", handleMouseWheel: false },
          fontSize: 12,
          lineHeight: MONACO_LINE_HEIGHT,
          lineNumbers: "off",
          wordWrap: "on",
          folding: false,
          automaticLayout: true,
          padding: { top: 4, bottom: 4 },
        }}
        height="100%"
        width="100%"
      />
    </div>
  );
}

// Streamdown component overrides: route fenced code blocks (anything with a
// `language-*` className) through Monaco; unwrap the outer <pre> since Monaco
// brings its own container; keep inline code as a small styled chip.
const STREAMDOWN_COMPONENTS = {
  code({ className, children, ...rest }: { className?: string; children?: ReactNode }) {
    const m = /language-([\w-]+)/.exec(className ?? "");
    if (m) {
      const value = (Array.isArray(children) ? children.join("") : String(children ?? "")).replace(
        /\n$/,
        "",
      );
      return <MonacoCodeBlock language={m[1]} value={value} />;
    }
    return (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs" {...rest}>
        {children}
      </code>
    );
  },
  pre({ children }: { children?: ReactNode }) {
    return <>{children}</>;
  },
};

/**
 * Markdown renderer used across the app. Wraps Streamdown with:
 *   - Auto JSON detection (raw JSON input is reflowed into a fenced ```json block).
 *   - Code blocks rendered with a read-only Monaco editor (theme-aware, word-wrapped).
 *   - Inline code styled as a small `bg-muted` chip.
 */
export function MarkdownView({ text }: { text: string }) {
  const pretty = tryPrettyJson(text);
  const body = pretty != null ? `\`\`\`json\n${pretty}\n\`\`\`` : normalizeNewlines(text);
  return <Streamdown components={STREAMDOWN_COMPONENTS}>{body}</Streamdown>;
}
