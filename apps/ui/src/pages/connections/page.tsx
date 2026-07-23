import type { ColDef, ICellRendererParams } from "ag-grid-community";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Info,
  KeyRound,
  Link2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useAgents } from "@/api/hooks/use-agents";
import { useMcpServers } from "@/api/hooks/use-mcp-servers";
import {
  useCredentialBindings,
  useDeleteOAuthApp,
  useDiscoverOAuthApp,
  useIntegrationsCatalog,
  useIntegrationsSurface,
  useOAuthApps,
  useOAuthPresets,
  useOAuthRedirectUri,
  useRefreshScriptConnection,
  useScriptConnections,
  useSetScriptConnectionEnabled,
  useUpsertCredentialBinding,
  useUpsertOAuthApp,
  useUpsertScriptConnection,
} from "@/api/hooks/use-script-connections";
import type {
  CredentialAuthKind,
  IntegrationsCatalogEntry,
  IntegrationsSurfaceCredential,
  IntegrationsSurfaceMechanics,
  IntegrationsSurfaceResponse,
  OAuthAppSummary,
  OAuthAuthorizationStatus,
  OAuthBindingTokenStatus,
  OAuthPreset,
  ScriptConnection,
  ScriptConnectionDetail,
  ScriptConnectionKind,
  ScriptConnectionScope,
  ScriptCredentialBinding,
} from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { MarkdownView } from "@/components/shared/markdown-view";
import { AlertCallout } from "@/components/ui/alert-callout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InfoTip } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { cn, formatSmartTime } from "@/lib/utils";
import { CatalogBrowser } from "@/pages/connections/components/catalog-browser";
import { PlaygroundPanel } from "./playground-panel";

const KIND_OPTIONS: Array<ScriptConnectionKind | "all"> = ["all", "openapi", "graphql", "mcp"];
const SCOPE_OPTIONS: Array<ScriptConnectionScope | "all"> = ["all", "global", "agent", "repo"];
const TAB_VALUES = ["connections", "bindings", "oauth-apps", "playground"] as const;
type ConnectionsTab = (typeof TAB_VALUES)[number];
const NEW_PARAM_BY_TAB: Partial<Record<ConnectionsTab, string>> = {
  connections: "connection",
  bindings: "binding",
  "oauth-apps": "oauth-app",
};
const ADD_LABEL_BY_TAB: Partial<Record<ConnectionsTab, string>> = {
  connections: "Add Connection",
  bindings: "Add Binding",
  "oauth-apps": "Add OAuth App",
};
const SEARCH_PLACEHOLDER_BY_TAB: Partial<Record<ConnectionsTab, string>> = {
  connections: "Search connections...",
  bindings: "Search bindings by config key, provider...",
  "oauth-apps": "Search OAuth apps by provider, client ID...",
};
function splitList(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function normalizeScriptSlug(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9]+(.)/g, (_match, char: string) => char.toUpperCase())
    .replace(/^[^A-Za-z_]+/, "")
    .replace(/[^A-Za-z0-9_]/g, "");
  if (!cleaned) return "";
  return `${cleaned[0]?.toLowerCase()}${cleaned.slice(1)}`;
}

function configPlaceholder(configKey: string): string {
  return configKey ? `[REDACTED:${configKey}]` : "[REDACTED:CONFIGKEY]";
}

function defaultHeaderTemplate(configKey: string): string {
  return `Authorization: Bearer ${configPlaceholder(configKey)}`;
}

const TEMPLATE_PRESETS: Array<{
  label: string;
  field: "header" | "query";
  template: (placeholder: string) => string;
}> = [
  { label: "Bearer", field: "header", template: (ph) => `Authorization: Bearer ${ph}` },
  { label: "X-API-Key", field: "header", template: (ph) => `X-API-Key: ${ph}` },
  { label: "Basic", field: "header", template: (ph) => `Authorization: Basic ${ph}` },
  { label: "Query token", field: "query", template: (ph) => `token=${ph}` },
  { label: "Query api_key", field: "query", template: (ph) => `api_key=${ph}` },
];

function optionalString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function FieldLabel({ children, tip }: { children: string; tip: string }) {
  return (
    <Label className="inline-flex items-center gap-1.5">
      {children}
      <InfoTip content={tip} />
    </Label>
  );
}

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-xs"
          variant="outline"
          aria-label={label}
          onClick={() => copy(value)}
          disabled={!value}
        >
          {copied ? <Check className="size-3 text-status-success" /> : <Copy className="size-3" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : label}</TooltipContent>
    </Tooltip>
  );
}

function scriptUsageSnippet(
  kind: ScriptConnectionKind,
  slug: string,
  detail?: Pick<ScriptConnectionDetail, "operations" | "tools">,
): string {
  const namespace = normalizeScriptSlug(slug) || "myConnection";
  if (kind === "graphql") return `await ctx.api.${namespace}.graphql("query { ... }");`;
  if (kind === "mcp") {
    const tool = detail?.tools[0]?.name || "toolName";
    return `await ctx.mcp.${namespace}.${tool}({});`;
  }
  // Prefer a read-only operation as the example — the first spec entry is
  // often a DELETE, which is a poor thing to invite copy-pasting.
  const operations = detail?.operations ?? [];
  const operation =
    operations.find((op) => op.method.toUpperCase() === "GET")?.name ||
    operations[0]?.name ||
    "exampleOperation";
  return `await ctx.api.${namespace}.${operation}({});`;
}

export function UsagePreview({
  kind,
  slug,
  detail,
}: {
  kind: ScriptConnectionKind;
  slug: string;
  detail?: Pick<ScriptConnectionDetail, "operations" | "tools">;
}) {
  const snippet = scriptUsageSnippet(kind, slug, detail);
  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase text-muted-foreground">
          Use it in a script
        </span>
        <CopyButton value={snippet} />
      </div>
      <pre className="overflow-x-auto text-xs leading-5">{snippet}</pre>
    </div>
  );
}

export function KindBadge({ kind }: { kind: ScriptConnectionKind }) {
  const colors: Record<ScriptConnectionKind, string> = {
    openapi: "border-action-default/30 text-action-default",
    graphql: "border-action-script/30 text-action-script",
    mcp: "border-action-delegate-to-agent/30 text-action-delegate-to-agent",
  };
  return (
    <Badge variant="outline" size="tag" className={colors[kind]}>
      {kind}
    </Badge>
  );
}

export function TokenStatusBadge({ status }: { status?: OAuthBindingTokenStatus }) {
  if (!status) return <span className="text-muted-foreground">-</span>;
  const colors: Record<OAuthBindingTokenStatus, string> = {
    ok: "border-status-success/30 text-status-success",
    expiring: "border-status-active/30 text-status-active",
    "refresh-failed": "border-status-error/30 text-status-error",
    revoked: "border-status-neutral/30 text-status-neutral",
    missing: "border-status-error/30 text-status-error",
  };
  return (
    <Badge variant="outline" size="tag" className={colors[status]}>
      {status}
    </Badge>
  );
}

const AUTHORIZATION_STATUS_COLORS: Record<OAuthAuthorizationStatus, string> = {
  active: "border-status-success/30 text-status-success",
  "refresh-failed": "border-status-error/30 text-status-error",
  expired: "border-status-warning/30 text-status-warning-strong",
  revoked: "border-status-neutral/30 text-status-neutral",
};

// Worst-first severity so the app grid can surface the most urgent state across
// all of an app's authorizations in a single column.
const AUTHORIZATION_STATUS_SEVERITY: Record<OAuthAuthorizationStatus, number> = {
  "refresh-failed": 3,
  expired: 2,
  revoked: 1,
  active: 0,
};

export function OAuthAuthorizationStatusBadge({ status }: { status: OAuthAuthorizationStatus }) {
  return (
    <Badge variant="outline" size="tag" className={AUTHORIZATION_STATUS_COLORS[status]}>
      {status}
    </Badge>
  );
}

export function worstAuthorizationStatus(
  authorizations: Array<{ status: OAuthAuthorizationStatus }>,
): OAuthAuthorizationStatus | null {
  if (authorizations.length === 0) return null;
  return authorizations.reduce<OAuthAuthorizationStatus>(
    (worst, current) =>
      AUTHORIZATION_STATUS_SEVERITY[current.status] > AUTHORIZATION_STATUS_SEVERITY[worst]
        ? current.status
        : worst,
    authorizations[0].status,
  );
}

const OAUTH_SOURCE_COLORS: Record<OAuthAppSummary["source"], string> = {
  manual: "border-status-neutral/30 text-status-neutral",
  "curated-prefill": "border-status-info/30 text-status-info-strong",
  dcr: "border-status-paused/30 text-status-paused-strong",
};

const OAUTH_SOURCE_LABELS: Record<OAuthAppSummary["source"], string> = {
  manual: "manual",
  "curated-prefill": "curated",
  dcr: "dcr",
};

export function OAuthSourceBadge({ source }: { source: OAuthAppSummary["source"] }) {
  return (
    <Badge variant="outline" size="tag" className={OAUTH_SOURCE_COLORS[source]}>
      {OAUTH_SOURCE_LABELS[source]}
    </Badge>
  );
}

function AuthKindBadge({ kind }: { kind: CredentialAuthKind }) {
  const colors: Record<CredentialAuthKind, string> = {
    config: "border-status-neutral/30 text-status-neutral",
    oauth: "border-action-script/30 text-action-script",
  };
  return (
    <Badge variant="outline" size="tag" className={colors[kind]}>
      {kind}
    </Badge>
  );
}

function HostChips({ hosts }: { hosts: string[] }) {
  if (hosts.length === 0) return <span className="text-muted-foreground">—</span>;
  const visible = hosts.slice(0, 2);
  const extraCount = hosts.length - visible.length;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {visible.map((host) => (
        <Badge key={host} variant="outline" size="tag" className="max-w-28 normal-case">
          <span className="truncate">{host}</span>
        </Badge>
      ))}
      {extraCount > 0 ? (
        <Badge variant="secondary" size="tag">
          +{extraCount}
        </Badge>
      ) : null}
    </span>
  );
}

function TemplateCell({ value }: { value?: string }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <code className="block max-w-full truncate rounded bg-muted/50 px-1.5 py-0.5 font-mono text-xs">
          {value}
        </code>
      </TooltipTrigger>
      <TooltipContent className="max-w-xl break-all font-mono leading-5">{value}</TooltipContent>
    </Tooltip>
  );
}

