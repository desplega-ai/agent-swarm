import Editor, { type Monaco } from "@monaco-editor/react";
import { useCallback, useEffect, useRef } from "react";
import type { ScriptTypeDefs } from "@/api/types";
import { useTheme } from "@/hooks/use-theme";
import { monacoDarkTheme, monacoLightTheme } from "@/lib/monaco-themes";
import { cn } from "@/lib/utils";

const SDK_LIB_URI = "file:///swarm-sdk.d.ts";
const STDLIB_LIB_URI = "file:///stdlib.d.ts";

/**
 * Register the swarm SDK + stdlib `.d.ts` as TypeScript extra libs so Monaco's
 * TS worker resolves SDK symbols and shows real inferred types on hover.
 * `typescriptDefaults` is a Monaco-global singleton — guard against duplicate
 * registration across mounts (each addExtraLib call would otherwise stack a
 * new lib version and re-trigger worker syncs).
 */
function registerScriptTypeDefs(monaco: Monaco, typeDefs: ScriptTypeDefs) {
  const tsDefaults = monaco.languages.typescript.typescriptDefaults;
  tsDefaults.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    noEmit: true,
    allowNonTsExtensions: true,
    strict: false,
  });
  const existing = tsDefaults.getExtraLibs();
  if (!existing[SDK_LIB_URI]) tsDefaults.addExtraLib(typeDefs.sdkTypes, SDK_LIB_URI);
  if (!existing[STDLIB_LIB_URI]) tsDefaults.addExtraLib(typeDefs.stdlibTypes, STDLIB_LIB_URI);
}

interface ScriptSourceEditorProps {
  source: string;
  onChange?: (source: string) => void;
  /** SDK + stdlib `.d.ts` from `GET /api/scripts/type-defs`; optional while loading. */
  typeDefs?: ScriptTypeDefs;
  readOnly?: boolean;
  className?: string;
  height?: string;
}

/**
 * Read-only Monaco TypeScript viewer for saved-script source. Loads the swarm
 * SDK + stdlib type defs as extra libs so hovering SDK symbols shows inferred
 * types (LSP-like quick info). Self-contained — the Versions tab reuses it
 * with a different `source`.
 */
export function ScriptSourceEditor({
  source,
  onChange,
  typeDefs,
  readOnly = true,
  className,
  height = "100%",
}: ScriptSourceEditorProps) {
  const { theme } = useTheme();
  const monacoRef = useRef<Monaco | null>(null);

  const handleBeforeMount = useCallback(
    (monaco: Monaco) => {
      monacoRef.current = monaco;
      monaco.editor.defineTheme("github-light", monacoLightTheme);
      monaco.editor.defineTheme("github-dark", monacoDarkTheme);
      if (typeDefs) registerScriptTypeDefs(monaco, typeDefs);
    },
    [typeDefs],
  );

  // Type defs come from an async query and may resolve after the editor
  // mounted — register them as soon as they arrive.
  useEffect(() => {
    if (monacoRef.current && typeDefs) registerScriptTypeDefs(monacoRef.current, typeDefs);
  }, [typeDefs]);

  return (
    <div className={cn("min-h-0 overflow-hidden rounded-md border bg-card", className)}>
      <Editor
        language="typescript"
        theme={theme === "dark" ? "github-dark" : "github-light"}
        value={source}
        onChange={(value) => onChange?.(value ?? "")}
        beforeMount={handleBeforeMount}
        height={height}
        width="100%"
        options={{
          readOnly,
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
          // Fixed-position suggest/hover widgets so they escape
          // overflow-hidden ancestors (cards, dialogs) instead of clipping.
          fixedOverflowWidgets: true,
        }}
      />
    </div>
  );
}
