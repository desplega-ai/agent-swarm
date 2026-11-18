import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useMemo } from "react";
import { type LiveModelsCatalog, modelGroupsForSchedule } from "../../lib/agent-runtime-models";
import { DIAL_LEVELS, type DialContext, type DialHarness, dialSetting } from "../../lib/model-dial";
import { tierRows } from "../../lib/model-tier-fixtures";
import {
  loadModelsSnapshot,
  modelsSnapshot,
  resetModelsSnapshotForTests,
} from "../../lib/models-snapshot";
import type { ModelsCatalogResponse } from "../client";

// Cold loads of the lazily loaded models.dev snapshot, through the real hook and
// a real QueryClient: a memo keyed on the catalog must recompute when the
// snapshot lands, with a cached live catalog or none at all. Only the catalog
// request is faked.

/** A cached live catalog that carries one section (the server may lag the snapshot). */
const PARTIAL: ModelsCatalogResponse = {
  source: "live",
  updatedAt: 1,
  providers: {
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      models: { "claude-opus-5-5": { id: "claude-opus-5-5", name: "Claude Opus 5.5" } },
    },
  } as unknown as LiveModelsCatalog,
};

/** The catalog request never answers. */
let fetchModelsCatalog = (): Promise<ModelsCatalogResponse> => new Promise(() => {});
mock.module("@/lib/config", () => require("../../lib/config"));
const realClient = await import("../client");
const fakeApi = Object.assign(Object.create(realClient.api), {
  fetchModelsCatalog: () => fetchModelsCatalog(),
});
mock.module("@/api/client", () => ({ ...realClient, api: fakeApi }));
const { useModelsCatalog } = await import("./use-models-catalog");

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// react-dom reads the DOM when it first loads: import it after the DOM exists.
const { createRoot } = await import("react-dom/client");

afterAll(async () => {
  // Later files in this process read the snapshot without awaiting it.
  await loadModelsSnapshot();
  await GlobalRegistrator.unregister();
});

const TIERS = tierRows();
const DIAL_HARNESSES: DialHarness[] = ["claude", "codex", "pi", "opencode", "dsh"];

const scheduleOptionCount = (catalog: LiveModelsCatalog | null | undefined) =>
  modelGroupsForSchedule(catalog).reduce((n, group) => n + group.models.length, 0);

/** Every dial level of every harness, as the setup pages read them. */
const dialSettings = (context: DialContext) =>
  JSON.stringify(
    DIAL_HARNESSES.flatMap((harness) =>
      DIAL_LEVELS.map((level) => dialSetting(harness, level, context)),
    ),
  );

interface Frame {
  loaded: boolean;
  catalog: LiveModelsCatalog | null;
  scheduleOptions: number;
  dial: string;
}

/** The schedule dialog's and the setup dial's memos, keyed as those pages key them. */
function Probe({ frames }: { frames: Frame[] }) {
  const { data } = useModelsCatalog();
  const scheduleGroups = useMemo(() => modelGroupsForSchedule(data?.providers), [data?.providers]);
  const catalog = data?.providers ?? null;
  const context = useMemo<DialContext>(
    () => ({ openrouter: false, catalog, tiers: TIERS }),
    [catalog],
  );
  const dial = useMemo(() => dialSettings(context), [context]);
  frames.push({
    loaded: modelsSnapshot() !== null,
    catalog,
    scheduleOptions: scheduleGroups.reduce((n, group) => n + group.models.length, 0),
    dial,
  });
  return null;
}

async function coldLoad(cached: ModelsCatalogResponse | null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
  });
  if (cached) client.setQueryData(["models-catalog"], cached);
  const frames: Frame[] = [];
  const root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe frames={frames} />
      </QueryClientProvider>,
    );
  });
  const first = frames[0];
  await act(async () => {
    await loadModelsSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const last = frames.at(-1);
  await act(async () => root.unmount());
  client.clear();
  return { first, last };
}

describe("useModelsCatalog on a cold load of the models.dev snapshot", () => {
  beforeEach(() => {
    resetModelsSnapshotForTests();
    fetchModelsCatalog = () => new Promise(() => {});
  });
  afterEach(() => {
    fetchModelsCatalog = () => new Promise(() => {});
  });

  test("memos recompute when the snapshot lands after a cached partial live catalog", async () => {
    const { first, last } = await coldLoad(PARTIAL);
    expect(first?.loaded).toBe(false);
    expect(last?.loaded).toBe(true);
    // Fresh computations on a new object, so no memo or dial cache answers them.
    const fresh = { ...PARTIAL.providers };
    expect(last?.scheduleOptions).toBe(scheduleOptionCount(fresh));
    expect(last?.scheduleOptions).toBeGreaterThan(first?.scheduleOptions ?? 0);
    expect(last?.dial).toBe(dialSettings({ openrouter: false, catalog: fresh, tiers: TIERS }));
    expect(last?.dial).not.toBe(first?.dial);
  });

  test("memos recompute when the snapshot lands with no live catalog", async () => {
    const { first, last } = await coldLoad(null);
    expect(first?.loaded).toBe(false);
    expect(first?.catalog).toBeNull();
    expect(last?.loaded).toBe(true);
    expect(last?.scheduleOptions).toBe(scheduleOptionCount(undefined));
    expect(last?.scheduleOptions).toBeGreaterThan(first?.scheduleOptions ?? 0);
    expect(last?.dial).toBe(dialSettings({ openrouter: false, catalog: {}, tiers: TIERS }));
    expect(last?.dial).not.toBe(first?.dial);
  });

  test("a failed catalog request also falls back to the snapshot once it lands", async () => {
    fetchModelsCatalog = () => Promise.reject(new Error("models-catalog: 503"));
    const { last } = await coldLoad(null);
    expect(last?.loaded).toBe(true);
    expect(last?.scheduleOptions).toBe(scheduleOptionCount(undefined));
  });
});
