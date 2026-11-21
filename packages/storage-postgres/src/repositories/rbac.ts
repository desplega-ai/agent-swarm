import { BaseRbacRepository } from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresRbacRepository extends BaseRbacRepository {
  purgeAuditOlderThanDays(days: number): Promise<number> {
    return notOnPostgresYet("PostgresRbacRepository.purgeAuditOlderThanDays");
  }

  ensureDefaultRoleTrigger(): Promise<void> {
    return notOnPostgresYet("PostgresRbacRepository.ensureDefaultRoleTrigger");
  }
}
