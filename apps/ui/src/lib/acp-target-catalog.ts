import { openAICompatibleBaseUrlVars, openAICompatibleKeyVars } from "@desplega/model-catalog";
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
      // OpenAI-compatible registry providers: keys (canonical and alias),
      // then their `<ID>_BASE_URL` overrides.
      ...openAICompatibleKeyVars(),
      ...openAICompatibleBaseUrlVars(),
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
    id: "qwen",
    label: "Qwen Code",
    description:
      "Qwen Code's ACP server, launched with `qwen --acp`. Authenticates with an OpenAI-compatible key (OPENAI_API_KEY, OPENAI_BASE_URL) unless QWEN_AUTH_TYPE selects another provider.",
    command: "qwen",
    args: ["--acp"],
    envKeys: [
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "OPENAI_MODEL",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_MODEL",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GEMINI_MODEL",
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_CLOUD_LOCATION",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "DASHSCOPE_API_KEY",
      "QWEN_HOME",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
    ],
    knobs: [{ id: "model", label: "Model", category: "model" }],
  },
  {
    id: "kiro",
    label: "Kiro CLI",
    description:
      "Kiro CLI's ACP server, launched with `kiro-cli acp`. Needs a KIRO_API_KEY, which only paid Kiro plans can create.",
    command: "kiro-cli",
    args: ["acp"],
    envKeys: ["KIRO_API_KEY", "KIRO_HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"],
    knobs: [{ id: "model", label: "Model", category: "model" }],
  },
  {
    id: "goose",
    label: "Goose",
    description:
      "Goose's ACP server, launched with `goose acp`. Set GOOSE_PROVIDER and that provider's API key.",
    command: "goose",
    args: ["acp"],
    envKeys: [
      "GOOSE_PROVIDER",
      "GOOSE_MODEL",
      "GOOSE_MODE",
      "GOOSE_TEMPERATURE",
      "OPENAI_API_KEY",
      "OPENAI_HOST",
      "OPENAI_BASE_PATH",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_HOST",
      "OPENROUTER_API_KEY",
      "OPENROUTER_HOST",
      "GOOGLE_API_KEY",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
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
];
