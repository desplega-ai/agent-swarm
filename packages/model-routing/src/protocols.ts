import type { Protocol, RoutableHarness, RouteProvider } from "./types.ts";

/** The protocol each harness speaks without a provider block. */
export const HARNESS_DEFAULT_PROTOCOL: Readonly<Record<RoutableHarness, Protocol>> = {
  claude: "anthropic-messages",
  codex: "openai-responses",
  pi: "openai-chat",
  opencode: "openai-chat",
  dsh: "openai-chat",
};

export function isRoutableHarness(harness: string): harness is RoutableHarness {
  return Object.hasOwn(HARNESS_DEFAULT_PROTOCOL, harness);
}

export function defineRouteProvider(
  p: Omit<RouteProvider, "isHarnessDefaultProtocol"> &
    Partial<Pick<RouteProvider, "isHarnessDefaultProtocol">>,
): RouteProvider {
  return {
    ...p,
    isHarnessDefaultProtocol:
      p.isHarnessDefaultProtocol ??
      ((harness, protocol) => HARNESS_DEFAULT_PROTOCOL[harness] === protocol),
  };
}
