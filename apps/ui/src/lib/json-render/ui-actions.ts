/**
 * `ui.set`, `ui.focus` and `ui.when`: the page-local action steps behind the
 * low-level primitives (`Input`, expressions, page `state`).
 */

import type { StateStore } from "@json-render/core";
import { ChainHaltError } from "./chain-halt";

/** A writable page-local path: `/local/<name>` or below, no prototype keys. */
const LOCAL_PATH = /^\/local(\/[^/]+)+$/;
const UNSAFE_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

export function isLocalStatePath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    LOCAL_PATH.test(path) &&
    !path.split("/").some((segment) => UNSAFE_SEGMENTS.has(segment))
  );
}

/** Focus targets keyed by `Input` id plus repeat index. */
export interface FocusRegistry {
  register: (id: string, index: number | undefined, element: HTMLElement) => () => void;
  focus: (id: string, index?: number) => boolean;
}

const focusKey = (id: string, index: number | undefined) =>
  index === undefined ? id : `${id}#${index}`;

export function createFocusRegistry(): FocusRegistry {
  const elements = new Map<string, HTMLElement>();
  return {
    register: (id, index, element) => {
      const key = focusKey(id, index);
      elements.set(key, element);
      return () => {
        if (elements.get(key) === element) elements.delete(key);
      };
    },
    focus: (id, index) => {
      const element = elements.get(focusKey(id, index));
      element?.focus();
      return element !== undefined;
    },
  };
}

/** Quiet halt: `installChainHaltGuard` swallows it and nothing is reported. */
class ChainSkip extends ChainHaltError {}

export function createUiActionHandlers(deps: {
  getStore: () => Pick<StateStore, "set">;
  focus: FocusRegistry;
  onError: (message: string) => void;
}) {
  return {
    "ui.set": async (params: Record<string, unknown> | undefined) => {
      if (!isLocalStatePath(params?.path)) {
        deps.onError(
          `ui.set can only write /local/<name> paths (got ${JSON.stringify(params?.path)})`,
        );
        throw new ChainSkip("ui.set path rejected");
      }
      deps.getStore().set(params.path, params.value);
    },
    "ui.focus": async (params: Record<string, unknown> | undefined) => {
      if (typeof params?.id !== "string") return;
      const index = typeof params.index === "number" ? params.index : undefined;
      deps.focus.focus(params.id, index);
    },
    "ui.when": async (params: Record<string, unknown> | undefined) => {
      const pass = params && "eq" in params ? params.value === params.eq : Boolean(params?.value);
      if (!pass) throw new ChainSkip("ui.when");
    },
  };
}
