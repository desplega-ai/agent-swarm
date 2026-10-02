import type { RouteProvider } from "../types.ts";
import { anthropicProvider } from "./anthropic.ts";
import { anthropicGatewayProvider } from "./anthropic-gateway.ts";
import { bedrockProvider } from "./bedrock.ts";
import { claudeSubscriptionProvider } from "./claude-subscription.ts";
import { foundryProvider } from "./foundry.ts";
import { vertexProvider } from "./vertex.ts";

export const ROUTE_PROVIDERS: readonly RouteProvider[] = [
  anthropicProvider,
  claudeSubscriptionProvider,
  anthropicGatewayProvider,
  foundryProvider,
  bedrockProvider,
  vertexProvider,
];

export function getRouteProvider(id: string): RouteProvider | undefined {
  return ROUTE_PROVIDERS.find((p) => p.id === id);
}
