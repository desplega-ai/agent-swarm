import { Check, Copy, Maximize2, Play, Save } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/api/client";
import { useAgents } from "@/api/hooks/use-agents";
import { useRunInlineScript } from "@/api/hooks/use-script-connections";
import { useScripts, useScriptTypeDefs, useUpsertScript } from "@/api/hooks/use-scripts";
import type { ScriptRunInlineResult } from "@/api/types";
import { ScriptSourceEditor } from "@/components/scripts/script-source-editor";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InfoTip } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

const PLAYGROUND_SOURCE = `import type { ScriptMain } from "swarm-sdk";

const main: ScriptMain = async (args, ctx) => {
  return { api: Object.keys(ctx.api ?? {}), mcp: Object.keys(ctx.mcp ?? {}) };
};

export default main;
`;

const PANE_HEIGHT = "h-[480px]";

function kebabCase(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function PaneLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </span>
  );
}

function InlineError({ error }: { error?: unknown }) {
  if (!error) return null;
  return (
    <p className="text-sm text-status-error">
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}

function IconCopyButton({ value, tip }: { value: string; tip: string }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          onClick={() => copy(value)}
          disabled={!value}
          aria-label={tip}
        >
          {copied ? <Check className="size-3 text-status-success" /> : <Copy className="size-3" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : tip}</TooltipContent>
    </Tooltip>
  );
}

// ── JSON pretty view (cheap token colorizer over JSON.stringify output) ──

const JSON_TOKEN_CLASSES = {
  key: "text-status-info",
  string: "text-status-success",
  number: "text-status-active",
  literal: "text-status-warning",
} as const;

const JSON_TOKEN_RE =
  /("(?:\\.|[^"\\])*")(\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function colorizeJson(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let spanKey = 0;
  for (const match of text.matchAll(JSON_TOKEN_RE)) {
    const index = match.index ?? 0;
    const [token, str, colon] = match;
    if (index > last) nodes.push(text.slice(last, index));
    if (str) {
      const cls = colon ? JSON_TOKEN_CLASSES.key : JSON_TOKEN_CLASSES.string;
      nodes.push(
        <span key={spanKey++} className={cls}>
          {str}
        </span>,
      );
      if (colon) nodes.push(colon);
    } else {
      const cls = /^(?:true|false|null)$/.test(token)
        ? JSON_TOKEN_CLASSES.literal
        : JSON_TOKEN_CLASSES.number;
      nodes.push(
        <span key={spanKey++} className={cls}>
          {token}
        </span>,
      );
    }
    last = index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// ── Output pane ──

function OutputPanel({
  result,
  error,
  isPending,
}: {
  result?: ScriptRunInlineResult;
  error: unknown;
  isPending: boolean;
}) {
  const failed = Boolean(
    result && (result.error != null || result.runtimeError != null || (result.exitCode ?? 0) !== 0),
  );
  const displayValue = result
    ? failed && (result.error != null || result.runtimeError != null)
      ? { error: result.error ?? null, runtimeError: result.runtimeError ?? null }
      : (result.result ?? null)
    : undefined;
  const resultText = useMemo(
    () => (result ? JSON.stringify(displayValue, null, 2) : ""),
    [result, displayValue],
  );
  const resultNodes = useMemo(() => colorizeJson(resultText), [resultText]);

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex h-6 items-center justify-between">
        <PaneLabel>Result</PaneLabel>
        {result ? <IconCopyButton value={resultText} tip="Copy result JSON" /> : null}
      </div>
      <div className={cn("flex min-h-0 flex-col gap-2", PANE_HEIGHT)}>
        {isPending ? (
          <div className="flex flex-1 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
            Running…
          </div>
        ) : result ? (
          <>
            <pre
              className={cn(
                "min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30 p-3 text-xs leading-relaxed",
                failed ? "border-status-error/50" : "border-status-success/50",
              )}
            >
              {resultNodes}
            </pre>
            {result.stdout ? (
              <div className="flex min-h-0 flex-col gap-1">
                <PaneLabel>Stdout</PaneLabel>
                <pre className="max-h-24 overflow-auto rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">
                  {result.stdout}
                </pre>
              </div>
            ) : null}
            {result.stderr ? (
              <div className="flex min-h-0 flex-col gap-1">
                <PaneLabel>Stderr</PaneLabel>
                <pre className="max-h-24 overflow-auto rounded-md border border-status-error/40 bg-muted/30 p-2 text-xs text-status-error">
                  {result.stderr}
                </pre>
              </div>
            ) : null}
            <div className="flex h-6 items-center justify-between rounded-md border bg-muted/20 px-2">
              <PaneLabel>Duration</PaneLabel>
              <span className="font-mono text-xs">{result.durationMs ?? 0} ms</span>
            </div>
          </>
        ) : error ? null : (
          <div className="flex flex-1 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
            Run a script to see its result.
          </div>
        )}
        <InlineError error={error} />
      </div>
    </div>
  );
}

// ── Playground panel ──

