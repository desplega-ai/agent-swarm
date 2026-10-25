import type { IncomingMessage, ServerResponse } from "node:http";
import { baseUrlEnvVar, providerForKeyVar } from "@desplega/model-catalog";
import { z } from "zod";
import {
  deleteSwarmConfigByKey,
  getDbClient,
  getKeyStatuses,
  getSwarmConfigs,
  recordKeyValidation,
} from "../be/db";
import { retirePoolKeyStatus } from "../be/db/api-keys";
import { upsertSwarmConfigWithPolicyMirror } from "../be/multi-runtime";
import { validateConfigEntry } from "../be/swarm-config-guard";
import type { SwarmConfig } from "../types";
import { CREDENTIAL_POOL_VARS, splitCredentialPool } from "../utils/credentials";
import { checkProviderPoolKey } from "../utils/provider-key-probes";
import { registerEnvSecrets, scrubSecrets } from "../utils/secret-scrubber";
import { ensureConfigAdmin, requestSecretReadScope, runConfigWriteSideEffects } from "./config";
import { getDeploymentEnvValue } from "./core";
import { route } from "./route-def";
import { jsonError } from "./utils";

export const PoolKeyStatusSchema = z.enum(["ok", "rejected", "rate_limited", "unchecked"]);
export type PoolKeyStatus = z.infer<typeof PoolKeyStatusSchema>;
export const PoolKeySchema = z.object({
  index: z.number().int().min(0),
  suffix: z.string(),
  status: PoolKeyStatusSchema,
  error: z.string().nullable(),
  checkedAt: z.string().nullable(),
  rateLimitedUntil: z.string().nullable(),
});
export type PoolKey = z.infer<typeof PoolKeySchema>;
export const PoolKeysResponseSchema = z.object({
  key: z.string(),
  source: z.enum(["stored", "env", "none"]),
  readOnly: z.boolean(),
  keys: z.array(PoolKeySchema),
});
export type PoolKeysResponse = z.infer<typeof PoolKeysResponseSchema>;
export const PoolKeyCheckResultSchema = z.enum(["verified", "rejected", "not_tested"]);
export type PoolKeyCheckResult = z.infer<typeof PoolKeyCheckResultSchema>;
export const PoolKeyCheckSchema = z.object({
  suffix: z.string(),
  result: PoolKeyCheckResultSchema,
  httpStatus: z.number().nullable(),
  error: z.string().nullable(),
});
export type PoolKeyCheck = z.infer<typeof PoolKeyCheckSchema>;

const poolVar = z
  .string()
  .refine(
    (key) => key !== "CODEX_OAUTH" && CREDENTIAL_POOL_VARS.includes(key),
    "Choose a credential pool variable.",
  );
const getPoolKeys = route({
  method: "get",
  path: "/api/config/pool-keys",
  pattern: ["api", "config", "pool-keys"],
  summary: "List credential pool suffixes and status",
  tags: ["Config"],
  query: z.object({ key: poolVar }),
  responses: {
    200: { description: "Credential pool", schema: PoolKeysResponseSchema },
    400: { description: "Invalid pool variable" },
    403: { description: "Secret read permission required" },
  },
});
const addPoolKeys = route({
  method: "post",
  path: "/api/config/pool-keys",
  pattern: ["api", "config", "pool-keys"],
  summary: "Test and append keys to a credential pool",
  tags: ["Config"],
  rbac: { permission: "config.write.any" },
  body: z.object({
    key: poolVar,
    value: z.string(),
    // The OpenRouter card can switch away from a stored gateway before the new key is saved.
    baseUrl: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Base URL for the check only. Null tests the provider default. Omit to use the stored URL.",
      ),
  }),
  responses: {
    200: {
      description: "Updated credential pool and checks",
      schema: PoolKeysResponseSchema.extend({ checks: z.array(PoolKeyCheckSchema) }),
    },
    400: { description: "Invalid key" },
    403: { description: "Config administration and permission to read all secrets required" },
    409: { description: "Duplicate key or deployment env pool" },
    422: {
      description: "Provider rejected a key. Nothing was saved.",
      schema: z.object({ error: z.string(), checks: z.array(PoolKeyCheckSchema) }),
    },
  },
});
const deletePoolKey = route({
  method: "delete",
  path: "/api/config/pool-keys",
  pattern: ["api", "config", "pool-keys"],
  summary: "Remove one credential pool member",
  tags: ["Config"],
  rbac: { permission: "config.delete.any" },
  query: z.object({
    key: poolVar,
    index: z.coerce.number().int().min(0),
    suffix: z.string().min(1).max(5),
  }),
  responses: {
    200: { description: "Updated credential pool", schema: PoolKeysResponseSchema },
    400: { description: "Invalid pool member" },
    403: { description: "Config administration and permission to read all secrets required" },
    409: { description: "The pool changed or comes from the deployment env" },
  },
});

