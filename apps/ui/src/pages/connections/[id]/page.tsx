import { ArrowLeft, Pencil, Power, PowerOff, RefreshCw } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DetailPageBody,
  DetailPageRail,
  QuickStat,
  QuickStats,
} from "@/components/ui/detail-page-layout";
import { PageHeader } from "@/components/ui/page-header";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { formatSmartTime } from "@/lib/utils";
import {
  AddConnectionDialog,
  InlineError,
  KindBadge,
  TokenStatusBadge,
  UsagePreview,
} from "@/pages/connections/page";

function CopyButton({ value }: { value: string }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <Button type="button" size="xs" variant="outline" onClick={() => copy(value)} disabled={!value}>
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid gap-1 py-2 text-sm md:grid-cols-[160px_1fr]">
      <div className="text-muted-foreground">{label}</div>
      <div className="min-w-0">{value}</div>
    </div>
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

  const canRefresh = connection.kind === "openapi" || connection.kind === "mcp";
  const target = connection.baseUrl ?? connection.mcpServerId ?? "-";

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto gap-4">
      <Button asChild variant="outline" size="sm" className="w-fit">
        <Link to="/connections">
          <ArrowLeft className="size-4" />
          Back
        </Link>
      </Button>
      <PageHeader
        title={
          <span className="inline-flex min-w-0 items-center gap-3">
            <span className="truncate">{connection.slug}</span>
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
        main={
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Overview</CardTitle>
              </CardHeader>
              <CardContent className="divide-y">
                <InfoRow label="Target" value={<span className="break-all">{target}</span>} />
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
                        <span>{connection.credentialBinding.configKey}</span>
                        {connection.credentialBinding.oauthProvider ? (
                          <span className="text-muted-foreground">
                            {connection.credentialBinding.oauthProvider}
                          </span>
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
                  <div className="overflow-hidden rounded-md border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2">Name</th>
                          <th className="px-3 py-2">Method</th>
                          <th className="px-3 py-2">Path</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {connection.operations.map((operation) => (
                          <tr key={`${operation.method}-${operation.path}-${operation.name}`}>
                            <td className="px-3 py-2 font-medium">{operation.name}</td>
                            <td className="px-3 py-2">{operation.method}</td>
                            <td className="px-3 py-2 font-mono text-xs">{operation.path}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">
                    {connection.graphql ? "GraphQL helper generated." : "No operations generated."}
                  </div>
                )}
              </CardContent>
            </Card>

            <UsagePreview kind={connection.kind} slug={connection.slug} detail={connection} />

            {connection.generatedTypes ? (
              <details className="rounded-md border">
                <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                  Generated types
                </summary>
                <div className="border-t p-4">
                  <div className="mb-2 flex justify-end">
                    <CopyButton value={connection.generatedTypes} />
                  </div>
                  <pre className="max-h-[480px] overflow-auto rounded-md bg-muted/40 p-3 text-xs">
                    {connection.generatedTypes}
                  </pre>
                </div>
              </details>
            ) : null}

            {connection.specPreview ? (
              <details className="rounded-md border">
                <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                  OpenAPI spec preview
                  {connection.specPreview.truncated ? " (truncated)" : ""}
                </summary>
                <pre className="max-h-[480px] overflow-auto border-t bg-muted/40 p-3 text-xs">
                  {connection.specPreview.json}
                </pre>
              </details>
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
    </div>
  );
}