const TOKEN_STATUS_TEXT: Record<OAuthBindingTokenStatus, string> = {
  ok: "text-status-success",
  expiring: "text-status-active",
  "refresh-failed": "text-status-error",
  revoked: "text-status-neutral",
  missing: "text-status-error",
};

// A binding whose token is `missing`, `refresh-failed`, or `revoked` can no
// longer resolve — the three states that warrant a dependent-connection
// warning. `ok`/`expiring` are healthy.
export function isBrokenTokenStatus(status?: OAuthBindingTokenStatus): boolean {
  return status === "missing" || status === "refresh-failed" || status === "revoked";
}

function CredentialChip({
  connection,
  bindings,
}: {
  connection: ScriptConnection;
  bindings: ScriptCredentialBinding[];
}) {
  const summary = connection.credentialBinding;
  if (!summary) return <span className="text-muted-foreground">—</span>;
  const full = bindings.find((binding) => binding.id === summary.id);
  const keyClass = summary.tokenStatus
    ? TOKEN_STATUS_TEXT[summary.tokenStatus]
    : "text-muted-foreground";
  // Tolerant of both shapes: prefer the embedded connection auth summary
  // (step-7), fall back to the binding token status. `missing` / `refresh-failed`
  // / `revoked` all flag an authorization that can no longer resolve.
  const authStatus = connection.auth?.status ?? summary.tokenStatus;
  const isBroken = summary.authKind === "oauth" && isBrokenTokenStatus(authStatus);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex max-w-full cursor-default items-center gap-1.5 rounded-md border bg-muted/40 px-1.5 py-0.5 font-mono text-xs">
            <KeyRound className={cn("size-3 shrink-0", keyClass)} />
            <span className="truncate">{summary.configKey}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="right"
          align="start"
          className="max-w-xs px-3 py-2.5 text-left whitespace-normal"
        >
          <div className="space-y-1.5 text-xs leading-relaxed">
            <div className="flex items-center gap-2">
              <span className="font-mono font-semibold">{summary.configKey}</span>
              <span className="uppercase opacity-70">{summary.authKind}</span>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 opacity-90">
              {summary.oauthProvider ? (
                <>
                  <dt className="opacity-60">Provider</dt>
                  <dd>{summary.oauthProvider}</dd>
                </>
              ) : null}
              {summary.tokenStatus ? (
                <>
                  <dt className="opacity-60">Token</dt>
                  <dd className="font-medium">{summary.tokenStatus}</dd>
                </>
              ) : null}
              {full?.allowedHosts.length ? (
                <>
                  <dt className="opacity-60">Hosts</dt>
                  <dd className="break-all">{full.allowedHosts.join(", ")}</dd>
                </>
              ) : null}
              {full?.headerTemplate ? (
                <>
                  <dt className="opacity-60">Header</dt>
                  <dd className="break-all font-mono">{full.headerTemplate}</dd>
                </>
              ) : null}
              {full?.queryTemplate ? (
                <>
                  <dt className="opacity-60">Query</dt>
                  <dd className="break-all font-mono">{full.queryTemplate}</dd>
                </>
              ) : null}
            </dl>
          </div>
        </TooltipContent>
      </Tooltip>
      {isBroken ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              size="tag"
              className="gap-1 border-status-error/30 text-status-error"
            >
              <AlertTriangle className="size-3" />
              {summary.oauthProvider ?? "auth"}
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs whitespace-normal">
            This connection's OAuth authorization{" "}
            {summary.oauthProvider ? `(${summary.oauthProvider}) ` : ""}
            needs attention — the token is missing, expired, or the last refresh failed.
            Re-authorize it from the OAuth Apps tab.
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  );
}

