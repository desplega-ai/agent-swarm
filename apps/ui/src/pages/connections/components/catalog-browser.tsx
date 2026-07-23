import { memo, useMemo, useState } from "react";
import type { IntegrationsCatalogEntry, ScriptConnectionKind } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { cn } from "@/lib/utils";
import { KindBadge } from "@/pages/connections/page";

// The catalog browser owns its search/filter state so keystrokes only
// re-render this subtree — hoisting the query into the (very large)
// AddConnectionDialog made typing visibly laggy.

function catalogSearchText(entry: IntegrationsCatalogEntry): string {
  return `${entry.name} ${entry.slug} ${entry.domain} ${entry.description}`.toLowerCase();
}

function tokenScore(text: string, token: string): number {
  if (!token) return 0;
  if (text.includes(token)) return token.length * 12;
  let cursor = 0;
  let score = 0;
  for (const char of token) {
    const found = text.indexOf(char, cursor);
    if (found === -1) return 0;
    score += found === cursor ? 4 : 1;
    cursor = found + 1;
  }
  return score;
}

function scoreCatalogEntry(entry: IntegrationsCatalogEntry, query: string): number {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) return 1;
  const text = catalogSearchText(entry);
  const total = tokens.reduce((sum, token) => sum + tokenScore(text, token), 0);
  return tokens.every((token) => tokenScore(text, token) > 0) ? total : 0;
}

const WELL_KNOWN_DOMAINS = new Set([
  "github.com",
  "google.com",
  "slack.com",
  "notion.so",
  "linear.app",
  "stripe.com",
  "openai.com",
  "anthropic.com",
  "atlassian.com",
  "gitlab.com",
  "microsoft.com",
  "figma.com",
  "vercel.com",
  "cloudflare.com",
  "twilio.com",
  "sendgrid.com",
  "hubspot.com",
  "salesforce.com",
  "dropbox.com",
  "shopify.com",
  "discord.com",
  "spotify.com",
  "zoom.us",
]);

// Rank curated entries above bulk apis.guru imports: boost hand-curated feeds,
// entries with an icon + description, and well-known provider domains.
function curationBoost(entry: IntegrationsCatalogEntry): number {
  let boost = 0;
  const feeds = entry.feeds ?? [];
  // Blessed (in-repo curated) entries outrank everything else.
  if (feeds.includes("blessed")) boost += 1000;
  if (feeds.length > 0 && !feeds.includes("apis-guru")) boost += 30;
  if (entry.icon) boost += 10;
  if (entry.description) boost += 10;
  if (WELL_KNOWN_DOMAINS.has(entry.domain)) boost += 40;
  return boost;
}

const CatalogCard = memo(function CatalogCard({
  entry,
  disabled,
  onSelect,
}: {
  entry: IntegrationsCatalogEntry;
  disabled: boolean;
  onSelect: (entry: IntegrationsCatalogEntry) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="flex h-full w-full flex-col gap-1.5 rounded-md border p-2.5 text-left transition-colors hover:bg-muted/40"
          onClick={() => onSelect(entry)}
          disabled={disabled}
        >
          <div className="flex w-full items-center gap-2">
            {entry.icon ? (
              <img src={entry.icon} alt="" className="size-6 shrink-0 rounded-sm" />
            ) : (
              <div className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-muted text-xs font-medium">
                {entry.name.slice(0, 1)}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium">{entry.name}</span>
                {entry.feeds?.includes("blessed") ? (
                  <Badge
                    variant="outline"
                    size="tag"
                    className="border-status-success/30 text-status-success-strong"
                  >
                    Blessed
                  </Badge>
                ) : null}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {entry.domain || entry.slug}
              </div>
            </div>
            <KindBadge kind={entry.kind} />
          </div>
          {entry.description ? (
            <p className="line-clamp-2 text-xs text-muted-foreground">{entry.description}</p>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="start"
        className="max-w-sm px-3 py-2.5 text-left whitespace-normal"
      >
        <div className="space-y-1.5 text-xs leading-relaxed">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{entry.name}</span>
            <span className="uppercase opacity-70">{entry.kind}</span>
          </div>
          {entry.domain ? <div className="font-mono opacity-90">{entry.domain}</div> : null}
          {entry.description ? <p className="opacity-90">{entry.description}</p> : null}
          {entry.categories.length > 0 ? (
            <div className="opacity-70">Categories: {entry.categories.join(", ")}</div>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
});

export interface CatalogBrowserProps {
  catalog: IntegrationsCatalogEntry[];
  loading: boolean;
  error: unknown;
  resolvingId: string | null;
  onSelect: (entry: IntegrationsCatalogEntry) => void;
  /** Render slot for load errors, so the parent's error component is reused. */
  renderError: (error: unknown) => React.ReactNode;
}

export function CatalogBrowser({
  catalog,
  loading,
  error,
  resolvingId,
  onSelect,
  renderError,
}: CatalogBrowserProps) {
  const [search, setSearch] = useState("");
  const [kinds, setKinds] = useState<ScriptConnectionKind[]>(["mcp", "openapi", "graphql"]);

  // Fuzzy-scoring thousands of catalog entries on every keystroke makes the
  // input laggy — score against a debounced query so typing stays responsive.
  const debouncedSearch = useDebouncedValue(search, 200);
  const results = useMemo(() => {
    return catalog
      .filter((entry) => kinds.includes(entry.kind))
      .map((entry) => {
        const fuzzy = scoreCatalogEntry(entry, debouncedSearch);
        return { entry, score: fuzzy > 0 ? fuzzy + curationBoost(entry) : 0 };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
      .slice(0, 60)
      .map(({ entry }) => entry);
  }, [catalog, debouncedSearch, kinds]);

  function toggleKind(kind: ScriptConnectionKind) {
    setKinds((current) =>
      current.includes(kind) ? current.filter((item) => item !== kind) : [...current, kind],
    );
  }

  return (
    <>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          placeholder="Search APIs, MCP servers, domains..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="flex-1"
        />
        <div className="flex items-center gap-1.5">
          {(["mcp", "openapi", "graphql"] as const).map((kind) => {
            const active = kinds.includes(kind);
            return (
              <Button
                key={kind}
                type="button"
                size="xs"
                variant={active ? "secondary" : "outline"}
                aria-pressed={active}
                className={cn(!active && "text-muted-foreground")}
                onClick={() => toggleKind(kind)}
              >
                {kind === "mcp" ? "MCP" : kind === "openapi" ? "OpenAPI" : "GraphQL"}
              </Button>
            );
          })}
        </div>
      </div>
      <div className="grid max-h-[52vh] grid-cols-1 content-start gap-2 overflow-y-auto pr-1 md:grid-cols-2 lg:grid-cols-3">
        {loading ? (
          <div className="col-span-full rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            Loading catalog...
          </div>
        ) : error ? (
          <div className="col-span-full">{renderError(error)}</div>
        ) : results.length === 0 ? (
          <div className="col-span-full rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            No matching integrations.
          </div>
        ) : (
          results.map((entry) => (
            <CatalogCard
              key={entry.id}
              entry={entry}
              disabled={resolvingId === entry.id}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
    </>
  );
}
