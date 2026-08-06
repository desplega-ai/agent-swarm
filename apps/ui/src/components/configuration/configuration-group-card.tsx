import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ConfigCatalogEntry, ConfigCatalogGroup } from "@/lib/configuration-catalog";
import type { EnvPresence } from "@/lib/integrations-status";
import { ConfigurationRow } from "./configuration-row";

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
        {entries.map((entry) => (
          <ConfigurationRow key={entry.key} entry={entry} inEnv={envPresence[entry.key] === true} />
        ))}
      </CardContent>
    </Card>
  );
}
