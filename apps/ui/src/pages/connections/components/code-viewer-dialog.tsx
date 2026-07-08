import Editor, { type Monaco } from "@monaco-editor/react";
import { ScriptSourceEditor } from "@/components/scripts/script-source-editor";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTheme } from "@/hooks/use-theme";
import { monacoDarkTheme, monacoLightTheme } from "@/lib/monaco-themes";
import { cn } from "@/lib/utils";
import { CopyIconButton } from "./copy-icon-button";

export type CodeViewerLanguage = "typescript" | "json";

/**
 * Read-only Monaco JSON viewer — sibling of ScriptSourceEditor (which is
 * hard-wired to TypeScript + SDK type defs) for spec-preview JSON blobs.
 */
export function JsonSourceViewer({
  source,
  className,
  height = "100%",
}: {
  source: string;
  className?: string;
  height?: string;
}) {
  const { theme } = useTheme();
  const handleBeforeMount = (monaco: Monaco) => {
    monaco.editor.defineTheme("github-light", monacoLightTheme);
    monaco.editor.defineTheme("github-dark", monacoDarkTheme);
  };
  return (
    <div className={cn("min-h-0 overflow-hidden rounded-md border bg-card", className)}>
      <Editor
        language="json"
        theme={theme === "dark" ? "github-dark" : "github-light"}
        value={source}
        beforeMount={handleBeforeMount}
        height={height}
        width="100%"
        options={{
          readOnly: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 12,
          lineNumbers: "on",
          wordWrap: "on",
          automaticLayout: true,
          padding: { top: 8, bottom: 8 },
          renderLineHighlight: "none",
          scrollbar: { vertical: "auto", horizontal: "auto" },
          overviewRulerLanes: 0,
          fixedOverflowWidgets: true,
        }}
      />
    </div>
  );
}

interface CodeViewerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  code: string;
  language: CodeViewerLanguage;
}

/**
 * Expanded ("maximize") view for code blocks on the connection detail page —
 * a near-fullscreen dialog (~90vw × 85vh) with a syntax-highlighted scrollable
 * viewer and a copy button in the header.
 */
export function CodeViewerDialog({
  open,
  onOpenChange,
  title,
  code,
  language,
}: CodeViewerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] w-[90vw] max-w-[90vw] flex-col gap-3 sm:max-w-[90vw]">
        <DialogHeader className="flex-row items-center gap-2 space-y-0">
          <DialogTitle className="min-w-0 truncate">{title}</DialogTitle>
          <CopyIconButton value={code} label={`Copy ${language === "json" ? "JSON" : "code"}`} />
        </DialogHeader>
        <div className="min-h-0 flex-1">
          {language === "typescript" ? (
            <ScriptSourceEditor source={code} readOnly className="h-full" />
          ) : (
            <JsonSourceViewer source={code} className="h-full" />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
