import { AlertTriangle, CheckCircle2, Database, RefreshCw, Webhook } from "lucide-react";
import {
  useAriaKnowledgeSources,
  useAriaSlackSurfaces,
  useVerifyAriaSlackSurface,
} from "@/api/hooks/use-ariahq";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";

function statusVariant(status: string | undefined) {
  return status === "verified" || status === "completed" ? "default" : "outline";
}

export default function AriaSourcesPage() {
  const sources = useAriaKnowledgeSources();
  const surfaces = useAriaSlackSurfaces();
  const verify = useVerifyAriaSlackSurface();

  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Sources & surfaces"
        description="Production boundaries for Aria's organizational knowledge and Slack interactions. Unverified surfaces remain inactive."
      />

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Knowledge sources</h2>
          <p className="text-sm text-muted-foreground">
            Polling sources run through scoped connections; webhooks use a source-specific secret.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {(sources.data?.sources ?? []).map((source) => (
            <Card key={source.id} className="shadow-none">
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    {source.adapter === "webhook" ? (
                      <Webhook className="size-5 text-primary" />
                    ) : (
                      <Database className="size-5 text-primary" />
                    )}
                    <CardTitle>{source.name}</CardTitle>
                  </div>
                  <Badge variant={statusVariant(source.lastSyncStatus)} size="tag">
                    {source.lastSyncStatus ?? (source.scheduleId ? "scheduled" : "ready")}
                  </Badge>
                </div>
                <CardDescription>
                  {source.sourceKind.replaceAll("_", " ")} · {source.audience}
                  {source.clientKey ? ` · ${source.clientKey}` : ""}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Adapter</span>
                  <span>
                    {source.adapter}
                    {source.connectionSlug ? ` · ${source.connectionSlug}` : ""}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Last sync</span>
                  <span>
                    {source.lastSyncAt ? new Date(source.lastSyncAt).toLocaleString() : "Not run"}
                  </span>
                </div>
                {source.lastErrorMessage ? (
                  <div className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <span>{source.lastErrorMessage}</span>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ))}
          {!sources.isLoading && (sources.data?.sources.length ?? 0) === 0 ? (
            <Card className="border-dashed shadow-none">
              <CardHeader>
                <CardTitle>No sources provisioned</CardTitle>
                <CardDescription>
                  Create a scoped OpenAPI connection or webhook source before treating Ask Aria as
                  organizationally grounded.
                </CardDescription>
              </CardHeader>
            </Card>
          ) : null}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Slack surfaces</h2>
          <p className="text-sm text-muted-foreground">
            Client intake activates only after the bot, workspace, and channel are verified.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {(surfaces.data?.surfaces ?? []).map((surface) => (
            <Card key={surface.id} className="shadow-none">
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    {surface.verificationStatus === "verified" ? (
                      <CheckCircle2 className="size-5 text-emerald-600" />
                    ) : (
                      <AlertTriangle className="size-5 text-amber-600" />
                    )}
                    <CardTitle>{surface.name}</CardTitle>
                  </div>
                  <Badge variant={statusVariant(surface.verificationStatus)} size="tag">
                    {surface.verificationStatus}
                  </Badge>
                </div>
                <CardDescription>
                  {surface.workspaceId} / {surface.channelId} · {surface.audience}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex items-end justify-between gap-4">
                <div className="text-sm text-muted-foreground">
                  {surface.verificationError ??
                    (surface.verifiedAt
                      ? `Verified ${new Date(surface.verifiedAt).toLocaleString()}`
                      : "Awaiting verification")}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={verify.isPending}
                  onClick={() => verify.mutate(surface.id)}
                >
                  <RefreshCw className={verify.isPending ? "animate-spin" : ""} /> Verify
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
