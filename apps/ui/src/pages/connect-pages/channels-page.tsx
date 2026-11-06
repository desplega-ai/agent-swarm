import { ChevronDown, MessageCircle, MessagesSquare, Plus } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useChatSdkStatus } from "@/api/hooks/use-chat-sdk";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useEnvPresence } from "@/api/hooks/use-integrations-meta";
import { ChannelStatusChip } from "@/components/integrations/channel-status-chip";
import { BetaTag } from "@/components/shared/beta-tag";
import { BrandLogo } from "@/components/shared/brand-logo";
import { EmptyState } from "@/components/shared/empty-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import {
  CHANNEL_DEFS,
  type ChannelDef,
  type ChannelState,
  chatSdkAdapterHref,
  deriveChannelStates,
  matchChannels,
} from "@/lib/channel-cards";
import { getPresenceKeys, INTEGRATIONS } from "@/lib/integrations-catalog";
import { ConnectPhoneTitle, ConnectSearch, ConnectToolbar } from "./connect-shell";

/** Env keys that can make the socket-mode Slack or Kapso card connected. */
const PRESENCE_KEYS = INTEGRATIONS.filter(
  (def) => def.id === "slack" || def.id === "kapso",
).flatMap(getPresenceKeys);

/** Every channel card, the same size, in one grid. */
const CHANNEL_GRID = "grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3";

/** Connect › Channels: where people talk to the swarm. */
export default function ChannelsPage() {
  const { searchParams } = useUrlSearchState();
  const search = readStringParam(searchParams, "search");
  const configs = useConfigs({ scope: "global" });
  const { data: envPresence } = useEnvPresence(PRESENCE_KEYS);
  const chatSdk = useChatSdkStatus({ poll: false });
  const states = useMemo(
    () =>
      deriveChannelStates({
        configs: configs.data ?? [],
        envPresence: envPresence ?? {},
        chatSdk: chatSdk.data,
      }),
    [configs.data, envPresence, chatSdk.data],
  );
  const shown = matchChannels(CHANNEL_DEFS, search);
  const loadError = configs.error ?? chatSdk.error;

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-y-auto gap-4">
      <ConnectPhoneTitle title="Channels" />
      <ConnectToolbar>
        <ConnectSearch placeholder="Search channels" />
        <ConnectChannelMenu />
      </ConnectToolbar>
      {loadError ? (
        <Alert variant="destructive">
          <AlertDescription>
            Failed to load channel status:{" "}
            {loadError instanceof Error ? loadError.message : String(loadError)}
          </AlertDescription>
        </Alert>
      ) : null}
      {configs.isLoading || chatSdk.isLoading ? (
        <div className={CHANNEL_GRID}>
          {CHANNEL_DEFS.map((def) => (
            <Skeleton key={def.id} className="h-[76px]" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <EmptyState icon={MessagesSquare} title="Nothing matches your search" compact />
      ) : (
        <div className={CHANNEL_GRID}>
          {shown.map((def) => (
            <ChannelCard key={def.id} def={def} state={states[def.id]} />
          ))}
        </div>
      )}
    </div>
  );
}

function ChannelLogo({ def }: { def: ChannelDef }) {
  return (
    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-muted/40">
      {def.logoSrc ? (
        <BrandLogo src={def.logoSrc} className="size-5 text-foreground" />
      ) : (
        <MessageCircle className="size-5 text-foreground" aria-hidden />
      )}
    </div>
  );
}

function actionLabel(state: ChannelState): string {
  return state.chip === "none" ? "Connect" : "Manage";
}

/** Slack goes to the page of the mode in use; socket mode when none is. */
function hrefFor(def: ChannelDef, state: ChannelState): string {
  if (def.id === "slack" && state.slackMode === "chat-sdk") return chatSdkAdapterHref("slack");
  return def.href;
}

/** One channel: logo, name, state, and Connect or Manage. A problem shows under the state. */
function ChannelCard({ def, state }: { def: ChannelDef; state: ChannelState }) {
  const action = actionLabel(state);
  return (
    <Card
      className="flex-row items-center gap-3 px-4 py-4 transition-colors hover:border-foreground/20"
      data-channel-id={def.id}
    >
      <ChannelLogo def={def} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-sm font-semibold">{def.name}</h3>
          {def.beta ? <BetaTag tooltip={def.beta} side="top" /> : null}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <ChannelStatusChip chip={state.chip} />
          {state.detail ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground" title={state.detail}>
              {state.detail}
            </span>
          ) : null}
        </div>
      </div>
      <Button asChild size="xs" variant="outline">
        <Link to={hrefFor(def, state)} aria-label={`${action} ${def.name}`}>
          {action}
        </Link>
      </Button>
    </Card>
  );
}

/** The primary action: the same channels as the cards, for people who look for a button. */
function ConnectChannelMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" className="shrink-0">
          <Plus className="size-4" />
          Connect a channel
          <ChevronDown className="size-3.5 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {CHANNEL_DEFS.map((def) => (
          <DropdownMenuItem key={def.id} asChild>
            <Link to={def.href}>{def.name}</Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/integrations/chat-sdk">All Chat SDK adapters</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
