/**
 * The `ui.toast` action, shared by the swarm-apps runtime and the DB-backed
 * pages renderer.
 *
 * The Undo button runs `undo.actions` long after the dispatching component
 * finished, so it cannot go back through `ActionProvider.execute`. It calls
 * the surface's own handler map instead, read through `getHandlers` at press
 * time: `ActionProvider` snapshots its `handlers` prop at mount, and both
 * surfaces build that map once.
 *
 * Params arrive with top-level `$state` already resolved by `ActionProvider`;
 * the nested undo params are resolved here, against the state at the moment
 * Undo is pressed. `$row` / `$form` were resolved by Table / Form before the
 * toast step was dispatched.
 */

import { toast } from "sonner";
import { resolveScopedParams } from "./action-params";
import type { ActionChain, UiToastParams } from "./catalog";

export type ActionHandlerMap = Record<
  string,
  (params: Record<string, unknown>) => Promise<unknown> | unknown
>;

export interface ToastActionDeps {
  /** The surface's live handler map; null until it is built. */
  getHandlers: () => ActionHandlerMap | null;
  /** State snapshot for `$state` reads inside the undo params. */
  getState?: () => Record<string, unknown>;
  /** Where an undo step that has no handler reports. */
  onError: (message: string) => void;
}

const SHOW_BY_TONE = {
  success: toast.success,
  error: toast.error,
  warning: toast.warning,
  info: toast.info,
} as const;

/** Runs a chain step by step through the handler map, stopping at a missing handler. */
export async function runChainThroughHandlers(
  chain: ActionChain,
  deps: ToastActionDeps,
): Promise<void> {
  for (const step of chain) {
    const handler = deps.getHandlers()?.[step.action];
    if (!handler) {
      deps.onError(`Undo failed: action "${step.action}" is not available here`);
      return;
    }
    await handler(resolveScopedParams(step.params, { state: deps.getState?.() }));
  }
}

export function createToastActionHandler(deps: ToastActionDeps) {
  return {
    "ui.toast": async (params: UiToastParams | undefined) => {
      if (!params?.message) return;
      const show = SHOW_BY_TONE[params.tone ?? "info"] ?? toast.info;
      const undo = params.undo;
      const undoChain = undo && Array.isArray(undo.actions) ? undo.actions : [];
      show(params.message, {
        description: params.description,
        action:
          undoChain.length > 0
            ? {
                label: undo?.label ?? "Undo",
                onClick: () => {
                  void runChainThroughHandlers(undoChain, deps).catch((error: unknown) =>
                    deps.onError(error instanceof Error ? error.message : String(error)),
                  );
                },
              }
            : undefined,
      });
    },
  };
}