export function InlineError({ error }: { error?: unknown }) {
  if (!error) return null;
  return (
    <p className="text-sm text-status-error">
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}

/** Surface a mutation failure as a toast (inline errors are reserved for page-load errors). */
export function toastMutationError(error: unknown) {
  toast.error(error instanceof Error ? error.message : String(error));
}

function ClearInputButton({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={label}
          onClick={onClear}
          className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Clear</TooltipContent>
    </Tooltip>
  );
}

async function resolveApisGuruOpenApi(domain: string): Promise<{
  specUrl?: string;
  baseUrl?: string;
  error?: string;
}> {
  if (!domain) return { error: "Catalog entry has no apis.guru domain." };
  try {
    const indexResponse = await fetch(
      `https://api.apis.guru/v2/${encodeURIComponent(domain)}.json`,
    );
    if (!indexResponse.ok) return { error: `apis.guru returned HTTP ${indexResponse.status}.` };
    const index = (await indexResponse.json()) as {
      preferred?: string;
      versions?: Record<string, { openapiUrl?: string; swaggerUrl?: string }>;
    };
    const versions = index.versions ?? {};
    const version = (index.preferred && versions[index.preferred]) || Object.values(versions)[0];
    const candidate =
      typeof version?.openapiUrl === "string" && version.openapiUrl.endsWith(".json")
        ? version.openapiUrl
        : typeof version?.swaggerUrl === "string" && version.swaggerUrl.endsWith(".json")
          ? version.swaggerUrl
          : undefined;
    if (!candidate) return { error: "No JSON OpenAPI spec URL found for this catalog entry." };

    const specResponse = await fetch(candidate);
    if (!specResponse.ok)
      return { specUrl: candidate, error: "Spec URL found, but preview failed." };
    const spec = (await specResponse.json()) as { servers?: Array<{ url?: string }> };
    const baseUrl = spec.servers?.find((server) => typeof server.url === "string")?.url;
    return { specUrl: candidate, baseUrl };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// Session-scoped cache of integrations.sh surface lookups (keyed by domain).
const integrationsSurfaceCache = new Map<string, IntegrationsSurfaceResponse>();

const SURFACE_DOMAIN_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

function surfaceConfigKeySuggestion(credentialId: string, domain: string): string {
  const fallback = `${domain.split(".")[0] ?? "API"}_API_KEY`;
  const cleaned = (credentialId || fallback)
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return cleaned || "API_KEY";
}

function surfaceHeaderTemplate(
  mechanics: IntegrationsSurfaceMechanics,
  configKey: string,
): string | null {
  if (mechanics.in !== "header" || !mechanics.headerName) return null;
  const scheme = mechanics.scheme ? `${mechanics.scheme} ` : "";
  return `${mechanics.headerName}: ${scheme}${configPlaceholder(configKey)}`;
}

/**
 * Compact markdown for integrations.sh texts (credential setup notes, domain
 * summaries). Links open in new tabs via the shared MarkdownView overrides.
 */
function CompactMarkdown({ text }: { text: string }) {
  return (
    <div className="text-sm text-muted-foreground [&_ol]:my-1 [&_p]:my-1 [&_ul]:my-1">
      <MarkdownView text={text} />
    </div>
  );
}

function SurfaceCredentialHelp({
  credential,
  applied,
  onApply,
}: {
  credential: IntegrationsSurfaceCredential;
  applied: boolean;
  onApply?: () => void;
}) {
  return (
    <div
      className={cn("rounded-md border bg-background p-2", applied && "border-status-success/60")}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium">{credential.label}</span>
        <Badge variant="outline" size="tag">
          {credential.type}
        </Badge>
        {applied ? <Check className="size-3.5 shrink-0 text-status-success" /> : null}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {credential.generateUrl ? (
            <a
              href={credential.generateUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"
            >
              Get it here <ExternalLink className="size-3" />
            </a>
          ) : null}
          {onApply ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="text-primary"
              onClick={onApply}
            >
              {applied ? "Applied" : "Use this auth"}
            </Button>
          ) : null}
        </span>
      </div>
      {credential.setup ? (
        <div className="mt-1">
          <CompactMarkdown text={credential.setup} />
        </div>
      ) : null}
    </div>
  );
}

function SurfaceAboutPanel({
  surface,
  appliedCredentialId,
  onApplyCredential,
}: {
  surface: IntegrationsSurfaceResponse;
  appliedCredentialId: string | null;
  onApplyCredential?: (id: string, credential: IntegrationsSurfaceCredential) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const credentials = Object.entries(surface.credentials);
  return (
    <div className="rounded-md border bg-muted/30">
      <button
        type="button"
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 p-3 text-left"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="text-xs font-medium uppercase text-muted-foreground">
          About {surface.domain} — auth & setup
        </span>
        {credentials.length > 0 ? (
          <Badge variant="secondary" size="tag">
            {credentials.length} credential{credentials.length === 1 ? "" : "s"}
          </Badge>
        ) : null}
        <ChevronDown
          className={cn(
            "ml-auto size-4 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded ? (
        <div className="space-y-3 border-t p-3">
          {surface.summary ? <CompactMarkdown text={surface.summary} /> : null}
          {credentials.length > 0 ? (
            <div className="space-y-2">
              {credentials.map(([id, credential]) => (
                <SurfaceCredentialHelp
                  key={id}
                  credential={credential}
                  applied={appliedCredentialId === id}
                  onApply={onApplyCredential ? () => onApplyCredential(id, credential) : undefined}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Shown when kind=mcp and the fetched surface advertises an MCP server:
 * MCP connections require a registered server, so walk the user through
 * creating one (deep-linked with prefill) and coming back.
 */
function McpGuidancePanel({
  surface,
  slug,
}: {
  surface: IntegrationsSurfaceResponse;
  slug: string;
}) {
  const mcpSurface = surface.surfaces.find((entry) => entry.type === "mcp");
  if (!mcpSurface?.url) return null;
  const credentialId = mcpSurface.auth.credentialIds[0];
  const credentialLabel = credentialId
    ? (surface.credentials[credentialId]?.label ?? credentialId)
    : null;
  const serverName = slug.trim() || normalizeScriptSlug(surface.domain.split(".")[0] ?? "");
  const createHref = `/mcp-servers?new=1&name=${encodeURIComponent(serverName)}&url=${encodeURIComponent(
    mcpSurface.url,
  )}&transport=http`;
  return (
    <div className="space-y-2 rounded-md border border-action-delegate-to-agent/40 bg-muted/30 p-3">
      <div className="text-xs font-medium uppercase text-muted-foreground">MCP setup</div>
      <div className="flex items-center gap-2 rounded-md border bg-background p-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium">MCP server URL</div>
          <div className="truncate font-mono text-xs text-muted-foreground">{mcpSurface.url}</div>
        </div>
        <CopyButton value={mcpSurface.url} label="Copy MCP server URL" />
        <Button asChild type="button" size="xs" variant="outline">
          <Link to={createHref}>Create MCP server</Link>
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Create the server there first (transport http, the URL above
        {mcpSurface.auth.required
          ? `, and auth headers — this provider requires ${credentialLabel ?? "a credential"}`
          : ""}
        ), then return here and select it in the MCP Server dropdown.
      </p>
    </div>
  );
}

export function AddConnectionDialog({
  open,
  onOpenChange,
  bindings,
  oauthApps,
  mcpServers,
  connection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bindings: ScriptCredentialBinding[];
  oauthApps: OAuthAppSummary[];
  mcpServers: Array<{ id: string; name: string }>;
  connection?: ScriptConnectionDetail | ScriptConnection;
}) {
  const upsert = useUpsertScriptConnection();
  const {
    data: catalog = [],
    isLoading: catalogLoading,
    error: catalogError,
  } = useIntegrationsCatalog();
  const [step, setStep] = useState<"catalog" | "form">(connection ? "form" : "catalog");
  const [catalogHint, setCatalogHint] = useState("");
  const [resolvingCatalogId, setResolvingCatalogId] = useState<string | null>(null);
  const surfaceLookup = useIntegrationsSurface();
  const [surface, setSurface] = useState<IntegrationsSurfaceResponse | null>(null);
  const [surfaceLoading, setSurfaceLoading] = useState(false);
  const [surfaceDomainInput, setSurfaceDomainInput] = useState("");
  const [kind, setKind] = useState<ScriptConnectionKind>("openapi");
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [allowedHosts, setAllowedHosts] = useState("");
  const [mcpServerId, setMcpServerId] = useState("");
  const [specMode, setSpecMode] = useState<"url" | "inline">("url");
  const [openapiSpecUrl, setOpenapiSpecUrl] = useState("");
  const [openapiSpecJson, setOpenapiSpecJson] = useState("");
  const [credentialMode, setCredentialMode] = useState<"none" | "existing" | "inline">("none");
  const [credentialBindingId, setCredentialBindingId] = useState("");
  const [configKey, setConfigKey] = useState("");
  const [headerTemplate, setHeaderTemplate] = useState(defaultHeaderTemplate(""));
  const [queryTemplate, setQueryTemplate] = useState("");
  const [authKind, setAuthKind] = useState<CredentialAuthKind>("config");
  const [oauthProvider, setOauthProvider] = useState("");
  const [appliedCredentialId, setAppliedCredentialId] = useState<string | null>(null);
  const previousAutoHeader = useRef(defaultHeaderTemplate(""));
  const isEdit = Boolean(connection);

  useEffect(() => {
    const next = defaultHeaderTemplate(configKey);
    if (!headerTemplate || headerTemplate === previousAutoHeader.current) {
      setHeaderTemplate(next);
    }
    previousAutoHeader.current = next;
  }, [configKey, headerTemplate]);

  // Reset form fields + loaded surface state. Runs on open, on close, and
  // when navigating back to the catalog step so a new selection starts clean.
  const resetForm = useCallback(() => {
    setCatalogHint("");
    setSurface(null);
    setSurfaceDomainInput("");
    setKind(connection?.kind ?? "openapi");
    setSlug(connection?.slug ?? "");
    setDisplayName(connection?.displayName ?? "");
    setBaseUrl(connection?.baseUrl ?? "");
    setAllowedHosts(connection?.allowedHosts.join(", ") ?? "");
    setMcpServerId(connection?.mcpServerId ?? "");
    setSpecMode(connection?.openapiSpecSourceKind === "inline" ? "inline" : "url");
    setOpenapiSpecUrl(
      connection?.kind === "openapi" && connection.openapiSpecSourceKind === "url"
        ? (connection.openapiSpecSource ?? "")
        : "",
    );
    setOpenapiSpecJson("");
    setCredentialMode(connection?.credentialBindingId ? "existing" : "none");
    setCredentialBindingId(connection?.credentialBindingId ?? "");
    setConfigKey("");
    setHeaderTemplate(defaultHeaderTemplate(""));
    setQueryTemplate("");
    setAuthKind("config");
    setOauthProvider("");
    setAppliedCredentialId(null);
    previousAutoHeader.current = defaultHeaderTemplate("");
  }, [connection]);

  useEffect(() => {
    if (!open) return;
    setStep(connection ? "form" : "catalog");
    resetForm();
  }, [open, connection, resetForm]);

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) resetForm();
    onOpenChange(nextOpen);
  }

  // Prefill form fields from integrations.sh surface data: the http surface
  // feeds baseUrl/allowedHosts and header-auth mechanics feed the inline
  // credential section; the mcp surface renders in the About panel.
  function applySurfacePrefill(
    data: IntegrationsSurfaceResponse,
    targetKind: ScriptConnectionKind,
  ) {
    const httpSurface = data.surfaces.find((entry) => entry.type === "http");
    if (!httpSurface || targetKind === "mcp") return;
    if (httpSurface.url) {
      const surfaceUrl = httpSurface.url;
      if (targetKind === "graphql") {
        // The catalog entry's own URL is the GraphQL endpoint; only fill gaps.
        setBaseUrl((current) => (current.trim() ? current : surfaceUrl));
      } else {
        setBaseUrl(surfaceUrl);
      }
      try {
        const hostname = new URL(surfaceUrl).hostname;
        setAllowedHosts((current) => uniqueStrings([...splitList(current), hostname]).join(", "));
      } catch {
        // Malformed surface URL; skip the allowed-hosts merge.
      }
    }
    // The surface may advertise an OpenAPI spec URL; only fill gaps so an
    // apis.guru-resolved (JSON) spec or user input is never overwritten.
    if (targetKind === "openapi" && httpSurface.spec) {
      const specUrl = httpSurface.spec;
      setSpecMode("url");
      setOpenapiSpecUrl((current) => (current.trim() ? current : specUrl));
    }
    const mechanics = httpSurface.auth.mechanics;
    if (httpSurface.auth.required && mechanics?.in === "header" && mechanics.headerName) {
      const suggestedKey = surfaceConfigKeySuggestion(
        httpSurface.auth.credentialIds[0] ?? "",
        data.domain,
      );
      const template = surfaceHeaderTemplate(mechanics, suggestedKey);
      setCredentialMode((current) => (current === "none" ? "inline" : current));
      setConfigKey((current) => (current.trim() ? current : suggestedKey));
      if (template) setHeaderTemplate(template);
    }
  }

  // "Use this auth": apply a surface credential card to the form's inline
  // credential section. OAuth-type credentials flip authKind to oauth (the
  // token comes from an OAuth app, not a stored config secret).
  function applySurfaceCredential(id: string, credential: IntegrationsSurfaceCredential) {
    const key = surfaceConfigKeySuggestion(id, surface?.domain ?? "");
    const mechanics =
      surface?.surfaces.find((entry) => entry.type === "http")?.auth.mechanics ?? null;
    const isOauth = credential.type.toLowerCase().includes("oauth");
    setCredentialMode("inline");
    setConfigKey(key);
    const template = mechanics ? surfaceHeaderTemplate(mechanics, key) : null;
    setHeaderTemplate(template ?? defaultHeaderTemplate(key));
    setAuthKind(isOauth ? "oauth" : "config");
    if (!isOauth) setOauthProvider("");
    setAppliedCredentialId(id);
  }

  async function loadSurface(
    domain: string,
    targetKind: ScriptConnectionKind,
  ): Promise<IntegrationsSurfaceResponse | null> {
    const normalized = domain.trim().toLowerCase();
    if (!normalized) return null;
    const cached = integrationsSurfaceCache.get(normalized);
    if (cached) {
      setSurface(cached);
      applySurfacePrefill(cached, targetKind);
      return cached;
    }
    setSurfaceLoading(true);
    try {
      const data = await surfaceLookup.mutateAsync(normalized);
      integrationsSurfaceCache.set(normalized, data);
      setSurface(data);
      applySurfacePrefill(data, targetKind);
      return data;
    } catch (error) {
      // Non-blocking: manual entry still works without surface details.
      toast.error(
        error instanceof Error
          ? error.message
          : `Could not load integration details for ${normalized}`,
      );
      return null;
    } finally {
      setSurfaceLoading(false);
    }
  }

  async function fetchDomainDetails() {
    const domain = surfaceDomainInput.trim().toLowerCase();
    if (!SURFACE_DOMAIN_PATTERN.test(domain)) {
      toast.error("Enter a bare domain like stripe.com");
      return;
    }
    const data = await loadSurface(domain, kind);
    if (!data) return;
    const httpSurface = data.surfaces.find((entry) => entry.type === "http");
    const mcpSurface = data.surfaces.find((entry) => entry.type === "mcp");
    if (!httpSurface && mcpSurface) {
      setKind("mcp");
      setCatalogHint("Select the matching MCP server from the manual form.");
    }
    setSlug((current) => current || normalizeScriptSlug(domain.split(".")[0] ?? domain));
    setDisplayName((current) => current || httpSurface?.name || mcpSurface?.name || data.domain);
    setAllowedHosts((current) => (current.trim() ? current : domain));
    setStep("form");
  }

  async function selectCatalogEntry(entry: IntegrationsCatalogEntry) {
    setStep("form");
    setCatalogHint("");
    setSurface(null);
    setKind(entry.kind);
    setSlug(normalizeScriptSlug(entry.slug || entry.name));
    setDisplayName(entry.name);
    if (entry.domain) setAllowedHosts(entry.domain);

    if (entry.kind === "graphql") {
      setBaseUrl(entry.url);
      if (entry.domain) void loadSurface(entry.domain, "graphql");
      return;
    }
    if (entry.kind === "mcp") {
      setCatalogHint("Select the matching MCP server from the manual form.");
      if (entry.domain) void loadSurface(entry.domain, "mcp");
      return;
    }
    setSpecMode("url");
    setOpenapiSpecUrl("");
    setBaseUrl(entry.url);
    setResolvingCatalogId(entry.id);
    const [resolved] = await Promise.all([
      resolveApisGuruOpenApi(entry.domain),
      entry.domain ? loadSurface(entry.domain, "openapi") : Promise.resolve(null),
    ]);
    setResolvingCatalogId(null);
    if (resolved.specUrl) setOpenapiSpecUrl(resolved.specUrl);
    // Spec-declared server URL wins over the surface prefill when available.
    if (resolved.baseUrl) setBaseUrl(resolved.baseUrl);
    if (resolved.error) {
      setCatalogHint(`Catalog selected; ${resolved.error}`);
    }
  }

  async function submit() {
    const parsedHosts = splitList(allowedHosts);
    const credential =
      credentialMode === "existing"
        ? { credentialBindingId: credentialBindingId || null }
        : credentialMode === "inline"
          ? {
              configKey,
              headerTemplate: optionalString(headerTemplate),
              queryTemplate: optionalString(queryTemplate),
              authKind,
              oauthProvider: authKind === "oauth" ? optionalString(oauthProvider) : undefined,
            }
          : {};
    const common = {
      id: connection?.id,
      slug,
      displayName: optionalString(displayName),
      allowedHosts: parsedHosts.length ? parsedHosts : undefined,
      ...credential,
    };

    try {
      if (kind === "mcp") {
        await upsert.mutateAsync({
          id: connection?.id,
          kind: "mcp",
          slug,
          displayName: optionalString(displayName),
          mcpServerId,
        });
      } else if (kind === "graphql") {
        await upsert.mutateAsync({
          ...common,
          kind: "graphql",
          baseUrl,
          allowedHosts: parsedHosts,
        });
      } else {
        await upsert.mutateAsync({
          ...common,
          kind: "openapi",
          baseUrl,
          ...(specMode === "url" && openapiSpecUrl.trim()
            ? { openapiSpecUrl: openapiSpecUrl.trim() }
            : specMode === "inline" && openapiSpecJson.trim()
              ? { openapiSpecJson: openapiSpecJson.trim() }
              : {}),
        });
      }
    } catch (error) {
      // InlineError keeps the detail visible in the dialog; the toast makes
      // the failure unmissable.
      toastMutationError(error);
      return;
    }
    toast.success(`Connection ${slug.trim()} saved`);
    handleOpenChange(false);
  }

  const specUrlIsYaml = /\.ya?ml($|[?#])/i.test(openapiSpecUrl.trim());

  const canSubmit =
    slug.trim() &&
    (kind === "mcp"
      ? mcpServerId
      : baseUrl.trim() &&
        (kind === "graphql" ||
          isEdit ||
          (specMode === "url" ? openapiSpecUrl.trim() : openapiSpecJson.trim()))) &&
    (credentialMode !== "existing" || credentialBindingId) &&
    (credentialMode !== "inline" ||
      (configKey.trim() && (authKind !== "oauth" || oauthProvider.trim())));

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader className="pb-2">
          <DialogTitle>{isEdit ? "Edit Connection" : "Add Connection"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the script namespace and generation inputs."
              : "Register an API or MCP namespace for scripts."}
          </DialogDescription>
        </DialogHeader>

        {!isEdit ? (
          <Tabs
            value={step}
            onValueChange={(value) => {
              const nextStep = value as "catalog" | "form";
              // Going back to the catalog clears the form + surface state so a
              // different selection starts clean.
              if (nextStep === "catalog") resetForm();
              setStep(nextStep);
            }}
          >
            <TabsList>
              <TabsTrigger value="catalog">Browse catalog</TabsTrigger>
              <TabsTrigger value="form">Manual form</TabsTrigger>
            </TabsList>
          </Tabs>
        ) : null}

        {step === "catalog" && !isEdit ? (
          <div className="space-y-4">
            <CatalogBrowser
              catalog={catalog}
              loading={catalogLoading}
              error={catalogError}
              resolvingId={resolvingCatalogId}
              onSelect={selectCatalogEntry}
              renderError={(error) => <InlineError error={error} />}
            />
            <div className="flex flex-col gap-2 rounded-md border border-dashed p-3 sm:flex-row sm:items-center">
              <p className="text-xs text-muted-foreground sm:flex-1">
                Not listed? Enter a provider domain to fetch connection details.
              </p>
              <div className="flex items-center gap-2">
                <Input
                  value={surfaceDomainInput}
                  onChange={(event) => setSurfaceDomainInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void fetchDomainDetails();
                    }
                  }}
                  placeholder="stripe.com"
                  className="h-8 w-44"
                />
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={!surfaceDomainInput.trim() || surfaceLoading}
                  onClick={() => void fetchDomainDetails()}
                >
                  {surfaceLoading ? "Fetching..." : "Fetch details"}
                </Button>
              </div>
            </div>
            <Button type="button" variant="outline" onClick={() => setStep("form")}>
              Skip - start from scratch
            </Button>
          </div>
        ) : (
          <div className="space-y-5">
            {surface ? (
              <SurfaceAboutPanel
                surface={surface}
                appliedCredentialId={appliedCredentialId}
                onApplyCredential={kind !== "mcp" ? applySurfaceCredential : undefined}
              />
            ) : null}
            {kind === "mcp" && surface ? <McpGuidancePanel surface={surface} slug={slug} /> : null}
            {surfaceLoading ? (
              <p className="text-xs text-muted-foreground">Loading integration details...</p>
            ) : null}
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <FieldLabel tip="Select OpenAPI for generated REST methods, GraphQL for a query helper, or MCP for server tools.">
                  Kind
                </FieldLabel>
                <Select
                  value={kind}
                  onValueChange={(value) => setKind(value as ScriptConnectionKind)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openapi">OpenAPI</SelectItem>
                    <SelectItem value="graphql">GraphQL</SelectItem>
                    <SelectItem value="mcp">MCP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <FieldLabel tip="Namespace under ctx.api or ctx.mcp in scripts. Use a short JavaScript-safe name.">
                  Slug
                </FieldLabel>
                <Input
                  value={slug}
                  onChange={(event) => setSlug(event.target.value)}
                  placeholder="github"
                />
              </div>
              <div className="space-y-2">
                <FieldLabel tip="Human-readable label shown in the dashboard; scripts still use the slug.">
                  Display Name
                </FieldLabel>
                <Input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="GitHub API"
                />
              </div>
            </div>

            {kind === "mcp" ? (
              <div className="space-y-2">
                <FieldLabel tip="Installed MCP server whose tools should be exposed under ctx.mcp.<slug>.">
                  MCP Server
                </FieldLabel>
                <Select value={mcpServerId} onValueChange={setMcpServerId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select server" />
                  </SelectTrigger>
                  <SelectContent>
                    {mcpServers.map((server) => (
                      <SelectItem key={server.id} value={server.id}>
                        {server.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <FieldLabel tip="Provider API origin used when scripts call this connection.">
                      Base URL
                    </FieldLabel>
                    <Input
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.target.value)}
                      placeholder="https://api.github.com"
                    />
                  </div>
                  <div className="space-y-2">
                    <FieldLabel tip="Exact hostnames where the credential placeholder is substituted at egress.">
                      Allowed Hosts
                    </FieldLabel>
                    <Input
                      value={allowedHosts}
                      onChange={(event) => setAllowedHosts(event.target.value)}
                      placeholder="api.github.com, uploads.github.com"
                    />
                  </div>
                </div>

                {kind === "openapi" ? (
                  <div className="grid gap-3">
                    <FieldLabel tip="Choose whether the OpenAPI document is fetched from a URL or pasted as JSON.">
                      Spec Source
                    </FieldLabel>
                    <Select
                      value={specMode}
                      onValueChange={(value) => setSpecMode(value as "url" | "inline")}
                    >
                      <SelectTrigger className="w-40">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="url">Spec URL</SelectItem>
                        <SelectItem value="inline">Inline JSON</SelectItem>
                      </SelectContent>
                    </Select>
                    {specMode === "url" ? (
                      <div className="space-y-2">
                        <FieldLabel tip="Public JSON OpenAPI document URL; the server fetches it and generates ctx.api methods.">
                          Spec URL
                        </FieldLabel>
                        <Input
                          value={openapiSpecUrl}
                          onChange={(event) => setOpenapiSpecUrl(event.target.value)}
                          placeholder="https://example.com/openapi.json"
                        />
                        {specUrlIsYaml ? (
                          <p className="text-xs text-muted-foreground">
                            YAML spec detected — it will be converted to JSON automatically.
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <FieldLabel tip="Raw OpenAPI JSON document pasted directly into this connection.">
                          Inline JSON
                        </FieldLabel>
                        <Textarea
                          value={openapiSpecJson}
                          onChange={(event) => setOpenapiSpecJson(event.target.value)}
                          className="min-h-40 font-mono text-xs"
                          placeholder={`{"openapi": "3.1.0", "info": {"title": "GitHub API"}, "paths": {...}}`}
                        />
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            )}

            {kind !== "mcp" ? (
              <div className="space-y-4 rounded-md border p-4">
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="space-y-2">
                    <FieldLabel tip="Choose no credential, reuse an existing binding, or create a binding while saving this connection.">
                      Credential
                    </FieldLabel>
                    <Select
                      value={credentialMode}
                      onValueChange={(value) =>
                        setCredentialMode(value as "none" | "existing" | "inline")
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        <SelectItem value="existing">Existing</SelectItem>
                        <SelectItem value="inline">Create Inline</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {credentialMode === "existing" ? (
                    <div className="space-y-2 md:col-span-2">
                      <FieldLabel tip="Existing credential binding whose config key and templates apply to this connection.">
                        Binding
                      </FieldLabel>
                      <Select value={credentialBindingId} onValueChange={setCredentialBindingId}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select binding" />
                        </SelectTrigger>
                        <SelectContent>
                          {bindings.map((binding) => (
                            <SelectItem key={binding.id} value={binding.id}>
                              {binding.configKey} ({binding.authKind})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                </div>

                {credentialMode === "inline" ? (
                  <div className="space-y-4">
                    <div className="grid gap-4 md:grid-cols-3">
                      <div className="space-y-2">
                        <FieldLabel tip="Swarm config secret key whose value is substituted only for allowed hosts.">
                          Config Key
                        </FieldLabel>
                        <Input
                          value={configKey}
                          onChange={(event) => setConfigKey(event.target.value)}
                          placeholder="GITHUB_TOKEN"
                        />
                      </div>
                      <div className="space-y-2">
                        <FieldLabel tip="Config uses a stored swarm secret; OAuth uses the selected OAuth app token.">
                          Auth Kind
                        </FieldLabel>
                        <Select
                          value={authKind}
                          onValueChange={(value) => setAuthKind(value as CredentialAuthKind)}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="config">Config</SelectItem>
                            <SelectItem value="oauth">OAuth</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {authKind === "oauth" ? (
                        <div className="space-y-2">
                          <FieldLabel tip="Provider slug from OAuth Apps; its token supplies this credential.">
                            OAuth Provider
                          </FieldLabel>
                          <Input
                            value={oauthProvider}
                            onChange={(event) => setOauthProvider(event.target.value)}
                            list="oauth-provider-options"
                            placeholder="github"
                          />
                          <datalist id="oauth-provider-options">
                            {oauthApps.map((app) => (
                              <option key={app.provider} value={app.provider} />
                            ))}
                          </datalist>
                        </div>
                      ) : null}
                    </div>
                    {authKind === "oauth" ? (
                      <p className="text-xs text-muted-foreground">
                        OAuth credentials need a configured OAuth app for this provider.{" "}
                        <Link
                          to="/connections?tab=oauth-apps&new=oauth-app"
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary underline underline-offset-2"
                        >
                          Create one in OAuth Apps
                        </Link>{" "}
                        (opens in a new tab), then enter its provider slug above.
                      </p>
                    ) : null}
                    <div className="space-y-2">
                      <FieldLabel
                        tip={`Must contain the exact placeholder ${configPlaceholder(configKey)}. Used to add request headers at egress.`}
                      >
                        Header Template
                      </FieldLabel>
                      <Input
                        value={headerTemplate}
                        onChange={(event) => setHeaderTemplate(event.target.value)}
                        placeholder={`Authorization: Bearer ${configPlaceholder(configKey)}`}
                      />
                    </div>
                    <div className="space-y-2">
                      <FieldLabel
                        tip={`Must contain the exact placeholder ${configPlaceholder(configKey)}. Used for APIs that expect credentials in a query string.`}
                      >
                        Query Template
                      </FieldLabel>
                      <Input
                        value={queryTemplate}
                        onChange={(event) => setQueryTemplate(event.target.value)}
                        placeholder={`access_token=${configPlaceholder(configKey)}`}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {catalogHint ? <p className="text-sm text-muted-foreground">{catalogHint}</p> : null}
            <UsagePreview kind={kind} slug={slug} />
            <InlineError error={upsert.error} />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit || upsert.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CredentialBindingDialog({
  open,
  onOpenChange,
  binding,
  oauthApps,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  binding?: ScriptCredentialBinding;
  oauthApps: OAuthAppSummary[];
}) {
  const upsert = useUpsertCredentialBinding();
  const [configKey, setConfigKey] = useState("");
  const [authKind, setAuthKind] = useState<CredentialAuthKind>("config");
  const [oauthProvider, setOauthProvider] = useState("");
  const [allowedHosts, setAllowedHosts] = useState<string[]>([]);
  const [headerTemplate, setHeaderTemplate] = useState(defaultHeaderTemplate(""));
  const [queryTemplate, setQueryTemplate] = useState("");
  const [scope, setScope] = useState<ScriptConnectionScope>("global");
  const [scopeId, setScopeId] = useState("");
  const [headerManuallyEdited, setHeaderManuallyEdited] = useState(false);
  const isEdit = Boolean(binding);

  useEffect(() => {
    if (!open) return;
    const nextConfigKey = binding?.configKey ?? "";
    const nextHeaderTemplate =
      binding?.headerTemplate ?? (binding ? "" : defaultHeaderTemplate(""));
    setConfigKey(nextConfigKey);
    setAuthKind(binding?.authKind ?? "config");
    setOauthProvider(binding?.oauthProvider ?? "");
    setAllowedHosts(binding?.allowedHosts ?? []);
    setHeaderTemplate(nextHeaderTemplate);
    setQueryTemplate(binding?.queryTemplate ?? "");
    setScope(binding?.scope ?? "global");
    setScopeId(binding?.scopeId ?? "");
    setHeaderManuallyEdited(
      Boolean(
        binding &&
          (!binding.headerTemplate ||
            binding.headerTemplate !== defaultHeaderTemplate(nextConfigKey)),
      ),
    );
  }, [open, binding]);

  useEffect(() => {
    if (!open || headerManuallyEdited) return;
    setHeaderTemplate(defaultHeaderTemplate(configKey));
  }, [configKey, headerManuallyEdited, open]);

  const providerOptions = useMemo(() => {
    const providers = oauthApps.map((app) => app.provider);
    return oauthProvider && !providers.includes(oauthProvider)
      ? [oauthProvider, ...providers]
      : providers;
  }, [oauthApps, oauthProvider]);

  async function submit() {
    try {
      await upsert.mutateAsync({
        id: binding?.id,
        configKey: configKey.trim(),
        allowedHosts,
        headerTemplate: optionalString(headerTemplate),
        queryTemplate: optionalString(queryTemplate),
        scope,
        scopeId: scope === "global" ? null : (optionalString(scopeId) ?? null),
        active: binding?.active ?? true,
        authKind,
        oauthProvider: authKind === "oauth" ? optionalString(oauthProvider) : undefined,
      });
    } catch (error) {
      // InlineError keeps the detail visible in the dialog; the toast makes
      // the failure unmissable.
      toastMutationError(error);
      return;
    }
    toast.success(`Binding ${configKey.trim()} saved`);
    onOpenChange(false);
  }

  const placeholder = configPlaceholder(configKey.trim());
  const canSubmit =
    configKey.trim() &&
    allowedHosts.length > 0 &&
    (headerTemplate.trim() || queryTemplate.trim()) &&
    (scope === "global" || scopeId.trim()) &&
    (authKind !== "oauth" || oauthProvider.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader className="pb-2">
          <DialogTitle>{isEdit ? "Edit Binding" : "Add Binding"}</DialogTitle>
          <DialogDescription>
            Bind a redacted placeholder to egress requests for specific hosts.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <FieldLabel tip="Secret config key referenced by the redacted placeholder in templates.">
                Config Key
              </FieldLabel>
              <Input
                value={configKey}
                onChange={(event) => setConfigKey(event.target.value)}
                placeholder="GITHUB_TOKEN"
              />
            </div>
            <div className="space-y-2">
              <FieldLabel tip="Config uses a stored swarm secret; OAuth uses the selected OAuth app token.">
                Auth Kind
              </FieldLabel>
              <Select
                value={authKind}
                onValueChange={(value) => {
                  const nextAuthKind = value as CredentialAuthKind;
                  setAuthKind(nextAuthKind);
                  if (nextAuthKind === "config") setOauthProvider("");
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="config">Config</SelectItem>
                  <SelectItem value="oauth">OAuth</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {authKind === "oauth" ? (
            <div className="space-y-2">
              <FieldLabel tip="OAuth app provider whose token supplies this credential.">
                OAuth Provider
              </FieldLabel>
              <Select value={oauthProvider} onValueChange={setOauthProvider}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={providerOptions.length ? "Select provider" : "No OAuth apps"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {providerOptions.map((provider) => (
                    <SelectItem key={provider} value={provider}>
                      {provider}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="space-y-2">
            <FieldLabel tip="Exact hostnames where this placeholder may be substituted during script egress.">
              Allowed Hosts
            </FieldLabel>
            <TagInput
              values={allowedHosts}
              onChange={setAllowedHosts}
              placeholder="api.github.com uploads.github.com"
              ariaLabel="Allowed host"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Presets:</span>
            {TEMPLATE_PRESETS.map((preset) => (
              <Button
                key={preset.label}
                type="button"
                size="xs"
                variant="outline"
                onClick={() => {
                  const value = preset.template(placeholder);
                  if (preset.field === "header") {
                    setHeaderTemplate(value);
                    setHeaderManuallyEdited(true);
                  } else {
                    setQueryTemplate(value);
                  }
                }}
              >
                {preset.label}
              </Button>
            ))}
          </div>

          <div className="space-y-2">
            <FieldLabel tip={`Header line to attach at egress. Must include ${placeholder}.`}>
              Header Template
            </FieldLabel>
            <div className="relative">
              <Input
                value={headerTemplate}
                onChange={(event) => {
                  setHeaderTemplate(event.target.value);
                  setHeaderManuallyEdited(true);
                }}
                placeholder={`Authorization: Bearer ${placeholder}`}
                className="pr-8 font-mono text-xs"
              />
              {headerTemplate ? (
                <ClearInputButton
                  label="Clear header template"
                  onClear={() => {
                    setHeaderTemplate("");
                    setHeaderManuallyEdited(true);
                  }}
                />
              ) : null}
            </div>
          </div>

          <div className="space-y-2">
            <FieldLabel
              tip={`Query fragment for APIs that expect credentials in the URL. Must include ${placeholder}.`}
            >
              Query Template
            </FieldLabel>
            <div className="relative">
              <Input
                value={queryTemplate}
                onChange={(event) => setQueryTemplate(event.target.value)}
                placeholder={`access_token=${placeholder}`}
                className="pr-8 font-mono text-xs"
              />
              {queryTemplate ? (
                <ClearInputButton
                  label="Clear query template"
                  onClear={() => setQueryTemplate("")}
                />
              ) : null}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <FieldLabel tip="Visibility scope for this binding. Global applies across the swarm.">
                Scope
              </FieldLabel>
              <Select
                value={scope}
                onValueChange={(value) => {
                  const nextScope = value as ScriptConnectionScope;
                  setScope(nextScope);
                  if (nextScope === "global") setScopeId("");
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Global</SelectItem>
                  <SelectItem value="agent">Agent</SelectItem>
                  <SelectItem value="repo">Repo</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {scope !== "global" ? (
              <div className="space-y-2">
                <FieldLabel tip="UUID of the agent or repo that owns this scoped binding.">
                  Scope ID
                </FieldLabel>
                <Input
                  value={scopeId}
                  onChange={(event) => setScopeId(event.target.value)}
                  placeholder="a1b2c3d4-e5f6-7890-abcd-ef1234567890"
                />
              </div>
            ) : null}
          </div>

          <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
            <div className="mb-2 text-xs font-medium uppercase text-foreground">
              Use in a script
            </div>
            <p>
              Use <code className="font-mono text-foreground">{placeholder}</code> in a header or
              query template. The server substitutes it only at egress, and only for the allowed
              hosts above.
            </p>
          </div>

          <InlineError error={upsert.error} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit || upsert.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CredentialBindingsSection({
  bindings,
  connections,
  oauthApps,
  search,
  loading,
}: {
  bindings: ScriptCredentialBinding[];
  connections: ScriptConnection[];
  oauthApps: OAuthAppSummary[];
  search: string;
  loading: boolean;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [editBinding, setEditBinding] = useState<ScriptCredentialBinding | undefined>();
  const upsert = useUpsertCredentialBinding();
  const usedByCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const binding of bindings) {
      const count = connections.filter((connection) => {
        return (
          connection.credentialBindingId === binding.id ||
          connection.credentialBinding?.id === binding.id ||
          connection.credentialBinding?.configKey === binding.configKey
        );
      }).length;
      counts.set(binding.id, count);
    }
    return counts;
  }, [bindings, connections]);

  const columnDefs = useMemo<ColDef<ScriptCredentialBinding>[]>(
    () => [
      {
        field: "configKey",
        headerName: "Config Key",
        minWidth: 170,
        flex: 1,
        cellRenderer: (params: ICellRendererParams<ScriptCredentialBinding>) => (
          <span className="font-mono text-xs font-semibold">{params.value}</span>
        ),
      },
      {
        field: "authKind",
        headerName: "Auth",
        width: 105,
        cellRenderer: (params: ICellRendererParams<ScriptCredentialBinding>) =>
          params.value ? <AuthKindBadge kind={params.value as CredentialAuthKind} /> : null,
      },
      {
        field: "oauthProvider",
        headerName: "OAuth Provider",
        minWidth: 150,
        cellRenderer: (params: ICellRendererParams<ScriptCredentialBinding>) => {
          const provider = params.data?.oauthProvider;
          if (!provider) return <span className="text-muted-foreground">—</span>;
          return (
            <Link
              to={`/connections/oauth-apps/${encodeURIComponent(provider)}`}
              className="inline-flex max-w-full items-center gap-1 text-action-default hover:underline"
              onClick={(event) => event.stopPropagation()}
            >
              <span className="truncate">{provider}</span>
              <ExternalLink className="size-3 shrink-0" />
            </Link>
          );
        },
      },
      {
        field: "allowedHosts",
        headerName: "Allowed Hosts",
        minWidth: 210,
        flex: 1,
        cellRenderer: (params: ICellRendererParams<ScriptCredentialBinding>) => (
          <HostChips hosts={params.data?.allowedHosts ?? []} />
        ),
      },
      {
        field: "headerTemplate",
        headerName: "Header Template",
        minWidth: 230,
        flex: 1,
        cellRenderer: (params: ICellRendererParams<ScriptCredentialBinding>) => (
          <TemplateCell value={params.data?.headerTemplate} />
        ),
      },
      {
        field: "queryTemplate",
        headerName: "Query Template",
        minWidth: 210,
        flex: 1,
        cellRenderer: (params: ICellRendererParams<ScriptCredentialBinding>) => (
          <TemplateCell value={params.data?.queryTemplate} />
        ),
      },
      {
        headerName: "Token",
        width: 100,
        cellRenderer: (params: ICellRendererParams<ScriptCredentialBinding>) =>
          params.data?.authKind === "oauth" ? (
            <TokenStatusBadge status={params.data.tokenStatus} />
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        headerName: "Used By",
        width: 105,
        valueGetter: (params) => (params.data ? (usedByCounts.get(params.data.id) ?? 0) : 0),
        cellRenderer: (params: ICellRendererParams<ScriptCredentialBinding>) => {
          const count = params.data ? (usedByCounts.get(params.data.id) ?? 0) : 0;
          return (
            <Badge variant={count > 0 ? "secondary" : "outline"} size="tag">
              {count} used
            </Badge>
          );
        },
      },
      {
        field: "active",
        headerName: "Active",
        width: 95,
        cellRenderer: (params: ICellRendererParams<ScriptCredentialBinding>) =>
          params.data ? (
            <span onClick={(event) => event.stopPropagation()}>
              <Switch
                size="sm"
                checked={params.data.active}
                onCheckedChange={(active) =>
                  upsert.mutate(
                    {
                      id: params.data!.id,
                      configKey: params.data!.configKey,
                      allowedHosts: params.data!.allowedHosts,
                      headerTemplate: params.data!.headerTemplate,
                      queryTemplate: params.data!.queryTemplate,
                      scope: params.data!.scope,
                      scopeId: params.data!.scopeId,
                      active,
                      authKind: params.data!.authKind,
                      oauthProvider:
                        params.data!.authKind === "oauth" ? params.data!.oauthProvider : undefined,
                    },
                    {
                      onSuccess: () =>
                        toast.success(
                          `Binding ${params.data!.configKey} ${active ? "enabled" : "disabled"}`,
                        ),
                      onError: toastMutationError,
                    },
                  )
                }
                disabled={upsert.isPending}
              />
            </span>
          ) : null,
      },
      {
        field: "createdAt",
        headerName: "Created",
        width: 140,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : ""),
      },
      {
        field: "updatedAt",
        headerName: "Updated",
        width: 140,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : ""),
      },
    ],
    [upsert, usedByCounts],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      <DataGrid
        rowData={bindings}
        columnDefs={columnDefs}
        quickFilterText={search}
        loading={loading}
        emptyMessage="No credential bindings found"
        paginationQueryKey="credentialBindings"
        onRowClicked={(event) => {
          const target = event.event?.target as HTMLElement | null;
          if (target?.closest("a, button")) return;
          if (event.data) {
            setEditBinding(event.data);
            setEditOpen(true);
          }
        }}
      />
      <CredentialBindingDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        binding={editBinding}
        oauthApps={oauthApps}
      />
    </div>
  );
}

function OAuthAppsSection({
  apps,
  search,
  loading,
}: {
  apps: OAuthAppSummary[];
  search: string;
  loading: boolean;
}) {
  const navigate = useNavigate();
  const [editOpen, setEditOpen] = useState(false);
  const [editApp, setEditApp] = useState<OAuthAppSummary | undefined>();
  const deleteApp = useDeleteOAuthApp();

  const columnDefs = useMemo<ColDef<OAuthAppSummary>[]>(
    () => [
      {
        field: "provider",
        headerName: "Provider",
        minWidth: 140,
        flex: 1,
        cellRenderer: (params: ICellRendererParams<OAuthAppSummary>) => (
          <span className="font-semibold">{params.value}</span>
        ),
      },
      {
        field: "source",
        headerName: "Source",
        width: 130,
        cellRenderer: (params: ICellRendererParams<OAuthAppSummary>) =>
          params.data ? <OAuthSourceBadge source={params.data.source} /> : null,
      },
      {
        field: "clientId",
        headerName: "Client ID",
        minWidth: 160,
        flex: 1,
        cellRenderer: (params: ICellRendererParams<OAuthAppSummary>) => (
          <span className="block max-w-full truncate font-mono text-xs text-muted-foreground">
            {params.value}
          </span>
        ),
      },
      {
        field: "redirectUri",
        headerName: "Redirect URI",
        minWidth: 220,
        flex: 1,
        cellRenderer: (params: ICellRendererParams<OAuthAppSummary>) =>
          params.data ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-xs text-muted-foreground">
                {params.data.redirectUri}
              </span>
              <span onClick={(event) => event.stopPropagation()}>
                <CopyButton value={params.data.redirectUri} />
              </span>
            </span>
          ) : null,
      },
      {
        headerName: "Accounts",
        width: 110,
        valueGetter: (params) => params.data?.authorizations.length ?? 0,
        cellRenderer: (params: ICellRendererParams<OAuthAppSummary>) => {
          const count = params.data?.authorizations.length ?? 0;
          return (
            <span className={count === 0 ? "text-muted-foreground" : "font-medium"}>{count}</span>
          );
        },
      },
      {
        headerName: "Status",
        width: 130,
        cellRenderer: (params: ICellRendererParams<OAuthAppSummary>) => {
          const worst = worstAuthorizationStatus(params.data?.authorizations ?? []);
          return worst ? (
            <OAuthAuthorizationStatusBadge status={worst} />
          ) : (
            <span className="text-muted-foreground">no accounts</span>
          );
        },
      },
      {
        headerName: "Actions",
        width: 150,
        sortable: false,
        cellRenderer: (params: ICellRendererParams<OAuthAppSummary>) => {
          const app = params.data;
          if (!app) return null;
          return (
            <span
              className="flex items-center gap-1.5"
              onClick={(event) => event.stopPropagation()}
            >
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  setEditApp(app);
                  setEditOpen(true);
                }}
              >
                Edit
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="icon-sm" variant="ghost" aria-label={`Delete ${app.provider}`}>
                    <Trash2 className="size-4" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete OAuth app?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This deletes the app configuration and all {app.authorizations.length}{" "}
                      authorization(s) for {app.provider}.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={async () => {
                        try {
                          await deleteApp.mutateAsync(app.id);
                          toast.success("OAuth app deleted");
                        } catch (error) {
                          toastMutationError(error);
                        }
                      }}
                      disabled={deleteApp.isPending}
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </span>
          );
        },
      },
    ],
    [deleteApp],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      <DataGrid
        rowData={apps}
        columnDefs={columnDefs}
        quickFilterText={search}
        loading={loading}
        emptyMessage="No OAuth apps found"
        paginationQueryKey="oauthApps"
        onRowClicked={(event) => {
          const target = event.event?.target as HTMLElement | null;
          if (target?.closest("a, button")) return;
          if (event.data) {
            navigate(`/connections/oauth-apps/${encodeURIComponent(event.data.id)}`);
          }
        }}
      />
      <OAuthAppDialog open={editOpen} onOpenChange={setEditOpen} app={editApp} />
    </div>
  );
}

function TagInput({
  values,
  onChange,
  placeholder,
  ariaLabel,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState("");

  function addValues(value: string) {
    const next = uniqueStrings([...values, ...splitList(value)]);
    onChange(next);
    setDraft("");
  }

  return (
    <div className="flex min-h-10 flex-wrap items-center gap-2 rounded-md border px-2 py-1.5">
      {values.map((value) => (
        <Badge key={value} variant="outline" className="gap-1 pr-1 normal-case" size="tag">
          {value}
          <button
            type="button"
            className="rounded-sm p-0.5 hover:bg-muted"
            onClick={() => onChange(values.filter((item) => item !== value))}
            aria-label={`Remove ${value}`}
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      <input
        className="min-w-32 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        value={draft}
        aria-label={ariaLabel}
        placeholder={values.length ? "" : placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            addValues(draft);
          } else if (event.key === "Backspace" && !draft && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text");
          if (splitList(text).length > 1) {
            event.preventDefault();
            addValues(text);
          }
        }}
        onBlur={() => {
          if (draft.trim()) addValues(draft);
        }}
      />
    </div>
  );
}

function ScopeTagInput({
  scopes,
  onChange,
}: {
  scopes: string[];
  onChange: (scopes: string[]) => void;
}) {
  return (
    <TagInput
      values={scopes}
      onChange={onChange}
      placeholder="repo read:org"
      ariaLabel="OAuth scope"
    />
  );
}

export function OAuthAppDialog({
  open,
  onOpenChange,
  app,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  app?: OAuthAppSummary;
}) {
  const upsert = useUpsertOAuthApp();
  const discover = useDiscoverOAuthApp();
  const { data: presets = [] } = useOAuthPresets();
  const { data: redirectUri } = useOAuthRedirectUri();
  const [presetId, setPresetId] = useState("");
  const [provider, setProvider] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [authorizeUrl, setAuthorizeUrl] = useState("");
  const [tokenUrl, setTokenUrl] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [discoverUrl, setDiscoverUrl] = useState("");
  const [tokenAuthStyle, setTokenAuthStyle] = useState<"body" | "basic">("body");
  const [tokenBodyFormat, setTokenBodyFormat] = useState<"form" | "json">("form");
  const [extraParams, setExtraParams] = useState<Array<{ key: string; value: string }>>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const isEdit = Boolean(app);

  const selectedPreset = useMemo<OAuthPreset | null>(
    () => presets.find((preset) => preset.id === presetId) ?? null,
    [presets, presetId],
  );

  useEffect(() => {
    if (!open) return;
    setPresetId("");
    setProvider(app?.provider ?? "");
    setClientId(app?.clientId ?? "");
    setClientSecret("");
    setAuthorizeUrl(app?.authorizeUrl ?? "");
    setTokenUrl(app?.tokenUrl ?? "");
    setScopes(app?.scopes ?? []);
    setDiscoverUrl("");
    setTokenAuthStyle(app?.tokenAuthStyle ?? "body");
    setTokenBodyFormat(app?.tokenBodyFormat ?? "form");
    setExtraParams(
      app?.extraParams
        ? Object.entries(app.extraParams).map(([key, value]) => ({ key, value }))
        : [],
    );
    // Edit mode always shows the endpoint fields (they're populated); creation
    // starts collapsed and leans on the preset picker / discovery.
    setShowAdvanced(Boolean(app));
  }, [open, app]);

  function applyPreset(id: string) {
    setPresetId(id);
    const preset = presets.find((candidate) => candidate.id === id);
    if (!preset) return;
    setProvider(preset.provider);
    setAuthorizeUrl(preset.authorizeUrl);
    setTokenUrl(preset.tokenUrl);
    setScopes([...preset.scopes]);
    setTokenAuthStyle(preset.tokenAuthStyle ?? "body");
    setTokenBodyFormat(preset.tokenBodyFormat ?? "form");
    setExtraParams(
      preset.extraParams
        ? Object.entries(preset.extraParams).map(([key, value]) => ({ key, value }))
        : [],
    );
  }

  async function discoverFromUrl() {
    try {
      const result = await discover.mutateAsync(discoverUrl.trim());
      setAuthorizeUrl(result.authorizeUrl);
      setTokenUrl(result.tokenUrl);
      setScopes((current) => uniqueStrings([...current, ...result.scopes]));
      toast.success("OAuth endpoints discovered");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "OAuth discovery failed");
    }
  }

  async function submit() {
    try {
      await upsert.mutateAsync({
        // On edit, target the exact row by id so a same-provider sibling app
        // is never mutated by mistake.
        ...(app?.id ? { id: app.id } : {}),
        // With a preset, the server hydrates endpoints/quirks (userinfo,
        // revocation, scope separator, rotation) that aren't editable here.
        // Explicit fields below still win server-side.
        ...(presetId ? { presetId } : {}),
        provider,
        clientId,
        ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
        authorizeUrl,
        tokenUrl,
        scopes,
        tokenAuthStyle,
        tokenBodyFormat,
        extraParams: Object.fromEntries(
          extraParams
            .map((row) => [row.key.trim(), row.value.trim()] as const)
            .filter(([key]) => key),
        ),
      });
    } catch (error) {
      // InlineError keeps the detail visible in the dialog; the toast makes
      // the failure unmissable.
      toastMutationError(error);
      return;
    }
    toast.success(`OAuth app ${provider.trim()} saved`);
    onOpenChange(false);
  }

  const canSubmit = presetId
    ? Boolean(clientId.trim() && (isEdit || clientSecret.trim()))
    : Boolean(
        provider.trim() &&
          clientId.trim() &&
          authorizeUrl.trim() &&
          tokenUrl.trim() &&
          (isEdit || clientSecret.trim()),
      );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader className="pb-2">
          <DialogTitle>{isEdit ? "Edit OAuth App" : "Add OAuth App"}</DialogTitle>
          <DialogDescription>
            Client secrets are write-only. Existing secrets are never shown again.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <div className="space-y-1.5 rounded-md border bg-muted/30 p-3">
            <FieldLabel tip="The single static callback the swarm listens on. It never changes and is derived from the public server URL.">
              Redirect URI
            </FieldLabel>
            <div className="flex min-w-0 items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                {redirectUri ?? "Loading…"}
              </code>
              {redirectUri ? <CopyButton value={redirectUri} /> : null}
            </div>
            <p className="text-xs text-muted-foreground">
              Register this exact URL in the provider console first — the authorization won't
              complete until it's whitelisted there.
            </p>
          </div>

          {!isEdit ? (
            <div className="space-y-2">
              <FieldLabel tip="Curated providers prefill endpoints, scopes, and provider quirks. Pick Custom to configure everything by hand.">
                Preset
              </FieldLabel>
              <Select
                value={presetId || "custom"}
                onValueChange={(value) =>
                  value === "custom" ? setPresetId("") : applyPreset(value)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="custom">Custom (no preset)</SelectItem>
                  {presets.map((preset) => (
                    <SelectItem key={preset.id} value={preset.id}>
                      {preset.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {selectedPreset?.setupHints.length ? (
            <AlertCallout tone="info" icon={Info}>
              <ul className="list-disc space-y-1 pl-4">
                {selectedPreset.setupHints.map((hint) => (
                  <li key={hint}>{hint}</li>
                ))}
              </ul>
            </AlertCallout>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <FieldLabel tip="Stable provider slug used by credential bindings, e.g. github or notion.">
                Provider
              </FieldLabel>
              <Input
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
                disabled={isEdit || Boolean(presetId)}
                placeholder="github"
              />
            </div>
            <div className="space-y-2">
              <FieldLabel tip="OAuth client ID from the provider's developer console.">
                Client ID
              </FieldLabel>
              <Input
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                placeholder="Iv1.8a61f9b3a7aba766"
              />
            </div>
          </div>
          <div className="space-y-2">
            <FieldLabel tip="From the provider's developer console. Stored write-only - never shown again.">
              Client Secret
            </FieldLabel>
            <Input
              type="password"
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
              placeholder={isEdit ? "unchanged" : "3c9d1f2e8ab74650cd1208d586cf1a2b34e5d6f7"}
            />
          </div>
          <div className="space-y-2">
            <FieldLabel tip="Optional scopes requested during authorization; paste or type and press Enter to add tags.">
              Scopes
            </FieldLabel>
            <ScopeTagInput scopes={scopes} onChange={setScopes} />
          </div>

          <div className="space-y-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1.5 px-1"
              onClick={() => setShowAdvanced((current) => !current)}
            >
              <ChevronDown
                className={cn("size-4 transition-transform", showAdvanced && "rotate-180")}
              />
              Advanced{presetId ? " (prefilled from preset)" : ""}
            </Button>
            {showAdvanced ? (
              <div className="space-y-5 rounded-md border border-dashed p-4">
                <div className="space-y-2">
                  <FieldLabel tip="Paste the provider base URL or issuer URL; the server checks OAuth and OIDC well-known metadata.">
                    Discover from URL
                  </FieldLabel>
                  <div className="flex gap-2">
                    <Input
                      value={discoverUrl}
                      onChange={(event) => setDiscoverUrl(event.target.value)}
                      placeholder="https://accounts.google.com"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={discoverFromUrl}
                      disabled={!discoverUrl.trim() || discover.isPending}
                    >
                      Discover
                    </Button>
                  </div>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <FieldLabel tip="Provider authorization endpoint; usually in OAuth app or issuer metadata.">
                      Authorize URL
                    </FieldLabel>
                    <Input
                      value={authorizeUrl}
                      onChange={(event) => setAuthorizeUrl(event.target.value)}
                      placeholder="https://github.com/login/oauth/authorize"
                    />
                  </div>
                  <div className="space-y-2">
                    <FieldLabel tip="Provider token endpoint used to exchange and refresh OAuth tokens.">
                      Token URL
                    </FieldLabel>
                    <Input
                      value={tokenUrl}
                      onChange={(event) => setTokenUrl(event.target.value)}
                      placeholder="https://github.com/login/oauth/access_token"
                    />
                  </div>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <FieldLabel tip="How client credentials are sent to the token endpoint; provider docs usually call this client authentication.">
                      Token Auth
                    </FieldLabel>
                    <Select
                      value={tokenAuthStyle}
                      onValueChange={(value) => setTokenAuthStyle(value as "body" | "basic")}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="body">Body</SelectItem>
                        <SelectItem value="basic">Basic</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <FieldLabel tip="Token request body encoding expected by the provider: form-encoded or JSON.">
                      Body Format
                    </FieldLabel>
                    <Select
                      value={tokenBodyFormat}
                      onValueChange={(value) => setTokenBodyFormat(value as "form" | "json")}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="form">Form</SelectItem>
                        <SelectItem value="json">JSON</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <FieldLabel tip="Optional static authorization parameters such as audience, resource, prompt, or access_type.">
                      Extra Params
                    </FieldLabel>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => setExtraParams((rows) => [...rows, { key: "", value: "" }])}
                    >
                      Add Row
                    </Button>
                  </div>
                  <div className="grid gap-2">
                    {extraParams.map((row, index) => (
                      <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                        <Input
                          value={row.key}
                          onChange={(event) =>
                            setExtraParams((rows) =>
                              rows.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, key: event.target.value } : item,
                              ),
                            )
                          }
                          placeholder="access_type"
                          aria-label="Extra parameter name"
                        />
                        <Input
                          value={row.value}
                          onChange={(event) =>
                            setExtraParams((rows) =>
                              rows.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, value: event.target.value } : item,
                              ),
                            )
                          }
                          placeholder="offline"
                          aria-label="Extra parameter value"
                        />
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          onClick={() =>
                            setExtraParams((rows) =>
                              rows.filter((_, itemIndex) => itemIndex !== index),
                            )
                          }
                          aria-label="Remove extra parameter"
                        >
                          <X className="size-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
          <InlineError error={upsert.error ?? discover.error} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit || upsert.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function ConnectionsPage() {
  const navigate = useNavigate();
  const { searchParams, setParam } = useUrlSearchState();
  const search = readStringParam(searchParams, "search");
  const kindParam = readStringParam(searchParams, "kind", "all");
  const scopeParam = readStringParam(searchParams, "scope", "all");
  const kindFilter = KIND_OPTIONS.includes(kindParam as ScriptConnectionKind | "all")
    ? (kindParam as ScriptConnectionKind | "all")
    : "all";
  const scopeFilter = SCOPE_OPTIONS.includes(scopeParam as ScriptConnectionScope | "all")
    ? (scopeParam as ScriptConnectionScope | "all")
    : "all";
  const tabParam = readStringParam(searchParams, "tab", "connections");
  const activeTab: ConnectionsTab = (TAB_VALUES as readonly string[]).includes(tabParam)
    ? (tabParam as ConnectionsTab)
    : "connections";
  const newParam = readStringParam(searchParams, "new");

  const { data: connections, isLoading } = useScriptConnections({
    kind: kindFilter,
    scope: scopeFilter,
  });
  const { data: bindings = [], isLoading: bindingsLoading } = useCredentialBindings();
  const { data: oauthApps = [], isLoading: oauthAppsLoading } = useOAuthApps();
  const { data: mcpServersData } = useMcpServers();
  const { data: agents } = useAgents(false);
  const refreshConnection = useRefreshScriptConnection();
  const setEnabled = useSetScriptConnectionEnabled();
  const defaultAgentId = useMemo(
    () => agents?.find((agent) => agent.isLead)?.id ?? agents?.[0]?.id,
    [agents],
  );

  const columnDefs = useMemo<ColDef<ScriptConnection>[]>(
    () => [
      {
        field: "slug",
        headerName: "Slug",
        minWidth: 140,
        flex: 1,
        cellRenderer: (params: ICellRendererParams<ScriptConnection>) => (
          <span className="font-semibold">{params.value}</span>
        ),
      },
      {
        field: "kind",
        headerName: "Kind",
        width: 110,
        cellRenderer: (params: ICellRendererParams<ScriptConnection>) =>
          params.value ? <KindBadge kind={params.value as ScriptConnectionKind} /> : null,
      },
      {
        headerName: "Target",
        minWidth: 220,
        flex: 1,
        valueGetter: (params) => params.data?.baseUrl ?? params.data?.mcpServerId ?? "",
        cellRenderer: (params: ICellRendererParams<ScriptConnection>) => (
          <span className="truncate text-muted-foreground">
            {params.data?.baseUrl ?? params.data?.mcpServerId ?? "—"}
          </span>
        ),
      },
      {
        headerName: "Ops",
        width: 90,
        valueGetter: (params) =>
          params.data
            ? params.data.kind === "mcp"
              ? params.data.toolCount
              : params.data.operationCount
            : 0,
      },
      {
        headerName: "Credential",
        minWidth: 170,
        flex: 1,
        cellRenderer: (params: ICellRendererParams<ScriptConnection>) =>
          params.data ? <CredentialChip connection={params.data} bindings={bindings} /> : null,
      },
      {
        field: "enabled",
        headerName: "Enabled",
        width: 105,
        cellRenderer: (params: ICellRendererParams<ScriptConnection>) =>
          params.data ? (
            <span onClick={(event) => event.stopPropagation()}>
              <Switch
                size="sm"
                checked={params.data.enabled}
                onCheckedChange={(enabled) =>
                  setEnabled.mutate(
                    { id: params.data!.id, enabled },
                    {
                      onSuccess: () =>
                        toast.success(
                          `Connection ${params.data!.slug} ${enabled ? "enabled" : "disabled"}`,
                        ),
                      onError: toastMutationError,
                    },
                  )
                }
                disabled={setEnabled.isPending}
              />
            </span>
          ) : null,
      },
      {
        headerName: "Refresh",
        width: 105,
        cellRenderer: (params: ICellRendererParams<ScriptConnection>) => {
          const canRefresh =
            params.data?.kind === "mcp" ||
            (params.data?.kind === "openapi" && params.data?.openapiSpecSourceKind === "url");
          return params.data && canRefresh ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={(event) => {
                event.stopPropagation();
                refreshConnection.mutate(params.data!.id, {
                  onSuccess: () => toast.success(`Connection ${params.data!.slug} refreshed`),
                  onError: toastMutationError,
                });
              }}
              disabled={refreshConnection.isPending}
            >
              <RefreshCw className="size-3" />
              Refresh
            </Button>
          ) : (
            <span className="text-muted-foreground">—</span>
          );
        },
      },
      {
        field: "createdAt",
        headerName: "Created",
        width: 140,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : ""),
      },
      {
        field: "updatedAt",
        headerName: "Updated",
        width: 140,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : ""),
      },
    ],
    [refreshConnection, setEnabled, bindings],
  );

  const addTarget = NEW_PARAM_BY_TAB[activeTab];
  const addLabel = ADD_LABEL_BY_TAB[activeTab];
  const searchPlaceholder = SEARCH_PLACEHOLDER_BY_TAB[activeTab];

  function setNewParam(value: string) {
    setParam("new", value);
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader
        title="Connections"
        icon={Link2}
        action={
          addTarget && addLabel ? (
            <Button onClick={() => setNewParam(addTarget)}>
              <Plus className="size-4" />
              {addLabel}
            </Button>
          ) : undefined
        }
      />

      <Tabs
        value={activeTab}
        onValueChange={(value) =>
          setParam("tab", value, { defaultValue: "connections", reset: ["new"] })
        }
        className="flex flex-col flex-1 min-h-0"
      >
        <div className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <TabsList className="w-full justify-start overflow-x-auto overflow-y-hidden sm:w-fit">
            <TabsTrigger value="connections">Connections</TabsTrigger>
            <TabsTrigger value="bindings">Bindings</TabsTrigger>
            <TabsTrigger value="oauth-apps">OAuth Apps</TabsTrigger>
            <TabsTrigger value="playground">Playground</TabsTrigger>
          </TabsList>
          {activeTab !== "playground" ? (
            <div className="flex w-full flex-col gap-2 md:flex-row md:items-center md:justify-end lg:w-auto">
              <div className="relative w-full md:w-72">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder={searchPlaceholder}
                  value={search}
                  onChange={(event) =>
                    setParam("search", event.target.value, {
                      reset: ["connectionsPage", "credentialBindingsPage", "oauthAppsPage"],
                    })
                  }
                  className="pl-9"
                />
              </div>
              {activeTab === "connections" ? (
                <div className="grid grid-cols-2 gap-2 md:flex md:items-center">
                  <Select
                    value={kindFilter}
                    onValueChange={(value) =>
                      setParam("kind", value, {
                        defaultValue: "all",
                        reset: ["connectionsPage"],
                      })
                    }
                  >
                    <SelectTrigger className="w-full md:w-[140px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Kinds</SelectItem>
                      <SelectItem value="openapi">OpenAPI</SelectItem>
                      <SelectItem value="graphql">GraphQL</SelectItem>
                      <SelectItem value="mcp">MCP</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={scopeFilter}
                    onValueChange={(value) =>
                      setParam("scope", value, {
                        defaultValue: "all",
                        reset: ["connectionsPage"],
                      })
                    }
                  >
                    <SelectTrigger className="w-full md:w-[140px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Scopes</SelectItem>
                      <SelectItem value="global">Global</SelectItem>
                      <SelectItem value="agent">Agent</SelectItem>
                      <SelectItem value="repo">Repo</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <TabsContent value="connections" className="flex flex-col flex-1 min-h-0 mt-3">
          <DataGrid
            rowData={connections ?? []}
            columnDefs={columnDefs}
            quickFilterText={search}
            onRowClicked={(event) => {
              const target = event.event?.target as HTMLElement | null;
              if (target?.closest("a, button")) return;
              if (event.data?.id) navigate(`/connections/${event.data.id}`);
            }}
            loading={isLoading}
            emptyMessage="No script connections found"
            paginationQueryKey="connections"
          />
        </TabsContent>
        <TabsContent value="bindings" className="flex flex-col flex-1 min-h-0 mt-3">
          <CredentialBindingsSection
            bindings={bindings}
            connections={connections ?? []}
            oauthApps={oauthApps}
            search={search}
            loading={bindingsLoading}
          />
        </TabsContent>
        <TabsContent value="oauth-apps" className="flex flex-col flex-1 min-h-0 mt-3">
          <OAuthAppsSection apps={oauthApps} search={search} loading={oauthAppsLoading} />
        </TabsContent>
        <TabsContent value="playground" className="mt-3">
          <PlaygroundPanel defaultAgentId={defaultAgentId} />
        </TabsContent>
      </Tabs>

      <AddConnectionDialog
        open={newParam === "connection"}
        onOpenChange={(open) => setNewParam(open ? "connection" : "")}
        bindings={bindings}
        oauthApps={oauthApps}
        mcpServers={(mcpServersData?.servers ?? []).map((server) => ({
          id: server.id,
          name: server.name,
        }))}
      />
      <CredentialBindingDialog
        open={newParam === "binding"}
        onOpenChange={(open) => setNewParam(open ? "binding" : "")}
        oauthApps={oauthApps}
      />
      <OAuthAppDialog
        open={newParam === "oauth-app"}
        onOpenChange={(open) => setNewParam(open ? "oauth-app" : "")}
      />
    </div>
  );
}
