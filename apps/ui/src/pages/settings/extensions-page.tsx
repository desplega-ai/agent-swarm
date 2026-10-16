import { AlertTriangle, Blocks, PanelRightOpen, Plus } from "lucide-react";
import { useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useExtensions } from "@/api/hooks/use-extensions";
import type { Extension } from "@/api/types";
import { EmptyState } from "@/components/shared/empty-state";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { cn, formatSmartTime } from "@/lib/utils";
import { ExtensionDetailSheet, statusBadgeVariant } from "./extension-detail";

/** An extension needs attention when it is failing or the server disabled it. */
function hasErrorState(extension: Extension): boolean {
  return (
    extension.consecutiveFailures > 0 ||
    !!extension.lastError ||
    extension.status === "error" ||
    extension.status === "auto-disabled"
  );
}

/** Failure count when the runtime is counting, else what the status says. */
function errorHeadline(extension: Extension): string {
  const failures = extension.consecutiveFailures;
  if (failures > 0) return `${failures} consecutive failure${failures === 1 ? "" : "s"}`;
  if (extension.status === "auto-disabled") return "Auto-disabled";
  return "Last error";
}

function ExtensionCard({ extension, onDetails }: { extension: Extension; onDetails: () => void }) {
  const failing = hasErrorState(extension);
  return (
    <Card className={cn("gap-4 py-5", failing && "border-destructive/50")}>
      <CardHeader className="px-5">
        <CardTitle className="flex min-w-0 items-center gap-2">
          <Blocks className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono" title={extension.name}>
            {extension.name}
          </span>
        </CardTitle>
        <CardDescription className="line-clamp-2">{extension.description || "—"}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3 px-5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-muted-foreground">
          <Badge variant={statusBadgeVariant(extension.status)} size="tag">
            {extension.status}
          </Badge>
          <span>
            v{extension.activeVersion}
            {extension.version !== extension.activeVersion && ` (latest v${extension.version})`}
          </span>
          <span>·</span>
          <span>{extension.runtime}</span>
          <span>·</span>
          <span>priority {extension.priority}</span>
        </div>
        {failing && (
          <div className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {errorHeadline(extension)}
            </div>
            {extension.lastError && (
              <p
                className="line-clamp-2 break-all font-mono text-[11px]"
                title={extension.lastError}
              >
                {extension.lastError}
              </p>
            )}
          </div>
        )}
      </CardContent>
      <CardFooter className="justify-between gap-2 px-5">
        <span className="text-xs text-muted-foreground">
          Updated {formatSmartTime(extension.updatedAt)}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-extension-details={extension.id}
          onClick={onDetails}
        >
          <PanelRightOpen className="h-4 w-4" />
          Details
        </Button>
      </CardFooter>
    </Card>
  );
}

/**
 * Installed extensions — the operator view of `GET /api/extensions`, as a card
 * grid. Details opens a right-side sheet where the bundle is inspected,
 * enabled, versioned, and its run log read. The sheet follows the URL:
 * `/settings/extensions/:id` renders this page with that extension's sheet
 * open. New bundles install from the catalog at `/settings/extensions/new`.
 */
export default function ExtensionsPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const { data: extensions, isLoading, error } = useExtensions();
  const installButton = useRef<HTMLButtonElement>(null);

  if (isLoading) return <PageSkeleton />;

  /** The card's Details control, else (deleted card) the page's install button. */
  function sheetFocusFallback(extensionId: string, deleted: boolean) {
    if (deleted) return installButton.current;
    return (
      document.querySelector<HTMLElement>(
        `[data-extension-details="${CSS.escape(extensionId)}"]`,
      ) ?? installButton.current
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-6">
      <PageHeader
        title="Extensions"
        description="Bundles that hook into swarm orchestration — task creation, follow-up, Slack routing, heartbeat remediation, and tool calls."
        action={
          <Button
            ref={installButton}
            type="button"
            size="sm"
            onClick={() => navigate("/settings/extensions/new")}
          >
            <Plus className="h-4 w-4" />
            Install extension
          </Button>
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            Failed to load extensions: {error instanceof Error ? error.message : String(error)}
          </AlertDescription>
        </Alert>
      )}

      {!error && (extensions?.length ?? 0) === 0 ? (
        <EmptyState
          icon={Blocks}
          title="No extensions installed"
          description="Install a predefined bundle to change routing, follow-up, heartbeat, or tool-call behaviour without a core change."
          action={
            <Button type="button" size="sm" onClick={() => navigate("/settings/extensions/new")}>
              <Plus className="h-4 w-4" />
              Install extension
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {(extensions ?? []).map((extension) => (
            <ExtensionCard
              key={extension.id}
              extension={extension}
              onDetails={() => void navigate(`/settings/extensions/${extension.id}`)}
            />
          ))}
        </div>
      )}

      <ExtensionDetailSheet
        extensionId={id ?? null}
        onClose={() => void navigate("/settings/extensions")}
        focusFallback={sheetFocusFallback}
      />
    </div>
  );
}
