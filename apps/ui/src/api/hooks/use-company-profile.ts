/**
 * The org's company profile: global `swarm_config` rows, read from the
 * `useConfigs({ scope: "global" })` cache that Settings and /setup share, and
 * written through one path (upsert each changed key, refresh the reads, then
 * `org.profile_updated`).
 */
import { useQueryClient } from "@tanstack/react-query";
import { useConfigs, useUpsertConfig } from "@/api/hooks/use-config-api";
import {
  type OrgProfileField,
  type OrgProfileSurface,
  useUiTelemetry,
} from "@/api/hooks/use-ui-telemetry";
import {
  ACQUISITION_SOURCES,
  type AcquisitionSource,
  optionValue,
  orgNameFromDomain,
  SWARM_ORG_ACQUISITION_SOURCE,
  SWARM_ORG_TEAM_SIZE,
  SWARM_ORG_USE_CASE,
  storedOrgName,
  TEAM_SIZES,
  type TeamSize,
  USE_CASES,
  type UseCase,
} from "@/lib/company-profile";
import { normalizeOrgWebsite, websiteSuggestion } from "../../../../../src/utils/org-website";
import { applySavedIdentity } from "./status-query";

export interface CompanyProfilePatch {
  /** Required: a blank name is refused before anything is written. */
  name?: string;
  /** As typed; stored as a bare hostname. Empty clears it. */
  website?: string;
  /** Null clears the answer. */
  teamSize?: TeamSize | null;
  useCase?: UseCase | null;
  acquisitionSource?: AcquisitionSource | null;
}

/** Write order follows the org-name prompt: name, then website, then the rest. */
const FIELDS: Array<{ prop: keyof CompanyProfilePatch; key: string; field: OrgProfileField }> = [
  { prop: "name", key: "SWARM_ORG_NAME", field: "name" },
  { prop: "website", key: "SWARM_ORG_WEBSITE", field: "website" },
  { prop: "teamSize", key: SWARM_ORG_TEAM_SIZE, field: "team_size" },
  { prop: "useCase", key: SWARM_ORG_USE_CASE, field: "use_case" },
  { prop: "acquisitionSource", key: SWARM_ORG_ACQUISITION_SOURCE, field: "acquisition_source" },
];

export function useCompanyProfile() {
  const queryClient = useQueryClient();
  const { data: configs, dataUpdatedAt } = useConfigs({ scope: "global" });
  const upsert = useUpsertConfig();
  const sendEvent = useUiTelemetry();

  const stored = (key: string) => configs?.find((entry) => entry.key === key)?.value ?? "";
  const website = stored("SWARM_ORG_WEBSITE") || null;
  // The admin's email domain, captured when the first admin gave an email.
  const adminDomain = stored("telemetry_org_domain") || null;
  const suggestedWebsite = websiteSuggestion(adminDomain);
  const nameSource = website ?? suggestedWebsite;

  /**
   * Store the changed fields of `patch` and report `org.profile_updated`.
   * Resolves with the fields it wrote (none when nothing changed, as on a
   * retry after a failed write). Throws on an invalid value or a failed write:
   * keys written before the failure stay written.
   *
   * No `/api/config/reload`: every global upsert schedules one on the server
   * (about 250 ms later), and a second reload restarts Slack again.
   */
  async function save(
    patch: CompanyProfilePatch,
    surface: OrgProfileSurface,
  ): Promise<OrgProfileField[]> {
    // Unread rows compare as empty, so a save would overwrite stored values.
    if (configs === undefined) throw new Error("Settings are still loading. Try again.");
    const writes: Array<{ key: string; value: string; field: OrgProfileField }> = [];
    for (const { prop, key, field } of FIELDS) {
      const raw = patch[prop];
      if (raw === undefined) continue;
      let value = (raw ?? "").trim();
      if (prop === "name" && !value) throw new Error("Enter a name for your swarm.");
      if (prop === "website" && value) {
        const host = normalizeOrgWebsite(value);
        if (!host) throw new Error("Enter a public website, such as example.com.");
        value = host;
      }
      if (value !== stored(key)) writes.push({ key, value, field });
    }
    if (writes.length === 0) return [];
    for (const { key, value } of writes) {
      await upsert.mutateAsync({ scope: "global", key, value, isSecret: false });
      // The shell shows a new name at once and reads `/status` again after the server reload.
      applySavedIdentity(queryClient, key, value);
    }
    await queryClient.invalidateQueries({ queryKey: ["configs"] });
    const fields = writes.map((write) => write.field);
    sendEvent({ event: "org.profile_updated", properties: { fields, surface } });
    return fields;
  }

  return {
    /** False until the global config rows load. Pre-fill only after this. */
    loaded: configs !== undefined,
    /** When the rows last came from the server (ms). A persisted snapshot keeps its old time. */
    updatedAt: dataUpdatedAt,
    /** Null when unset, also for the old default "Your Swarm". */
    name: storedOrgName(stored("SWARM_ORG_NAME")),
    website,
    teamSize: optionValue(TEAM_SIZES, stored(SWARM_ORG_TEAM_SIZE)),
    useCase: optionValue(USE_CASES, stored(SWARM_ORG_USE_CASE)),
    acquisitionSource: optionValue(ACQUISITION_SOURCES, stored(SWARM_ORG_ACQUISITION_SOURCE)),
    adminDomain,
    /** From the website, else the admin's work domain (acme.com becomes Acme). */
    suggestedName: nameSource ? orgNameFromDomain(nameSource) : null,
    /** The admin's email domain, unless it is free mail. */
    suggestedWebsite,
    save,
  };
}
