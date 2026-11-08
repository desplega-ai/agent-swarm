import {
  type ProviderCreate,
  type ProviderOperationContext,
  type ProviderState,
  type ResourceHandle,
  type ResourceProvider,
  ResourceProviderError,
} from "./types";

/** Deterministic in-memory adapter for tests. It performs no network operations. */
export function createFakeResourceProvider(
  kind: "sandbox" | "browser",
  now: () => Date = () => new Date(),
): ResourceProvider {
  const sessions = new Map<
    string,
    { handle: ResourceHandle; state: ProviderState; expiresAt: string }
  >();
  const files = new Map<string, Uint8Array>();
  const profiles = new Map<string, string>();
  const lookup = (handle: ResourceHandle) => {
    const row = sessions.get(handle.externalId);
    if (
      !row ||
      row.handle.resourceId !== handle.resourceId ||
      row.handle.generation !== handle.generation ||
      row.handle.ownerId !== handle.ownerId
    ) {
      throw new ResourceProviderError("not-found", "The resource generation does not exist.");
    }
    if (row.state === "running" && Date.parse(row.expiresAt) <= now().getTime())
      row.state = kind === "sandbox" ? "paused" : "stopped";
    return row;
  };
  const unsupported = () => {
    throw new ResourceProviderError(
      "unsupported",
      "Browser sessions do not support pause or resume.",
    );
  };
  const check = (context?: ProviderOperationContext) => {
    if (context?.signal.aborted || (context && Date.parse(context.deadlineAt) <= now().getTime()))
      throw new ResourceProviderError("deadline", "The provider mutation deadline expired.");
    if (context?.sessionDeadlineAt && Date.parse(context.sessionDeadlineAt) <= now().getTime())
      throw new ResourceProviderError("deadline", "The provider session deadline expired.");
  };
  const common = {
    provider: "fake" as const,
    rates: [{ dimension: "runtime", usdPerMs: 0.000001, effectiveAt: "2026-01-01T00:00:00.000Z" }],
    async renewLease(
      handle: ResourceHandle,
      timeoutMs: number,
      context?: ProviderOperationContext,
    ) {
      check(context);
      if (common.traits.leaseRenewal === "fixed")
        throw new ResourceProviderError(
          "unsupported",
          "This session has a fixed deadline. Reconnect after it stops. Open tabs will be lost.",
        );
      const row = lookup(handle);
      if (row.state !== "running")
        throw new ResourceProviderError("conflict", "The session is not running.");
      row.expiresAt =
        context?.sessionDeadlineAt ?? new Date(now().getTime() + timeoutMs).toISOString();
      return handle;
    },
    traits: {
      supportsPause: kind === "sandbox",
      leaseRenewal: "extendable" as "extendable" | "fixed",
      maxContinuousMs: 60_000,
      previewAccess: kind === "sandbox" ? ("public" as const) : ("none" as const),
      preservesTabsOnStop: false as const,
    },
    async create(input: ProviderCreate, context?: ProviderOperationContext) {
      check(context);
      const externalId = `${input.resourceId}:${input.generation}`;
      if (sessions.has(externalId))
        throw new ResourceProviderError("conflict", "The resource generation already exists.");
      const handle = {
        ownerId: input.ownerId,
        resourceId: input.resourceId,
        generation: input.generation,
        externalId,
      };
      sessions.set(externalId, {
        handle,
        state: "running",
        expiresAt:
          context?.sessionDeadlineAt ?? new Date(now().getTime() + input.timeoutMs).toISOString(),
      });
      return handle;
    },
    async status(handle: ResourceHandle, context?: ProviderOperationContext) {
      check(context);
      return lookup(handle).state;
    },
    async pause(handle: ResourceHandle, context?: ProviderOperationContext) {
      check(context);
      if (kind === "browser") unsupported();
      const row = lookup(handle);
      if (row.state === "destroyed")
        throw new ResourceProviderError("conflict", "The resource is destroyed.");
      row.state = "paused";
    },
    async resume(handle: ResourceHandle, timeoutMs: number, context?: ProviderOperationContext) {
      check(context);
      if (kind === "browser") unsupported();
      const row = lookup(handle);
      if (row.state === "destroyed")
        throw new ResourceProviderError("conflict", "The resource is destroyed.");
      row.state = "running";
      row.expiresAt =
        context?.sessionDeadlineAt ?? new Date(now().getTime() + timeoutMs).toISOString();
      return handle;
    },
    async destroy(handle: ResourceHandle, context?: ProviderOperationContext) {
      check(context);
      lookup(handle).state = "destroyed";
    },
    async listOwned(ownerId: string, context?: ProviderOperationContext) {
      check(context);
      return [...sessions.values()]
        .filter((row) => row.handle.ownerId === ownerId && row.state !== "destroyed")
        .map((row) => row.handle);
    },
  };
  if (kind === "sandbox")
    return {
      ...common,
      kind,
      async exec(handle) {
        lookup(handle);
        return { exitCode: 0, stdout: "fake", stderr: "" };
      },
      async writeFiles(handle, entries) {
        lookup(handle);
        for (const entry of entries)
          files.set(`${handle.externalId}/${entry.path}`, entry.data.slice());
      },
      async readFile(handle, path) {
        lookup(handle);
        const data = files.get(`${handle.externalId}/${path}`);
        if (!data) throw new ResourceProviderError("not-found", "The file does not exist.");
        return data.slice();
      },
      async previewUrl(handle, port) {
        lookup(handle);
        return `https://preview.invalid/${handle.resourceId}/${port}`;
      },
    };
  return {
    ...common,
    kind,
    async stop(handle, context) {
      check(context);
      const row = lookup(handle);
      if (row.state === "destroyed")
        throw new ResourceProviderError("conflict", "The resource is destroyed.");
      row.state = "stopped";
    },
    async createProfile(name) {
      const id = crypto.randomUUID();
      profiles.set(id, name);
      return id;
    },
    async listProfiles() {
      return [...profiles].map(([externalId, name]) => ({ externalId, name }));
    },
    async deleteProfile(id) {
      profiles.delete(id);
    },
    async connection(handle) {
      const row = lookup(handle);
      if (row.state !== "running")
        throw new ResourceProviderError("conflict", "The browser session is stopped.");
      return {
        cdpUrl: `https://cdp.invalid/${handle.externalId}`,
        liveUrl: `https://live.invalid/${handle.externalId}`,
        expiresAt: row.expiresAt,
      };
    },
  };
}
