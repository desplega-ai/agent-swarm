import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import {
  AddIntegrationMenu,
  ConnectPhoneTitle,
  ConnectSearch,
  ConnectToolbar,
  IntegrationCardGrid,
  integrationsIn,
  matchIntegrations,
} from "./connect-shell";

const CHANNELS = integrationsIn(["comm"]);

/** Connect › Channels: where people talk to the swarm (Slack, Chat SDK, Kapso). */
export default function ChannelsPage() {
  const { searchParams } = useUrlSearchState();
  const search = readStringParam(searchParams, "search");
  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-y-auto gap-4">
      <ConnectPhoneTitle title="Channels" />
      <ConnectToolbar>
        <ConnectSearch placeholder="Search channels" />
        <AddIntegrationMenu label="Add channel" defs={CHANNELS} />
      </ConnectToolbar>
      <IntegrationCardGrid defs={matchIntegrations(CHANNELS, search)} />
    </div>
  );
}
