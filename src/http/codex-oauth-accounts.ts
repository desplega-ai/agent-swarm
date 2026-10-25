import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { decryptSecret, getEncryptionKey } from "../be/crypto";
import { deleteKv, deleteSwarmConfigByKey, getDbClient, getKeyStatuses, getKv } from "../be/db";
import { retirePoolKeyStatus } from "../be/db/api-keys";
import { deriveCodexKeySuffix } from "../providers/codex-oauth/auth-json";
import { decodeJwt, extractChatgptPlanType } from "../providers/codex-oauth/flow";
import { MAX_CODEX_OAUTH_SLOT } from "../providers/codex-oauth/storage";
import {
  CODEX_AUTH_FAILURE_BENCH_THRESHOLD,
  CODEX_AUTH_WATCH_NAMESPACE,
  codexAuthBenchMarkerKey,
} from "../utils/codex-auth-failure";
import { ensureConfigAdmin, requestSecretReadScope, runConfigWriteSideEffects } from "./config";
import { route } from "./route-def";
import { jsonError } from "./utils";

export const CodexAccountSchema = z.object({
  slot: z.number().int().min(0),
  configKey: z.string(),
  legacy: z.boolean(),
  suffix: z.string().nullable(),
  plan: z.string().nullable(),
  email: z.string().nullable(),
  status: z.enum(["ok", "needs_login", "unchecked"]),
});
export type CodexAccount = z.infer<typeof CodexAccountSchema>;

export const CodexAccountsResponseSchema = z.object({ accounts: z.array(CodexAccountSchema) });
export type CodexAccountsResponse = z.infer<typeof CodexAccountsResponseSchema>;

const listAccounts = route({
  method: "get",
  path: "/api/codex-oauth/accounts",
  pattern: ["api", "codex-oauth", "accounts"],
  summary: "List stored Codex ChatGPT accounts",
  tags: ["Codex OAuth"],
  responses: {
    200: { description: "Stored account metadata", schema: CodexAccountsResponseSchema },
    403: { description: "Caller cannot read all secrets" },
  },
});

const deleteAccount = route({
  method: "delete",
  path: "/api/codex-oauth/accounts/{slot}",
  pattern: ["api", "codex-oauth", "accounts", null],
  summary: "Remove a stored Codex ChatGPT account",
  tags: ["Codex OAuth"],
  rbac: { permission: "config.delete.any" },
  params: z.object({ slot: z.coerce.number().int().min(0).max(MAX_CODEX_OAUTH_SLOT) }),
  responses: {
    200: { description: "Remaining accounts", schema: CodexAccountsResponseSchema },
    403: { description: "Config administration and permission to read all secrets required" },
    404: { description: "Account slot does not exist" },
  },
});

type AccountRow = { key: string; value: string; encrypted: number };

async function accountRows(): Promise<Array<AccountRow & { slot: number; legacy: boolean }>> {
  const rows = await getDbClient().query<AccountRow>(
    "SELECT key, value, encrypted FROM swarm_config WHERE scope = 'global' AND (key = 'codex_oauth' OR key GLOB 'codex_oauth_[0-9]*')",
  );
  const hasSlotZero = rows.some((row) => row.key === "codex_oauth_0");
  return rows
    .flatMap((row) => {
      if (row.key === "codex_oauth") {
        return hasSlotZero ? [] : [{ ...row, slot: 0, legacy: true }];
      }
      const match = /^codex_oauth_(0|[1-9]\d*)$/.exec(row.key);
      if (!match) return [];
      const slot = Number(match[1]);
      return slot <= MAX_CODEX_OAUTH_SLOT ? [{ ...row, slot, legacy: false }] : [];
    })
    .sort((a, b) => a.slot - b.slot);
}

const AccountCredentialsSchema = z.object({
  access: z.string().min(1),
  refresh: z.string().min(1),
  expires: z.number().finite(),
  accountId: z.string().min(1),
});

