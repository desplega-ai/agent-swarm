import { createResourceProvider } from "../../resource-providers";
import {
  type ProviderOperationContext,
  type ResourceHandle,
  type ResourceProvider,
  ResourceProviderError,
  type ResourceProviderSelection,
} from "../../resource-providers/types";
import type { Resource, ResourceOperation } from "../../types";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { getDbClient } from "../db";
import { openSealedJson, sealJson } from "../sealed-json";
import {
  canAccessResource,
  canCreateResource,
  type ResourceAccess,
  resolveResourceAccess,
} from "./access";
import { admitResource } from "./admission";
import { resourceCleanupIdleMs, resourceConfig } from "./config";
import { type BillingRow, checkpointCosts } from "./costs";
import { createResource, getResource, getResourcePrivate, insertResourceOperation } from "./db";
import { claimOperation, finishOperation, getOperation, resourceRetryDelayMs } from "./operations";
import { type ResourcePrivateConfig, registerResourceHandle } from "./private-config";

export type ResourceServiceOptions = {
  ownerId: string;
  now?: () => Date;
  provider?: (selection: ResourceProviderSelection) => Promise<ResourceProvider>;
};
type Action = "pause" | "resume" | "stop" | "destroy" | "touch";
const PROVIDER_CALL_TIMEOUT_MS = 5_000;
class ResourceClaimLostError extends Error {}
export class ResourceService {
  readonly now: () => Date;
  private readonly providers = new Map<string, Promise<ResourceProvider>>();
  private accepting = true;
  constructor(readonly options: ResourceServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }
  shutdown() {
    this.accepting = false;
  }
  private assertAccepting() {
    if (!this.accepting) throw new Error("Resource work is stopped for shutdown.");
  }
  async provider(resource: Pick<Resource, "kind" | "provider">) {
    const key = `${resource.kind}:${resource.provider}`;
    let provider = this.providers.get(key);
    if (!provider) {
      const selection = resource as ResourceProviderSelection;
      provider = (this.options.provider ?? createResourceProvider)(selection);
      this.providers.set(key, provider);
    }
    const adapter = await provider.catch((error) => {
      if (this.providers.get(key) === provider) this.providers.delete(key);
      throw error;
    });
    if (adapter.kind !== resource.kind || adapter.provider !== resource.provider)
      throw new Error("The resource adapter does not match the reservation.");
    return adapter;
  }
  get isAccepting() {
    return this.accepting;
  }
  /** One bounded provider call. Timeout preserves uncertainty until authoritative recovery. */
  async call<T>(
    run: (context: ProviderOperationContext) => Promise<T>,
    sessionDeadlineAt?: string,
    dispatched = false,
  ): Promise<T> {
    // A committed mutation marker is the dispatch boundary. Shutdown rejects new
    // work, but must not turn an already committed dispatch into a phantom effect.
    if (!dispatched) this.assertAccepting();
    const controller = new AbortController();
    const context = {
      signal: controller.signal,
      deadlineAt: new Date(this.now().getTime() + PROVIDER_CALL_TIMEOUT_MS).toISOString(),
      sessionDeadlineAt,
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run(context),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new ResourceProviderError("deadline", "The resource provider call timed out."));
          }, PROVIDER_CALL_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async before(resource: Resource) {
    return {
      resource: await getDbClient().get<BeforeResource>(
        "SELECT state,generation,providerHandle,liveReservation,runningLeaseExpiresAt,continuousStartedAt,lastActivityAt,expiresAt FROM resources WHERE id=?",
        [resource.id],
      ),
      billing: await getDbClient().query<BillingRow>(
        "SELECT * FROM resource_billing WHERE resourceId=? AND generation=?",
        [resource.id, resource.generation],
      ),
    };
  }

