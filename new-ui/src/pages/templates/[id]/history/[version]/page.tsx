import Editor from "@monaco-editor/react";
import { ArrowLeft } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Link, useNavigate, useParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { usePreviewTemplate, usePromptTemplate, usePromptTemplateEvents } from "@/api/hooks";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTheme } from "@/hooks/use-theme";
import { formatSmartTime } from "@/lib/utils";

export default function TemplateVersionDetailPage() {
  const { id, version: versionParam } = useParams<{ id: string; version: string }>();
  const navigate = useNavigate();
  const { theme } = useTheme();
  const versionNum = Number(versionParam);

  const { data, isLoading } = usePromptTemplate(id);
  const { data: events } = usePromptTemplateEvents();
  const previewMutation = usePreviewTemplate();

  const template = data?.template;
  const history = data?.history ?? [];
  const versionEntry = useMemo(
    () => history.find((h) => h.version === versionNum),
    [history, versionNum],
  );

  // Rendered tab state
  const [rendered, setRendered] = useState("");
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Debounced preview
  const templateEventType = template?.eventType;
  const versionBody = versionEntry?.body;
  const previewMutate = previewMutation.mutate;
  useEffect(() => {
    if (!templateEventType || !versionBody) return;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const sampleVars: Record<string, string> = {};
      const eventDef = events?.find((e) => e.eventType === templateEventType);
      if (eventDef) {
        for (const v of eventDef.variables) {
          sampleVars[v.name] = v.example ?? v.name;
        }
      }
      previewMutate(
        { eventType: templateEventType, body: versionBody, variables: sampleVars },
        {
          onSuccess: (result) => {
            setRendered(result.rendered);
            setUnresolved(result.unresolved);
          },
        },
      );
    }, 300);
    return () => clearTimeout(timerRef.current);
  }, [versionBody, templateEventType, events, previewMutate]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!template || !versionEntry) {
    return <p className="text-muted-foreground">Version not found.</p>;
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* Header */}
      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => navigate(`/templates/${id}`)}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors w-fit"
        >
          <ArrowLeft className="h-4 w-4" /> Back to{" "}
          <Link to={`/templates/${id}`} className="hover:underline">
            {template.eventType}
          </Link>
        </button>

        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-xl font-semibold">Version {versionEntry.version}</h1>
          <Badge
            variant="outline"
            className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase"
          >
            {versionEntry.state?.replace(/_/g, " ") ?? "—"}
          </Badge>
        </div>

        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          {versionEntry.changedBy && <span>Changed by: {versionEntry.changedBy}</span>}
          <span>Changed at: {formatSmartTime(versionEntry.changedAt)}</span>
          {versionEntry.changeReason && <span>Reason: {versionEntry.changeReason}</span>}
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="raw" className="flex flex-col flex-1 min-h-0">
        <TabsList>
          <TabsTrigger value="raw">Raw</TabsTrigger>
          <TabsTrigger value="rendered">Rendered</TabsTrigger>
        </TabsList>

        {/* Raw Tab — read only */}
        <TabsContent value="raw" className="flex-1 min-h-0">
          <div className="flex-1 min-h-0 h-full border border-border rounded-md overflow-hidden">
            <Editor
              language="markdown"
              theme={theme === "dark" ? "vs-dark" : "vs"}
              value={versionEntry.body}
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
        </TabsContent>

        {/* Rendered Tab */}
        <TabsContent value="rendered" className="flex-1 overflow-auto">
          <div className="space-y-4">
            {unresolved.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-muted-foreground">Unresolved variables:</span>
                {unresolved.map((v) => (
                  <Badge
                    key={v}
                    variant="outline"
                    className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase border-amber-500/30 text-amber-400"
                  >
                    {v}
                  </Badge>
                ))}
              </div>
            )}

            <div className="prose prose-sm dark:prose-invert max-w-none rounded-md border border-border p-4">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {rendered || versionEntry.body}
              </ReactMarkdown>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
