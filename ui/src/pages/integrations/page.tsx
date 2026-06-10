import { Plug, Search } from "lucide-react";
import { useMemo } from "react";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useEnvPresence } from "@/api/hooks/use-integrations-meta";
import { IntegrationCard } from "@/components/integrations/integration-card";
import { EmptyState } from "@/components/shared/empty-state";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import {
  getIntegrationFields,
  INTEGRATIONS,
  type IntegrationCategory,
} from "@/lib/integrations-catalog";
import { deriveIntegrationStatus, findConfigForKey } from "@/lib/integrations-status";
import { cn } from "@/lib/utils";

const QUICK_PICK_IDS = ["slack", "github", "anthropic"] as const;

const CATEGORY_LABELS: Record<IntegrationCategory, string> = {
  comm: "Communication",
  issues: "Issues & VCS",
  crm: "CRM",
  llm: "LLM providers",
  observability: "Observability",
  payments: "Payments",
  email: "Email",
  other: "Other",
};

type CategoryFilter = "all" | IntegrationCategory;

function coerceCategory(value: string): CategoryFilter {
  return value in CATEGORY_LABELS ? (value as IntegrationCategory) : "all";
}

export default function IntegrationsPage() {
  const { data: configs, isLoading, error } = useConfigs({ scope: "global" });
  const { searchParams, setParam } = useUrlSearchState();
  const search = readStringParam(searchParams, "search");
  const category = coerceCategory(readStringParam(searchParams, "category", "all"));

  // Gather every catalog key (+ disableKey) so a single env-presence request
  // covers status derivation for the whole grid.
  const allCatalogKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const def of INTEGRATIONS) {
      for (const f of getIntegrationFields(def)) keys.add(f.key);
      if (def.disableKey) keys.add(def.disableKey);
    }
    return Array.from(keys);
  }, []);
  const { data: envPresence } = useEnvPresence(allCatalogKeys);
  const presence = envPresence ?? {};

  // "Fresh swarm" check: nothing in DB AND nothing in deploy env.
  const hasAnyIntegrationConfigured = useMemo(() => {
    for (const def of INTEGRATIONS) {
      for (const f of getIntegrationFields(def)) {
        if (findConfigForKey(configs ?? [], f.key)) return true;
        if (presence[f.key]) return true;
      }
      if (def.disableKey) {
        if (findConfigForKey(configs ?? [], def.disableKey)) return true;
        if (presence[def.disableKey]) return true;
      }
    }
    return false;
  }, [configs, presence]);

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
    <div className="flex flex-col flex-1 min-h-0 gap-6">
      <div className="space-y-2">
        <PageHeader
          title="Integrations"
          description={
            <>
              Configure third-party integrations (Slack, GitHub, LLM providers, and more) without
              hand-editing <code className="font-mono text-xs">.env</code>.
            </>
          }
        />
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none hover:text-foreground">
            Legend — what do the chips mean?
          </summary>
          <ul className="mt-2 space-y-1 pl-1">
            <li>
              <span className="inline-flex items-center gap-1">
                <StatusChip
                  label="Configured"
                  colorClass="border-status-success/30 text-status-success"
                />
                <span>— every required value is present; integration will load on reload.</span>
              </span>
            </li>
            <li>
              <span className="inline-flex items-center gap-1">
                <StatusChip
                  label="Partial"
                  colorClass="border-status-active/30 text-status-active"
                />
                <span>— some required values set, but not all.</span>
              </span>
            </li>
            <li>
              <span className="inline-flex items-center gap-1">
                <StatusChip
                  label="Disabled"
                  colorClass="border-status-neutral/30 text-status-neutral"
                />
                <span>
                  — <code className="font-mono text-[11px]">&lt;PREFIX&gt;_DISABLE</code> is truthy
                  in the DB.
                </span>
              </span>
            </li>
            <li>
              <span className="inline-flex items-center gap-1">
                <StatusChip
                  label="Not configured"
                  colorClass="border-border text-muted-foreground"
                />
                <span>— no value set in DB or deployment env.</span>
              </span>
            </li>
            <li className="pt-2">Per-field source chips (on each integration's detail page):</li>
            <li>
              <SourceChip
                label="db+env"
                colorClass="bg-status-success/10 text-status-success border-status-success/30"
              />{" "}
              — stored in DB and loaded into the server's{" "}
              <code className="font-mono text-[11px]">process.env</code>. Live.
            </li>
            <li>
              <SourceChip
                label="env (deploy)"
                colorClass="bg-status-info/10 text-status-info border-status-info/30"
              />{" "}
              — set via deployment env only (<code className="font-mono text-[11px]">.env</code>,
              docker). No DB row; saving here creates one that takes over on reload.
            </li>
            <li>
              <SourceChip
                label="db (pending reload)"
                colorClass="bg-status-active/10 text-status-active border-status-active/30"
              />{" "}
              — persisted in DB but not yet in{" "}
              <code className="font-mono text-[11px]">process.env</code>. Save or reload to apply.
            </li>
          </ul>
        </details>
      </div>

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
              const status = deriveIntegrationStatus(def, configs ?? [], presence);
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
            onChange={(e) => setParam("search", e.target.value)}
            className="pl-8"
            aria-label="Search integrations"
          />
        </div>

        <fieldset className="flex flex-wrap items-center gap-1.5 border-0 p-0 m-0">
          <legend className="sr-only">Category filters</legend>
          <CategoryChip
            label="All"
            active={category === "all"}
            onClick={() => setParam("category", "all", { defaultValue: "all" })}
          />
          {availableCategories.map((cat) => (
            <CategoryChip
              key={cat}
              label={CATEGORY_LABELS[cat]}
              active={category === cat}
              onClick={() => setParam("category", cat, { defaultValue: "all" })}
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
            const status = deriveIntegrationStatus(def, configs ?? [], presence);
            return <IntegrationCard key={def.id} def={def} status={status} />;
          })}
        </div>
      )}
    </div>
  );
}

function StatusChip({ label, colorClass }: { label: string; colorClass: string }) {
  return (
    <Badge variant="outline" size="tag" className={colorClass}>
      {label}
    </Badge>
  );
}

function SourceChip({ label, colorClass }: { label: string; colorClass: string }) {
  return (
    <span
      className={cn(
        "text-[9px] uppercase tracking-wide px-1.5 py-0 h-5 inline-flex items-center rounded-md border font-medium leading-none",
        colorClass,
      )}
    >
      {label}
    </span>
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
