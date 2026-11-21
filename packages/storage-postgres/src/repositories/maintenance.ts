import { BaseMaintenanceRepository } from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresMaintenanceRepository extends BaseMaintenanceRepository {
  deleteSkippedBootScrubVersions(version: number): Promise<void> {
    return notOnPostgresYet("PostgresMaintenanceRepository.deleteSkippedBootScrubVersions");
  }
}
