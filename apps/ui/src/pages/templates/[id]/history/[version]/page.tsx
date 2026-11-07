import { ArrowLeft } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import { usePreviewTemplate, usePromptTemplate, usePromptTemplateEvents } from "@/api/hooks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIsMobile } from "@/hooks/use-mobile";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { formatSmartTime } from "@/lib/utils";
import { PhoneDetailHeader } from "../../../components/phone-detail-header";
import { TemplateCode } from "../../../components/template-code";

export default function TemplateVersionDetailPage() {
  const { id, version: versionParam } = useParams<{ id: string; version: string }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { searchParams, setParam } = useUrlSearchState();
  const activeTab = readStringParam(searchParams, "tab") === "rendered" ? "rendered" : "raw";
  const versionNum = Number(versionParam);

  const { data, isLoading, isError } = usePromptTemplate(id);
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

  if (isError || !template || !versionEntry) {
    return (
      <div className="flex flex-col flex-1 items-center justify-center gap-2 text-muted-foreground">
        <p>{!template ? "Template not found" : "Version not found"}</p>
        <Button variant="outline" size="sm" asChild>
          <Link to={template ? `/templates/${id}` : "/templates"}>
            {template ? `Back to ${template.eventType}` : "Back to Templates"}
          </Link>
        </Button>
      </div>
    );
  }

  const stateBadge = (
    <Badge variant="outline" size="tag">
      {versionEntry.state?.replace(/_/g, " ") ?? "—"}
    </Badge>
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3 md:gap-4">
      {/* Header */}
      {isMobile ? (
        <div className="flex flex-col gap-2">
          <PhoneDetailHeader
            backTo={`/templates/${id}`}
            backLabel={`Back to ${template.eventType}`}
            title={
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                Version {versionEntry.version}
                {stateBadge}
              </span>
            }
            actions={
              <Link
                to={`/templates/${id}`}
                title={template.eventType}
                className="max-w-[48%] self-center truncate font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
              >
                {template.eventType}
              </Link>
            }
          />
          {/* Two rows, label left: who and when, then why. */}
          <dl className="grid grid-cols-[4rem_1fr] gap-x-2 gap-y-1 pl-8 text-xs">
            <dt className="text-muted-foreground">Changed</dt>
            <dd className="min-w-0 truncate">
              {[versionEntry.changedBy, formatSmartTime(versionEntry.changedAt)]
                .filter(Boolean)
                .join(" · ")}
            </dd>
            {versionEntry.changeReason ? (
              <>
                <dt className="text-muted-foreground">Reason</dt>
                <dd className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">
                  {versionEntry.changeReason}
                </dd>
              </>
            ) : null}
          </dl>
        </div>
      ) : (
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

          <PageHeader
            title={
              <div className="flex items-center gap-3 flex-wrap min-w-0">
                <h1 className="text-xl font-semibold">Version {versionEntry.version}</h1>
                {stateBadge}
              </div>
            }
          />

          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            {versionEntry.changedBy && <span>Changed by: {versionEntry.changedBy}</span>}
            <span>Changed at: {formatSmartTime(versionEntry.changedAt)}</span>
            {versionEntry.changeReason && <span>Reason: {versionEntry.changeReason}</span>}
          </div>
        </div>
      )}

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={(tab) => setParam("tab", tab, { defaultValue: "raw" })}
        className="flex flex-col flex-1 min-h-0"
      >
        <TabsList>
          <TabsTrigger value="raw">Raw</TabsTrigger>
          <TabsTrigger value="rendered">Rendered</TabsTrigger>
        </TabsList>

        {/* Raw Tab — read only */}
        <TabsContent value="raw" className="flex flex-col flex-1 min-h-0">
          <TemplateCode
            editorKey={`version-${id}-${versionEntry.version}-${isMobile}`}
            value={versionEntry.body}
            phone={isMobile}
          />
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
                    size="tag"
                    className="border-status-active/30 text-status-active-strong"
                  >
                    {v}
                  </Badge>
                ))}
              </div>
            )}

            <div className="prose-chat text-sm text-foreground/90 rounded-md border border-border p-3 md:p-4 overflow-auto">
              <Streamdown>{rendered || versionEntry.body}</Streamdown>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