  async create(
    access: ResourceAccess,
    input: {
      kind: Resource["kind"];
      provider: Resource["provider"];
      key: string;
      profileId?: string;
      templateId?: string;
      config?: ResourcePrivateConfig;
    },
  ) {
    this.assertAccepting();
    // Authorization and private-mode rejection precede even adapter selection.
    if (!(await canCreateResource(access, input.profileId)))
      throw new Error("Resource creation is denied.");
    const config = await resourceConfig();
    if (config.access !== "public") throw new Error("Private resource previews are not supported.");
    const adapter = await this.provider(input);
    return getDbClient().transaction(async (tx) => {
      this.assertAccepting();
      const current = await resolveResourceAccess(access.principal, access.taskId ?? undefined);
      if (!current?.taskId || !(await canCreateResource(current, input.profileId)))
        throw new Error("Resource creation is denied.");
      const context = await tx.get<{ agentId: string }>(
        "SELECT agentId FROM agent_tasks WHERE id=?",
        [current.taskId],
      );
      const existing = await tx.get<{ id: string }>(
        "SELECT id FROM resources WHERE creatorAgentId=? AND sourceTaskId=? AND createRequestKey=?",
        [context?.agentId ?? "", current.taskId, input.key],
      );
      const resource = await createResource({
        kind: input.kind,
        provider: input.provider,
        creatorAgentId: context?.agentId ?? "",
        sourceTaskId: current.taskId,
        createRequestKey: input.key,
        profileId: input.profileId,
        templateId: input.templateId,
        privateConfig: input.config,
        expiresAt: new Date(this.now().getTime() + config.RESOURCE_EXPIRY_MS).toISOString(),
      });
      if (existing) {
        const prior = await tx.get<{ id: string }>(
          "SELECT id FROM resource_operations WHERE resourceId=? AND kind='create' AND idempotencyKey=?",
          [resource.id, input.key],
        );
        if (prior) return (await getOperation(prior.id))!;
      }
      const before = !existing ? await this.before(resource) : undefined;
      if (before?.resource) before.resource.liveReservation = 0;
      if (!existing)
        await admitResource(resource, adapter.rates, adapter.traits.maxContinuousMs, this.now());
      return insertResourceOperation({
        resourceId: resource.id,
        generation: 1,
        kind: "create",
        idempotencyKey: input.key,
        privateConfig: { snapshot: { access, before } },
      });
    });
  }
  async action(access: ResourceAccess, id: string, action: Action, key: string) {
    this.assertAccepting();
    if (!key.trim()) throw new Error("An explicit operation key is required.");
    const selected = await getResource(id);
    if (
      !selected ||
      !(await canAccessResource(
        access,
        selected,
        action === "destroy" ? "resource.destroy" : "resource.use",
      ))
    )
      throw new Error("Resource use is denied.");
    const adapter = await this.provider(selected);
    return getDbClient().transaction(async (tx) => {
      this.assertAccepting();
      const resource = await getResource(id);
      if (
        !resource ||
        !(await canAccessResource(
          access,
          resource,
          action === "destroy" ? "resource.destroy" : "resource.use",
        ))
      )
        throw new Error("Resource use is denied.");
      const kind = action === "touch" ? "resume" : action;
      const prior = await tx.get<{ id: string; kind: string; privateConfig: string }>(
        "SELECT id,kind,privateConfig FROM resource_operations WHERE resourceId=? AND idempotencyKey=?",
        [id, key],
      );
      if (prior) {
        if (
          prior.kind !== kind ||
          (openSealedJson(prior.privateConfig) as ResourcePrivateConfig).snapshot.action !== action
        )
          throw new Error("The operation key identifies a different request.");
        return (await getOperation(prior.id))!;
      }
      if (resource.state === "destroyed") throw new Error("The resource is destroyed.");
      if (
        await tx.get(
          "SELECT 1 FROM resource_operations WHERE resourceId=? AND status IN ('pending','running')",
          [id],
        )
      )
        throw new Error("A resource operation is still active.");
      const before = await this.before(resource);
      const uncertainStarts = await tx.query<UncertainStart>(
        "SELECT kind,generation,privateConfig FROM resource_operations WHERE resourceId=? AND status='uncertain' AND kind IN ('create','resume')",
        [id],
      );
      // Terminal cleanup can supersede renewal of the same known handle. Pause
      // cannot: a later resume reuses its handle and could receive the old renewal.
      const terminal = action === "destroy" || (action === "stop" && resource.kind === "browser");
      if (
        uncertainStarts.length &&
        (!terminal ||
          !uncertainStarts.every((op) => this.isKnownRenewal(resource, before.resource, op)))
      )
        throw new Error("Reconcile the uncertain running lease before another lifecycle action.");
      if (action === "pause" && !adapter.traits.supportsPause)
        throw new ResourceProviderError(
          "unsupported",
          "Browser sessions cannot pause. Stop the browser instead.",
        );
      if (action === "stop" && resource.kind !== "browser")
        throw new Error("Sandbox resources must pause or be destroyed.");
      if (action === "resume" || action === "touch") {
        if (
          resource.state === "running" &&
          !(Date.parse(resource.runningLeaseExpiresAt ?? "") > this.now().getTime())
        )
          throw new Error("The running lease expired. Reconcile the resource before resuming.");
        if (resource.state === "running" && adapter.traits.leaseRenewal === "fixed")
          throw new ResourceProviderError(
            "unsupported",
            "This session has a fixed deadline. Reconnect after it stops. Open tabs will be lost.",
          );
        if (action === "touch" && resource.state !== "running")
          throw new Error("Only a running resource can renew its lease.");
        if (action === "resume" && !["paused", "stopped", "running"].includes(resource.state))
          throw new Error("The resource cannot resume in its current state.");
        if (resource.kind === "browser" && resource.state === "stopped") {
          await tx.run(
            "UPDATE resources SET generation=generation+1,providerHandle=NULL WHERE id=? AND generation=?",
            [id, resource.generation],
          );
          resource.generation++;
        }
        await admitResource(resource, adapter.rates, adapter.traits.maxContinuousMs, this.now());
      }
      const operation = await insertResourceOperation({
        resourceId: id,
        generation: resource.generation,
        kind,
        idempotencyKey: key,
        privateConfig: { snapshot: { action, access, before } },
      });
      const state =
        action === "touch" || (action === "resume" && resource.state === "running")
          ? resource.state
          : action === "pause"
            ? "pausing"
            : action === "stop"
              ? "stopping"
              : action === "destroy"
                ? "destroying"
                : "resuming";
      await tx.run("UPDATE resources SET state=?,updatedAt=? WHERE id=? AND generation=?", [
        state,
        this.now().toISOString(),
        id,
        resource.generation,
      ]);
      return operation;
    });
  }
  async poll(access: ResourceAccess, id: string, attempts = 1): Promise<ResourceOperation | null> {
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 20)
      throw new Error("Poll attempts must be between 1 and 20.");
    for (let i = 0; i < attempts; i++) {
      const operation = await getOperation(id);
      const resource = operation ? await getResource(operation.resourceId) : null;
      if (!operation || !resource) return null;
      if (!(await canAccessResource(access, resource)))
        throw new Error("Resource reads are denied.");
      if (!["pending", "running"].includes(operation.status) || i === attempts - 1)
        return operation;
      await Bun.sleep(10);
    }
    return null;
  }
  private valid(handle: ResourceHandle, resource: Resource) {
    if (
      handle.ownerId !== this.options.ownerId ||
      handle.resourceId !== resource.id ||
      handle.generation !== resource.generation
    )
      throw new Error("The provider handle does not match the reserved resource generation.");
  }
  private isKnownRenewal(
    resource: Resource,
    current: BeforeResource | null | undefined,
    op: UncertainStart,
  ) {
    if (op.kind !== "resume" || op.generation !== resource.generation || !current?.providerHandle)
      return false;
    const snapshot = (openSealedJson(op.privateConfig) as ResourcePrivateConfig).snapshot;
    const prior = (snapshot.before as Before | undefined)?.resource;
    if (
      prior?.state !== "running" ||
      prior.generation !== resource.generation ||
      !prior.providerHandle
    )
      return false;
    const currentHandle = openSealedJson(current.providerHandle) as ResourceHandle;
    const priorHandle = openSealedJson(prior.providerHandle) as ResourceHandle;
    if (!currentHandle || !priorHandle) return false;
    this.valid(currentHandle, resource);
    this.valid(priorHandle, resource);
    return currentHandle.externalId === priorHandle.externalId;
  }
  private async lock(resource: Resource, op: ResourceOperation, owner: string) {
    if (
      !(await getDbClient().get(
        "SELECT 1 FROM resources r JOIN resource_operations o ON o.resourceId=r.id WHERE r.id=? AND r.generation=? AND r.leaseOwner=? AND r.leaseExpiresAt>? AND o.id=? AND o.leaseOwner=? AND o.status='running'",
        [resource.id, op.generation, owner, this.now().toISOString(), op.id, owner],
      ))
    )
      throw new ResourceClaimLostError(
        "The resource claim expired. Reconciliation must inspect the provider result.",
      );
  }
  private async compensate(
    op: ResourceOperation,
    owner: string,
    before: Before | undefined,
    message: string,
    systemCleanup: boolean,
  ) {
    await getDbClient().transaction(async (tx) => {
      const resource = await getResource(op.resourceId);
      if (!resource) return;
      await this.lock(resource, op, owner);
      // Preserve real running charges. Roll back only the new admission.
      const prior = before?.resource;
      if (prior) {
        await tx.run(
          "UPDATE resources SET state=?,providerHandle=?,liveReservation=?,runningLeaseExpiresAt=?,continuousStartedAt=?,lastActivityAt=?,expiresAt=?,lastError=?,updatedAt=? WHERE id=? AND generation=? AND leaseOwner=?",
          [
            prior.state === "provisioning" ? "error" : prior.state,
            prior.generation === op.generation ? prior.providerHandle : null,
            prior.liveReservation,
            prior.runningLeaseExpiresAt,
            prior.continuousStartedAt,
            prior.lastActivityAt,
            prior.expiresAt,
            message,
            this.now().toISOString(),
            resource.id,
            op.generation,
            owner,
          ],
        );
        await tx.run(
          "UPDATE resource_billing SET active=0,reserved=0 WHERE resourceId=? AND generation=?",
          [resource.id, op.generation],
        );
        for (const row of before.billing)
          await tx.run(
            "UPDATE resource_billing SET active=?,reserved=?,checkpointAt=MAX(checkpointAt,?),leaseEndsAt=?,billableEndsAt=?,reservationStartsAt=? WHERE resourceId=? AND generation=? AND dimension=?",
            [
              row.active,
              row.reserved,
              row.checkpointAt,
              row.leaseEndsAt,
              row.billableEndsAt,
              row.reservationStartsAt,
              row.resourceId,
              row.generation,
              row.dimension,
            ],
          );
      } else {
        await tx.run(
          // Without a prior snapshot, do not assume an existing session is absent.
          "UPDATE resources SET state='error',lastError=? WHERE id=? AND generation=? AND leaseOwner=?",
          [message, resource.id, op.generation, owner],
        );
      }
      if (systemCleanup) {
        const retry = await tx.get<{ cleanupRetryCount: number }>(
          "SELECT cleanupRetryCount FROM resources WHERE id=?",
          [resource.id],
        );
        await tx.run(
          "UPDATE resources SET cleanupRetryCount=cleanupRetryCount+1,cleanupNextAttemptAt=? WHERE id=?",
          [
            new Date(
              this.now().getTime() + resourceRetryDelayMs(retry!.cleanupRetryCount),
            ).toISOString(),
            resource.id,
          ],
        );
      }
      await finishOperation(op.id, owner, "failed", this.now(), message);
    });
  }
  async execute(id: string) {
    if (!this.accepting) return;
    const owner = crypto.randomUUID();
    const claim = await claimOperation(id, this.now(), owner);
    if (!claim) return;
    const { op, recover } = claim;
    const claimDeadline = Date.parse(claim.leaseExpiresAt);
    let attempted = false;
    let systemCleanup = false;
    let before: Before | undefined;
    try {
      const resource = (await getResource(op.resourceId))!;
      const row = (await getDbClient().get<OperationPrivate>(
        "SELECT privateConfig,mutationStartedAt,providerDeadlineAt FROM resource_operations WHERE id=?",
        [id],
      ))!;
      attempted = row.mutationStartedAt !== null;
      const snapshot = (openSealedJson(row.privateConfig) as ResourcePrivateConfig).snapshot;
      before = snapshot.before as Before | undefined;
      systemCleanup = snapshot.systemCleanup === true;
      if (["exec", "setup", "refresh"].includes(op.kind)) {
        attempted = true;
        throw new Error(
          "Interrupted commands require an explicit retry. Automatic replay is disabled.",
        );
      }
      if (recover && !attempted) {
        await this.compensate(
          op,
          owner,
          before,
          "The operation did not dispatch a provider mutation.",
          systemCleanup,
        );
        return;
      }
      const adapter = await this.provider(resource);
      const data = await getResourcePrivate(resource.id);
      const config = data?.config as ResourcePrivateConfig;
      let handle = data?.handle as ResourceHandle | null;
      const access = snapshot.access as ResourceAccess | undefined;
      const starts = op.kind === "create" || op.kind === "resume";
      if (!recover) {
        if (
          access &&
          !(op.kind === "create"
            ? await canCreateResource(access, resource.profileId ?? undefined)
            : await canAccessResource(
                access,
                resource,
                op.kind === "destroy" ? "resource.destroy" : "resource.use",
              ))
        )
          throw new Error("Resource authorization changed before execution.");
        if (starts && (await resourceConfig()).access !== "public")
          throw new Error("Private resource previews are not supported.");
        if (starts && !(Date.parse(resource.runningLeaseExpiresAt ?? "") > this.now().getTime()))
          throw new Error("The admitted provider lease expired before execution.");
        if (
          op.kind === "resume" &&
          before?.resource?.state === "running" &&
          !(Date.parse(before.resource.runningLeaseExpiresAt ?? "") > this.now().getTime())
        )
          throw new Error("The previous running lease expired before renewal execution.");
      }
      const replacement =
        op.kind === "create" || (op.kind === "resume" && resource.kind === "browser" && !handle);
      let target: Resource["state"] =
        op.kind === "pause"
          ? "paused"
          : op.kind === "stop"
            ? "stopped"
            : op.kind === "destroy"
              ? "destroyed"
              : "running";
      let settledFailure = false;
      const previousDeadline = before?.resource?.runningLeaseExpiresAt;
      const renewalDeadlinePassed = Boolean(
        op.kind === "resume" &&
          before?.resource?.state === "running" &&
          previousDeadline &&
          this.now().getTime() >= Date.parse(previousDeadline) + RECOVERY_GRACE_MS,
      );
      const deadlinePassed =
        renewalDeadlinePassed ||
        (row.providerDeadlineAt !== null &&
          this.now().getTime() >= Date.parse(row.providerDeadlineAt) + RECOVERY_GRACE_MS);
      if (recover || (!handle && !replacement)) {
        const owned = (
          await this.call((ctx) => adapter.listOwned(this.options.ownerId, ctx))
        ).filter(
          (h) =>
            h.ownerId === this.options.ownerId &&
            h.resourceId === resource.id &&
            h.generation === resource.generation,
        );
        if (owned.length > 1)
          throw new Error("Multiple provider sessions require operator inspection.");
        if (owned.length === 1) handle = owned[0]!;
        else if (recover && !deadlinePassed)
          throw new Error(
            "The provider mutation can still complete. Recovery must wait for its deadline.",
          );
        else if (owned.length === 0) {
          // listOwned is authoritative and complete. Errors must never become empty listings.
          target =
            op.kind === "destroy"
              ? "destroyed"
              : resource.kind === "sandbox"
                ? "destroyed"
                : "stopped";
          settledFailure = starts;
          handle = null;
        }
      }
      const mutate = async <T>(run: (ctx: ProviderOperationContext) => Promise<T>) => {
        this.assertAccepting();
        await getDbClient().transaction(async (tx) => {
          await this.lock(resource, op, owner);
          this.assertAccepting();
          // This durable marker precedes every effect, including cleanup retries.
          const deadline = starts
            ? resource.runningLeaseExpiresAt
            : new Date(this.now().getTime() + PROVIDER_CALL_TIMEOUT_MS).toISOString();
          await tx.run(
            "UPDATE resource_operations SET mutationStartedAt=COALESCE(mutationStartedAt,?),providerDeadlineAt=COALESCE(providerDeadlineAt,?) WHERE id=? AND leaseOwner=?",
            [this.now().toISOString(), deadline, id, owner],
          );
          if (starts)
            await tx.run(
              "UPDATE resource_billing SET checkpointAt=CASE WHEN active=0 THEN ? ELSE checkpointAt END,active=1,billableEndsAt=leaseEndsAt WHERE resourceId=? AND generation=?",
              [this.now().toISOString(), resource.id, op.generation],
            );
        });
        attempted = true;
        return this.call(
          (ctx) =>
            run({
              ...ctx,
              deadlineAt: new Date(
                Math.min(Date.parse(ctx.deadlineAt), claimDeadline - 1000),
              ).toISOString(),
            }),
          starts ? (resource.runningLeaseExpiresAt ?? undefined) : undefined,
          true,
        );
      };
      if (!recover && replacement) {
        const profile =
          adapter.kind === "browser" && resource.profileId
            ? await getDbClient().get<{ privateConfig: string }>(
                "SELECT privateConfig FROM browser_profiles WHERE id=?",
                [resource.profileId],
              )
            : null;
        const externalId = profile
          ? (openSealedJson(profile.privateConfig) as ResourcePrivateConfig).secrets?.externalId
          : undefined;
        const input = {
          ownerId: this.options.ownerId,
          resourceId: resource.id,
          generation: resource.generation,
          timeoutMs: Date.parse(resource.runningLeaseExpiresAt!) - this.now().getTime(),
          config: config.snapshot,
          profileHandle: typeof externalId === "string" ? externalId : undefined,
        };
        handle = await mutate((ctx) => adapter.create(input, ctx));
      }
      if (handle) {
        this.valid(handle, resource);
        registerResourceHandle(handle, `resource:${resource.id}`);
        if (recover) {
          const status = await this.call((ctx) => adapter.status(handle!, ctx));
          if (status === "unknown") throw new Error("The provider state is unknown.");
          if (starts) {
            if (
              op.kind === "resume" &&
              before?.resource?.state === "running" &&
              status === "running" &&
              !renewalDeadlinePassed
            )
              throw new Error(
                "The old running lease is not proof of renewal. Recovery must wait for its deadline.",
              );
            // A renewal never resumes a stopped or absent session, so its old
            // deadline plus grace also bounds recovery of authoritative absence.
            if (status !== "running" && !deadlinePassed)
              throw new Error(
                "The provider mutation can still complete. Recovery must wait for its deadline.",
              );
            target = status;
            settledFailure = status !== "running";
          } else if (status !== target) {
            // Cleanup is idempotent. Reissue it under a new bounded claim.
            if (op.kind === "pause") await mutate((ctx) => adapter.pause(handle!, ctx));
            if (op.kind === "stop" && adapter.kind === "browser")
              await mutate((ctx) => adapter.stop(handle!, ctx));
            if (op.kind === "destroy") await mutate((ctx) => adapter.destroy(handle!, ctx));
          }
        } else if (op.kind === "pause") await mutate((ctx) => adapter.pause(handle!, ctx));
        else if (op.kind === "stop") {
          if (adapter.kind !== "browser")
            throw new ResourceProviderError("unsupported", "Only browsers support stop.");
          await mutate((ctx) => adapter.stop(handle!, ctx));
        } else if (op.kind === "destroy") await mutate((ctx) => adapter.destroy(handle!, ctx));
        else if (op.kind === "resume" && !replacement) {
          const timeout = Date.parse(resource.runningLeaseExpiresAt!) - this.now().getTime();
          handle = await mutate((ctx) =>
            before?.resource?.state === "running" || snapshot.action === "touch"
              ? adapter.renewLease(handle!, timeout, ctx)
              : adapter.resume(handle!, timeout, ctx),
          );
          this.valid(handle, resource);
        }
        const status = await this.call((ctx) => adapter.status(handle!, ctx), undefined, attempted);
        if (status !== target) throw new Error("The provider did not confirm the requested state.");
      } else if (!recover && replacement) throw new Error("The provider returned no handle.");
      await getDbClient().transaction(async (tx) => {
        await this.lock(resource, op, owner);
        await checkpointCosts(this.now(), resource.id);
        await tx.run(
          "UPDATE resources SET state=?,providerHandle=?,liveReservation=?,lastError=NULL,destroyedAt=?,updatedAt=?,cleanupNextAttemptAt=NULL,cleanupRetryCount=0 WHERE id=? AND generation=? AND leaseOwner=?",
          [
            target,
            handle ? sealJson(handle) : null,
            target === "running" ? 1 : 0,
            target === "destroyed" ? this.now().toISOString() : null,
            this.now().toISOString(),
            resource.id,
            op.generation,
            owner,
          ],
        );
        if (target !== "running") {
          await tx.run(
            "UPDATE resource_billing SET active=0,reserved=0,updatedAt=? WHERE resourceId=? AND generation=?",
            [this.now().toISOString(), resource.id, op.generation],
          );
          // Confirmed termination supersedes uncertainty in older running operations.
          await tx.run(
            "UPDATE resource_operations SET status='failed',finishedAt=?,updatedAt=?,lastError='A later operation confirmed termination.' WHERE resourceId=? AND generation=? AND id<>? AND status='uncertain'",
            [this.now().toISOString(), this.now().toISOString(), resource.id, op.generation, id],
          );
        }
        await finishOperation(
          id,
          owner,
          settledFailure ? "failed" : "succeeded",
          this.now(),
          settledFailure ? "The provider did not retain a running session." : null,
        );
      });
    } catch (error) {
      const message = scrubSecrets(error instanceof Error ? error.message : String(error));
      if (!attempted) {
        try {
          await this.compensate(op, owner, before, message, systemCleanup);
        } catch (compensationError) {
          if (!(compensationError instanceof ResourceClaimLostError))
            console.error(
              "[resources] Compensation failed:",
              scrubSecrets(
                compensationError instanceof Error
                  ? compensationError.message
                  : String(compensationError),
              ),
            );
        }
      } else {
        await finishOperation(id, owner, "uncertain", this.now(), message);
        await getDbClient().run(
          "UPDATE resources SET lastError=?,updatedAt=? WHERE id=? AND generation=? AND leaseOwner=?",
          [message, this.now().toISOString(), op.resourceId, op.generation, owner],
        );
      }
    } finally {
      await getDbClient().run(
        "UPDATE resources SET leaseOwner=NULL,leaseExpiresAt=NULL WHERE id=? AND leaseOwner=?",
        [op.resourceId, owner],
      );
    }
  }
  /** Internal cleanup has no authenticated activity side effect. */
  async cleanup(resource: Pick<Resource, "id" | "generation">) {
    if (!this.accepting) return;
    return getDbClient().transaction(async (tx) => {
      if (!this.accepting) return;
      const current = await getResource(resource.id);
      if (!current || current.generation !== resource.generation || current.state === "destroyed")
        return;
      if (
        await tx.get(
          "SELECT 1 FROM resource_operations WHERE resourceId=? AND status IN ('pending','running')",
          [resource.id],
        )
      )
        return;
      // Let the existing uncertain operation obey its durable recovery schedule.
      if (
        await tx.get(
          "SELECT 1 FROM resource_operations WHERE resourceId=? AND status='uncertain' AND kind IN ('create','resume','pause','stop','destroy')",
          [resource.id],
        )
      )
        return;
      const now = this.now();
      const retry = await tx.get<{ liveReservation: number; cleanupNextAttemptAt: string | null }>(
        "SELECT liveReservation,cleanupNextAttemptAt FROM resources WHERE id=?",
        [current.id],
      );
      if (retry!.cleanupNextAttemptAt && retry!.cleanupNextAttemptAt > now.toISOString()) return;
      const idleMs = await resourceCleanupIdleMs();
      const expired = Date.parse(current.expiresAt) <= now.getTime();
      const idle =
        retry!.liveReservation === 1 &&
        (Date.parse(current.runningLeaseExpiresAt ?? "") <= now.getTime() ||
          Date.parse(current.lastActivityAt) <= now.getTime() - idleMs);
      // The page is only a candidate list: another request may have renewed this
      // resource, or its expiry may have passed while an earlier item ran.
      if (!expired && !idle) return;
      const kind = expired ? "destroy" : current.kind === "sandbox" ? "pause" : "stop";
      const before = await this.before(current);
      const op = await insertResourceOperation({
        resourceId: resource.id,
        generation: resource.generation,
        kind,
        privateConfig: { snapshot: { before, systemCleanup: true } },
        // The transaction and active-operation guard serialize attempts. A terminal
        // failed attempt must never be reused with a new (volatile) before snapshot.
        idempotencyKey: `reaper:${kind}:${resource.generation}:${crypto.randomUUID()}`,
      });
      await tx.run("UPDATE resources SET state=? WHERE id=? AND generation=?", [
        kind === "destroy" ? "destroying" : kind === "pause" ? "pausing" : "stopping",
        resource.id,
        resource.generation,
      ]);
      return op;
    });
  }
}

export const RECOVERY_GRACE_MS = 10_000;
type BeforeResource = Pick<
  Resource,
  "state" | "generation" | "runningLeaseExpiresAt" | "lastActivityAt" | "expiresAt"
> & {
  providerHandle: string | null;
  liveReservation: number;
  continuousStartedAt: string | null;
};
type Before = { resource: BeforeResource | null; billing: BillingRow[] };
type UncertainStart = Pick<ResourceOperation, "kind" | "generation"> & { privateConfig: string };
type OperationPrivate = {
  privateConfig: string;
  mutationStartedAt: string | null;
  providerDeadlineAt: string | null;
};
