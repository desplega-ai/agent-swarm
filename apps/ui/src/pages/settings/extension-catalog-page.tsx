import { ArrowLeft, Blocks, Download, ExternalLink, PanelRightOpen, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { ExtensionInstallError } from "@/api/client";
import { useExtensionCatalog, useInstallExtension } from "@/api/hooks/use-extensions";
import type { ExtensionCatalogItem, ExtensionInstallResult } from "@/api/types";
import { EmptyState } from "@/components/shared/empty-state";
import { MarkdownView } from "@/components/shared/markdown-view";
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
import { InfoRow } from "@/components/ui/info-row";
import { PageHeader } from "@/components/ui/page-header";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useSheetFocus } from "./extension-detail";

/** Display order for known asset kinds; unknown kinds follow alphabetically. */
const ASSET_ORDER = ["scripts", "schedules", "skills", "workflows"];

/** Search param naming the catalog template whose details sheet is open. */
const TEMPLATE_PARAM = "template";

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

interface InstallErrorState {
  template: string;
  message: string;
  diagnostics: string[];
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

function InstallButton({
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
  );
}

function InstallErrorAlert({ error }: { error: InstallErrorState }) {
  return (
    <Alert variant="destructive">
      <AlertDescription>
        <p>
          Failed to install <span className="font-mono">{error.template}</span>: {error.message}
        </p>
        {error.diagnostics.length > 0 && (
          <ul className="mt-2 list-disc pl-4 font-mono text-[11px] leading-relaxed">
            {error.diagnostics.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  );
}

function CatalogCard({
  item,
  installing,
  busy,
  onInstall,
  onDetails,
}: {
  item: ExtensionCatalogItem;
  installing: boolean;
  busy: boolean;
  onInstall: () => void;
  onDetails: () => void;
}) {
  return (
    <Card className="gap-4 py-5">
      <CardHeader className="px-5">
        <CardTitle className="flex min-w-0 items-center gap-2">
          <Blocks className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono" title={item.name}>
            {item.name}
          </span>
        </CardTitle>
        <CardDescription className="line-clamp-2">{item.description || "—"}</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 px-5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-muted-foreground">
          <InstalledBadge installed={item.installed} />
          <span>v{item.version}</span>
          <span>·</span>
          <span>{formatAssetCounts(item.assets)}</span>
        </div>
      </CardContent>
      <CardFooter className="flex-wrap justify-end gap-2 px-5">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-catalog-details={item.name}
          onClick={onDetails}
        >
          <PanelRightOpen className="h-4 w-4" />
          Details
        </Button>
        <InstallButton item={item} installing={installing} busy={busy} onInstall={onInstall} />
      </CardFooter>
    </Card>
  );
}

/**
 * Details for one catalog template: the manifest summary the catalog serves,
 * its README, and the install action. Full width on small screens.
 * `focusFallback` names where focus goes on close when the opener is gone.
 */
function CatalogDetailSheet({
  item,
  installing,
  busy,
  installError,
  onInstall,
  onClose,
  focusFallback,
}: {
  item: ExtensionCatalogItem | null;
  installing: boolean;
  busy: boolean;
  installError: InstallErrorState | null;
  onInstall: (item: ExtensionCatalogItem) => void;
  onClose: () => void;
  focusFallback: (name: string) => HTMLElement | null;
}) {
  // Keep the last item so the body stays rendered while the sheet animates closed.
  const [shown, setShown] = useState(item);
  if (item && item !== shown) setShown(item);
  const focus = useSheetFocus(() => (shown ? focusFallback(shown.name) : null));

  return (
    <Sheet open={!!item} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-2xl" {...focus.contentProps}>
        <SheetHeader className="border-b border-border px-6 py-4 pr-12">
          <SheetTitle className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono">{shown?.name ?? "Extension"}</span>
            {shown && <InstalledBadge installed={shown.installed} />}
          </SheetTitle>
          <SheetDescription>{shown?.description || "Catalog extension"}</SheetDescription>
        </SheetHeader>
        {shown && (
          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-4">
            <div className="flex flex-wrap items-center justify-end gap-2">
              {shown.installed && (
                <Button type="button" size="sm" variant="ghost" asChild>
                  <Link to={`/settings/extensions/${shown.installed.id}`}>
                    <ExternalLink className="h-4 w-4" />
                    Open installed
                  </Link>
                </Button>
              )}
              <InstallButton
                item={shown}
                installing={installing}
                busy={busy}
                onInstall={() => onInstall(shown)}
              />
            </div>

            {installError?.template === shown.name && <InstallErrorAlert error={installError} />}

            <Card>
              <CardHeader>
                <CardTitle>Manifest</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <InfoRow label="Version">
                  <span className="font-mono text-xs">v{shown.version}</span>
                </InfoRow>
                <InfoRow label="Manifest file">
                  <span className="font-mono text-xs break-all">{shown.manifestFile}</span>
                </InfoRow>
                <InfoRow label="Assets">
                  <span className="font-mono text-xs">{formatAssetCounts(shown.assets)}</span>
                </InfoRow>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>README</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                {shown.readme ? (
                  <MarkdownView text={shown.readme} normalizeSoftBreaks={false} />
                ) : (
                  <p className="text-muted-foreground">This template ships no README.</p>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

/**
 * `/settings/extensions/new` — the predefined bundles bundled with the server
 * (`GET /api/extensions/catalog`), as a card grid. Details opens a sheet driven
 * by `?template=<name>`. Extensions install only from this catalog; installing
 * an already-installed template stages a new version when its content changed,
 * and is a no-op otherwise.
 */
export default function ExtensionCatalogPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: catalog, isLoading, error } = useExtensionCatalog();
  const install = useInstallExtension();
  const [installError, setInstallError] = useState<InstallErrorState | null>(null);
  const backLink = useRef<HTMLAnchorElement>(null);

  if (isLoading) return <PageSkeleton />;

  /** The template card's Details control, else the page's Back link. */
  function sheetFocusFallback(name: string) {
    return (
      document.querySelector<HTMLElement>(`[data-catalog-details="${CSS.escape(name)}"]`) ??
      backLink.current
    );
  }

  const selectedName = searchParams.get(TEMPLATE_PARAM);
  const selected = (catalog ?? []).find((item) => item.name === selectedName) ?? null;

  function setSelected(name: string | null) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (name) next.set(TEMPLATE_PARAM, name);
      else next.delete(TEMPLATE_PARAM);
      return next;
    });
  }

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
        description="Predefined bundles shipped with this server. Installing adds the extension disabled; enable it from its details. Reinstalling stages a new version only when the bundle changed."
        action={
          <Button type="button" size="sm" variant="ghost" asChild>
            <Link ref={backLink} to="/settings/extensions">
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

      {installError && <InstallErrorAlert error={installError} />}

      {!error && (catalog?.length ?? 0) === 0 ? (
        <EmptyState
          icon={Blocks}
          title="No predefined extensions"
          description="This server ships no extension templates."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
          {(catalog ?? []).map((item) => (
            <CatalogCard
              key={item.name}
              item={item}
              busy={install.isPending}
              installing={install.isPending && install.variables?.template === item.name}
              onInstall={() => handleInstall(item)}
              onDetails={() => setSelected(item.name)}
            />
          ))}
        </div>
      )}

      <CatalogDetailSheet
        item={selected}
        busy={install.isPending}
        installing={install.isPending && install.variables?.template === selected?.name}
        installError={installError}
        onInstall={handleInstall}
        onClose={() => setSelected(null)}
        focusFallback={sheetFocusFallback}
      />
    </div>
  );
}
