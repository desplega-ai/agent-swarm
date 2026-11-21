import { BaseModelsRepository, type TaskHoldWindow } from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresModelsRepository extends BaseModelsRepository {
  listProfilesWithFallback(name: string): Promise<string[]> {
    return notOnPostgresYet("PostgresModelsRepository.listProfilesWithFallback");
  }

  deleteUnreferencedProfile(
    name: string,
    window: TaskHoldWindow,
    defaultConfigKey: string,
  ): Promise<boolean> {
    return notOnPostgresYet("PostgresModelsRepository.deleteUnreferencedProfile");
  }
}
