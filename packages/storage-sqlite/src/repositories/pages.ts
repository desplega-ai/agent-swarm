import { BasePagesRepository } from "@desplega/storage";

/** Every pages statement is portable: the SQLite engine adds nothing. */
export class SqlitePagesRepository extends BasePagesRepository {}
