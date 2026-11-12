import "@excalidraw/excalidraw/index.css";
import {
  CaptureUpdateAction,
  Excalidraw,
  hashElementsVersion,
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

/** Save this long after the last edit. */
export const AUTOSAVE_MS = 1500;

type Scene = {
  elements?: ExcalidrawElement[];
  appState?: Partial<AppState>;
  files?: BinaryFiles;
  swarm?: Record<string, unknown>;
};

type SaveResponse = { version: number | null };

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
  /** Element hash at that version; a different hash means unsaved edits. Null until loaded. */
  const savedHash = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [conflict, setConflict] = useState<{ version: number | null } | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const dirty = () => {
    const api = apiRef.current;
    return api && savedHash.current !== null
      ? hashElementsVersion(api.getSceneElements()) !== savedHash.current
      : false;
  };

  const apply = useCallback((next: ObjectSnapshot) => {
    const api = apiRef.current;
    const scene = next.content as Scene;
    if (!api) return;
    const elements = restoreElements(scene.elements ?? [], null, { refreshDimensions: true });
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
    if (scene.files) api.addFiles(Object.values(scene.files));
    base.current = next.version;
    savedHash.current = hashElementsVersion(api.getSceneElements());
    setConflict(null);
  }, []);

  const save = useCallback(
    async (ifMatch: number | null) => {
      const api = apiRef.current;
      if (!api || ifMatch === null) return;
      const elements = api.getSceneElements();
      const hash = hashElementsVersion(elements);
      const scene = JSON.parse(
        serializeAsJSON(elements, api.getAppState(), api.getFiles(), "local"),
      ) as Scene;
      setStatus("Saving…");
      try {
        const saved = await objectCall<SaveResponse>(
          fetchFn,
          `/api/objects/${encodeURIComponent(snapshot.object.id)}/content`,
          { method: "PUT", body: { content: { ...scene, swarm: initial.swarm }, ifMatch } },
        );
        base.current = saved.version;
        savedHash.current = hash;
        markVersion(saved.version);
        setConflict(null);
        setStatus("Saved");
      } catch (err) {
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

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const onChange = () => {
    // The first change is the loaded scene: restoring it may bump versions, so it is the baseline.
    if (savedHash.current === null && apiRef.current) {
      savedHash.current = hashElementsVersion(apiRef.current.getSceneElements());
      return;
    }
    if (readOnly || conflict || !dirty()) return;
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
          elements: restoreElements(initial.elements ?? [], null, { refreshDimensions: true }),
          appState: { viewBackgroundColor: initial.appState?.viewBackgroundColor },
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
