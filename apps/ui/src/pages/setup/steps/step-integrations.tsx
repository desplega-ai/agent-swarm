import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useEnvPresence } from "@/api/hooks/use-integrations-meta";
import { ONBOARDING_QUERY_KEY } from "@/api/hooks/use-onboarding";
import { useOAuthApps } from "@/api/hooks/use-script-connections";
import { FadeIn } from "@/components/onboarding/fade-in";
import { StatusIcon } from "@/components/onboarding/save-indicator";
import { BrandLogo, SetupCard, SetupChip } from "@/components/onboarding/setup-card";
import { AutosaveScopeContext, useAutosaveScope } from "@/components/onboarding/use-autosave";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { StepProps } from "../step-contract";
import { activeAuthorization, ComingSoonPane, OAuthToolPane } from "./integrations/business-panes";
import {
  ALL_SETUP_KEYS,
  CORE_INTEGRATIONS,
  connectedMethod,
  findSetupIntegration,
  SETUP_GROUPS,
  type SetupIntegration,
  type SetupIntegrationId,
} from "./integrations/catalog";
import { GitHubPane, GitLabPane } from "./integrations/git-panes";
import { JiraPane, LinearPane } from "./integrations/oauth-panes";
import { SlackPane } from "./integrations/slack-pane";
import type { PaneProps } from "./integrations/use-config-form";

/** Query params the Linear/Jira OAuth return adds to `/setup?step=5`. */
const RETURN_PARAMS = ["integration", "oauth", "error", "error_description"];

type ItemState = "connected" | "saved" | "soon" | "none";

export function StepIntegrations({ onboarding, act, setContinueBlocker }: StepProps) {
  const scope = useAutosaveScope(setContinueBlocker);
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedId, setSelectedId] = useState<SetupIntegrationId>(
    () => findSetupIntegration(searchParams.get("integration"))?.id ?? "slack",
  );
  const [oauthError, setOauthError] = useState<{ id: SetupIntegrationId; message: string } | null>(
    null,
  );
  const configsQ = useConfigs({ scope: "global" });
  const presenceQ = useEnvPresence(ALL_SETUP_KEYS);
  // Older APIs have no OAuth apps: the business tools then show no status.
  const oauthApps = useOAuthApps().data ?? [];
  const configs = configsQ.data ?? [];
  const presence = presenceQ.data ?? {};
  const signals = onboarding.signals.integrations;

  // Linear/Jira land back here after OAuth: report the result once, then
  // strip the params so a refresh does not repeat it.
  const handledReturn = useRef(false);
  useEffect(() => {
    if (handledReturn.current) return;
    const returned = findSetupIntegration(searchParams.get("integration"));
    const oauth = searchParams.get("oauth");
    if (!returned && !oauth) return;
    handledReturn.current = true;
    if (returned && oauth === "success") {
      toast.success(`${returned.name} connected.`);
      void queryClient.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: [returned.id, "tracker", "status"] });
    } else if (returned && oauth === "error") {
      const message =
        searchParams.get("error_description") ?? searchParams.get("error") ?? "Unknown error";
      setOauthError({ id: returned.id, message });
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const key of RETURN_PARAMS) next.delete(key);
        return next;
      },
      { replace: true },
    );
  }, [searchParams, setSearchParams, queryClient]);

  // Record the precise method once the first integration connects. The API
  // also derives it on read, so a failed call needs no retry.
  const method = connectedMethod(signals);
  const stepStatus = onboarding.state.steps.integrations.status;
  const completeSent = useRef(false);
  useEffect(() => {
    if (!method || stepStatus === "done" || completeSent.current) return;
    completeSent.current = true;
    act({ action: "complete", step: "integrations", method }).catch(() => undefined);
  }, [method, stepStatus, act]);

  function itemState(item: SetupIntegration): ItemState {
    if (item.group === "business") {
      if (!item.oauthPresetId) return "soon";
      return activeAuthorization(oauthApps, item.oauthPresetId) ? "connected" : "none";
    }
    if (signals[item.id]) return "connected";
    const saved = item.chipKeys.some(
      (key) => presence[key] || configs.some((c) => c.key === key && c.scope === "global"),
    );
    return saved ? "saved" : "none";
  }

  const selected = findSetupIntegration(selectedId) ?? CORE_INTEGRATIONS[0];
  const paneError = oauthError?.id === selected.id ? oauthError.message : null;

  return (
    <AutosaveScopeContext.Provider value={scope}>
      {/* Fixed height on sm+: the list and the pane scroll inside, so switching never moves the page. */}
      <div className="grid gap-3 sm:h-[34rem] sm:grid-cols-[232px_minmax(0,1fr)]">
        <nav
          aria-label="Integrations"
          className="flex gap-2 overflow-x-auto pb-1 sm:min-h-0 sm:flex-col sm:gap-0 sm:overflow-x-hidden sm:overflow-y-auto sm:rounded-xl sm:border sm:bg-card sm:py-1 sm:shadow-sm"
        >
          {SETUP_GROUPS.map((group) => (
            <Fragment key={group.label}>
              <p className="hidden px-3 pt-3 pb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground sm:block">
                {group.label}
              </p>
              {group.items.map((item) => (
                <IntegrationItem
                  key={item.id}
                  item={item}
                  state={itemState(item)}
                  active={item.id === selected.id}
                  onSelect={() => setSelectedId(item.id)}
                />
              ))}
            </Fragment>
          ))}
          <Link
            to="/settings/integrations"
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-8 shrink-0 items-center gap-2 rounded-full border px-3 text-sm text-muted-foreground hover:text-foreground hover-linger transition-colors sm:mt-1 sm:h-auto sm:rounded-none sm:border-0 sm:border-t sm:border-border-subtle sm:px-3 sm:py-2.5"
          >
            <ExternalLink className="size-4 shrink-0" />
            <span className="font-medium">More in Settings</span>
          </Link>
        </nav>

        <SetupCard
          icon={<BrandLogo src={selected.logo} />}
          title={selected.name}
          description={selected.purpose}
          actions={
            <a
              href={selected.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline"
            >
              Docs
              <ExternalLink className="size-3" />
            </a>
          }
          status={<ItemStatus state={itemState(selected)} />}
          className="sm:flex sm:min-h-0 sm:flex-col"
          bodyClassName="sm:min-h-0 sm:flex-1 sm:overflow-y-auto"
        >
          <FadeIn key={selected.id} className="space-y-4">
            {configsQ.isPending && selected.group === "core" ? (
              <div className="space-y-3">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-2/3" />
              </div>
            ) : (
              <IntegrationPane
                item={selected}
                paneProps={{ configs, presence, connected: itemState(selected) === "connected" }}
                oauthError={paneError}
              />
            )}
          </FadeIn>
        </SetupCard>
      </div>
    </AutosaveScopeContext.Provider>
  );
}

