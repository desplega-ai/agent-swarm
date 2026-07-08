import { ArrowLeft, Maximize2, Pencil, Power, PowerOff, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMcpServers } from "@/api/hooks/use-mcp-servers";
import {
  useCredentialBindings,
  useOAuthApps,
  useRefreshScriptConnection,
  useScriptConnection,
  useSetScriptConnectionEnabled,
} from "@/api/hooks/use-script-connections";
import { ScriptSourceEditor } from "@/components/scripts/script-source-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DetailPageBody,
  DetailPageRail,
  QuickStat,
  QuickStats,
} from "@/components/ui/detail-page-layout";
import { PageHeader } from "@/components/ui/page-header";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatSmartTime } from "@/lib/utils";
import {
  CodeViewerDialog,
  JsonSourceViewer,
} from "@/pages/connections/components/code-viewer-dialog";
import { CopyIconButton } from "@/pages/connections/components/copy-icon-button";
import { OperationsTable } from "@/pages/connections/components/operations-table";
import {
  AddConnectionDialog,
  InlineError,
  KindBadge,
  TokenStatusBadge,
  UsagePreview,
} from "@/pages/connections/page";

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid gap-1 py-2 text-sm md:grid-cols-[160px_1fr]">
      <div className="text-muted-foreground">{label}</div>
      <div className="min-w-0">{value}</div>
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
  const { data: bindings = [] } = useCredentialBindings();
  const { data: oauthApps = [] } = useOAuthApps();
  const { data: mcpServersData } = useMcpServers();
  const refreshConnection = useRefreshScriptConnection();
  const setEnabled = useSetScriptConnectionEnabled();
  const [editOpen, setEditOpen] = useState(false);
  const [typesExpanded, setTypesExpanded] = useState(false);
  const [specExpanded, setSpecExpanded] = useState(false);

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading connection...</div>;
  }
  if (error || !connection) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Button asChild variant="outline" size="sm" className="w-fit">
          <Link to="/connections">
            <ArrowLeft className="size-4" />
            Back
          </Link>
        </Button>
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
  const specUrl =
    connection.openapiSpecSourceKind === "url" ? (connection.openapiSpecSource ?? "") : "";

  return (
    <div className="flex flex-col gap-4 lg:flex-1 lg:min-h-0 lg:overflow-y-hidden">
      <PageHeader
        title={
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <Button asChild variant="ghost" size="icon-sm" aria-label="Back to connections">
              <Link to="/connections">
                <ArrowLeft className="size-4" />
              </Link>
            </Button>
            <span className="truncate text-xl font-semibold">{connection.slug}</span>
            <CopyIconButton value={connection.slug} label="Copy slug" />
            <KindBadge kind={connection.kind} />
            <Badge variant={connection.enabled ? "outline" : "secondary"} size="tag">
              {connection.enabled ? "enabled" : "disabled"}
            </Badge>
          </span>
        }
        description={`${connection.displayName ?? connection.slug} - updated ${formatSmartTime(connection.updatedAt)}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEnabled.mutate({ id: connection.id, enabled: !connection.enabled })}
              disabled={setEnabled.isPending}
            >
              {connection.enabled ? <PowerOff className="size-4" /> : <Power className="size-4" />}
              {connection.enabled ? "Disable" : "Enable"}
            </Button>
            {canRefresh ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => refreshConnection.mutate(connection.id)}
                disabled={refreshConnection.isPending}
              >
                <RefreshCw className="size-4" />
                Refresh
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              <Pencil className="size-4" />
              Edit
            </Button>
          </div>
        }
      />

      <DetailPageBody
        className="lg:flex-1 lg:min-h-0"
        main={
          <div className="space-y-4 lg:flex-1 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Overview</CardTitle>
              </CardHeader>
              <CardContent className="divide-y">
                <InfoRow
                  label="Target"
                  value={
                    <div className="flex min-w-0 items-center gap-1">
                      <span className="break-all">{target}</span>
                      {target !== "-" ? (
                        <CopyIconButton value={target} label="Copy target" />
                      ) : null}
                    </div>
                  }
                />
                {connection.openapiSpecSourceKind ? (
                  <InfoRow
                    label="Spec source"
                    value={
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
                    }
                  />
                ) : null}
                <InfoRow
                  label="Allowed hosts"
                  value={
                    connection.allowedHosts.length ? (
                      <div className="flex flex-wrap gap-1">
                        {connection.allowedHosts.map((host) => (
                          <Badge key={host} variant="outline" size="tag">
                            {host}
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )
                  }
                />
                <InfoRow
                  label="Credential"
                  value={
                    connection.credentialBinding ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" size="tag">
                          {connection.credentialBinding.authKind}
                        </Badge>
                        <Link
                          to="/connections?tab=bindings"
                          className="hover:underline"
                          title="View credential bindings"
                        >
                          {connection.credentialBinding.configKey}
                        </Link>
                        {connection.credentialBinding.oauthProvider ? (
                          <Link
                            to={`/connections/oauth-apps/${encodeURIComponent(connection.credentialBinding.oauthProvider)}`}
                            className="text-muted-foreground hover:text-foreground hover:underline"
                            title="View OAuth app"
                          >
                            {connection.credentialBinding.oauthProvider}
                          </Link>
                        ) : null}
                        <TokenStatusBadge status={connection.credentialBinding.tokenStatus} />
                      </div>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )
                  }
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {connection.kind === "mcp" ? "Tools" : "Operations"}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {connection.kind === "mcp" ? (
                  connection.tools.length ? (
                    <div className="divide-y rounded-md border">
                      {connection.tools.map((tool) => (
                        <div key={tool.name} className="grid gap-1 p-3 text-sm">
                          <div className="font-medium">{tool.name}</div>
                          {tool.description ? (
                            <div className="text-muted-foreground">{tool.description}</div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">No tools generated.</div>
                  )
                ) : connection.operations.length ? (
                  <OperationsTable operations={connection.operations} />
                ) : (
                  <div className="text-sm text-muted-foreground">
                    {connection.graphql ? "GraphQL helper generated." : "No operations generated."}
                  </div>
                )}
              </CardContent>
            </Card>

            <UsagePreview kind={connection.kind} slug={connection.slug} detail={connection} />

            {connection.generatedTypes ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Generated types</CardTitle>
                  <CardAction className="flex items-center gap-1">
                    <CopyIconButton value={connection.generatedTypes} label="Copy types" />
                    <ExpandButton label="Expand types" onClick={() => setTypesExpanded(true)} />
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <ScriptSourceEditor source={connection.generatedTypes} readOnly height="360px" />
                </CardContent>
              </Card>
            ) : null}

            {connection.specPreview ? (
              <Card>
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
                  <JsonSourceViewer source={connection.specPreview.json} height="360px" />
                </CardContent>
              </Card>
            ) : null}
          </div>
        }
        rail={
          <DetailPageRail>
            <QuickStats>
              <QuickStat label="Created" value={formatSmartTime(connection.createdAt)} />
              <QuickStat label="Updated" value={formatSmartTime(connection.updatedAt)} />
              <QuickStat label="Version" value={connection.version} />
              <QuickStat
                label={connection.kind === "mcp" ? "Tools" : "Operations"}
                value={
                  connection.kind === "mcp" ? connection.tools.length : connection.operations.length
                }
              />
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

      <InlineError error={refreshConnection.error ?? setEnabled.error} />
      <AddConnectionDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        connection={connection}
        bindings={bindings}
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
    </div>
  );
}
