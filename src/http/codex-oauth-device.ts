import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { decryptSecret, encryptSecret, getEncryptionKey } from "../be/crypto";
import { getDbClient, getKv, upsertKv, upsertSwarmConfig } from "../be/db";
import { updateOnboardingAiFromCodexDevice } from "../be/onboarding";
import {
  CODEX_DEVICE_VERIFICATION_URL,
  DeviceCodeNotEnabledError,
  exchangeDeviceAuthorizationCode,
  pollDeviceToken,
  requestDeviceCode,
} from "../providers/codex-oauth/device";
import { codexOAuthKeyForSlot, MAX_CODEX_OAUTH_SLOT } from "../providers/codex-oauth/storage";
import type { CodexOAuthCredentials } from "../providers/codex-oauth/types";
import { registerVolatileSecret, scrubSecrets } from "../utils/secret-scrubber";
import { ensureConfigAdmin } from "./config";
import { route } from "./route-def";
import { jsonError } from "./utils";

const FLOW_NAMESPACE = "codex-oauth-device";
const FLOW_TTL_MS = 15 * 60 * 1_000;
const POLL_LEASE_MS = 45_000;

const FlowStateSchema = z.object({
  deviceAuthId: z.string(),
  userCode: z.string(),
  intervalSeconds: z.number().positive(),
  expiresAt: z.number().int(),
  lastPolledAt: z.number().int().nullable(),
  pollLeaseId: z.string().uuid().nullable(),
  pollLeaseExpiresAt: z.number().int().nullable(),
  status: z.enum(["pending", "complete", "failed", "expired"]),
  slot: z.number().int().min(0).max(MAX_CODEX_OAUTH_SLOT).nullable(),
  error: z.string().nullable(),
});
type FlowState = z.infer<typeof FlowStateSchema>;

const StartResponseSchema = z.object({
  flowId: z.string().uuid(),
  userCode: z.string(),
  verificationUrl: z.string().url(),
  intervalSeconds: z.number().positive(),
  expiresAt: z.string().datetime(),
});
const PollResponseSchema = z.object({
  status: z.enum(["pending", "complete", "failed", "expired"]),
  slot: z.number().int().min(0).max(MAX_CODEX_OAUTH_SLOT).optional(),
  error: z.string().optional(),
});
type PollResponse = z.infer<typeof PollResponseSchema>;

const startDeviceFlow = route({
  method: "post",
  path: "/api/codex-oauth/device",
  pattern: ["api", "codex-oauth", "device"],
  summary: "Start a Codex ChatGPT device login",
  tags: ["Codex OAuth"],
  rbac: { permission: "config.write.any" },
  body: z.object({}).optional(),
  responses: {
    200: { description: "Device login started", schema: StartResponseSchema },
    409: { description: "Device login is not enabled" },
    500: { description: "Failed to store device login state" },
    502: { description: "OpenAI device login request failed" },
  },
});

const pollDeviceFlow = route({
  method: "post",
  path: "/api/codex-oauth/device/{flowId}/poll",
  pattern: ["api", "codex-oauth", "device", null, "poll"],
  summary: "Poll a Codex ChatGPT device login",
  tags: ["Codex OAuth"],
  rbac: { permission: "config.write.any" },
  params: z.object({ flowId: z.string().uuid() }),
  body: z.object({}).optional(),
  responses: {
    200: { description: "Current device login status", schema: PollResponseSchema },
  },
});

function registerFlowSecrets(state: FlowState): void {
  registerVolatileSecret(state.deviceAuthId, "codex-device-auth-id");
  registerVolatileSecret(state.userCode, "codex-device-user-code");
}

async function readFlow(flowId: string): Promise<FlowState | null> {
  const entry = await getKv(FLOW_NAMESPACE, flowId);
  if (!entry || typeof entry.value !== "string") return null;
  try {
    const plaintext = decryptSecret(entry.value, getEncryptionKey());
    const parsed = FlowStateSchema.safeParse(JSON.parse(plaintext));
    if (!parsed.success) return null;
    registerFlowSecrets(parsed.data);
    return parsed.data;
  } catch {
    return null;
  }
}

async function writeFlow(flowId: string, state: FlowState): Promise<void> {
  await upsertKv({
    namespace: FLOW_NAMESPACE,
    key: flowId,
    value: encryptSecret(JSON.stringify(state), getEncryptionKey()),
    valueType: "string",
    expiresAt: state.expiresAt,
  });
}

