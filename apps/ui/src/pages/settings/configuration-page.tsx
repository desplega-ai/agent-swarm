import { RefreshCw, Search, SlidersHorizontal } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useEnvPresence, useReloadConfig } from "@/api/hooks/use-integrations-meta";
import { ConfigurationGroupCard } from "@/components/configuration/configuration-group-card";
import { EmptyState } from "@/components/shared/empty-state";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { useConfig } from "@/hooks/use-config";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import {
  CONFIGURATION_GROUPS,
  CONFIGURATION_KEYS,
  type ConfigCatalogEntry,
  type ConfigCatalogGroup,
} from "@/lib/configuration-catalog";
import { cn } from "@/lib/utils";
import { WelcomeCard } from "@/pages/config/components/welcome-card";

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
  const { isConfigured } = useConfig();
  // Rendered rows own their own reads/writes via `useSwarmConfig`; this query
  // exists so the page can show a skeleton and surface a load error once,
  // rather than 50 times. It shares react-query's cache with the rows.
  const { isLoading, error } = useConfigs({ scope: "global" });
  const { data: envPresence } = useEnvPresence(CONFIGURATION_KEYS);
  const reloadConfig = useReloadConfig();
  const { searchParams, setParam } = useUrlSearchState();
  const search = readStringParam(searchParams, "search");

  const visibleGroups = useMemo<VisibleGroup[]>(() => {
    const q = search.trim().toLowerCase();
    const result: VisibleGroup[] = [];
    for (const group of CONFIGURATION_GROUPS) {
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
  }, [search]);

  if (!isConfigured) {
    return <WelcomeCard />;
  }

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
      <PageHeader
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

      {visibleGroups.length === 0 ? (
        <EmptyState
          icon={SlidersHorizontal}
          title="No settings match your search"
          description="Try a different term, or clear the search to see every setting."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {visibleGroups.map(({ group, entries }) => (
            <ConfigurationGroupCard
              key={group.id}
              group={group}
              entries={entries}
              envPresence={envPresence ?? {}}
            />
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground pb-2">
        Values set as environment variables take precedence at boot; values saved here are stored in
        the swarm config and applied on reload. Settings marked Restart required need a server
        restart.
      </p>
    </div>
  );
}
