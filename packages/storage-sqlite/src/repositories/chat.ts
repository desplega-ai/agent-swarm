import { BaseChatRepository } from "@desplega/storage";

/** Every chat statement is portable: SQLite adds no override. */
export class SqliteChatRepository extends BaseChatRepository {}
