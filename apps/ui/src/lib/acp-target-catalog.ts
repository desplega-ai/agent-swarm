import type { AcpTarget } from "../api/types";

export interface AcpTargetCatalogEntry {
  id: AcpTarget;
  label: string;
  description: string;
  command?: string;
  args?: string[];
  envKeys: string[];
  knobs: Array<{ id: string; label: string; category: string }>;
}

/** Dashboard mirror of the worker catalog, guarded by acp-dashboard-runtime.test.ts. */
export const ACP_TARGET_CATALOG: readonly AcpTargetCatalogEntry[] = [
  {
    id: "opencode",
    label: "OpenCode",
    description: "OpenCode's ACP server, launched with `opencode acp`.",
    command: "opencode",
    args: ["acp"],
    envKeys: [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "OPENROUTER_BASE_URL",
      "GOOGLE_API_KEY",
      "GEMINI_API_KEY",
      "OPENCODE_CONFIG",
      "OPENCODE_CONFIG_CONTENT",
      "OPENCODE_CONFIG_DIR",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ],
    knobs: [{ id: "model", label: "Model", category: "model" }],
  },
  {
    id: "custom",
    label: "Custom",
    description: "An operator-supplied ACP command and explicit environment allowlist.",
    envKeys: [],
    knobs: [{ id: "model", label: "Model", category: "model" }],
  },
];
