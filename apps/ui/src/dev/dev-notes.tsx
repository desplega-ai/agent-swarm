/**
 * Dev notes overlay. Dev server only: `dev-notes/vite-plugin.ts` injects this
 * module when `DEV_NOTES=1`, and nothing in the app imports it, so production
 * builds never contain it. Pick an element, leave a note, and an agent reads
 * the notes with `bun dev-notes/cli.ts list`. Notes show as numbered pins and
 * stay listed in the panel after a reload.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DevNote, NewDevNote } from "../../dev-notes/types";

const API = "/__dev-notes/notes";
const PIN = 22;

type Draft = Omit<NewDevNote, "comment"> & { x: number; y: number };
type Pin = { x: number; y: number };
/** Dev-build React fiber fields we read. Server component owners carry `name` instead of `type`. */
type Fiber = { type?: unknown; name?: string; _debugOwner?: Fiber | null };

const host = document.createElement("div");
host.setAttribute("data-dev-notes", "");
document.body.appendChild(host);

const currentPath = () => window.location.pathname + window.location.search;
// A note belongs to a page by pathname. Query strings such as `?tabs=` change
// while you work, so they would hide the page's notes.
const pageOf = (path: string) => path.split("?")[0];
const isOwn = (node: unknown) => node instanceof Node && host.contains(node);
// React's generated ids (`:r1:`, `«r1»`, `_r_1l_`, `radix-_r_3_`) change between renders.
const stableId = (id: string) => id && !/[:«»]|_r_/.test(id);

/** A selector that finds the element again: nearest stable id or test id, then nth-of-type steps. */
function selectorFor(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.body) {
    if (stableId(node.id)) return [`#${CSS.escape(node.id)}`, ...parts].join(" > ");
    const testId = node.getAttribute("data-testid");
    if (testId) return [`[data-testid="${CSS.escape(testId)}"]`, ...parts].join(" > ");
    const parent: Element | null = node.parentElement;
    if (!parent) break;
    const tag = node.tagName;
    const same = Array.from(parent.children).filter((child) => child.tagName === tag);
    const step = tag.toLowerCase();
    parts.unshift(same.length > 1 ? `${step}:nth-of-type(${same.indexOf(node) + 1})` : step);
    node = parent;
  }
  return ["body", ...parts].join(" > ");
}

function componentName(type: unknown): string | null {
  if (typeof type === "function") {
    const fn = type as { displayName?: string; name?: string };
    return fn.displayName || fn.name || null;
  }
  if (type && typeof type === "object") {
    // memo() and forwardRef() wrap the component in `type` or `render`.
    const wrapper = type as { displayName?: string; type?: unknown; render?: unknown };
    return wrapper.displayName || componentName(wrapper.type) || componentName(wrapper.render);
  }
  return null;
}

/**
 * Components that rendered the element, nearest first. Follows the dev-only
 * `_debugOwner` chain (who rendered whom), so wrappers that only pass children
 * through drop out. Library owners (AG Grid, Radix) stay in the list.
 */
function componentsFor(el: Element): string[] {
  const key = Object.keys(el).find((name) => name.startsWith("__reactFiber$"));
  const fiber = key ? (el as unknown as Record<string, Fiber | undefined>)[key] : undefined;
  const names: string[] = [];
  let owner = fiber?._debugOwner ?? null;
  for (let depth = 0; owner && depth < 100 && names.length < 16; depth++) {
    const name = componentName(owner.type) ?? owner.name ?? null;
    if (name && names[names.length - 1] !== name) names.push(name);
    owner = owner._debugOwner ?? null;
  }
  return names;
}

