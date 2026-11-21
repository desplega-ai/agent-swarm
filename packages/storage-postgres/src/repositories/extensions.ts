import { BaseExtensionsRepository, type ExtensionRunRow } from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresExtensionsRepository extends BaseExtensionsRepository {
  pruneRuns(extensionId: string, keep: number): Promise<void> {
    return notOnPostgresYet("PostgresExtensionsRepository.pruneRuns");
  }

  listRuns(extensionId: string, limit: number): Promise<ExtensionRunRow[]> {
    return notOnPostgresYet("PostgresExtensionsRepository.listRuns");
  }
}
