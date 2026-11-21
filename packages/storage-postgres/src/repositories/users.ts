import {
  BaseUsersRepository,
  type IdentityEventRow,
  type UserFavoriteRow,
  type UserMergeJobRow,
  type UserRow,
  type UserTokenSummaryRow,
} from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresUsersRepository extends BaseUsersRepository {
  listUsers(): Promise<UserRow[]> {
    return notOnPostgresYet("PostgresUsersRepository.listUsers");
  }

  findUserByPrimaryEmail(email: string): Promise<UserRow | null> {
    return notOnPostgresYet("PostgresUsersRepository.findUserByPrimaryEmail");
  }

  listUsersWithEmailAliases(): Promise<UserRow[]> {
    return notOnPostgresYet("PostgresUsersRepository.listUsersWithEmailAliases");
  }

  listUsersByName(name: string): Promise<UserRow[]> {
    return notOnPostgresYet("PostgresUsersRepository.listUsersByName");
  }

  listUsersByNamePrefix(prefix: string): Promise<UserRow[]> {
    return notOnPostgresYet("PostgresUsersRepository.listUsersByNamePrefix");
  }

  getUserJobFunction(id: string): Promise<string | null | undefined> {
    return notOnPostgresYet("PostgresUsersRepository.getUserJobFunction");
  }

  listIdentityEvents(
    userId: string,
    opts: { before: string | null; limit: number },
  ): Promise<IdentityEventRow[]> {
    return notOnPostgresYet("PostgresUsersRepository.listIdentityEvents");
  }

  listUserTokens(userId: string): Promise<UserTokenSummaryRow[]> {
    return notOnPostgresYet("PostgresUsersRepository.listUserTokens");
  }

  listUnrevokedUserTokens(
    userId: string,
  ): Promise<{ id: string; label: string | null; tokenPreview: string }[]> {
    return notOnPostgresYet("PostgresUsersRepository.listUnrevokedUserTokens");
  }

  listMergeJobs(opts: {
    status: UserMergeJobRow["status"] | null;
    limit: number;
  }): Promise<UserMergeJobRow[]> {
    return notOnPostgresYet("PostgresUsersRepository.listMergeJobs");
  }

  findActiveMergeJob(userId: string): Promise<UserMergeJobRow | null> {
    return notOnPostgresYet("PostgresUsersRepository.findActiveMergeJob");
  }

  findFailedMergeJob(sourceUserId: string, targetUserId: string): Promise<UserMergeJobRow | null> {
    return notOnPostgresYet("PostgresUsersRepository.findFailedMergeJob");
  }

  claimNextMergeJob(now: string): Promise<UserMergeJobRow | null> {
    return notOnPostgresYet("PostgresUsersRepository.claimNextMergeJob");
  }

  listFavorites(opts: {
    favoriteScope: string;
    itemType?: string;
    itemIds?: string[];
  }): Promise<UserFavoriteRow[]> {
    return notOnPostgresYet("PostgresUsersRepository.listFavorites");
  }
}
