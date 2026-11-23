import {
  BaseTrackersRepository,
  sql,
  type TrackerAgentMappingRow,
  type TrackerSyncRow,
} from "@desplega/storage";

// The SQLite override's order, with "_rowid" for rowid: equal createdAt values
// stay in insertion order.
export class PostgresTrackersRepository extends BaseTrackersRepository {
  listSyncs(filters: { provider?: string; entityType?: string }): Promise<TrackerSyncRow[]> {
    return this.db.query<TrackerSyncRow>(
      sql`SELECT * FROM tracker_sync${this.syncFilters(filters)} ORDER BY "createdAt" DESC, "_rowid" ASC`,
    );
  }

  listAgentMappings(provider?: string): Promise<TrackerAgentMappingRow[]> {
    return this.db.query<TrackerAgentMappingRow>(
      provider
        ? sql`SELECT * FROM tracker_agent_mapping WHERE provider = ${provider} ORDER BY "createdAt" DESC, "_rowid" ASC`
        : sql`SELECT * FROM tracker_agent_mapping ORDER BY "createdAt" DESC, "_rowid" ASC`,
    );
  }
}
