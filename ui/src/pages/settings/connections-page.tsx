import { PageHeader } from "@/components/ui/page-header";
import { useConfig } from "@/hooks/use-config";
import { ConnectionsSection } from "@/pages/config/components/connections-section";
import { WelcomeCard } from "@/pages/config/components/welcome-card";

/**
 * Connections settings page — server connections (API URL + key). Before any
 * connection exists, the WelcomeCard onboarding flow takes over the surface.
 */
export default function ConnectionsPage() {
  const { isConfigured } = useConfig();

  if (!isConfigured) {
    return <WelcomeCard />;
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-6">
      <PageHeader title="Connections" />
      <ConnectionsSection />
    </div>
  );
}