const ENV_POOL_ERROR = "These keys come from the deployment env. Change them there.";

async function readPool(key: string) {
  const [row] = await getSwarmConfigs({ scope: "global", key });
  const envValue = getDeploymentEnvValue(key);
  const source = row ? "stored" : envValue ? "env" : "none";
  const value = row?.value ?? envValue ?? "";
  registerEnvSecrets({ [key]: value });
  return { row, source, members: splitCredentialPool(value) } as const;
}

async function poolResponse(key: string): Promise<PoolKeysResponse> {
  const pool = await readPool(key);
  const statuses = await getKeyStatuses(key, "global", null);
  return {
    key,
    source: pool.source,
    readOnly: pool.source === "env",
    keys: pool.members.map((member, index) => {
      const suffix = member.slice(-5);
      const row = statuses.find((status) => status.keySuffix === suffix);
      const rejected = !!row?.lastValidationFailedAt;
      const limited =
        row?.status === "rate_limited" &&
        !!row.rateLimitedUntil &&
        Date.parse(row.rateLimitedUntil) > Date.now();
      return {
        index,
        suffix,
        status: rejected ? "rejected" : limited ? "rate_limited" : row ? "ok" : "unchecked",
        error: rejected ? scrubSecrets(row?.lastValidationError) || null : null,
        checkedAt: rejected ? row!.lastValidationFailedAt : (row?.updatedAt ?? null),
        rateLimitedUntil: row?.rateLimitedUntil ?? null,
      };
    }),
  };
}

function duplicateError(members: readonly string[], additions: string[]): string | null {
  const seen = new Set(members);
  for (const member of additions) {
    if (seen.has(member)) return `The key ending ${member.slice(-5)} is already in the pool.`;
    seen.add(member);
  }
  return null;
}

async function savePool(key: string, members: string[], row: SwarmConfig | undefined) {
  const value = members.join(",");
  const validationError = validateConfigEntry({
    scope: "global",
    key,
    value,
    exportToEnv: row?.exportToEnv,
  });
  if (validationError) return validationError;
  await upsertSwarmConfigWithPolicyMirror({
    scope: "global",
    key,
    value,
    isSecret: true,
    description: row?.description ?? null,
    envPath: row?.envPath ?? null,
    exportToEnv: row?.exportToEnv,
  });
  return null;
}

/** Every response lists the pool's key suffixes and statuses, so each route needs this gate. */
async function ensureSecretRead(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if ((await requestSecretReadScope(req)) === "all") return true;
  jsonError(res, "Reading credential pools requires permission to read all secrets.", 403);
  return false;
}

