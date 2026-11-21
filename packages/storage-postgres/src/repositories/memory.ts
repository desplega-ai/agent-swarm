import {
  type AgentMemoryRow,
  BaseMemoryRepository,
  type MemoryHealthCountsRow,
  type MemoryReadExecutor,
  type MemorySearchFilter,
  type NewMemoryLink,
  type ReviewTaskRule,
  type SqlQuery,
} from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresMemoryRepository extends BaseMemoryRepository {
  protected notReviewTaskCompletion(alias: string, rule: ReviewTaskRule): SqlQuery {
    return notOnPostgresYet("PostgresMemoryRepository.notReviewTaskCompletion");
  }

  searchFtsRows(
    match: string,
    filter: MemorySearchFilter,
    limit: number,
    reader?: MemoryReadExecutor,
  ): Promise<(AgentMemoryRow & { rank: number })[]> {
    return notOnPostgresYet("PostgresMemoryRepository.searchFtsRows");
  }

  searchVecRows(
    embedding: Uint8Array,
    filter: MemorySearchFilter,
    knn: number,
    limit: number,
    reader?: MemoryReadExecutor,
  ): Promise<(AgentMemoryRow & { distance: number })[]> {
    return notOnPostgresYet("PostgresMemoryRepository.searchVecRows");
  }

  scoreCappedRows(
    embedding: Uint8Array,
    filter: MemorySearchFilter,
    cap: number,
    floor: number,
    limit: number,
    reader?: MemoryReadExecutor,
  ): Promise<{ id: string; similarity: number }[]> {
    return notOnPostgresYet("PostgresMemoryRepository.scoreCappedRows");
  }

  healthCounts(
    vectorBytes: number,
    vecUsable: boolean,
    reader?: MemoryReadExecutor,
  ): Promise<MemoryHealthCountsRow | null> {
    return notOnPostgresYet("PostgresMemoryRepository.healthCounts");
  }

  ftsTableSchema(): Promise<string | null> {
    return notOnPostgresYet("PostgresMemoryRepository.ftsTableSchema");
  }

  scanFtsBatch(
    afterRowid: number,
    limit: number,
  ): Promise<{ rowid: number; memoryId: string | null; orphan: number }[]> {
    return notOnPostgresYet("PostgresMemoryRepository.scanFtsBatch");
  }

  deleteFtsRowsByRowid(rowids: number[]): Promise<void> {
    return notOnPostgresYet("PostgresMemoryRepository.deleteFtsRowsByRowid");
  }

  scanMemoryIdBatch(afterRowid: number, limit: number): Promise<{ rowid: number; id: string }[]> {
    return notOnPostgresYet("PostgresMemoryRepository.scanMemoryIdBatch");
  }

  insertMissingFtsRows(ids: string[]): Promise<void> {
    return notOnPostgresYet("PostgresMemoryRepository.insertMissingFtsRows");
  }

  deleteFtsRow(memoryId: string): Promise<void> {
    return notOnPostgresYet("PostgresMemoryRepository.deleteFtsRow");
  }

  insertFtsRow(memoryId: string, name: string, content: string): Promise<void> {
    return notOnPostgresYet("PostgresMemoryRepository.insertFtsRow");
  }

  deleteFtsRows(memoryIds: string[]): Promise<void> {
    return notOnPostgresYet("PostgresMemoryRepository.deleteFtsRows");
  }

  deleteVecRows(memoryIds: string[]): Promise<void> {
    return notOnPostgresYet("PostgresMemoryRepository.deleteVecRows");
  }

  deleteVecRow(memoryId: string): Promise<void> {
    return notOnPostgresYet("PostgresMemoryRepository.deleteVecRow");
  }

  insertVecRow(memoryId: string, embedding: Uint8Array): Promise<void> {
    return notOnPostgresYet("PostgresMemoryRepository.insertVecRow");
  }

  purgeSearchRetrievalsBefore(cutoff: string, limit: number): Promise<number> {
    return notOnPostgresYet("PostgresMemoryRepository.purgeSearchRetrievalsBefore");
  }

  insertLinkIfAbsent(link: NewMemoryLink): Promise<void> {
    return notOnPostgresYet("PostgresMemoryRepository.insertLinkIfAbsent");
  }
}