const STATE_LABEL: Record<Exclude<ItemState, "soon" | "none">, string> = {
  connected: "Connected",
  saved: "Saved, not connected yet",
};

function ItemStatus({ state, focusable }: { state: ItemState; focusable?: boolean }) {
  if (state === "soon") return <SetupChip>Soon</SetupChip>;
  if (state === "none") return <StatusIcon tone="none" />;
  return (
    <StatusIcon
      tone={state === "connected" ? "done" : "saved"}
      label={STATE_LABEL[state]}
      focusable={focusable}
    />
  );
}

function IntegrationItem({
  item,
  state,
  active,
  onSelect,
}: {
  item: SetupIntegration;
  state: ItemState;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={cn(
        "flex h-8 shrink-0 items-center gap-2 rounded-full border px-3 text-sm hover:bg-accent/50 hover-linger transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        "sm:h-auto sm:rounded-none sm:border-0 sm:border-l-2 sm:border-l-transparent sm:py-2 sm:pr-3 sm:pl-2.5",
        active && "border-primary/60 bg-primary/5 font-medium sm:border-l-primary",
      )}
    >
      <BrandLogo src={item.logo} className="size-4" />
      <span className="flex-1 truncate text-left">{item.name}</span>
      <span className="hidden sm:inline-flex">
        {/* Inside the item button: no focus stop of its own. */}
        <ItemStatus state={state} focusable={false} />
      </span>
    </button>
  );
}

function IntegrationPane({
  item,
  paneProps,
  oauthError,
}: {
  item: SetupIntegration;
  paneProps: PaneProps;
  oauthError: string | null;
}) {
  if (item.group === "business") {
    return item.oauthPresetId ? <OAuthToolPane tool={item} /> : <ComingSoonPane tool={item} />;
  }
  switch (item.id) {
    case "slack":
      return <SlackPane {...paneProps} />;
    case "github":
      return <GitHubPane {...paneProps} />;
    case "gitlab":
      return <GitLabPane {...paneProps} />;
    case "linear":
      return <LinearPane {...paneProps} oauthError={oauthError} />;
    case "jira":
      return <JiraPane {...paneProps} oauthError={oauthError} />;
  }
}
