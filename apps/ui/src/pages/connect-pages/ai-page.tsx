import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { ProviderKeysPanel } from "@/pages/api-keys/page";
import {
  AddIntegrationMenu,
  ConnectPhoneTitle,
  ConnectSearch,
  ConnectToolbar,
  IntegrationCardGrid,
  integrationsIn,
  matchIntegrations,
} from "./connect-shell";

const AI_PROVIDERS = integrationsIn(["llm"]);

/** Connect › AI providers: the LLM provider cards, then the pooled provider keys. */
export default function AiProvidersPage() {
  const { searchParams } = useUrlSearchState();
  const search = readStringParam(searchParams, "search");
  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-y-auto gap-6">
      <div className="flex flex-col gap-4">
        <ConnectPhoneTitle title="AI providers" />
        <ConnectToolbar>
          <ConnectSearch placeholder="Search providers and keys" />
          <AddIntegrationMenu label="Add provider" defs={AI_PROVIDERS} />
        </ConnectToolbar>
        <IntegrationCardGrid defs={matchIntegrations(AI_PROVIDERS, search)} />
      </div>
      <section aria-labelledby="provider-keys-heading" className="flex flex-col gap-3">
        <h2 id="provider-keys-heading" className="text-sm font-semibold">
          Provider keys
        </h2>
        <ProviderKeysPanel hideSearch />
      </section>
    </div>
  );
}
