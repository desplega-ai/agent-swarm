import {
  BaseSavingsRepository,
  type SavingsLinkRow,
  type SavingsScriptBucket,
} from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresSavingsRepository extends BaseSavingsRepository {
  replaceScriptBucket(bucket: SavingsScriptBucket): Promise<void> {
    return notOnPostgresYet("PostgresSavingsRepository.replaceScriptBucket");
  }

  replaceLink(link: SavingsLinkRow): Promise<void> {
    return notOnPostgresYet("PostgresSavingsRepository.replaceLink");
  }
}
