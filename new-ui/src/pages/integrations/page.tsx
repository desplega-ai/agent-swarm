import { Info, Plug, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useConfigs } from "@/api/hooks/use-config-api";
import { IntegrationCard } from "@/components/integrations/integration-card";
import { EmptyState } from "@/components/shared/empty-state";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { INTEGRATIONS, type IntegrationCategory } from "@/lib/integrations-catalog";
import { deriveIntegrationStatus, findConfigForKey } from "@/lib/integrations-status";
import { cn } from "@/lib/utils";

const RESTART_HINT_DISMISS_KEY = "integrations-restart-hint-dismissed";
const QUICK_PICK_IDS = ["slack", "github", "anthropic"] as const;

const CATEGORY_LABELS: Record<IntegrationCategory, string> = {
  comm: "Communication",
  issues: "Issues & VCS",
  llm: "LLM providers",
  observability: "Observability",
  payments: "Payments",
  email: "Email",
  other: "Other",
};

type CategoryFilter = "all" | IntegrationCategory;

export default function IntegrationsPage() {
  const { data: configs, isLoading, error } = useConfigs({ scope: "global" });
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [hintDismissed, setHintDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.sessionStorage.getItem(RESTART_HINT_DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });

  function dismissHint() {
    setHintDismissed(true);
    try {
      window.sessionStorage.setItem(RESTART_HINT_DISMISS_KEY, "1");
    } catch {
      // sessionStorage unavailable — keep in-memory state, no-op.
    }
  }

  // Determine whether any catalog integration has at least one config set.
  // We look up each catalog field key (plus disableKey) against the fetched
  // configs; if none match, treat the swarm as "fresh" and show quick-picks.
  const hasAnyIntegrationConfigured = useMemo(() => {
    if (!configs || configs.length === 0) return false;
    for (const def of INTEGRATIONS) {
      for (const f of def.fields) {
        if (findConfigForKey(configs, f.key)) return true;
      }
      if (def.disableKey && findConfigForKey(configs, def.disableKey)) return true;
    }
    return false;
  }, [configs]);

  // Keep in sync if another tab clears sessionStorage.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === RESTART_HINT_DISMISS_KEY && e.newValue === null) {
        setHintDismissed(false);
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const availableCategories = useMemo<IntegrationCategory[]>(() => {
    const present = new Set<IntegrationCategory>();
    for (const def of INTEGRATIONS) present.add(def.category);
    // Stable order based on CATEGORY_LABELS keys.
    return (Object.keys(CATEGORY_LABELS) as IntegrationCategory[]).filter((c) => present.has(c));
  }, []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return INTEGRATIONS.filter((def) => {
      if (category !== "all" && def.category !== category) return false;
      if (!q) return true;
      return (
        def.name.toLowerCase().includes(q) ||
        def.id.toLowerCase().includes(q) ||
        def.description.toLowerCase().includes(q)
      );
    });
  }, [search, category]);

  if (isLoading) {
    return <PageSkeleton />;
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-6 p-2">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Integrations</h1>
        <p className="text-sm text-muted-foreground">
          Configure third-party integrations (Slack, GitHub, LLM providers, and more) without
          hand-editing <code className="font-mono text-xs">.env</code>.
        </p>
      </div>

      {!hintDismissed && (
        <Alert className="relative pr-10">
          <Info className="h-4 w-4" />
          <AlertDescription>
            Some changes take effect only after restarting the API server (e.g.{" "}
            <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">
              bun run pm2-restart
            </code>
            ).
          </AlertDescription>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="absolute right-1 top-1 h-6 w-6"
            onClick={dismissHint}
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            Failed to load configuration: {error instanceof Error ? error.message : String(error)}
          </AlertDescription>
        </Alert>
      )}

      {/* Get started — show only when nothing is configured. */}
      {!hasAnyIntegrationConfigured && (
        <section className="space-y-3" aria-labelledby="get-started-heading">
          <h2
            id="get-started-heading"
            className="text-sm font-semibold uppercase text-muted-foreground tracking-wide"
          >
            Get started
          </h2>
          <div className="grid gap-4 grid-cols-1 md:grid-cols-3">
            {QUICK_PICK_IDS.map((pickId) => {
              const def = INTEGRATIONS.find((i) => i.id === pickId);
              if (!def) return null;
              const status = deriveIntegrationStatus(def, configs ?? []);
              return <IntegrationCard key={def.id} def={def} status={status} />;
            })}
          </div>
        </section>
      )}

      {/* Filter bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative max-w-sm w-full">
          <Search
            className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            placeholder="Search integrations..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
            aria-label="Search integrations"
          />
        </div>

        <fieldset className="flex flex-wrap items-center gap-1.5 border-0 p-0 m-0">
          <legend className="sr-only">Category filters</legend>
          <CategoryChip
            label="All"
            active={category === "all"}
            onClick={() => setCategory("all")}
          />
          {availableCategories.map((cat) => (
            <CategoryChip
              key={cat}
              label={CATEGORY_LABELS[cat]}
              active={category === cat}
              onClick={() => setCategory(cat)}
            />
          ))}
        </fieldset>
      </div>

      {/* Grid */}
      {visible.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="No integrations match your filters"
          description="Try clearing the search or selecting a different category."
        />
      ) : (
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
          {visible.map((def) => {
            const status = deriveIntegrationStatus(def, configs ?? []);
            return <IntegrationCard key={def.id} def={def} status={status} />;
          })}
        </div>
      )}
    </div>
  );
}

interface CategoryChipProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

function CategoryChip({ label, active, onClick }: CategoryChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <Badge
        variant="outline"
        className={cn(
          "text-[10px] px-2 py-0.5 h-6 font-medium leading-none items-center uppercase cursor-pointer",
          active
            ? "border-primary/50 bg-primary/10 text-primary"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        {label}
      </Badge>
    </button>
  );
}
