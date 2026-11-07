import { AlertTriangle, Maximize2, Pencil, Power, PowerOff, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMcpServers } from "@/api/hooks/use-mcp-servers";
import {
  useOAuthApps,
  useRefreshScriptConnection,
  useScriptConnection,
  useSetScriptConnectionEnabled,
} from "@/api/hooks/use-script-connections";
import type { ScriptConnectionTool } from "@/api/types";
import { ScriptSourceEditor } from "@/components/scripts/script-source-editor";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DetailPageBody,
  DetailPageRail,
  DetailPageSection,
  QuickStat,
  QuickStats,
} from "@/components/ui/detail-page-layout";
import { PageHeader } from "@/components/ui/page-header";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatSmartTime } from "@/lib/utils";
import { BackButton } from "@/pages/connections/components/back-button";
import {
  CodeViewerDialog,
  JsonSourceViewer,
} from "@/pages/connections/components/code-viewer-dialog";
import { CopyIconButton } from "@/pages/connections/components/copy-icon-button";
import { OperationDetailDialog } from "@/pages/connections/components/operation-detail-dialog";
import { OperationsTable } from "@/pages/connections/components/operations-table";
import { useFitCodeHeight } from "@/pages/connections/components/use-fit-code-height";
import {
  AddConnectionDialog,
  InlineError,
  isBrokenTokenStatus,
  KindBadge,
  TokenStatusBadge,
  toastMutationError,
  UsagePreview,
} from "@/pages/connections/page";

// mockup(ui-audit): tighter card padding below md so the content (not the card chrome) leads
const COMPACT_CARD =
  "max-md:gap-3 max-md:py-4 max-md:[&>[data-slot=card-header]]:px-4 max-md:[&>[data-slot=card-content]]:px-4";

// mockup(ui-audit): compact Overview — label and value side by side at every width, empty rows hidden
type OverviewRow = { label: string; value: ReactNode };

function InfoRow({ label, value }: OverviewRow) {
  return (
    <div className="grid grid-cols-[84px_1fr] items-baseline gap-2 py-1.5 text-sm md:grid-cols-[140px_1fr]">
      <div className="text-xs text-muted-foreground md:text-sm">{label}</div>
      <div className="min-w-0">{value}</div>
    </div>
  );
}

// mockup(ui-audit): on lg the Overview rows move into the right rail so the operations table starts under the header
function RailInfoRow({ label, value }: OverviewRow) {
  return (
    <div className="flex flex-col gap-0.5 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <div className="min-w-0 font-medium">{value}</div>
    </div>
  );
}

// mockup(ui-audit): header actions go icon-only below sm so the name and badges keep their row
function HeaderActionButton({
  label,
  icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="max-sm:size-8 max-sm:px-0!"
    >
      {icon}
      <span className="max-sm:sr-only">{label}</span>
    </Button>
  );
}

// mockup(ui-audit): code viewers sized to content (cap 360px) instead of fixed 360px boxes
function FitTypesViewer({ source }: { source: string }) {
  const { ref, height } = useFitCodeHeight(source);
  return (
    <div ref={ref}>
      <ScriptSourceEditor source={source} readOnly height={height} />
    </div>
  );
}

function FitJsonViewer({ source }: { source: string }) {
  const { ref, height } = useFitCodeHeight(source);
  return (
    <div ref={ref}>
      <JsonSourceViewer source={source} height={height} />
    </div>
  );
}

function ExpandButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={label}
          onClick={onClick}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <Maximize2 />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export default function ConnectionDetailPage() {
  const { id } = useParams();
  const { data: connection, isLoading, error } = useScriptConnection(id);
  const { data: oauthApps = [] } = useOAuthApps();
  const { data: mcpServersData } = useMcpServers();
  const refreshConnection = useRefreshScriptConnection();
  const setEnabled = useSetScriptConnectionEnabled();
  const [editOpen, setEditOpen] = useState(false);
  const [typesExpanded, setTypesExpanded] = useState(false);
  const [specExpanded, setSpecExpanded] = useState(false);
  const [selectedTool, setSelectedTool] = useState<ScriptConnectionTool | null>(null);

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading connection...</div>;
  }
  if (error || !connection) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <BackButton fallback="/integrations/tools?tab=connections" />
        <InlineError error={error ?? "Connection not found"} />
      </div>
    );
  }

  // MCP refresh re-runs tool discovery; OpenAPI refresh re-fetches the spec,
  // so it only exists for URL-sourced specs (inline JSON has nothing to fetch).
  const canRefresh =
    connection.kind === "mcp" ||
    (connection.kind === "openapi" && connection.openapiSpecSourceKind === "url");
  const target = connection.baseUrl ?? connection.mcpServerId ?? "-";
  // mockup(ui-audit): mcp target shows the server name (linked), not the raw server UUID
  const mcpServer = connection.mcpServerId
    ? mcpServersData?.servers.find((server) => server.id === connection.mcpServerId)
    : undefined;
  const specUrl =
    connection.openapiSpecSourceKind === "url" ? (connection.openapiSpecSource ?? "") : "";
  // Tolerant of both shapes: the embedded auth summary (step-7) or the binding
  // token status. `missing` / `refresh-failed` / `revoked` flag a broken
  // OAuth authorization.
  const authStatus = connection.auth?.status ?? connection.credentialBinding?.tokenStatus;
  const authBroken =
    connection.credentialBinding?.authKind === "oauth" && isBrokenTokenStatus(authStatus);
  // N apps per provider are possible, so link to the specific app that owns this
  // authorization rather than by provider (which resolves to an arbitrary row).
  // Falls back to the provider slug when the owning app isn't in the loaded set.
  const oauthAuthorizationId = connection.auth?.authorizationId;
  const oauthAppId = oauthAuthorizationId
    ? (oauthApps.find((app) =>
        app.authorizations?.some((authorization) => authorization.id === oauthAuthorizationId),
      )?.id ?? null)
    : null;

  // mockup(ui-audit): compact Overview — only rows with a value render
  const overviewRows: OverviewRow[] = [];
  if (target !== "-") {
    overviewRows.push({
      label: connection.kind === "mcp" ? "MCP server" : "Target",
      value:
        connection.kind === "mcp" && mcpServer ? (
          <Link to={`/mcp-servers/${mcpServer.id}`} className="break-all hover:underline">
            {mcpServer.name}
          </Link>
        ) : (
          <div className="flex min-w-0 items-center gap-1">
            <span className="[overflow-wrap:anywhere]">{target}</span>
            <CopyIconButton value={target} label="Copy target" />
          </div>
        ),
    });
  }
  if (connection.openapiSpecSourceKind) {
    overviewRows.push({
      label: "Spec source",
      value: (
        <div className="flex min-w-0 items-center gap-1">
          <Badge variant="outline" size="tag">
            {connection.openapiSpecSourceKind}
          </Badge>
          {specUrl ? (
            <>
              <span className="break-all">{specUrl}</span>
              <CopyIconButton value={specUrl} label="Copy spec URL" />
            </>
          ) : null}
        </div>
      ),
    });
  }
  if (connection.allowedHosts.length) {
    overviewRows.push({
      label: "Allowed hosts",
      value: (
        <div className="flex flex-wrap gap-1">
          {connection.allowedHosts.map((host) => (
            <Badge key={host} variant="outline" size="tag">
              {host}
            </Badge>
          ))}
        </div>
      ),
    });
  }
  if (connection.credentialBinding) {
    const binding = connection.credentialBinding;
    overviewRows.push({
      label: "Credential",
      value: (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Badge variant="outline" size="tag">
            {binding.authKind}
          </Badge>
          <Link
            to="/settings/fetch-credentials"
            className="break-all hover:underline"
            title="View credential bindings"
          >
            {binding.configKey}
          </Link>
          {binding.oauthProvider ? (
            <Link
              to={`/integrations/tools/oauth-apps/${encodeURIComponent(oauthAppId ?? binding.oauthProvider)}`}
              className="text-muted-foreground hover:text-foreground hover:underline"
              title="View OAuth app"
            >
              {binding.oauthProvider}
            </Link>
          ) : null}
          {binding.tokenStatus ? <TokenStatusBadge status={binding.tokenStatus} /> : null}
        </div>
      ),
    });
  }
  // mockup(ui-audit): graphql / sql have no operations — drop the one-sentence card, the rail names the helper
  const helperName =
    connection.kind === "graphql"
      ? "graphql()"
      : (connection.kind as string) === "sql"
        ? "query()"
        : null;
  const showOperationsCard =
    connection.kind === "mcp" || connection.operations.length > 0 || !helperName;

  return (
    <div className="flex flex-col gap-4 lg:flex-1 lg:min-h-0 lg:overflow-y-hidden">
      <PageHeader
        // mockup(ui-audit): actions top-align with the slug row when badges wrap
        className="[&>div:first-child]:items-start"
        title={
          // mockup(ui-audit): back + slug + copy stay one nowrap group; badges wrap after it
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="flex min-w-0 items-center gap-1">
              <BackButton fallback="/integrations/tools?tab=connections" iconOnly />
              <span className="truncate text-xl font-semibold">{connection.slug}</span>
              <CopyIconButton value={connection.slug} label="Copy slug" />
            </span>
            <span className="flex items-center gap-2">
              <KindBadge kind={connection.kind} />
              <Badge variant={connection.enabled ? "outline" : "secondary"} size="tag">
                {connection.enabled ? "enabled" : "disabled"}
              </Badge>
            </span>
          </span>
        }
        description={`${connection.displayName ?? connection.slug} - updated ${formatSmartTime(connection.updatedAt)}`}
        action={
          <div className="flex items-center gap-1.5 sm:gap-2">
            <HeaderActionButton
              label={connection.enabled ? "Disable" : "Enable"}
              icon={
                connection.enabled ? <PowerOff className="size-4" /> : <Power className="size-4" />
              }
              onClick={() =>
                setEnabled.mutate(
                  { id: connection.id, enabled: !connection.enabled },
                  { onError: toastMutationError },
                )
              }
              disabled={setEnabled.isPending}
            />
            {canRefresh ? (
              <HeaderActionButton
                label="Refresh"
                icon={<RefreshCw className="size-4" />}
                onClick={() =>
                  refreshConnection.mutate(connection.id, { onError: toastMutationError })
                }
                disabled={refreshConnection.isPending}
              />
            ) : null}
            <HeaderActionButton
              label="Edit"
              icon={<Pencil className="size-4" />}
              onClick={() => setEditOpen(true)}
            />
          </div>
        }
      />

      <DetailPageBody
        className="lg:flex-1 lg:min-h-0"
        main={
          <div className="space-y-4 lg:flex-1 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
            {overviewRows.length ? (
              <Card className="gap-0 py-1.5 lg:hidden">
                <CardContent className="divide-y divide-border-subtle px-3 md:px-4">
                  {overviewRows.map((row) => (
                    <InfoRow key={row.label} label={row.label} value={row.value} />
                  ))}
                </CardContent>
              </Card>
            ) : null}

            {authBroken ? (
              <AlertCallout tone="error" icon={AlertTriangle}>
                This connection's OAuth authorization
                {connection.credentialBinding?.oauthProvider
                  ? ` (${connection.credentialBinding.oauthProvider})`
                  : ""}{" "}
                needs attention — the token is missing, expired, or the last refresh failed.
                Re-authorize it from the OAuth Apps tab; calls will fail until then.
              </AlertCallout>
            ) : null}

            {showOperationsCard ? (
              <Card className={COMPACT_CARD}>
                <CardHeader>
                  <CardTitle className="text-base">
                    {connection.kind === "mcp" ? "Tools" : "Operations"}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {connection.kind === "mcp" ? (
                    connection.tools.length ? (
                      <div className="divide-y divide-border-subtle rounded-md border">
                        {connection.tools.map((tool) => (
                          <button
                            key={tool.name}
                            type="button"
                            onClick={() => setSelectedTool(tool)}
                            className="grid w-full cursor-pointer gap-1 p-3 text-left text-sm hover:bg-muted/50"
                          >
                            <div className="font-medium">{tool.name}</div>
                            {tool.description ? (
                              <div className="text-muted-foreground">{tool.description}</div>
                            ) : null}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="text-sm text-muted-foreground">No tools generated.</div>
                    )
                  ) : connection.operations.length ? (
                    <OperationsTable operations={connection.operations} slug={connection.slug} />
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      {connection.graphql
                        ? "GraphQL helper generated."
                        : "No operations generated."}
                    </div>
                  )}
                </CardContent>
              </Card>
            ) : null}

            <UsagePreview kind={connection.kind} slug={connection.slug} detail={connection} />

            {connection.generatedTypes ? (
              <Card className={COMPACT_CARD}>
                <CardHeader>
                  <CardTitle className="text-base">Generated types</CardTitle>
                  <CardAction className="flex items-center gap-1">
                    <CopyIconButton value={connection.generatedTypes} label="Copy types" />
                    <ExpandButton label="Expand types" onClick={() => setTypesExpanded(true)} />
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <FitTypesViewer source={connection.generatedTypes} />
                </CardContent>
              </Card>
            ) : null}

            {connection.specPreview ? (
              <Card className={COMPACT_CARD}>
                <CardHeader>
                  <CardTitle className="text-base">
                    OpenAPI spec preview
                    {connection.specPreview.truncated ? " (truncated)" : ""}
                  </CardTitle>
                  <CardAction className="flex items-center gap-1">
                    <CopyIconButton value={connection.specPreview.json} label="Copy spec JSON" />
                    <ExpandButton label="Expand spec" onClick={() => setSpecExpanded(true)} />
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <FitJsonViewer source={connection.specPreview.json} />
                </CardContent>
              </Card>
            ) : null}
          </div>
        }
        rail={
          <DetailPageRail>
            {overviewRows.length ? (
              <DetailPageSection title="Connection" className="hidden lg:block">
                <div className="flex flex-col">
                  {overviewRows.map((row) => (
                    <RailInfoRow key={row.label} label={row.label} value={row.value} />
                  ))}
                </div>
              </DetailPageSection>
            ) : null}
            <QuickStats>
              <QuickStat label="Created" value={formatSmartTime(connection.createdAt)} />
              <QuickStat label="Updated" value={formatSmartTime(connection.updatedAt)} />
              <QuickStat label="Version" value={connection.version} />
              {helperName && !connection.operations.length ? (
                <QuickStat label="Helper" value={helperName} mono />
              ) : (
                <QuickStat
                  label={connection.kind === "mcp" ? "Tools" : "Operations"}
                  value={
                    connection.kind === "mcp"
                      ? connection.tools.length
                      : connection.operations.length
                  }
                />
              )}
            </QuickStats>
            {connection.specSummary ? (
              <QuickStats title="Spec">
                <QuickStat label="Title" value={connection.specSummary.title ?? "-"} />
                <QuickStat label="Version" value={connection.specSummary.version ?? "-"} />
                <QuickStat label="Paths" value={connection.specSummary.pathCount} />
              </QuickStats>
            ) : null}
          </DetailPageRail>
        }
      />

      <AddConnectionDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        connection={connection}
        oauthApps={oauthApps}
        mcpServers={(mcpServersData?.servers ?? []).map((server) => ({
          id: server.id,
          name: server.name,
        }))}
      />
      {connection.generatedTypes ? (
        <CodeViewerDialog
          open={typesExpanded}
          onOpenChange={setTypesExpanded}
          title={`${connection.slug} — generated types`}
          code={connection.generatedTypes}
          language="typescript"
        />
      ) : null}
      {connection.specPreview ? (
        <CodeViewerDialog
          open={specExpanded}
          onOpenChange={setSpecExpanded}
          title={`${connection.slug} — OpenAPI spec${connection.specPreview.truncated ? " (truncated)" : ""}`}
          code={connection.specPreview.json}
          language="json"
        />
      ) : null}
      <OperationDetailDialog
        open={selectedTool !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedTool(null);
        }}
        slug={connection.slug}
        subject={selectedTool ? { kind: "tool", tool: selectedTool } : null}
      />
    </div>
  );
}
