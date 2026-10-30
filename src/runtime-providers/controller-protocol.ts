import { z } from "zod";
import { RuntimePoolCacheSchema, RuntimeProviderKindSchema } from "../types";

export const CONTROLLER_PROTOCOL_VERSION = 1;
export const CONTROLLER_COMMAND_TIMEOUT_MS = 60_000;
export const CONTROLLER_PING_INTERVAL_MS = 15_000;

export const RuntimeHandleSchema = z.object({
  kind: RuntimeProviderKindSchema,
  externalId: z.string().min(1),
  createdAt: z.string().optional(),
  controllerId: z.string().optional(),
  meta: z.record(z.string(), z.string()).optional(),
});
const traitsSchema = z.object({
  canProvision: z.boolean(),
  ephemeralDisk: z.boolean(),
  supportsPause: z.boolean(),
  persistentCache: z.boolean().optional(),
  maxTtlSec: z.number().positive().optional(),
  maxContinuousSec: z.number().positive().optional(),
});
const provisionSchema = z.object({
  runtimeId: z.string().min(1),
  agentId: z.string().min(1),
  poolId: z.string().min(1),
  ownerId: z.string().min(1),
  image: z.string().min(1),
  env: z.record(z.string(), z.string()),
  labels: z.record(z.string(), z.string()),
  resources: z
    .object({ cpu: z.number().positive().optional(), memoryMb: z.number().positive().optional() })
    .optional(),
  ttlSec: z.number().positive().optional(),
  cache: RuntimePoolCacheSchema.extend({
    key: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/),
  }).optional(),
});
const command = { type: z.literal("cmd"), id: z.string().min(1) };
export const ControllerCommandSchema = z.discriminatedUnion("op", [
  z.object({
    ...command,
    op: z.literal("release-cache"),
    payload: z.object({
      key: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/),
      poolId: z.string().min(1),
      ownerId: z.string().min(1),
    }),
  }),
  z.object({ ...command, op: z.literal("provision"), payload: provisionSchema }),
  z.object({
    ...command,
    op: z.literal("terminate"),
    payload: z.object({ handle: RuntimeHandleSchema, reason: z.string() }),
  }),
  z.object({
    ...command,
    op: z.literal("status"),
    payload: z.object({ handles: z.array(RuntimeHandleSchema) }),
  }),
  z.object({
    ...command,
    op: z.literal("list"),
    payload: z.object({ ownerId: z.string().min(1) }),
  }),
  z.object({
    ...command,
    op: z.literal("renew"),
    payload: z.object({ handle: RuntimeHandleSchema, ttlSec: z.number().positive() }),
  }),
  z.object({
    ...command,
    op: z.literal("pause"),
    payload: z.object({ handle: RuntimeHandleSchema }),
  }),
  z.object({
    ...command,
    op: z.literal("resume"),
    payload: z.object({ handle: RuntimeHandleSchema }),
  }),
]);
export type ControllerCommand = z.infer<typeof ControllerCommandSchema>;
export const ControllerClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    controllerId: z.string().min(1),
    kind: RuntimeProviderKindSchema,
    version: z.literal(CONTROLLER_PROTOCOL_VERSION),
    traits: traitsSchema,
  }),
  z.object({
    type: z.literal("result"),
    id: z.string().min(1),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().optional(),
  }),
]);
export const ControllerServerMessageSchema = z.union([
  z.object({
    type: z.literal("welcome"),
    controllerId: z.string().min(1),
    version: z.literal(CONTROLLER_PROTOCOL_VERSION),
  }),
  ControllerCommandSchema,
]);
export const ControllerStatusResultSchema = z.record(
  z.string(),
  z.enum(["starting", "running", "paused", "exited", "failed", "unknown"]),
);
