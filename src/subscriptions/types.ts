import * as z from "zod";

// SPIKE NOTE: schemas live module-local for now; production would hoist them
// into src/types.ts alongside the other table-backed schemas.

export const SubscriptionTargetTypeSchema = z.enum(["script", "workflow"]);
export type SubscriptionTargetType = z.infer<typeof SubscriptionTargetTypeSchema>;

export const SubscriptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  /**
   * Glob over dot-separated event names: `*` matches one segment,
   * `**` matches the rest. e.g. "task.*", "github.**", "task.completed".
   */
  eventPattern: z.string(),
  /**
   * Optional payload filter using the wait-node filter language: either an
   * object of dot-path → expected value, or a string expression compiled by
   * src/workflows/wait-filter.ts.
   */
  filter: z.unknown().optional(),
  targetType: SubscriptionTargetTypeSchema,
  scriptName: z.string().optional(),
  scriptArgs: z.record(z.string(), z.unknown()).optional(),
  workflowId: z.string().optional(),
  enabled: z.boolean(),
  createdByAgentId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

export const SwarmEventSchema = z.object({
  id: z.string(),
  name: z.string(),
  data: z.unknown().optional(),
  emittedAt: z.string(),
});
export type SwarmEvent = z.infer<typeof SwarmEventSchema>;

export const SubscriptionDeliveryStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
]);
export type SubscriptionDeliveryStatus = z.infer<typeof SubscriptionDeliveryStatusSchema>;

export const SubscriptionDeliverySchema = z.object({
  id: z.string(),
  subscriptionId: z.string(),
  eventId: z.string(),
  status: SubscriptionDeliveryStatusSchema,
  attempts: z.number().int(),
  claimedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
  result: z.unknown().optional(),
  createdAt: z.string(),
});
export type SubscriptionDelivery = z.infer<typeof SubscriptionDeliverySchema>;