function responseForState(state: FlowState): PollResponse {
  return {
    status: state.status,
    ...(state.slot === null ? {} : { slot: state.slot }),
    ...(state.error === null ? {} : { error: state.error }),
  };
}

async function claimPoll(
  flowId: string,
): Promise<
  | { type: "expired" }
  | { type: "return"; response: PollResponse }
  | { type: "poll"; state: FlowState; leaseId: string }
> {
  return await getDbClient().transaction(async () => {
    const state = await readFlow(flowId);
    if (!state || state.expiresAt <= Date.now()) return { type: "expired" };
    if (state.status !== "pending") {
      return { type: "return", response: responseForState(state) };
    }

    const now = Date.now();
    if (
      state.pollLeaseId !== null &&
      state.pollLeaseExpiresAt !== null &&
      state.pollLeaseExpiresAt > now
    ) {
      return { type: "return", response: { status: "pending" } };
    }
    if (state.lastPolledAt !== null && now - state.lastPolledAt < state.intervalSeconds * 1_000) {
      return { type: "return", response: { status: "pending" } };
    }

    const leaseId = crypto.randomUUID();
    state.lastPolledAt = now;
    state.pollLeaseId = leaseId;
    state.pollLeaseExpiresAt = now + POLL_LEASE_MS;
    await writeFlow(flowId, state);
    return { type: "poll", state, leaseId };
  });
}

function ownsActiveLease(state: FlowState, leaseId: string): boolean {
  return (
    state.pollLeaseId === leaseId &&
    state.pollLeaseExpiresAt !== null &&
    state.pollLeaseExpiresAt > Date.now()
  );
}

async function releasePendingLease(flowId: string, leaseId: string): Promise<PollResponse> {
  return await getDbClient().transaction(async () => {
    const state = await readFlow(flowId);
    if (!state || state.expiresAt <= Date.now()) {
      return { status: "expired" };
    }
    if (state.status !== "pending" || !ownsActiveLease(state, leaseId)) {
      return responseForState(state);
    }

    state.pollLeaseId = null;
    state.pollLeaseExpiresAt = null;
    await writeFlow(flowId, state);
    return { status: "pending" };
  });
}

function firstFreeSlot(configKeys: Set<string>): number | null {
  for (let slot = 0; slot <= MAX_CODEX_OAUTH_SLOT; slot += 1) {
    if (slot === 0 && configKeys.has("codex_oauth")) continue;
    if (!configKeys.has(codexOAuthKeyForSlot(slot))) return slot;
  }
  return null;
}

async function completeFlow(
  flowId: string,
  credentials: CodexOAuthCredentials,
): Promise<PollResponse> {
  return await getDbClient().transaction(async () => {
    const state = await readFlow(flowId);
    if (!state || state.expiresAt <= Date.now()) {
      return { status: "expired" };
    }
    if (state.status !== "pending") return responseForState(state);

    const configKeys = await getDbClient().query<{ key: string }>(
      "SELECT key FROM swarm_config WHERE scope = 'global'",
    );
    const slot = firstFreeSlot(new Set(configKeys.map((config) => config.key)));
    if (slot === null) {
      return await failFlow(flowId, "", "No Codex OAuth slots are available", true);
    }

    const storedCredentials: CodexOAuthCredentials = {
      access: credentials.access,
      refresh: credentials.refresh,
      expires: credentials.expires,
      accountId: credentials.accountId,
    };
    await upsertSwarmConfig({
      scope: "global",
      key: codexOAuthKeyForSlot(slot),
      value: JSON.stringify(storedCredentials),
      isSecret: true,
      description: `Codex ChatGPT OAuth credentials slot ${slot} (stored by dashboard device login)`,
    });
    await updateOnboardingAiFromCodexDevice({ status: "complete" });
    state.status = "complete";
    state.slot = slot;
    state.error = null;
    state.pollLeaseId = null;
    state.pollLeaseExpiresAt = null;
    await writeFlow(flowId, state);
    return { status: "complete", slot };
  });
}

