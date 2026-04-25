import Editor from "@monaco-editor/react";
import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { ArrowLeft, ChevronDown, ChevronRight, Info } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import { toast } from "sonner";
import {
  useCheckoutTemplate,
  useDeleteTemplate,
  usePromptTemplate,
  usePromptTemplateEvents,
  useRenderTemplate,
  useResetTemplate,
  useUpsertTemplate,
} from "@/api/hooks";
import type { PromptTemplateHistory } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTheme } from "@/hooks/use-theme";
import { formatSmartTime } from "@/lib/utils";

const STATE_VARIANTS: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  enabled: "default",
  default_prompt_fallback: "secondary",
  skip_event: "outline",
};

export default function TemplateDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { theme } = useTheme();

  const { data, isLoading, isError } = usePromptTemplate(id);
  const { data: events } = usePromptTemplateEvents();
  const upsertMutation = useUpsertTemplate();
  const deleteMutation = useDeleteTemplate();
  const resetMutation = useResetTemplate();
  const checkoutMutation = useCheckoutTemplate();
  const renderMutation = useRenderTemplate();

  const template = data?.template;
  const history = data?.history ?? [];

  const [body, setBody] = useState("");
  const [state, setState] = useState<string>("enabled");
  const [editing, setEditing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [checkoutVersion, setCheckoutVersion] = useState<number | null>(null);

  // Rendered tab state
  const [rendered, setRendered] = useState("");
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const [varsOpen, setVarsOpen] = useState(false);

  // Sync body/state from template data
  useEffect(() => {
    if (template) {
      setBody(template.body);
      setState(template.state);
    }
  }, [template]);

  // Render fully resolved template (re-triggers after save/checkout/reset via version change)
  const templateEventType = template?.eventType;
  const templateVersion = template?.version;
  const renderMutate = renderMutation.mutate;
  // biome-ignore lint/correctness/useExhaustiveDependencies: templateVersion triggers re-render after save/checkout/reset
  useEffect(() => {
    if (!templateEventType) return;
    const sampleVars: Record<string, string> = {};
    const eventDef = events?.find((e) => e.eventType === templateEventType);
    if (eventDef) {
      for (const v of eventDef.variables) {
        sampleVars[v.name] = v.example ?? v.name;
      }
    }
    renderMutate(
      { eventType: templateEventType, variables: sampleVars },
      {
        onSuccess: (result) => {
          setRendered(result.text);
          setUnresolved(result.unresolved);
        },
      },
    );
  }, [templateEventType, templateVersion, events, renderMutate]);

  const handleSave = useCallback(() => {
    if (!template) return;
    upsertMutation.mutate(
      {
        eventType: template.eventType,
        body,
        state: state as "enabled" | "default_prompt_fallback" | "skip_event",
        scope: template.scope,
        scopeId: template.scopeId ?? undefined,
      },
      {
        onSuccess: () => toast.success("Template saved"),
        onError: () => toast.error("Failed to save template"),
      },
    );
  }, [template, body, state, upsertMutation]);

  const handleCustomize = useCallback(() => {
    if (!template) return;
    upsertMutation.mutate(
      {
        eventType: template.eventType,
        body: template.body,
        scope: "global",
      },
      {
        onSuccess: (newTemplate) => {
          toast.success("Template customized — you can now edit it");
          if (newTemplate?.id && newTemplate.id !== id) {
            navigate(`/templates/${newTemplate.id}`);
          }
        },
        onError: () => toast.error("Failed to customize template"),
      },
    );
  }, [template, upsertMutation, id, navigate]);

  const handleDelete = useCallback(() => {
    if (!id) return;
    deleteMutation.mutate(id, {
      onSuccess: () => {
        toast.success("Template deleted");
        navigate("/templates");
      },
      onError: () => toast.error("Failed to delete template"),
    });
  }, [id, deleteMutation, navigate]);

  const handleReset = useCallback(() => {
    if (!id) return;
    resetMutation.mutate(id, {
      onSuccess: () => toast.success("Template reset to default"),
      onError: () => toast.error("Failed to reset template"),
    });
    setResetOpen(false);
  }, [id, resetMutation]);

  const handleCheckout = useCallback(() => {
    if (!id || checkoutVersion === null) return;
    const ver = checkoutVersion;
    checkoutMutation.mutate(
      { id, version: ver },
      {
        onSuccess: () => toast.success(`Checked out version ${ver}`),
        onError: () => toast.error("Failed to checkout version"),
      },
    );
    setCheckoutVersion(null);
  }, [id, checkoutVersion, checkoutMutation]);

  const hasChanges = template ? body !== template.body || state !== template.state : false;

  // Cmd+S / Ctrl+S to save (only when editing non-default templates)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (editing && hasChanges) {
          handleSave();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editing, hasChanges, handleSave]);

  const eventDef = useMemo(
    () => events?.find((e) => e.eventType === template?.eventType),
    [events, template?.eventType],
  );

  // History grid columns
  const historyColumns = useMemo<ColDef<PromptTemplateHistory>[]>(
    () => [
      { field: "version", headerName: "Version", width: 90 },
      {
        field: "state",
        headerName: "State",
        width: 180,
        cellRenderer: (params: { value: string }) => (
          <Badge variant={STATE_VARIANTS[params.value] ?? "outline"} size="tag">
            {params.value?.replace(/_/g, " ")}
          </Badge>
        ),
      },
      { field: "changedBy", headerName: "Changed By", flex: 1, minWidth: 120 },
      {
        field: "changedAt",
        headerName: "Changed At",
        width: 150,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : ""),
      },
      {
        field: "changeReason",
        headerName: "Reason",
        flex: 1,
        minWidth: 150,
      },
      {
        headerName: "",
        width: 100,
        cellRenderer: (params: { data: PromptTemplateHistory | undefined }) => {
          if (!params.data) return null;
          return (
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                setCheckoutVersion(params.data!.version);
              }}
            >
              Checkout
            </Button>
          );
        },
        sortable: false,
      },
    ],
    [],
  );

  const onHistoryRowClicked = useCallback(
    (event: RowClickedEvent<PromptTemplateHistory>) => {
      if (event.data) {
        navigate(`/templates/${id}/history/${event.data.version}`);
      }
    },
    [navigate, id],
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (isError || !template) {
    return (
      <div className="flex flex-col flex-1 items-center justify-center gap-2 text-muted-foreground">
        <p>Template not found</p>
        <Button variant="outline" size="sm" asChild>
          <Link to="/templates">Back to Templates</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* Header */}
      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => navigate("/templates")}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors w-fit"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Templates
        </button>

        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-xl font-semibold">{template.eventType}</h1>
          <Badge variant="outline" size="tag">
            {template.scope}
          </Badge>
          <Badge variant={STATE_VARIANTS[template.state] ?? "outline"} size="tag">
            {template.state.replace(/_/g, " ")}
          </Badge>
          <Badge variant="outline" size="tag">
            v{template.version}
          </Badge>
          {template.isDefault && (
            <Badge variant="secondary" size="tag">
              Default
            </Badge>
          )}

          {!template.isDefault && (
            <div className="ml-auto">
              <Button variant="destructive-outline" size="sm" onClick={() => setDeleteOpen(true)}>
                Delete
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="raw" className="flex flex-col flex-1 min-h-0">
        <TabsList>
          <TabsTrigger value="raw">Raw</TabsTrigger>
          <TabsTrigger value="rendered">Rendered</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        {/* Raw Tab */}
        <TabsContent value="raw" className="flex flex-col flex-1 min-h-0 gap-3">
          {template.isDefault ? (
            <>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" size="tag">
                  Default — Read Only
                </Badge>
                <Button variant="outline" size="sm" onClick={handleCustomize}>
                  Customize
                </Button>
              </div>
              <div className="flex-1 min-h-0 border border-border rounded-md overflow-hidden">
                <Editor
                  key={`readonly-${id}`}
                  language="markdown"
                  theme={theme === "dark" ? "vs-dark" : "vs"}
                  value={template.body}
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    fontSize: 13,
                    lineNumbers: "on",
                    wordWrap: "on",
                    automaticLayout: true,
                    padding: { top: 8 },
                  }}
                  height="100%"
                />
              </div>
            </>
          ) : editing ? (
            <>
              <div className="flex items-center gap-3">
                <Select value={state} onValueChange={setState}>
                  <SelectTrigger className="w-[220px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="enabled">Enabled</SelectItem>
                    <SelectItem value="default_prompt_fallback">Default Prompt Fallback</SelectItem>
                    <SelectItem value="skip_event">Skip Event</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={upsertMutation.isPending || !hasChanges}
                  className="bg-primary hover:bg-primary/90"
                >
                  {upsertMutation.isPending ? "Saving..." : "Save"}
                </Button>
                {hasChanges ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (template) {
                        setBody(template.body);
                        setState(template.state);
                      }
                    }}
                  >
                    Reset
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                )}
              </div>
              <div className="flex-1 min-h-0 border border-border rounded-md overflow-hidden">
                <Editor
                  key={`editable-${id}`}
                  language="markdown"
                  theme={theme === "dark" ? "vs-dark" : "vs"}
                  value={body}
                  onChange={(value) => setBody(value ?? "")}
                  options={{
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    fontSize: 13,
                    lineNumbers: "on",
                    wordWrap: "on",
                    automaticLayout: true,
                    padding: { top: 8 },
                  }}
                  height="100%"
                />
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              </div>
              <div className="flex-1 min-h-0 border border-border rounded-md overflow-hidden">
                <Editor
                  key={`view-${id}`}
                  language="markdown"
                  theme={theme === "dark" ? "vs-dark" : "vs"}
                  value={template.body}
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    fontSize: 13,
                    lineNumbers: "on",
                    wordWrap: "on",
                    automaticLayout: true,
                    padding: { top: 8 },
                  }}
                  height="100%"
                />
              </div>
            </>
          )}
        </TabsContent>

        {/* Rendered Tab */}
        <TabsContent value="rendered" className="flex-1 overflow-auto">
          <div className="space-y-4">
            {(() => {
              const templateRefs = unresolved.filter((v) => v.startsWith("@template["));
              const regularVars = unresolved.filter((v) => !v.startsWith("@template["));
              const hasContent = rendered.trim().length > 0;
              return (
                <>
                  {templateRefs.length > 0 && (
                    <div className="flex items-start gap-2 rounded-md border border-border bg-muted/50 p-3">
                      <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                      <div className="space-y-2">
                        <p className="text-xs text-muted-foreground">
                          This template includes composition references that are resolved at
                          runtime:
                        </p>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {templateRefs.map((v) => (
                            <Badge
                              key={v}
                              variant="outline"
                              className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center border-muted-foreground/30 text-muted-foreground"
                            >
                              {v}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                  {regularVars.length > 0 && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-muted-foreground">Unresolved variables:</span>
                      {regularVars.map((v) => (
                        <Badge
                          key={v}
                          variant="outline"
                          size="tag"
                          className="border-amber-500/30 text-amber-400"
                        >
                          {v}
                        </Badge>
                      ))}
                    </div>
                  )}
                  <div className="prose-chat text-sm text-foreground/90 rounded-md border border-border p-4 overflow-auto">
                    <Streamdown>{hasContent ? rendered : body}</Streamdown>
                  </div>
                </>
              );
            })()}

            {/* Variables section */}
            {eventDef && eventDef.variables.length > 0 && (
              <div className="border border-border rounded-md">
                <button
                  type="button"
                  className="flex items-center gap-2 w-full px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setVarsOpen(!varsOpen)}
                >
                  {varsOpen ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                  Variables ({eventDef.variables.length})
                </button>
                {varsOpen && (
                  <div className="px-3 pb-3 space-y-2">
                    {eventDef.variables.map((v) => (
                      <div key={v.name} className="flex items-start gap-3 text-sm">
                        <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded shrink-0">
                          {`{{${v.name}}}`}
                        </code>
                        <span className="text-muted-foreground">{v.description}</span>
                        {v.example && (
                          <span className="text-xs text-muted-foreground/60 shrink-0">
                            e.g. {v.example}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </TabsContent>

        {/* History Tab */}
        <TabsContent value="history" className="flex-1 min-h-0">
          <DataGrid
            rowData={history}
            columnDefs={historyColumns}
            onRowClicked={onHistoryRowClicked}
            emptyMessage="No version history"
            pagination={false}
          />
        </TabsContent>
      </Tabs>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete template?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this template override. The default template will be used
              instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={handleDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reset Confirmation */}
      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset template?</AlertDialogTitle>
            <AlertDialogDescription>
              This will reset the template to its default body. Your current changes will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleReset}>Reset</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Checkout Confirmation */}
      <AlertDialog
        open={checkoutVersion !== null}
        onOpenChange={(open) => {
          if (!open) setCheckoutVersion(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Checkout version {checkoutVersion}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will restore the template body from version {checkoutVersion}. A new version will
              be created.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleCheckout}>Checkout</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
