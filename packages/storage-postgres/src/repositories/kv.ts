import type { KvJsonFieldFilter, SqlQuery } from "@desplega/storage";
import { BaseKvRepository } from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresKvRepository extends BaseKvRepository {
  protected jsonFieldEquals(filters: readonly KvJsonFieldFilter[]): SqlQuery {
    return notOnPostgresYet("PostgresKvRepository.jsonFieldEquals");
  }
}
