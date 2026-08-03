import Editor, { type Monaco } from "@monaco-editor/react";
import { useCallback } from "react";
import { useTheme } from "@/hooks/use-theme";
import { monacoDarkTheme, monacoLightTheme } from "@/lib/monaco-themes";
import { cn } from "@/lib/utils";

interface MarkdownEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  className?: string;
  height?: string;
}

/**
 * Monaco editor tuned for authoring markdown documents (SKILL.md content,
 * task templates, …). Shares the app's Monaco themes with
 * `ScriptSourceEditor`; markdown needs no extra libs, so there is no
 * type-def registration here.
 */
export function MarkdownEditor({
  value,
  onChange,
  readOnly = false,
  className,
  height = "100%",
}: MarkdownEditorProps) {
  const { theme } = useTheme();

  const handleBeforeMount = useCallback((monaco: Monaco) => {
    monaco.editor.defineTheme("github-light", monacoLightTheme);
    monaco.editor.defineTheme("github-dark", monacoDarkTheme);
  }, []);

  return (
    <div className={cn("min-h-0 overflow-hidden rounded-md border bg-card", className)}>
      <Editor
        language="markdown"
        theme={theme === "dark" ? "github-dark" : "github-light"}
        value={value}
        onChange={(next) => onChange?.(next ?? "")}
        beforeMount={handleBeforeMount}
        height={height}
        width="100%"
        options={{
          readOnly,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 13,
          lineNumbers: "on",
          wordWrap: "on",
          automaticLayout: true,
          padding: { top: 8, bottom: 8 },
          renderLineHighlight: "none",
          scrollbar: { vertical: "auto", horizontal: "auto" },
          overviewRulerLanes: 0,
          // Fixed-position widgets so they escape overflow-hidden ancestors.
          fixedOverflowWidgets: true,
        }}
      />
    </div>
  );
}
