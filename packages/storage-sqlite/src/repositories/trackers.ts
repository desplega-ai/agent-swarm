import {
  BaseTrackersRepository,
  sql,
  type TrackerAgentMappingRow,
  type TrackerSyncRow,
} from "@desplega/storage";

// Ties keep the order SQLite returned before the move: the sort over a rowid
// (or index-by-rowid) scan leaves equal createdAt values in insertion order.
export class SqliteTrackersRepository extends BaseTrackersRepository {
  listSyncs(filters: { provider?: string; entityType?: string }): Promise<TrackerSyncRow[]> {
    return this.db.query<TrackerSyncRow>(
      sql`SELECT * FROM tracker_sync${this.syncFilters(filters)} ORDER BY "createdAt" DESC, rowid ASC`,
    );
  }

  listAgentMappings(provider?: string): Promise<TrackerAgentMappingRow[]> {
    return this.db.query<TrackerAgentMappingRow>(
      provider
        ? sql`SELECT * FROM tracker_agent_mapping WHERE provider = ${provider} ORDER BY "createdAt" DESC, rowid ASC`
        : sql`SELECT * FROM tracker_agent_mapping ORDER BY "createdAt" DESC, rowid ASC`,
    );
  }
}
