import { ChevronDown, Plug, Plus, Search } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { Link } from "react-router-dom";
import { useChatSdkStatus } from "@/api/hooks/use-chat-sdk";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useEnvPresence } from "@/api/hooks/use-integrations-meta";
import { IntegrationCard } from "@/components/integrations/integration-card";
import { EmptyState } from "@/components/shared/empty-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useUrlSearchInput } from "@/hooks/use-url-search-state";
import {
  getPresenceKeys,
  INTEGRATIONS,
  type IntegrationCategory,
  type IntegrationDef,
} from "@/lib/integrations-catalog";
import { deriveIntegrationStatus, findConfigForKey } from "@/lib/integrations-status";
import { cn } from "@/lib/utils";

/*
 * Shared parts of the three Connect page shells (Channels, Tools, AI
 * providers). Each shell re-mounts today's components; steps 6, 7 and 8
 * replace the shells one page at a time.
 */

/** Catalog entries of the given categories, in catalog order. */
export function integrationsIn(categories: readonly IntegrationCategory[]): IntegrationDef[] {
  return INTEGRATIONS.filter((def) => categories.includes(def.category));
}

/** Catalog entries whose name, id or description contains the query. */
export function matchIntegrations(defs: IntegrationDef[], search: string): IntegrationDef[] {
  const q = search.trim().toLowerCase();
  if (!q) return defs;
  return defs.filter(
    (def) =>
      def.name.toLowerCase().includes(q) ||
      def.id.toLowerCase().includes(q) ||
      def.description.toLowerCase().includes(q),
  );
}

/** The page name on phones only: on wider screens the breadcrumb carries it. */
export function ConnectPhoneTitle({ title }: { title: string }) {
  return <h1 className="text-lg font-semibold tracking-tight md:hidden">{title}</h1>;
}

/** The search input bound to `?search`. */
export function ConnectSearch({
  placeholder,
  className,
}: {
  placeholder: string;
  className?: string;
}) {
  const [search, setSearch] = useUrlSearchInput("search");
  return (
    <div className={cn("relative w-full md:w-64", className)}>
      <Search
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        type="search"
        placeholder={placeholder}
        aria-label={placeholder}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="pl-9"
      />
    </div>
  );
}

/** The primary action: a menu of catalog entries, each opening its detail page. */
export function AddIntegrationMenu({ label, defs }: { label: string; defs: IntegrationDef[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" className="shrink-0">
          <Plus className="size-4" />
          {label}
          <ChevronDown className="size-3.5 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-56 overflow-y-auto">
        {defs.map((def) => (
          <DropdownMenuItem key={def.id} asChild>
            <Link to={`/integrations/${def.id}`}>{def.name}</Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One top row: the search on the left, the actions on the right. */
export function ConnectToolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      {children}
    </div>
  );
}

/**
 * Integration cards for the given catalog entries, with the same status
 * derivation the old Settings › Integrations page used (DB rows, deploy env
 * presence, and the live Chat SDK flag when it comes from the env only).
 */
export function IntegrationCardGrid({
  defs,
  emptyTitle = "Nothing matches your search",
}: {
  defs: IntegrationDef[];
  emptyTitle?: string;
}) {
  const { data: configs, isLoading, error } = useConfigs({ scope: "global" });
  const presenceKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const def of INTEGRATIONS) {
      for (const key of getPresenceKeys(def)) keys.add(key);
    }
    return Array.from(keys);
  }, []);
  const { data: envPresence } = useEnvPresence(presenceKeys);
  const presence = envPresence ?? {};
  // Env presence cannot show CHAT_SDK_ENABLED=false, so read the live value
  // when the flag comes from the env only.
  const chatSdkEnvOnly =
    presence.CHAT_SDK_ENABLED === true && !findConfigForKey(configs ?? [], "CHAT_SDK_ENABLED");
  const chatSdkStatus = useChatSdkStatus({ enabled: chatSdkEnvOnly, poll: false });
  const live = { chatSdkEnabled: chatSdkStatus.data?.enabled };

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {defs.slice(0, 3).map((def) => (
          <Skeleton key={def.id} className="h-36" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>
            Failed to load configuration: {error instanceof Error ? error.message : String(error)}
          </AlertDescription>
        </Alert>
      ) : null}
      {defs.length === 0 ? (
        <EmptyState icon={Plug} title={emptyTitle} compact />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {defs.map((def) => (
            <IntegrationCard
              key={def.id}
              def={def}
              status={deriveIntegrationStatus(def, configs ?? [], presence, live)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
