import { useUiTelemetry } from "@/api/hooks/use-ui-telemetry";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ConfigCatalogEntry, ConfigCatalogGroup } from "@/lib/configuration-catalog";
import type { EnvPresence } from "@/lib/integrations-status";
import { normalizeOrgWebsite } from "../../../../../src/utils/org-website";
import { ConfigurationRow } from "./configuration-row";
import { UsedByConsentRow } from "./used-by-consent-row";

const PROFILE_FIELDS: Record<string, "name" | "website"> = {
  SWARM_ORG_NAME: "name",
  SWARM_ORG_WEBSITE: "website",
};

export interface ConfigurationGroupCardProps {
  group: ConfigCatalogGroup;
  /** Entries to render — already filtered by the page's search box. */
  entries: ConfigCatalogEntry[];
  envPresence: EnvPresence;
}

export function ConfigurationGroupCard({
  group,
  entries,
  envPresence,
}: ConfigurationGroupCardProps) {
  const Icon = group.icon;
  const sendEvent = useUiTelemetry();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
          <span>{group.title}</span>
        </CardTitle>
        <CardDescription>{group.description}</CardDescription>
      </CardHeader>
      <CardContent className="divide-y divide-border-subtle pt-0">
        {entries.map((entry) => {
          const field = PROFILE_FIELDS[entry.key];
          return (
            <ConfigurationRow
              key={entry.key}
              entry={entry}
              inEnv={envPresence[entry.key] === true}
              normalize={
                entry.key === "SWARM_ORG_WEBSITE"
                  ? (value) => normalizeOrgWebsite(value) ?? value
                  : undefined
              }
              onSave={
                field
                  ? () =>
                      sendEvent({
                        event: "org.profile_updated",
                        properties: { fields: [field], surface: "settings" },
                      })
                  : undefined
              }
            />
          );
        })}
        {group.id === "branding" && entries.some((entry) => entry.key === "SWARM_ORG_WEBSITE") ? (
          <UsedByConsentRow />
        ) : null}
      </CardContent>
    </Card>
  );
}
