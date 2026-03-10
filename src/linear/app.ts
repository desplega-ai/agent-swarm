/**
 * Linear integration initialization — follows the same pattern as src/github/app.ts.
 *
 * Provides `isLinearEnabled()`, `initLinear()`, and `resetLinear()`.
 */

let initialized = false;

/**
 * Check if the Linear integration is enabled.
 * Requires `LINEAR_CLIENT_ID` to be set and `LINEAR_DISABLE` to not be "true".
 */
export function isLinearEnabled(): boolean {
  const disabled = process.env.LINEAR_DISABLE;
  if (disabled === "true" || disabled === "1") {
    return false;
  }
  // Also honour the LINEAR_ENABLED flag (defaults to enabled if not set)
  const enabled = process.env.LINEAR_ENABLED;
  if (enabled === "false" || enabled === "0") {
    return false;
  }
  return !!process.env.LINEAR_CLIENT_ID;
}

/**
 * Reset state so `initLinear()` can be called again after config reload.
 */
export function resetLinear(): void {
  initialized = false;
}

/**
 * Initialise the Linear integration. Idempotent — safe to call multiple times.
 * Returns `true` if the integration is enabled and ready.
 */
export function initLinear(): boolean {
  if (initialized) {
    return isLinearEnabled();
  }
  initialized = true;

  if (!isLinearEnabled()) {
    console.log("[Linear] Integration disabled or LINEAR_CLIENT_ID not set");
    return false;
  }

  const hasSecret = !!process.env.LINEAR_CLIENT_SECRET;
  const hasRedirect = !!process.env.LINEAR_REDIRECT_URI;

  if (!hasSecret || !hasRedirect) {
    console.log(
      "[Linear] Missing LINEAR_CLIENT_SECRET or LINEAR_REDIRECT_URI — OAuth flow will not work until configured",
    );
  }

  console.log("[Linear] Integration initialized");
  return true;
}