export function PlaygroundPanel({ defaultAgentId }: { defaultAgentId?: string }) {
  const navigate = useNavigate();
  const { data: agents } = useAgents(false);
  const { data: typeDefs } = useScriptTypeDefs();
  const { data: scripts } = useScripts({ scope: "all" });
  const run = useRunInlineScript();
  const upsert = useUpsertScript();

  const [source, setSource] = useState(PLAYGROUND_SOURCE);
  const [agentId, setAgentId] = useState(defaultAgentId ?? "");
  const [expanded, setExpanded] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [selectedScriptId, setSelectedScriptId] = useState("");
  const [pendingScriptId, setPendingScriptId] = useState<string | null>(null);
  // Last loaded/saved source — the "clean" baseline for unsaved-edit detection.
  const baselineRef = useRef(PLAYGROUND_SOURCE);

  useEffect(() => {
    if (!agentId && defaultAgentId) setAgentId(defaultAgentId);
  }, [agentId, defaultAgentId]);

  const scriptById = useMemo(
    () => new Map((scripts ?? []).map((script) => [script.id, script])),
    [scripts],
  );
  const pendingScript = pendingScriptId ? scriptById.get(pendingScriptId) : undefined;

  async function loadScript(id: string) {
    try {
      const detail = await api.fetchScript(id);
      baselineRef.current = detail.source;
      setSource(detail.source);
      setSelectedScriptId(id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load script");
    }
  }

  function handleSelectScript(id: string) {
    if (id === selectedScriptId) return;
    if (source !== baselineRef.current) {
      setPendingScriptId(id);
      return;
    }
    void loadScript(id);
  }

  function openSaveDialog() {
    const selected = scriptById.get(selectedScriptId);
    setSaveName(selected ? kebabCase(selected.name) : "playground-script");
    setSaveOpen(true);
  }

  async function submitSave() {
    const name = saveName.trim();
    if (!name || !agentId) return;
    try {
      const saved = await upsert.mutateAsync({
        name,
        source,
        description: "",
        intent: "created from connections playground",
        agentId,
      });
      baselineRef.current = source;
      setSaveOpen(false);
      let savedId: string | undefined;
      try {
        const list = await api.fetchScripts({ scope: "all" });
        savedId = list.scripts.find((script) => script.name === saved.name)?.id;
      } catch {
        // Toast falls back to a plain success message without the link.
      }
      if (savedId) {
        const id = savedId;
        setSelectedScriptId(id);
        toast.success(`Saved script "${saved.name}" (v${saved.version})`, {
          action: { label: "Open", onClick: () => navigate(`/scripts/${id}`) },
        });
      } else {
        toast.success(`Saved script "${saved.name}" (v${saved.version})`);
      }
    } catch {
      // upsert.error renders inside the dialog (typecheck diagnostics etc.).
    }
  }

  const editorProps = {
    source,
    onChange: setSource,
    readOnly: false,
    typeDefs,
  };

  return (
    <Card className="rounded-lg py-4">
      <CardContent className="flex flex-col gap-4 px-4">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={selectedScriptId} onValueChange={handleSelectScript}>
            <SelectTrigger className="w-56" aria-label="Load a saved script">
              <SelectValue placeholder="Load saved script…" />
            </SelectTrigger>
            <SelectContent>
              {(scripts ?? []).map((script) => (
                <SelectItem key={script.id} value={script.id}>
                  {script.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Label className="inline-flex items-center gap-1.5">
              Run as
              <InfoTip content="Scripts execute under this agent's identity (X-Agent-ID) — its scope determines which connections and credentials resolve." />
            </Label>
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Select agent" />
              </SelectTrigger>
              <SelectContent>
                {(agents ?? []).map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              onClick={() => run.mutate({ source, intent: "connections playground", agentId })}
              disabled={!agentId || run.isPending}
            >
              <Play className="size-4" />
              Run
            </Button>
            <Button size="sm" variant="outline" onClick={openSaveDialog} disabled={!agentId}>
              <Save className="size-4" />
              Save as
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => setExpanded(true)}
                  aria-label="Expand editor"
                >
                  <Maximize2 className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Expand editor</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex h-6 items-center justify-between">
              <PaneLabel>Source</PaneLabel>
              <IconCopyButton value={source} tip="Copy source" />
            </div>
            <ScriptSourceEditor {...editorProps} className={PANE_HEIGHT} />
          </div>
          <OutputPanel result={run.data} error={run.error} isPending={run.isPending} />
        </div>
      </CardContent>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="flex h-[85vh] w-[90vw] flex-col gap-3 p-4 sm:max-w-[90vw]">
          <DialogHeader>
            <DialogTitle>Playground source</DialogTitle>
            <DialogDescription className="sr-only">
              Focused full-screen editor for the playground script source.
            </DialogDescription>
          </DialogHeader>
          <ScriptSourceEditor {...editorProps} className="min-h-0 flex-1" />
        </DialogContent>
      </Dialog>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save as swarm script</DialogTitle>
            <DialogDescription>
              Saves the current editor source as a reusable swarm script.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={saveName}
            onChange={(event) => setSaveName(event.target.value)}
            placeholder="my-script-name"
            aria-label="Script name"
            autoFocus
            onKeyDown={(event) => {
              if (event.key === "Enter") void submitSave();
            }}
          />
          <InlineError error={upsert.error} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void submitSave()}
              disabled={!saveName.trim() || upsert.isPending}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingScriptId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingScriptId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard current edits?</AlertDialogTitle>
            <AlertDialogDescription>
              Loading {pendingScript ? `"${pendingScript.name}"` : "this script"} replaces the
              editor contents. Your unsaved changes will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const id = pendingScriptId;
                setPendingScriptId(null);
                if (id) void loadScript(id);
              }}
            >
              Load script
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
