import Editor from "@monaco-editor/react";
import { useTheme } from "@/hooks/use-theme";
import { MAIN_BLEED_Y } from "@/lib/main-gutter";
import { cn } from "@/lib/utils";

/**
 * The Monaco body view/editor shared by the template detail and version
 * pages. It fills the height its parent gives it.
 *
 * On a phone it runs to the bottom edge, drops the line-number gutter, the
 * glyph margin and folding (about 50px of width the lines need more), and
 * uses a 12px font. It does not bleed sideways: the page renders inside the
 * settings layout, whose content column clips a horizontal bleed and would
 * cut the first characters of every line. Desktop keeps line numbers.
 */
export function TemplateCode({
  value,
  onChange,
  readOnly = true,
  phone = false,
  editorKey,
}: {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  phone?: boolean;
  editorKey?: string;
}) {
  const { theme } = useTheme();
  return (
    <div
      className={cn(
        "flex-1 min-h-0 overflow-hidden",
        phone
          ? cn(MAIN_BLEED_Y, "rounded-t-md border border-b-0 border-border")
          : "rounded-md border border-border",
      )}
    >
      <Editor
        key={editorKey}
        language="markdown"
        theme={theme === "dark" ? "vs-dark" : "vs"}
        value={value}
        onChange={onChange ? (next) => onChange(next ?? "") : undefined}
        options={{
          readOnly,
          domReadOnly: readOnly,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: phone ? 12 : 13,
          lineNumbers: phone ? "off" : "on",
          glyphMargin: !phone,
          folding: !phone,
          lineDecorationsWidth: phone ? 12 : 10,
          lineNumbersMinChars: phone ? 0 : 5,
          renderLineHighlight: phone && readOnly ? "none" : "line",
          overviewRulerLanes: phone ? 0 : 3,
          hideCursorInOverviewRuler: phone,
          scrollbar: phone ? { verticalScrollbarSize: 6 } : undefined,
          wordWrap: "on",
          automaticLayout: true,
          padding: { top: 8, bottom: 8 },
        }}
        height="100%"
      />
    </div>
  );
}