function readCredentials(row: AccountRow): z.infer<typeof AccountCredentialsSchema> | null {
  try {
    const value = row.encrypted ? decryptSecret(row.value, getEncryptionKey()) : row.value;
    return AccountCredentialsSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

function accountSuffix(row: AccountRow): string | null {
  const credentials = readCredentials(row);
  return credentials ? deriveCodexKeySuffix(credentials.access, credentials.accountId) : null;
}

async function accountsResponse(): Promise<CodexAccountsResponse> {
  const rows = await accountRows();
  const statuses = await getKeyStatuses("CODEX_OAUTH", "global", null);
  const accounts: CodexAccount[] = [];
  for (const row of rows) {
    const account: CodexAccount = {
      slot: row.slot,
      configKey: row.key,
      legacy: row.legacy,
      suffix: null,
      plan: null,
      email: null,
      status: "needs_login",
    };
    const credentials = readCredentials(row);
    if (!credentials) {
      accounts.push(account);
      continue;
    }
    account.suffix = deriveCodexKeySuffix(credentials.access, credentials.accountId);
    account.plan = extractChatgptPlanType(credentials.access);
    const profile = decodeJwt(credentials.access)?.["https://api.openai.com/profile"];
    if (profile && typeof profile === "object" && "email" in profile) {
      account.email = typeof profile.email === "string" && profile.email ? profile.email : null;
    }
    const status = statuses.find((entry) => entry.keySuffix === account.suffix);
    const marker = await getKv(CODEX_AUTH_WATCH_NAMESPACE, codexAuthBenchMarkerKey(account.suffix));
    const statusBenched =
      status &&
      status.consecutiveAuthFailures >= CODEX_AUTH_FAILURE_BENCH_THRESHOLD &&
      status.status === "rate_limited";
    account.status = marker || statusBenched ? "needs_login" : status ? "ok" : "unchecked";
    accounts.push(account);
  }
  return { accounts };
}

/** Both responses list account emails and plans, so both routes need this gate. */
async function ensureSecretRead(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if ((await requestSecretReadScope(req)) === "all") return true;
  jsonError(res, "Reading Codex accounts requires access to all secrets", 403);
  return false;
}

export async function handleCodexOAuthAccounts(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (listAccounts.match(req.method, pathSegments)) {
    const parsed = await listAccounts.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await ensureSecretRead(req, res))) return true;
    listAccounts.respond(res, 200, await accountsResponse());
    return true;
  }

  if (deleteAccount.match(req.method, pathSegments)) {
    const parsed = await deleteAccount.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await ensureConfigAdmin(req, res, "config.delete.any"))) return true;
    if (!(await ensureSecretRead(req, res))) return true;
    const deletedKey = await getDbClient().transaction(async () => {
      const rows = await accountRows();
      const account = rows.find((row) => row.slot === parsed.params.slot);
      if (!account || !(await deleteSwarmConfigByKey("global", null, account.key))) return null;
      // A new sign-in takes the first free slot, so it must not inherit this
      // account's auth bench (keyed by slot) or its bench marker.
      const suffix = accountSuffix(account);
      if (suffix) {
        const remaining = rows.flatMap((row) => {
          const keySuffix = row === account ? null : accountSuffix(row);
          return keySuffix ? [{ keySuffix, keyIndex: row.slot }] : [];
        });
        await retirePoolKeyStatus("CODEX_OAUTH", suffix, remaining);
        if (!remaining.some((row) => row.keySuffix === suffix)) {
          await deleteKv(CODEX_AUTH_WATCH_NAMESPACE, codexAuthBenchMarkerKey(suffix));
        }
      }
      return account.key;
    });
    if (deletedKey === null) {
      jsonError(res, "Codex account slot does not exist", 404);
      return true;
    }
    await runConfigWriteSideEffects("global", deletedKey, "");
    deleteAccount.respond(res, 200, await accountsResponse());
    return true;
  }
  return false;
}
