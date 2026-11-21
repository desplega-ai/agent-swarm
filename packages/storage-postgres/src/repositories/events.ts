import {
  BaseEventsRepository,
  type EventColumn,
  type EventCount,
  type EventCountFilters,
  type EventRow,
} from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresEventsRepository extends BaseEventsRepository {
  list(limit: number, filter?: { column: EventColumn; value: string }): Promise<EventRow[]> {
    return notOnPostgresYet("PostgresEventsRepository.list");
  }

  countByEvent(filters: EventCountFilters): Promise<EventCount[]> {
    return notOnPostgresYet("PostgresEventsRepository.countByEvent");
  }
}
