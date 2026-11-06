import { ChevronDown, ChevronUp, RefreshCw, Search, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useEnvPresence, useReloadConfig } from "@/api/hooks/use-integrations-meta";
import { useModelTiers } from "@/api/hooks/use-model-tiers";
import { ConfigurationGroupCard } from "@/components/configuration/configuration-group-card";
import { EmptyState } from "@/components/shared/empty-state";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import {
  CONFIGURATION_GROUPS,
  CONFIGURATION_KEYS,
  type ConfigCatalogEntry,
  type ConfigCatalogGroup,
  withModelTierGroup,
} from "@/lib/configuration-catalog";
import { cn } from "@/lib/utils";

interface VisibleGroup {
  group: ConfigCatalogGroup;
  entries: ConfigCatalogEntry[];
}

/**
 * Configuration settings page — curated, non-secret `swarm_config` globals
 * grouped by subsystem.
 *
 * Values live in the same store the Integrations UI writes to. Env vars win at
 * boot; a value saved here becomes effective after the server's debounced
 * auto-reload (or the explicit "Reload config" button). Entries flagged
 * "Restart required" are read once at process start.
 */
export default function ConfigurationPage() {
  // Rendered rows own their own reads/writes via `useSwarmConfig`; this query
  // exists so the page can show a skeleton and surface a load error once,
  // rather than 50 times. It shares react-query's cache with the rows.
  const { isLoading, error } = useConfigs({ scope: "global" });
  // The Model tiers rows come from the API (defaults, configured value and the
  // resolved model per provider and tier), not from the static catalog.
  const { data: tiers } = useModelTiers();
  const groups = useMemo(() => withModelTierGroup(CONFIGURATION_GROUPS, tiers), [tiers]);
  const envKeys = useMemo(
    () => [...CONFIGURATION_KEYS, ...(tiers ?? []).map((tier) => tier.key)],
    [tiers],
  );
  const { data: envPresence } = useEnvPresence(envKeys);
  const reloadConfig = useReloadConfig();
  const { searchParams, setParam } = useUrlSearchState();
  const search = readStringParam(searchParams, "search");
  // mockup(ui-audit): configuration is 70 phone screens, groups collapse (first open by default)
  const [openIds, setOpenIds] = useState<Set<string> | null>(null);
  const searching = search.trim().length > 0;

  const visibleGroups = useMemo<VisibleGroup[]>(() => {
    const q = search.trim().toLowerCase();
    const result: VisibleGroup[] = [];
    for (const group of groups) {
      const entries = q
        ? group.entries.filter(
            (e) =>
              e.key.toLowerCase().includes(q) ||
              e.label.toLowerCase().includes(q) ||
              e.description.toLowerCase().includes(q),
          )
        : group.entries;
      if (entries.length > 0) result.push({ group, entries });
    }
    return result;
  }, [search, groups]);

  // mockup(ui-audit): null = untouched, so only the first group starts open
  const firstId = visibleGroups[0]?.group.id;
  const isOpen = (id: string) => (openIds ? openIds.has(id) : id === firstId);
  const allOpen = visibleGroups.every(({ group }) => isOpen(group.id));
  const toggle = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev ?? (firstId ? [firstId] : []));
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (isLoading) {
    return <PageSkeleton />;
  }

  function handleReload() {
    reloadConfig.mutate(undefined, {
      onSuccess: (result) => {
        const count = result.configsLoaded;
        if (count === 0) {
          toast.success("Config reloaded — no stored values to apply");
          return;
        }
        toast.success("Config reloaded", {
          // sonner's default `[data-description]` style is low-contrast on the
          // popover surface, so the description carries its own foreground
          // token rather than inheriting the muted default.
          description: (
            <div className="space-y-1 text-popover-foreground">
              <p className="text-xs">
                Re-applied {count} value{count === 1 ? "" : "s"} to the environment.
              </p>
              {result.keysUpdated.length > 0 && (
                <p className="font-mono text-[11px] leading-relaxed break-all">
                  {result.keysUpdated.join(", ")}
                </p>
              )}
            </div>
          ),
        });
      },
    });
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-6">
      {/* mockup(ui-audit): description wrapped to 5 lines beside Reload on mobile, header is desktop-only */}
      <PageHeader
        className="hidden sm:flex"
        title="Configuration"
        description="Tune swarm-wide behaviour — steering, memory, heartbeat, harness, integrations, and branding — without hand-editing .env."
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleReload}
            disabled={reloadConfig.isPending}
          >
            <RefreshCw className={cn("h-4 w-4", reloadConfig.isPending && "animate-spin")} />
            Reload config
          </Button>
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            Failed to load configuration: {error instanceof Error ? error.message : String(error)}
          </AlertDescription>
        </Alert>
      )}

      {/* mockup(ui-audit): on mobile, Reload sits beside the search as an icon button */}
      <div className="flex items-center gap-2">
        <div className="relative max-w-sm w-full">
          <Search
            className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            placeholder="Search settings..."
            value={search}
            onChange={(e) => setParam("search", e.target.value)}
            className="pl-8"
            aria-label="Search configuration settings"
          />
        </div>
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="sm:hidden shrink-0"
          onClick={handleReload}
          disabled={reloadConfig.isPending}
          aria-label="Reload config"
        >
          <RefreshCw className={cn("h-4 w-4", reloadConfig.isPending && "animate-spin")} />
        </Button>
        {!searching && visibleGroups.length > 1 ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto shrink-0 text-muted-foreground"
            onClick={() =>
              setOpenIds(allOpen ? new Set() : new Set(visibleGroups.map((g) => g.group.id)))
            }
          >
            {allOpen ? "Collapse all" : "Expand all"}
          </Button>
        ) : null}
      </div>

      {visibleGroups.length === 0 ? (
        <EmptyState
          icon={SlidersHorizontal}
          title="No settings match your search"
          description="Try a different term, or clear the search to see every setting."
        />
      ) : (
        <div className="flex flex-col gap-3 sm:gap-4">
          {visibleGroups.map(({ group, entries }) =>
            searching || isOpen(group.id) ? (
              // mockup(ui-audit): expanded group keeps the shared card, with a collapse button over its header
              <div
                key={group.id}
                className="relative max-sm:[&_[data-slot=card-description]]:line-clamp-2"
              >
                <ConfigurationGroupCard
                  group={group}
                  entries={entries}
                  envPresence={envPresence ?? {}}
                />
                {searching ? null : (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="absolute top-3 right-2 sm:right-4 h-8 w-8 text-muted-foreground"
                    onClick={() => toggle(group.id)}
                    aria-expanded
                    aria-label={`Collapse ${group.title}`}
                  >
                    <ChevronUp className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ) : (
              <CollapsedGroup
                key={group.id}
                group={group}
                count={entries.length}
                onOpen={() => toggle(group.id)}
              />
            ),
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground pb-2">
        Values saved here are stored in the swarm config and take precedence over environment
        variables, at boot and on reload. Settings marked Restart required need a server restart.
      </p>
    </div>
  );
}

// mockup(ui-audit): configuration is 70 phone screens, a collapsed group is one compact row
function CollapsedGroup({
  group,
  count,
  onOpen,
}: {
  group: ConfigCatalogGroup;
  count: number;
  onOpen: () => void;
}) {
  const Icon = group.icon;
  return (
    <Card className="py-0 gap-0 transition-colors hover:border-primary/40">
      <button
        type="button"
        onClick={onOpen}
        aria-expanded={false}
        className="flex w-full items-center gap-3 px-4 py-3 text-left sm:px-6 sm:py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded-xl"
      >
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate font-semibold leading-tight">{group.title}</span>
            <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground tabular-nums">
              {count} setting{count === 1 ? "" : "s"}
            </span>
          </span>
          <span className="truncate text-sm text-muted-foreground">{group.description}</span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
    </Card>
  );
}
