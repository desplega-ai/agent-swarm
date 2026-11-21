import type { SqlQuery } from "@desplega/storage";
import { BasePagesRepository } from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresPagesRepository extends BasePagesRepository {
  protected insertionOrder(): SqlQuery {
    return notOnPostgresYet("PostgresPagesRepository.insertionOrder");
  }
}
