import "@excalidraw/excalidraw/index.css";
import {
  CaptureUpdateAction,
  Excalidraw,
  hashElementsVersion,
  restoreAppState,
  restoreElements,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type ObjectFetch,
  ObjectRequestError,
  type ObjectSnapshot,
  objectCall,
} from "./use-object";

// Excalidraw's fonts are self-hosted next to the page embed bundle
// (`vite.embed.config.ts`), on the origin that served this chunk. The dev
// server has no copy, so it keeps Excalidraw's esm.sh default.
const excalidrawWindow = window as Window & { EXCALIDRAW_ASSET_PATH?: string | string[] };
if (import.meta.env.PROD && excalidrawWindow.EXCALIDRAW_ASSET_PATH === undefined) {
  excalidrawWindow.EXCALIDRAW_ASSET_PATH = `${new URL(import.meta.url).origin}/embed/v1/`;
}

/** Save this long after the last edit. */
export const AUTOSAVE_MS = 1500;

type Scene = {
  elements?: ExcalidrawElement[];
  appState?: Partial<AppState>;
  files?: BinaryFiles;
  swarm?: Record<string, unknown>;
};

type SaveResponse = { version: number | null };

/**
 * The appState a saved board keeps: Excalidraw's export set, which is what
 * `serializeAsJSON(…, "local")` writes. Selection, scroll and zoom are view-only.
 */
const PERSISTED_APP_STATE = [
  "viewBackgroundColor",
  "gridSize",
  "gridStep",
  "gridModeEnabled",
] as const;

type PersistedAppState = Partial<Pick<AppState, (typeof PERSISTED_APP_STATE)[number]>>;

function persistedAppState(appState: Partial<AppState>): PersistedAppState {
  const out: Record<string, unknown> = {};
  for (const key of PERSISTED_APP_STATE) {
    if (appState[key] !== undefined) out[key] = appState[key];
  }
  return out as PersistedAppState;
}

/**
 * Excalidraw renders an element's `customData.generationData.html` as an iframe
 * document, and any agent can write a board. This embed has no generate feature,
 * so the field is dropped before Excalidraw sees the scene.
 */
function loadElements(elements: readonly ExcalidrawElement[] | undefined) {
  const safe = (elements ?? []).map((el) => {
    const data = el.customData;
    if (!data || !("generationData" in data)) return el;
    const { generationData: _html, ...rest } = data;
    return { ...el, customData: rest };
  });
  return restoreElements(safe, null, { refreshDimensions: true });
}

/** The saved part of a scene; a key unlike the saved one means unsaved edits. */
const sceneKey = (elements: readonly ExcalidrawElement[], appState: Partial<AppState>) =>
  `${hashElementsVersion(elements)}:${JSON.stringify(persistedAppState(appState))}`;

export type BoardViewProps = {
  snapshot: ObjectSnapshot;
  fetchFn: ObjectFetch;
  refetch: () => Promise<ObjectSnapshot | null>;
  markVersion: (version: number | null) => void;
  readOnly?: boolean;
  theme?: "light" | "dark";
};

/**
 * An `.excalidraw` board in stock Excalidraw. Edits autosave 1.5 s after the
 * last change with the full scene and `ifMatch`. A newer version from the poll
 * replaces the scene when nothing is unsaved; with unsaved edits, or on a save
 * 409, a banner offers keep mine (save over theirs) or take theirs (reload).
 */
