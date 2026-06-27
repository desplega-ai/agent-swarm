import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ConfigJson } from "../types.ts";
import { ConfigChip } from "./ConfigChip.tsx";
import { fuzzyMatch } from "./DataTable.tsx";
import { HARNESS_LABELS, HarnessIcon } from "./HarnessIcon.tsx";

const EDGE = 8; // min distance from viewport edges (mirrors the judge model-select)

/** Fixed provider group order (v6 §11.2); unknown future providers append alphabetically. */
const PROVIDER_ORDER = ["claude", "codex", "pi", "opencode"];

interface MenuPos {
  left: number;
  top: number;
  width: number;
}

interface Group {
  provider: string;
  rows: ConfigJson[];
}

/**
 * Searchable, provider-grouped multi-config picker for the new-run dialog
 * (v6 F6, §11.2 frozen interaction contract). Replaces the flat 26-row
 * check-list: search input + "Defaults" quick-chip + count badge as the
 * trigger row, a viewport-clamped fixed-position dropdown grouped by provider
 * (tri-state select-all, collapsible groups), and removable selected chips
 * underneath. Selection state lives in the caller (NewRunForm's configSel).
 * Styles live in pages/new-run.css (imported by NewRunDialog — runs.css is
 * shared with RunsPage and must not be touched).
 */
