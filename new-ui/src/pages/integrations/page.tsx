import { Plug, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useConfigs } from "@/api/hooks/use-config-api";
import { IntegrationCard } from "@/components/integrations/integration-card";
import { EmptyState } from "@/components/shared/empty-state";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { INTEGRATIONS, type IntegrationCategory } from "@/lib/integrations-catalog";
import { deriveIntegrationStatus } from "@/lib/integrations-status";
import { cn } from "@/lib/utils";

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

      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            Failed to load configuration: {error instanceof Error ? error.message : String(error)}
          </AlertDescription>
        </Alert>
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