export default function BoardView({
  snapshot,
  fetchFn,
  refetch,
  markVersion,
  readOnly,
  theme,
}: BoardViewProps) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [initial] = useState(() => snapshot.content as Scene);
  /** The version the scene on screen was loaded from or last saved as. */
  const base = useRef(snapshot.version);
  /** `sceneKey` at that version; a different key means unsaved edits. Null until loaded. */
  const savedKey = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** False once unmounted: a save that returns later must not mark the next object's version. */
  const live = useRef(true);
  const [conflict, setConflict] = useState<{ version: number | null } | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const dirty = (appState?: Partial<AppState>) => {
    const api = apiRef.current;
    return api && savedKey.current !== null
      ? sceneKey(api.getSceneElements(), appState ?? api.getAppState()) !== savedKey.current
      : false;
  };

  const apply = useCallback((next: ObjectSnapshot) => {
    const api = apiRef.current;
    const scene = next.content as Scene;
    if (!api) return;
    const elements = loadElements(scene.elements);
    // A field the file leaves out takes Excalidraw's default, not the color on screen.
    const restored = restoreAppState(scene.appState ?? {}, null);
    const appState = {
      viewBackgroundColor: restored.viewBackgroundColor,
      gridSize: restored.gridSize,
      gridStep: restored.gridStep,
      gridModeEnabled: restored.gridModeEnabled,
    } satisfies Required<PersistedAppState>;
    api.updateScene({ elements, appState, captureUpdate: CaptureUpdateAction.NEVER });
    if (scene.files) api.addFiles(Object.values(scene.files));
    base.current = next.version;
    // Key from what was applied: getAppState() can lag a batched updateScene.
    savedKey.current = sceneKey(api.getSceneElements(), appState);
    setConflict(null);
  }, []);

  const save = useCallback(
    async (ifMatch: number | null) => {
      const api = apiRef.current;
      if (!api || ifMatch === null) return;
      const elements = api.getSceneElements();
      const appState = api.getAppState();
      const key = sceneKey(elements, appState);
      const scene = JSON.parse(
        serializeAsJSON(elements, appState, api.getFiles(), "local"),
      ) as Scene;
      setStatus("Saving…");
      try {
        const saved = await objectCall<SaveResponse>(
          fetchFn,
          `/api/objects/${encodeURIComponent(snapshot.object.id)}/content`,
          { method: "PUT", body: { content: { ...scene, swarm: initial.swarm }, ifMatch } },
        );
        if (!live.current) return;
        base.current = saved.version;
        savedKey.current = key;
        markVersion(saved.version);
        setConflict(null);
        setStatus("Saved");
      } catch (err) {
        if (!live.current) return;
        if (err instanceof ObjectRequestError && err.status === 409) {
          setConflict({ version: err.version ?? null });
          setStatus(null);
        } else {
          setStatus(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
    [fetchFn, initial.swarm, markVersion, snapshot.object.id],
  );

  // A newer version from the poll: take it, unless this viewer has unsaved edits.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new snapshot is the trigger
  useEffect(() => {
    if (snapshot.version === base.current) return;
    if (dirty()) setConflict({ version: snapshot.version });
    else apply(snapshot);
  }, [snapshot, apply]);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const onChange = (_elements: readonly ExcalidrawElement[], appState: AppState) => {
    // The first change is the loaded scene: restoring it may bump versions, so it is the baseline.
    if (savedKey.current === null && apiRef.current) {
      savedKey.current = sceneKey(apiRef.current.getSceneElements(), appState);
      return;
    }
    // A selection, scroll or zoom change keeps the key, so it schedules no save.
    if (readOnly || conflict || !dirty(appState)) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(base.current), AUTOSAVE_MS);
  };

  const keepMine = async () => {
    const version = conflict?.version ?? (await refetch())?.version ?? null;
    await save(version);
  };

  const takeTheirs = async () => {
    const latest = await refetch();
    if (latest) apply(latest);
  };

  return (
    <div className="relative h-full">
      {conflict ? (
        <div
          role="alert"
          className="absolute inset-x-2 top-2 z-10 flex flex-wrap items-center gap-2 rounded-md border bg-background/95 p-2 text-sm shadow"
        >
          <span className="flex-1">Someone else changed this board.</span>
          <Button size="sm" variant="outline" onClick={() => void takeTheirs()}>
            Take theirs
          </Button>
          <Button size="sm" onClick={() => void keepMine()}>
            Keep mine
          </Button>
        </div>
      ) : null}
      <Excalidraw
        excalidrawAPI={(api) => {
          apiRef.current = api;
          // The canvas measures its box once; refresh after layout settles.
          requestAnimationFrame(() => api.refresh());
        }}
        initialData={{
          // Re-measure text: an agent may change a label without its width and height.
          elements: loadElements(initial.elements),
          appState: persistedAppState(initial.appState ?? {}),
          files: initial.files,
          scrollToContent: true,
        }}
        onChange={onChange}
        viewModeEnabled={readOnly}
        theme={theme}
      />
      {status ? (
        <p
          aria-live="polite"
          className="pointer-events-none absolute bottom-2 right-2 rounded bg-background/90 px-2 py-0.5 text-xs text-muted-foreground"
        >
          {status}
        </p>
      ) : null}
    </div>
  );
}
