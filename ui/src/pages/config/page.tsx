import { useSearchParams } from "react-router-dom";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useConfig } from "@/hooks/use-config";
import { ConnectionsSection } from "./components/connections-section";
import { SwarmConfigSection } from "./components/swarm-config-section";
import { WelcomeCard } from "./components/welcome-card";

type ConfigTab = "connections" | "secrets";
const CONFIG_TABS: readonly ConfigTab[] = ["connections", "secrets"] as const;

export default function ConfigPage() {
  const { isConfigured } = useConfig();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: ConfigTab = CONFIG_TABS.includes(tabParam as ConfigTab)
    ? (tabParam as ConfigTab)
    : "connections";

  function setTab(next: ConfigTab) {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.set("tab", next);
        return params;
      },
      { replace: true },
    );
  }

  if (!isConfigured) {
    return <WelcomeCard />;
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-6">
      <PageHeader title="Settings" />
      <Tabs value={tab} onValueChange={(v) => setTab(v as ConfigTab)} className="flex-1 min-h-0">
        <TabsList variant="line">
          <TabsTrigger value="connections">Connections</TabsTrigger>
          <TabsTrigger value="secrets">Secrets</TabsTrigger>
        </TabsList>
        <TabsContent value="connections" className="mt-4 overflow-y-auto">
          <ConnectionsSection />
        </TabsContent>
        <TabsContent value="secrets" className="mt-4 flex flex-col min-h-0">
          <SwarmConfigSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