async function failFlow(
  flowId: string,
  leaseId: string,
  error: string,
  acceptPending = false,
): Promise<PollResponse> {
  return await getDbClient().transaction(async () => {
    const state = await readFlow(flowId);
    if (!state || state.expiresAt <= Date.now()) {
      return { status: "expired" };
    }
    if (state.status !== "pending") return responseForState(state);
    if (!acceptPending && !ownsActiveLease(state, leaseId)) return { status: "pending" };

    const safeError = scrubSecrets(error).slice(0, 200) || "Device login failed";
    state.status = "failed";
    state.error = safeError;
    state.pollLeaseId = null;
    state.pollLeaseExpiresAt = null;
    await writeFlow(flowId, state);
    await updateOnboardingAiFromCodexDevice({ status: "failed", errorClass: "unknown" });
    return { status: "failed", error: safeError };
  });
}

export async function handleCodexOAuthDevice(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (startDeviceFlow.match(req.method, pathSegments)) {
    const parsed = await startDeviceFlow.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await ensureConfigAdmin(req, res, "config.write.any"))) return true;

    let device: Awaited<ReturnType<typeof requestDeviceCode>>;
    try {
      device = await requestDeviceCode();
    } catch (error) {
      if (error instanceof DeviceCodeNotEnabledError) {
        await updateOnboardingAiFromCodexDevice({ status: "failed", errorClass: "not_enabled" });
        jsonError(res, "Codex device login is not enabled", 409);
      } else {
        await updateOnboardingAiFromCodexDevice({ status: "failed", errorClass: "unknown" });
        console.error(
          "[codex-device] Failed to start device login:",
          scrubSecrets(error instanceof Error ? error.message : String(error)),
        );
        jsonError(res, "Failed to start Codex device login", 502);
      }
      return true;
    }

    const flowId = crypto.randomUUID();
    const expiresAt = Date.now() + FLOW_TTL_MS;
    const state: FlowState = {
      deviceAuthId: device.deviceAuthId,
      userCode: device.userCode,
      intervalSeconds: device.intervalSeconds,
      expiresAt,
      lastPolledAt: null,
      pollLeaseId: null,
      pollLeaseExpiresAt: null,
      status: "pending",
      slot: null,
      error: null,
    };
    try {
      registerFlowSecrets(state);
      await writeFlow(flowId, state);
      startDeviceFlow.respond(res, 200, {
        flowId,
        userCode: device.userCode,
        verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
        intervalSeconds: device.intervalSeconds,
        expiresAt: new Date(expiresAt).toISOString(),
      });
    } catch (error) {
      console.error(
        "[codex-device] Failed to store device login:",
        scrubSecrets(error instanceof Error ? error.message : String(error)),
      );
      jsonError(res, "Failed to store Codex device login", 500);
    }
    return true;
  }

  if (pollDeviceFlow.match(req.method, pathSegments)) {
    const parsed = await pollDeviceFlow.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await ensureConfigAdmin(req, res, "config.write.any"))) return true;

    const claimed = await claimPoll(parsed.params.flowId);
    if (claimed.type === "expired") {
      pollDeviceFlow.respond(res, 200, { status: "expired" });
      return true;
    }
    if (claimed.type === "return") {
      pollDeviceFlow.respond(res, 200, claimed.response);
      return true;
    }

    try {
      const result = await pollDeviceToken(claimed.state.deviceAuthId, claimed.state.userCode);
      if (result.type === "pending") {
        pollDeviceFlow.respond(
          res,
          200,
          await releasePendingLease(parsed.params.flowId, claimed.leaseId),
        );
      } else if (result.type === "failed") {
        pollDeviceFlow.respond(
          res,
          200,
          await failFlow(
            parsed.params.flowId,
            claimed.leaseId,
            `Device authorization failed (HTTP ${result.status})`,
          ),
        );
      } else {
        registerVolatileSecret(result.authorizationCode, "codex-device-authorization-code");
        registerVolatileSecret(result.codeVerifier, "codex-device-code-verifier");
        const credentials = await exchangeDeviceAuthorizationCode(
          result.authorizationCode,
          result.codeVerifier,
        );
        if (!credentials) {
          pollDeviceFlow.respond(
            res,
            200,
            await failFlow(parsed.params.flowId, claimed.leaseId, "Token exchange failed"),
          );
        } else {
          pollDeviceFlow.respond(res, 200, await completeFlow(parsed.params.flowId, credentials));
        }
      }
    } catch (error) {
      console.error(
        "[codex-device] Device login failed:",
        scrubSecrets(error instanceof Error ? error.message : String(error)),
      );
      pollDeviceFlow.respond(
        res,
        200,
        await failFlow(parsed.params.flowId, claimed.leaseId, "Device login failed"),
      );
    }
    return true;
  }

  return false;
}