export async function handlePoolKeys(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (getPoolKeys.match(req.method, pathSegments)) {
    const parsed = await getPoolKeys.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await ensureSecretRead(req, res))) return true;
    getPoolKeys.respond(res, 200, await poolResponse(parsed.query.key));
    return true;
  }
  if (addPoolKeys.match(req.method, pathSegments)) {
    const parsed = await addPoolKeys.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await ensureConfigAdmin(req, res, "config.write.any"))) return true;
    if (!(await ensureSecretRead(req, res))) return true;
    const { key, value, baseUrl } = parsed.body;
    const additions = value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (!additions.length) {
      jsonError(res, "Enter a key.", 400);
      return true;
    }
    if (additions.some((part) => /\s/.test(part))) {
      jsonError(res, "A key cannot contain spaces or line breaks.", 400);
      return true;
    }
    registerEnvSecrets({ [key]: additions.join(",") });
    const initial = await readPool(key);
    if (initial.source === "env") {
      jsonError(res, ENV_POOL_ERROR, 409);
      return true;
    }
    const duplicate = duplicateError(initial.members, additions);
    if (duplicate) {
      jsonError(res, scrubSecrets(duplicate), 409);
      return true;
    }
    const env = { ...process.env };
    const provider = providerForKeyVar(key);
    const baseUrlKey =
      key === "OPENROUTER_API_KEY"
        ? "OPENROUTER_BASE_URL"
        : provider
          ? baseUrlEnvVar(provider)
          : undefined;
    if (baseUrlKey && baseUrl !== undefined) {
      env[baseUrlKey] = baseUrl ?? "";
    } else if (baseUrlKey) {
      const [row] = await getSwarmConfigs({ scope: "global", key: baseUrlKey });
      if (row) env[baseUrlKey] = row.value;
    }
    const checks = await Promise.all(
      additions.map(async (member): Promise<PoolKeyCheck> => {
        try {
          const probe = await checkProviderPoolKey(key, member, env);
          return {
            suffix: member.slice(-5),
            result: probe.skipped
              ? "not_tested"
              : probe.ok
                ? "verified"
                : probe.httpStatus === 401
                  ? "rejected"
                  : "not_tested",
            httpStatus: probe.httpStatus ?? null,
            error: scrubSecrets(probe.error?.replaceAll(member, "[REDACTED]")) || null,
          };
        } catch {
          return {
            suffix: member.slice(-5),
            result: "not_tested",
            httpStatus: null,
            error: "The provider check did not complete.",
          };
        }
      }),
    );
    const rejected = checks.find((check) => check.result === "rejected");
    if (rejected) {
      addPoolKeys.respond(res, 422, {
        error: scrubSecrets(
          `The key ending ${rejected.suffix} was rejected (HTTP 401). Nothing was saved.`,
        ),
        checks,
      });
      return true;
    }
    const result = await getDbClient().transaction(async () => {
      const current = await readPool(key);
      if (current.source === "env") return { error: ENV_POOL_ERROR, status: 409 };
      const duplicate = duplicateError(current.members, additions);
      if (duplicate) return { error: duplicate, status: 409 };
      const members = [...current.members, ...additions];
      const error = await savePool(key, members, current.row);
      if (error) return { error, status: 400 };
      await recordKeyValidation(
        key,
        checks.flatMap((check, index) =>
          check.result === "verified"
            ? [{ keyIndex: current.members.length + index, keySuffix: check.suffix, ok: true }]
            : [],
        ),
        "global",
        null,
        { retireAbsent: false },
      );
      return { value: members.join(",") };
    });
    if ("error" in result) {
      jsonError(res, scrubSecrets(result.error), result.status);
      return true;
    }
    await runConfigWriteSideEffects("global", key, result.value);
    addPoolKeys.respond(res, 200, { ...(await poolResponse(key)), checks });
    return true;
  }
  if (deletePoolKey.match(req.method, pathSegments)) {
    const parsed = await deletePoolKey.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await ensureConfigAdmin(req, res, "config.delete.any"))) return true;
    if (!(await ensureSecretRead(req, res))) return true;
    const { key, index, suffix } = parsed.query;
    const result = await getDbClient().transaction(async () => {
      const current = await readPool(key);
      if (current.source === "env") return { error: ENV_POOL_ERROR, status: 409 };
      if (!current.members[index] || current.members[index].slice(-5) !== suffix) {
        return { error: "The key list changed. Reload it and try again.", status: 409 };
      }
      const members = current.members.filter((_, position) => position !== index);
      if (members.length) {
        const error = await savePool(key, members, current.row);
        if (error) return { error, status: 400 };
      } else {
        await deleteSwarmConfigByKey("global", null, key);
      }
      await retirePoolKeyStatus(
        key,
        suffix,
        members.map((member, keyIndex) => ({ keySuffix: member.slice(-5), keyIndex })),
      );
      return { value: members.join(",") };
    });
    if ("error" in result) {
      jsonError(res, scrubSecrets(result.error), result.status);
      return true;
    }
    await runConfigWriteSideEffects("global", key, result.value);
    deletePoolKey.respond(res, 200, await poolResponse(key));
    return true;
  }
  return false;
}