function textFor(el: Element): string {
  const label = el.getAttribute("aria-label") || el.getAttribute("title");
  const text = label || (el as HTMLElement).innerText || el.textContent || "";
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

function findElement(selector: string): Element | null {
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

function DevNotes() {
  const [notes, setNotes] = useState<DevNote[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState(() => window.location.pathname);
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<"page" | "all">("page");
  const [picking, setPicking] = useState(false);
  const [hover, setHover] = useState<DOMRect | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState("");
  const [pins, setPins] = useState<Record<string, Pin>>({});
  const [flash, setFlash] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const refresh = useCallback(async () => {
    try {
      setNotes(await call<DevNote[]>("GET", API));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // The plugin sends this when the notes file changes, including CLI edits.
    import.meta.hot?.on("dev-notes:changed", () => void refresh());
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  // The router changes the URL without a reload. Follow it.
  useEffect(() => {
    const sync = () => setPath(window.location.pathname);
    const timer = window.setInterval(sync, 400);
    window.addEventListener("popstate", sync);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  // Memoized: the pin effect below depends on it, and a new array each render would loop.
  const pageNotes = useMemo(
    () => notes.filter((note) => pageOf(note.path) === path),
    [notes, path],
  );
  const listed = scope === "page" ? pageNotes : notes;
  const openCount = pageNotes.filter((note) => note.status === "open").length;

  // Pins use viewport coordinates. Panes scroll on their own, so listen to every scroll.
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const next: Record<string, Pin> = {};
      for (const note of pageNotes) {
        const el = findElement(note.selector);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const x = r.left + note.anchor.x * r.width;
        const y = r.top + note.anchor.y * r.height;
        if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
        next[note.id] = { x, y };
      }
      setPins(next);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    measure();
    const timer = window.setInterval(schedule, 1000);
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(timer);
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
    };
  }, [pageNotes]);

  // Keep the app's dialogs open and their focus traps quiet while the overlay is in use.
  useEffect(() => {
    const stop = (event: Event) => event.stopPropagation();
    const shielded = ["pointerdown", "mousedown", "focusin", "keydown"] as const;
    for (const type of shielded) host.addEventListener(type, stop);
    const onFocusOut = (event: FocusEvent) => {
      if (isOwn(event.relatedTarget)) event.stopImmediatePropagation();
    };
    window.addEventListener("focusout", onFocusOut, true);
    return () => {
      for (const type of shielded) host.removeEventListener(type, stop);
      window.removeEventListener("focusout", onFocusOut, true);
    };
  }, []);

  // Pick mode: outline the element under the pointer and swallow the click, so nothing in the app fires.
  useEffect(() => {
    if (!picking) return;
    const target = (event: Event) => {
      const el = event.target;
      return el instanceof Element && !isOwn(el) ? el : null;
    };
    const swallow = (event: Event) => {
      if (!target(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onMove = (event: MouseEvent) => {
      const el = target(event);
      setHover(el ? el.getBoundingClientRect() : null);
    };
    const onClick = (event: MouseEvent) => {
      const el = target(event);
      if (!el) return;
      swallow(event);
      const r = el.getBoundingClientRect();
      setDraft({
        path: currentPath(),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
        selector: selectorFor(el),
        components: componentsFor(el),
        tag: el.tagName.toLowerCase(),
        text: textFor(el),
        anchor: {
          x: r.width ? Math.min(Math.max((event.clientX - r.left) / r.width, 0), 1) : 0,
          y: r.height ? Math.min(Math.max((event.clientY - r.top) / r.height, 0), 1) : 0,
        },
        x: event.clientX,
        y: event.clientY,
      });
      setText("");
      setPicking(false);
      setHover(null);
      window.setTimeout(() => textRef.current?.focus(), 0);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      setPicking(false);
      setHover(null);
    };
    const style = document.createElement("style");
    style.textContent = "* { cursor: crosshair !important; }";
    document.head.appendChild(style);
    const swallowed = [
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "dblclick",
      "contextmenu",
    ] as const;
    for (const type of swallowed) window.addEventListener(type, swallow, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      style.remove();
      for (const type of swallowed) window.removeEventListener(type, swallow, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [picking]);

  /** Runs a notes API call. Returns false when it failed, with the error set. */
  const run = async (action: () => Promise<unknown>) => {
    let ok = true;
    try {
      await action();
      setError(null);
    } catch (err) {
      setError(String(err));
      ok = false;
    }
    await refresh();
    return ok;
  };

  const save = async () => {
    if (!draft || !text.trim()) return;
    const { x: _x, y: _y, ...fields } = draft;
    // A failed save keeps the draft, so the typed note is not lost.
    if (!(await run(() => call("POST", API, { ...fields, comment: text.trim() })))) return;
    setDraft(null);
    setOpen(true);
  };

  const goTo = (note: DevNote) => {
    const reveal = () => {
      findElement(note.selector)?.scrollIntoView({ block: "center", behavior: "smooth" });
      setFlash(note.id);
      window.setTimeout(() => setFlash(null), 1600);
    };
    if (pageOf(note.path) === window.location.pathname) return reveal();
    window.history.pushState(null, "", note.path);
    window.dispatchEvent(new PopStateEvent("popstate"));
    window.setTimeout(reveal, 700);
  };

  const panelButton = "rounded px-1.5 py-0.5 hover:bg-muted";

  return (
    <div className="font-sans text-[13px]" style={{ pointerEvents: "auto" }}>
      {hover && (
        <div
          className="pointer-events-none fixed z-[2147483600] rounded-sm border-2 border-primary bg-primary/10"
          style={{ left: hover.left, top: hover.top, width: hover.width, height: hover.height }}
        />
      )}

      {pageNotes.map((note) => {
        const pin = pins[note.id];
        if (!pin || (note.status === "done" && !open)) return null;
        return (
          <button
            key={note.id}
            type="button"
            title={note.comment}
            onClick={() => {
              setOpen(true);
              setFlash(note.id);
            }}
            className={`fixed z-[2147483601] flex items-center justify-center rounded-full px-1.5 font-mono text-[11px] font-bold shadow-md ring-2 ring-background transition-transform ${
              note.status === "done"
                ? "bg-muted-foreground text-background"
                : "bg-primary text-primary-foreground"
            } ${flash === note.id ? "scale-125" : ""}`}
            style={{ left: pin.x - PIN / 2, top: pin.y - PIN / 2, height: PIN, minWidth: PIN }}
          >
            {note.n}
          </button>
        );
      })}

      {draft && (
        <div
          className="fixed z-[2147483602] w-[320px] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-xl"
          style={{
            left: Math.min(Math.max(draft.x - 160, 8), window.innerWidth - 328),
            top: Math.min(draft.y + 16, window.innerHeight - 220),
          }}
        >
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {[draft.components[0], draft.text || draft.tag].filter(Boolean).join(" · ")}
          </p>
          <textarea
            ref={textRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void save();
              if (event.key === "Escape") setDraft(null);
            }}
            rows={4}
            placeholder="What should change here?"
            className="mt-2 w-full resize-none rounded-md border border-border bg-background p-2 text-[13px] outline-none focus:border-primary"
          />
          <div className="mt-2 flex items-center justify-between">
            {error ? (
              <span className="truncate font-mono text-[10.5px] text-destructive" title={error}>
                Not saved: {error}
              </span>
            ) : (
              <span className="font-mono text-[10.5px] text-muted-foreground">
                ⌘↵ save · esc cancel
              </span>
            )}
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="h-7 rounded-md px-2.5 text-muted-foreground hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={!text.trim()}
                className="h-7 rounded-md bg-primary px-2.5 font-semibold text-primary-foreground disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {picking && (
        <div className="pointer-events-none fixed top-3 left-1/2 z-[2147483602] -translate-x-1/2 rounded-full bg-foreground px-3 py-1 font-semibold text-background shadow-lg">
          Click an element to comment · esc cancels
        </div>
      )}

      {/* A slim tab on the right edge: page padding sits there, so it covers almost no app UI. */}
      <div className="fixed top-1/2 right-0 z-[2147483602] flex -translate-y-1/2 items-center gap-2">
        {open && (
          <div className="flex max-h-[70vh] w-[360px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl">
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
              <div className="flex gap-1 font-mono text-[11px]">
                {(["page", "all"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setScope(value)}
                    className={`rounded px-2 py-0.5 ${scope === value ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted"}`}
                  >
                    {value === "page" ? `This page · ${pageNotes.length}` : `All · ${notes.length}`}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded px-2 py-0.5 text-muted-foreground hover:bg-muted"
              >
                Close
              </button>
            </div>
            {error && (
              <p className="px-3 py-2 text-[12px] text-destructive">Notes API failed: {error}</p>
            )}
            <ol className="flex-1 divide-y divide-border overflow-y-auto">
              {listed.length === 0 && (
                <li className="px-3 py-4 text-muted-foreground">
                  No notes yet. Press “Add note”, then click an element.
                </li>
              )}
              {listed.map((note) => (
                <li key={note.id} className={`px-3 py-2.5 ${flash === note.id ? "bg-muted" : ""}`}>
                  <div className="flex items-baseline gap-2 font-mono text-[10.5px] text-muted-foreground">
                    <span
                      className={`text-[11px] font-bold ${note.status === "done" ? "" : "text-primary"}`}
                    >
                      #{note.n}
                    </span>
                    <span className="truncate">
                      {[
                        scope === "all" ? note.path : null,
                        note.components[0],
                        `${note.viewport.width}px`,
                        new Date(note.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        }),
                        pageOf(note.path) === path && !pins[note.id] ? "not visible" : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </div>
                  <p
                    className={`mt-1 whitespace-pre-wrap leading-snug ${note.status === "done" ? "text-muted-foreground line-through" : ""}`}
                  >
                    {note.comment}
                  </p>
                  {note.reply && (
                    <p className="mt-1.5 whitespace-pre-wrap border-l-2 border-primary pl-2 text-[12px] leading-snug text-muted-foreground">
                      {note.reply}
                    </p>
                  )}
                  <div className="mt-1.5 -ml-1.5 flex gap-1 font-mono text-[11px] text-muted-foreground">
                    <button
                      type="button"
                      onClick={() => goTo(note)}
                      className={`${panelButton} text-primary`}
                    >
                      Go to
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void run(() =>
                          call("PATCH", `${API}/${note.id}`, {
                            status: note.status === "done" ? "open" : "done",
                          }),
                        )
                      }
                      className={panelButton}
                    >
                      {note.status === "done" ? "Reopen" : "Done"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void run(() => call("DELETE", `${API}/${note.id}`))}
                      className={panelButton}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}
        <div className="flex flex-col overflow-hidden rounded-l-md border border-r-0 border-border bg-popover font-mono font-bold shadow-lg">
          <button
            type="button"
            title={picking ? "Cancel (esc)" : "Add note"}
            aria-label={picking ? "Cancel adding a note" : "Add note"}
            onClick={() => {
              setDraft(null);
              setPicking((value) => !value);
            }}
            className={`h-8 w-7 text-[15px] ${picking ? "bg-foreground text-background" : "bg-primary text-primary-foreground hover:opacity-90"}`}
          >
            {picking ? "×" : "+"}
          </button>
          <button
            type="button"
            title="Notes on this page"
            aria-label={`Notes, ${openCount} open on this page`}
            onClick={() => {
              setOpen((value) => !value);
              void refresh();
            }}
            className="h-8 w-7 text-[11px] text-popover-foreground hover:bg-muted"
          >
            {openCount}
          </button>
        </div>
      </div>
    </div>
  );
}

const root = createRoot(host);
root.render(<DevNotes />);
import.meta.hot?.dispose(() => {
  root.unmount();
  host.remove();
});
