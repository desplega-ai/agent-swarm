import { ArrowLeft, Blocks, Download, ExternalLink, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ExtensionInstallError } from "@/api/client";
import { useExtensionCatalog, useInstallExtension } from "@/api/hooks/use-extensions";
import type { ExtensionCatalogItem, ExtensionInstallResult } from "@/api/types";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { EmptyState } from "@/components/shared/empty-state";
import { MarkdownView } from "@/components/shared/markdown-view";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";

/** Display order for known asset kinds; unknown kinds follow alphabetically. */
const ASSET_ORDER = ["scripts", "schedules", "skills", "workflows"];

/**
 * "1 script · 2 schedules", or "hooks only" when the bundle declares no global
 * assets. Counts come from the catalog; hooks are never counted there.
 */
export function formatAssetCounts(assets: Record<string, number>): string {
  const kinds = Object.keys(assets)
    .filter((kind) => (assets[kind] ?? 0) > 0)
    .sort((a, b) => {
      const ai = ASSET_ORDER.indexOf(a);
      const bi = ASSET_ORDER.indexOf(b);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      return a.localeCompare(b);
    });
  if (kinds.length === 0) return "hooks only";
  return kinds
    .map((kind) => {
      const count = assets[kind] ?? 0;
      const label = count === 1 && kind.endsWith("s") ? kind.slice(0, -1) : kind;
      return `${count} ${label}`;
    })
    .join(" · ");
}

/** "2 created, 1 updated" for the install toast; empty when nothing moved. */
function formatInstallAssets(result: ExtensionInstallResult): string {
  const assets = result.assets;
  if (!assets) return "";
  const parts = [
    assets.created.length > 0 ? `${assets.created.length} created` : null,
    assets.updated.length > 0 ? `${assets.updated.length} updated` : null,
    assets.skipped.length > 0 ? `${assets.skipped.length} skipped` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `Assets: ${parts.join(", ")}` : "";
}

function InstalledBadge({ installed }: { installed: ExtensionCatalogItem["installed"] }) {
  if (!installed) {
    return (
      <Badge variant="outline" size="tag">
        Not installed
      </Badge>
    );
  }
  return (
    <Badge variant={installed.enabled ? "default" : "secondary"} size="tag">
      Installed v{installed.version} · {installed.enabled ? "enabled" : "disabled"}
    </Badge>
  );
}

function CatalogCard({
  item,
  installing,
  busy,
  onInstall,
}: {
  item: ExtensionCatalogItem;
  installing: boolean;
  busy: boolean;
  onInstall: () => void;
}) {
  const installed = item.installed;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{item.name}</span>
              <InstalledBadge installed={installed} />
            </CardTitle>
            <p className="text-sm text-muted-foreground">{item.description || "—"}</p>
          </div>
          <div className="flex items-center gap-2">
            {installed && (
              <Button type="button" size="sm" variant="ghost" asChild>
                <Link to={`/settings/extensions/${installed.id}`}>
                  <ExternalLink className="h-4 w-4" />
                  Open
                </Link>
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant={installed ? "outline" : "default"}
              disabled={busy}
              onClick={onInstall}
            >
              {installed ? <RefreshCw className="h-4 w-4" /> : <Download className="h-4 w-4" />}
              {installing ? "Installing…" : installed ? "Reinstall / update" : "Install"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground">
          <span>v{item.version}</span>
          <span>·</span>
          <span>{item.manifestFile}</span>
          <span>·</span>
          <span>{formatAssetCounts(item.assets)}</span>
        </div>
        {item.readme && (
          <CollapsibleSection title="README">
            <div className="pt-2 text-sm">
              <MarkdownView text={item.readme} normalizeSoftBreaks={false} />
            </div>
          </CollapsibleSection>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * `/settings/extensions/new` — the predefined bundles bundled with the server
 * (`GET /api/extensions/catalog`). Extensions install only from this catalog;
 * installing an already-installed template stages a new version when its
 * content changed, and is a no-op otherwise.
 */
export default function ExtensionCatalogPage() {
  const navigate = useNavigate();
  const { data: catalog, isLoading, error } = useExtensionCatalog();
  const install = useInstallExtension();
  const [installError, setInstallError] = useState<{
    template: string;
    message: string;
    diagnostics: string[];
  } | null>(null);

  if (isLoading) return <PageSkeleton />;

  function handleInstall(item: ExtensionCatalogItem) {
    setInstallError(null);
    install.mutate(
      { template: item.name },
      {
        onSuccess: (result) => {
          if (result.contentDeduped) {
            toast.success("Already up to date", {
              description: `${item.name} v${result.extension.version} matches the catalog.`,
            });
          } else {
            const assets = formatInstallAssets(result);
            toast.success(`Installed ${item.name} v${result.extension.version}`, {
              description: assets || undefined,
            });
          }
          void navigate(`/settings/extensions/${result.extension.id}`);
        },
        onError: (err) => {
          setInstallError({
            template: item.name,
            message: err instanceof Error ? err.message : String(err),
            diagnostics: err instanceof ExtensionInstallError ? err.diagnostics : [],
          });
        },
      },
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-6">
      <PageHeader
        title="Install extension"
        description="Predefined bundles shipped with this server. Installing adds the extension disabled; enable it from its detail page. Reinstalling stages a new version only when the bundle changed."
        action={
          <Button type="button" size="sm" variant="ghost" asChild>
            <Link to="/settings/extensions">
              <ArrowLeft className="h-4 w-4" />
              Back
            </Link>
          </Button>
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            Failed to load the extension catalog:{" "}
            {error instanceof Error ? error.message : String(error)}
          </AlertDescription>
        </Alert>
      )}

      {installError && (
        <Alert variant="destructive">
          <AlertDescription>
            <p>
              Failed to install <span className="font-mono">{installError.template}</span>:{" "}
              {installError.message}
            </p>
            {installError.diagnostics.length > 0 && (
              <ul className="mt-2 list-disc pl-4 font-mono text-[11px] leading-relaxed">
                {installError.diagnostics.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}

      {!error && (catalog?.length ?? 0) === 0 ? (
        <EmptyState
          icon={Blocks}
          title="No predefined extensions"
          description="This server ships no extension templates."
        />
      ) : (
        <div className="flex flex-col gap-4">
          {(catalog ?? []).map((item) => (
            <CatalogCard
              key={item.name}
              item={item}
              busy={install.isPending}
              installing={install.isPending && install.variables?.template === item.name}
              onInstall={() => handleInstall(item)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
