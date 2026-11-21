import {
  BaseTrackersRepository,
  type TrackerAgentMappingRow,
  type TrackerSyncRow,
} from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresTrackersRepository extends BaseTrackersRepository {
  listSyncs(filters: { provider?: string; entityType?: string }): Promise<TrackerSyncRow[]> {
    return notOnPostgresYet("PostgresTrackersRepository.listSyncs");
  }

  listAgentMappings(provider?: string): Promise<TrackerAgentMappingRow[]> {
    return notOnPostgresYet("PostgresTrackersRepository.listAgentMappings");
  }
}
