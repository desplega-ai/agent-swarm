import {
  type AssetKeyAuditData,
  BaseAssetsRepository,
  type ImportPendingAssignmentRow,
} from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresAssetsRepository extends BaseAssetsRepository {
  readAssetKeyAuditData(): Promise<AssetKeyAuditData> {
    return notOnPostgresYet("PostgresAssetsRepository.readAssetKeyAuditData");
  }

  existingUserIds(ids: readonly string[]): Promise<Set<string>> {
    return notOnPostgresYet("PostgresAssetsRepository.existingUserIds");
  }

  listPendingAssignmentsForAgent(
    agentId: string,
    agentName: string,
  ): Promise<ImportPendingAssignmentRow[]> {
    return notOnPostgresYet("PostgresAssetsRepository.listPendingAssignmentsForAgent");
  }
}
