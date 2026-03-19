import { upsertOAuthApp } from "../be/db-queries/oauth";
import { initLinearOutboundSync, teardownLinearOutboundSync } from "./outbound";

let initialized = false;

export function isLinearEnabled(): boolean {
  const disabled = process.env.LINEAR_DISABLE;
  if (disabled === "true" || disabled === "1") return false;
  const enabled = process.env.LINEAR_ENABLED;
  if (enabled === "false" || enabled === "0") return false;
  return !!process.env.LINEAR_CLIENT_ID;
}

export function resetLinear(): void {
  teardownLinearOutboundSync();
  initialized = false;
}

export function initLinear(): boolean {
  if (initialized) return isLinearEnabled();
  initialized = true;

  if (!isLinearEnabled()) {
    console.log("[Linear] Integration disabled or LINEAR_CLIENT_ID not set");
    return false;
  }

  const clientId = process.env.LINEAR_CLIENT_ID!;
  const clientSecret = process.env.LINEAR_CLIENT_SECRET ?? "";
  const redirectUri =
    process.env.LINEAR_REDIRECT_URI ?? "http://localhost:3013/api/trackers/linear/callback";

  upsertOAuthApp("linear", {
    clientId,
    clientSecret,
    authorizeUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    redirectUri,
    scopes: "read,write,issues:create,comments:create,app:assignable,app:mentionable",
    metadata: JSON.stringify({ actor: "app" }),
  });

  initLinearOutboundSync();

  console.log("[Linear] Integration initialized");
  return true;
}
