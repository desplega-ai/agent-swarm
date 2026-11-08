import { ResourceSchema } from "../../types";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { getDbClient } from "../db";
import { ensureRuntimeOwnerId } from "../runtime-pools/controllers";
import { resourceCleanupIdleMs } from "./config";
import { checkpointCosts } from "./costs";
import { ResourceService } from "./service";

/** Bounded pages prevent retained operation history from dominating each tick. */
export class ResourceReconciler {
  private operationCursor = "";
  private lastDiscovery: number | null = null;
  ownedOrphans: { resourceId: string; generation: number }[] = [];
  private resourceCursor = "";
  constructor(readonly service: ResourceService) {}
  async tick() {
    if (!this.service.isAccepting) return;
    const now = this.service.now();
    if (this.lastDiscovery === null || now.getTime() - this.lastDiscovery >= 60_000) {
      try {
        this.ownedOrphans = await this.discoverOwned();
      } catch (error) {
        console.warn(
          "[resources] Ownership discovery failed:",
          scrubSecrets(error instanceof Error ? error.message : String(error)),
        );
      }
      this.lastDiscovery = now.getTime();
      if (this.ownedOrphans.length)
        console.warn(
          `[resources] ${this.ownedOrphans.length} owned provider generations require orphan inspection.`,
        );
    }
    const operations = await getDbClient().query<{ id: string }>(
      `SELECT id FROM resource_operations WHERE id>? AND status IN ('pending','running','uncertain') AND (status<>'uncertain' OR kind IN ('create','resume','pause','stop','destroy')) AND (leaseExpiresAt IS NULL OR leaseExpiresAt<=?) AND (nextAttemptAt IS NULL OR nextAttemptAt<=?) ORDER BY id LIMIT 100`,
      [this.operationCursor, now.toISOString(), now.toISOString()],
    );
    this.operationCursor = operations.length === 100 ? operations.at(-1)!.id : "";
    for (const operation of operations) {
      try {
        await this.service.execute(operation.id);
      } catch (error) {
        console.error(
          "[resources] Operation reconciliation failed:",
          scrubSecrets(error instanceof Error ? error.message : String(error)),
        );
      }
    }
    await checkpointCosts(now);
    const idleMs = await resourceCleanupIdleMs();
    const resources = await getDbClient().query(
      `SELECT * FROM resources WHERE id>? AND state<>'destroyed' AND (expiresAt<=? OR (liveReservation=1 AND (runningLeaseExpiresAt<=? OR lastActivityAt<=?))) ORDER BY id LIMIT 100`,
      [
        this.resourceCursor,
        now.toISOString(),
        now.toISOString(),
        new Date(now.getTime() - idleMs).toISOString(),
      ],
    );
    this.resourceCursor = resources.length === 100 ? ResourceSchema.parse(resources.at(-1)).id : "";
    for (const row of resources) {
      try {
        const resource = ResourceSchema.parse(row);
        const op = await this.service.cleanup(resource);
        if (op) await this.service.execute(op.id);
      } catch (error) {
        console.error(
          "[resources] Resource cleanup failed:",
          scrubSecrets(error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }
  /** Discovery is diagnostic. An absent local record has no safe billing attribution. */
  async discoverOwned() {
    const selections = await getDbClient().query<{
      kind: "sandbox" | "browser";
      provider: "fake" | "e2b" | "browser-use";
    }>("SELECT DISTINCT kind,provider FROM resources");
    const orphans: { resourceId: string; generation: number }[] = [];
    for (const selection of selections) {
      const adapter = await this.service.provider(selection);
      for (const handle of await this.service.call((ctx) =>
        adapter.listOwned(this.service.options.ownerId, ctx),
      )) {
        if (handle.ownerId !== this.service.options.ownerId) continue;
        const resource = await getDbClient().get<{
          generation: number;
          state: string;
          liveReservation: number;
        }>("SELECT generation,state,liveReservation FROM resources WHERE id=?", [
          handle.resourceId,
        ]);
        let orphan =
          !resource || resource.generation !== handle.generation || resource.state === "destroyed";
        if (!orphan && !resource!.liveReservation) {
          // listOwned also includes legitimately retained paused/stopped sessions.
          const status = await this.service.call((ctx) => adapter.status(handle, ctx));
          orphan = status === "running" || status === "unknown";
        }
        if (orphan) orphans.push({ resourceId: handle.resourceId, generation: handle.generation });
      }
    }
    return orphans;
  }
}

type ReconcilerState = {
  service: ResourceService;
  timer: ReturnType<typeof setInterval> | null;
  pending: Promise<void> | null;
};
let active: ReconcilerState | null = null;
export async function startResourceReconciler() {
  if (active) return;
  const service = new ResourceService({ ownerId: await ensureRuntimeOwnerId() });
  const reconciler = new ResourceReconciler(service);
  const state: ReconcilerState = {
    service,
    timer: null,
    pending: null,
  };
  const tick = () => {
    if (state.pending) return;
    state.pending = reconciler
      .tick()
      .catch((error) =>
        console.error(
          "[resources] Reconciliation failed:",
          scrubSecrets(error instanceof Error ? error.message : String(error)),
        ),
      )
      .finally(() => {
        state.pending = null;
      });
  };
  state.timer = setInterval(tick, 5_000);
  state.timer.unref();
  active = state;
  tick();
}
export async function stopResourceReconciler() {
  const state = active;
  if (!state) return;
  active = null;
  if (state.timer) clearInterval(state.timer);
  state.service.shutdown();
  // Provider calls have finite deadlines. Interrupted operations remain durable.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      state.pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
