export const ACP_TARGET_IDS = ["opencode", "gemini", "copilot", "custom"] as const;

export type AcpTarget = (typeof ACP_TARGET_IDS)[number];

export interface AcpTargetCatalogEntry {
  id: AcpTarget;
  label: string;
  description: string;
  command?: string;
  args?: string[];
  envKeys: string[];
  knobs: Array<{
    id: string;
    label: string;
    category: string;
  }>;
}

/**
 * Dashboard-safe metadata for the ACP targets supported by the worker.
 * Runtime-only fallback behavior remains in acp-targets.ts.
 */
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
    id: "gemini",
    label: "Gemini CLI",
    description: "Google's Gemini CLI, launched with `gemini --acp`.",
    command: "gemini",
    args: ["--acp"],
    envKeys: [
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_GENAI_USE_VERTEXAI",
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_CLOUD_LOCATION",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GOOGLE_GEMINI_BASE_URL",
      "GOOGLE_VERTEX_BASE_URL",
      "GEMINI_CLI_HOME",
    ],
    knobs: [{ id: "model", label: "Model", category: "model" }],
  },
  {
    id: "copilot",
    label: "GitHub Copilot CLI",
    description:
      "GitHub Copilot CLI's ACP server, launched with `copilot --acp`. Uses a Copilot-entitled COPILOT_GITHUB_TOKEN, or a BYOK provider via COPILOT_PROVIDER_*.",
    command: "copilot",
    args: ["--acp"],
    envKeys: [
      "COPILOT_GITHUB_TOKEN",
      "COPILOT_GH_HOST",
      "GH_HOST",
      "COPILOT_HOME",
      "COPILOT_MODEL",
      "COPILOT_AUTO_TIER",
      "COPILOT_OFFLINE",
      "COPILOT_PROVIDER_BASE_URL",
      "COPILOT_PROVIDER_TYPE",
      "COPILOT_PROVIDER_API_KEY",
      "COPILOT_PROVIDER_API_KEY_COMMAND",
      "COPILOT_PROVIDER_BEARER_TOKEN",
      "COPILOT_PROVIDER_WIRE_API",
      "COPILOT_PROVIDER_TRANSPORT",
      "COPILOT_PROVIDER_AZURE_API_VERSION",
      "COPILOT_PROVIDER_MODEL_ID",
      "COPILOT_PROVIDER_WIRE_MODEL",
      "COPILOT_PROVIDER_MAX_PROMPT_TOKENS",
      "COPILOT_PROVIDER_MAX_OUTPUT_TOKENS",
      "COPILOT_PROVIDER_HEADERS",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
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
] as const;

export function isAcpTarget(value: string): value is AcpTarget {
  return (ACP_TARGET_IDS as readonly string[]).includes(value);
}

export function getAcpTargetCatalogEntry(target: AcpTarget): AcpTargetCatalogEntry {
  return ACP_TARGET_CATALOG.find((entry) => entry.id === target)!;
}