export function ConfigMultiSelect(props: {
  configs: ConfigJson[]; // full /api/configs catalog (isDefault included)
  selected: Set<string>; // selected config ids
  onChange: (next: Set<string>) => void;
}): ReactNode {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  // Collapsed provider groups. Component state — the dialog body remounts per
  // open, so collapse state resets on each dialog open (frozen contract).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const q = query.trim();
  const searching = q.length > 0;

  // Rows visible under the active search filter, grouped by provider in fixed
  // order. Non-matching rows hidden → empty groups hidden.
  const groups = useMemo<Group[]>(() => {
    const visible = searching
      ? props.configs.filter((c) => fuzzyMatch(q, `${c.id} ${c.label ?? ""} ${c.model ?? ""}`))
      : props.configs;
    const byProvider = new Map<string, ConfigJson[]>();
    for (const c of visible) {
      const rows = byProvider.get(c.provider);
      if (rows) rows.push(c);
      else byProvider.set(c.provider, [c]);
    }
    const known = PROVIDER_ORDER.filter((p) => byProvider.has(p));
    const unknown = [...byProvider.keys()].filter((p) => !PROVIDER_ORDER.includes(p)).sort();
    return [...known, ...unknown].map((provider) => ({
      provider,
      rows: byProvider.get(provider) ?? [],
    }));
  }, [props.configs, q, searching]);

  // Same MenuPos/EDGE pattern as the dialog's judge model-select: the dropdown
  // renders position: fixed with viewport coords, INSIDE the dialog subtree
  // (not portaled to document.body — the open modal's top layer paints above,
  // and inerts, everything outside it). Anchor to the trigger row, flip above
  // when there is no room below, clamp x to the viewport.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reposition when filtering/collapsing changes the menu height
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = triggerRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const rect = anchor.getBoundingClientRect();
    menu.style.width = `${rect.width}px`; // apply before measuring the height
    const menuHeight = menu.getBoundingClientRect().height;
    const left = Math.max(EDGE, Math.min(rect.left, window.innerWidth - EDGE - rect.width));
    let top = rect.bottom + 4;
    if (top + menuHeight > window.innerHeight - EDGE) top = rect.top - 4 - menuHeight;
    setMenuPos({ left, top: Math.max(EDGE, top), width: rect.width });
  }, [open, groups, collapsed]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); // close the dropdown only — keep the dialog open AND the search text
      setOpen(false);
    };
    const onResize = () => setOpen(false); // stale positions are worse than no menu
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const toggleOne = (id: string) => {
    const next = new Set(props.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    props.onChange(next);
  };

  // Select-all toggles ONLY the rows visible under the active search filter.
  const toggleGroup = (rows: ConfigJson[]) => {
    const all = rows.every((r) => props.selected.has(r.id));
    const next = new Set(props.selected);
    for (const r of rows) {
      if (all) next.delete(r.id);
      else next.add(r.id);
    }
    props.onChange(next);
  };

  // REPLACES the selection with exactly the isDefault set (not a union).
  const applyDefaults = () => {
    props.onChange(new Set(props.configs.filter((c) => c.isDefault).map((c) => c.id)));
  };

  const toggleCollapse = (provider: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });
  };

  // Catalog order, not toggle order — the stable always-visible record.
  const selectedRows = props.configs.filter((c) => props.selected.has(c.id));

  return (
    <div className="cms">
      <div className="cms-trigger" ref={triggerRef}>
        <input
          type="text"
          className="cms-search"
          placeholder="Search configs…"
          value={query}
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)} // reopen on click when already focused
        />
        <button
          type="button"
          className="cms-defaults"
          title="Replace the selection with the curated default set"
          onClick={applyDefaults}
        >
          Defaults
        </button>
        <span className="cms-count">{props.selected.size} selected</span>
      </div>

      {open ? (
        <div
          ref={menuRef}
          className="cms-menu"
          style={
            menuPos
              ? { left: menuPos.left, top: menuPos.top, width: menuPos.width }
              : { left: -9999, top: -9999, visibility: "hidden" }
          }
        >
          {groups.length === 0 ? (
            <div className="cms-empty">No configs match “{q}”</div>
          ) : (
            groups.map((g) => {
              const total = g.rows.length;
              const selCount = g.rows.filter((r) => props.selected.has(r.id)).length;
              const all = total > 0 && selCount === total;
              const some = selCount > 0 && !all;
              // A non-empty query force-expands the remaining groups.
              const expanded = searching || !collapsed.has(g.provider);
              return (
                <div className="cms-group" key={g.provider}>
                  <div className="cms-group-header">
                    <button
                      type="button"
                      className="cms-group-toggle"
                      aria-expanded={expanded}
                      onClick={() => toggleCollapse(g.provider)}
                    >
                      <HarnessIcon harness={g.provider} plain />
                      <span className="cms-group-name">
                        {HARNESS_LABELS[g.provider] ?? g.provider}
                      </span>
                      <span className="cms-group-count">
                        {selCount}/{total}
                      </span>
                    </button>
                    <input
                      type="checkbox"
                      className="cms-group-all"
                      checked={all}
                      aria-label={`Select all visible ${HARNESS_LABELS[g.provider] ?? g.provider} configs`}
                      ref={(el) => {
                        // inline ref runs every render → indeterminate stays in sync
                        if (el) el.indeterminate = some;
                      }}
                      onChange={() => toggleGroup(g.rows)}
                    />
                    <button
                      type="button"
                      className="cms-chevron"
                      aria-label={expanded ? "Collapse group" : "Expand group"}
                      onClick={() => toggleCollapse(g.provider)}
                    >
                      {expanded ? "▾" : "▸"}
                    </button>
                  </div>
                  {expanded
                    ? g.rows.map((c) => (
                        <label className="cms-row" key={c.id}>
                          <input
                            type="checkbox"
                            checked={props.selected.has(c.id)}
                            onChange={() => toggleOne(c.id)}
                          />
                          <ConfigChip configId={c.id} />
                          {/* v7.6 §C5: dim raw id alongside the pretty chip
                              (judge model-menu convention) — disambiguates
                              configs that resolve to the same model name. */}
                          <span className="cms-row-id dim">{c.id}</span>
                        </label>
                      ))
                    : null}
                </div>
              );
            })
          )}
        </div>
      ) : null}

      <div className="cms-selected">
        {selectedRows.length === 0 ? (
          <span className="cms-selected-empty dim">No configs selected</span>
        ) : (
          selectedRows.map((c) => (
            <span className="cms-selected-chip" key={c.id}>
              <ConfigChip configId={c.id} />
              <button
                type="button"
                className="cms-chip-x"
                aria-label={`Remove ${c.id}`}
                onClick={() => toggleOne(c.id)}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>
    </div>
  );
}
