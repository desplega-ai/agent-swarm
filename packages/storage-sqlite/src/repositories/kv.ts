import {
  BaseKvRepository,
  EMPTY,
  type KvJsonFieldFilter,
  type SqlQuery,
  sql,
  sqlJoin,
} from "@desplega/storage";

export class SqliteKvRepository extends BaseKvRepository {
  protected jsonFieldEquals(filters: readonly KvJsonFieldFilter[]): SqlQuery {
    if (filters.length === 0) return EMPTY;
    // json_valid guards corrupt rows: json_extract would abort the whole query on one.
    return sqlJoin(
      filters.map(
        (f) =>
          sql` AND (CASE WHEN value_type = 'json' AND json_valid(value) THEN json_extract(value, ${f.path}) END) = ${f.value}`,
      ),
      EMPTY,
    );
  }
}
