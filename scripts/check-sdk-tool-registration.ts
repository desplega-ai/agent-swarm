#!/usr/bin/env bun
/**
 * CI check: every MCP tool in ALL_TOOLS must be either registered in
 * SDK_TOOL_NAME_MAP (exposed to swarm-scripts) or explicitly excluded below.
 *
 * When you add a new MCP tool, this script forces you to decide:
 *   1. Add it to SDK_TOOL_NAME_MAP in src/scripts-runtime/sdk-allowlist.ts, OR
 *   2. Add it to EXCLUDED_TOOLS below with a reason.
 *
 * Modelled on scripts/check-db-boundary.sh.
 */

import { SDK_TOOL_NAME_MAP } from "../src/scripts-runtime/sdk-allowlist";
import { ALL_TOOLS } from "../src/tools/tool-config";

// Tools intentionally NOT exposed to the scripts SDK.
// Each entry must have a reason — reviewers will check.
const EXCLUDED_TOOLS: Record<string, string> = {
  "create-channel": "channel management — admin lifecycle, not script-relevant",
  "delete-channel": "channel management — admin lifecycle, not script-relevant",
  "list-channels": "channel management — admin lifecycle, not script-relevant",
  "register-agentmail-inbox": "integration lifecycle — one-time setup, not script-relevant",
  "register-kapso-number": "integration lifecycle — one-time setup, not script-relevant",
  "unregister-kapso-number": "integration lifecycle — one-time setup, not script-relevant",
  "send-whatsapp-message": "external messaging — not yet exposed to scripts",
  "reply-whatsapp-message": "external messaging — not yet exposed to scripts",
  "get-oauth-access-token": "credential management — security-sensitive, not for scripts",
  "credential-bindings": "credential binding management — lead-only security control, not for scripts",
  "script-connections": "script connection registration — lead-only security control, not for scripts",
  "script-apis": "external API endpoint management (bearer tokens) — security-sensitive, not for scripts to self-administer",
  "skill-install-remote": "admin-only remote skill management",
  "skill-sync-remote": "admin-only remote skill management",
  "swarm_x": "external command router — dispatches to third-party services",
};

const sdkToolNames = new Set(Object.values(SDK_TOOL_NAME_MAP));
const excludedNames = new Set(Object.keys(EXCLUDED_TOOLS));

const unregistered: string[] = [];
for (const tool of ALL_TOOLS) {
  if (!sdkToolNames.has(tool) && !excludedNames.has(tool)) {
    unregistered.push(tool);
  }
}

const staleExclusions: string[] = [];
for (const tool of excludedNames) {
  if (!ALL_TOOLS.has(tool)) {
    staleExclusions.push(tool);
  }
}

let failed = false;

if (unregistered.length > 0) {
  failed = true;
  console.error("ERROR: MCP tools not registered in the scripts SDK!\n");
  console.error(
    "The following tools are in ALL_TOOLS (src/tools/tool-config.ts) but are",
  );
  console.error(
    "neither in SDK_TOOL_NAME_MAP (src/scripts-runtime/sdk-allowlist.ts)",
  );
  console.error(
    "nor in EXCLUDED_TOOLS (scripts/check-sdk-tool-registration.ts):\n",
  );
  for (const t of unregistered.sort()) {
    console.error(`  - ${t}`);
  }
  console.error(
    "\nFix: add each tool to SDK_TOOL_NAME_MAP (to expose it to scripts)",
  );
  console.error(
    "or to EXCLUDED_TOOLS in this file (with a reason why it's excluded).",
  );
}

if (staleExclusions.length > 0) {
  failed = true;
  console.error("\nWARNING: Stale entries in EXCLUDED_TOOLS:\n");
  for (const t of staleExclusions.sort()) {
    console.error(`  - ${t} (not in ALL_TOOLS — was it removed or renamed?)`);
  }
  console.error("\nFix: remove stale entries from EXCLUDED_TOOLS.");
}

if (failed) {
  process.exit(1);
}

console.log(
  `SDK tool registration check passed (${sdkToolNames.size} registered, ${excludedNames.size} excluded, ${ALL_TOOLS.size} total).`,
);
