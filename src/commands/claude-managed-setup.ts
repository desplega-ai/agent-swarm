/**
 * `agent-swarm claude-managed-setup` — bootstrap the Anthropic-side managed
 * agent + environment + skills, then persist their IDs to `swarm_config` so
 * deployed workers can fetch them at boot.
 *
 * Mirrors the shape of `codex-login.ts`: non-UI command, plain stdout, exits
 * via `process.exit`. No Ink. Talks to the swarm API exclusively over HTTP
 * (NO direct DB access — the boundary check enforces this).
 *
 * Reference: thoughts/taras/plans/2026-04-28-claude-managed-agents-provider.md
 *   Phase 2 §1 — "Setup CLI command (NOT a standalone script)"
 *
 * SDK shape note: the plan's spec referred to `skill_id` / `content_md` field
 * names, but the actual `@anthropic-ai/sdk` `client.beta.skills.create`
 * accepts `{ display_title?, files: Array<Uploadable> }` and returns a
 * response object with `id` (the field used as `skill_id` when later
 * referencing the skill from an agent definition via
 * `BetaManagedAgentsCustomSkillParams`). The MCP-server param shape is
 * `{ name, type: "url", url }` — the SDK does NOT accept `http_headers`
 * here, so MCP auth is configured Anthropic-side via the dashboard / vault.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import Anthropic, { BadRequestError, ConflictError } from "@anthropic-ai/sdk";
import type {
  AgentCreateParams,
  BetaManagedAgentsAgent,
  BetaManagedAgentsCustomSkillParams,
  BetaManagedAgentsURLMCPServerParams,
} from "@anthropic-ai/sdk/resources/beta/agents";
import type { BetaEnvironment } from "@anthropic-ai/sdk/resources/beta/environments";
import type { SkillCreateResponse } from "@anthropic-ai/sdk/resources/beta/skills";
import { toFile } from "@anthropic-ai/sdk/uploads";

import { promptHiddenInput } from "./codex-login.js";

// ─── Types ───────────────────────────────────────────────────────────────────

type ParsedArgs = {
  apiUrl?: string;
  apiKey?: string;
  force: boolean;
  showHelp: boolean;
};

type SwarmConfigEntry = {
  id?: string;
  scope: string;
  scopeId?: string | null;
  key: string;
  value: string;
  isSecret?: boolean;
};

export type ClaudeManagedSetupResult = {
  agentId: string;
  environmentId: string;
  skillIds: string[];
  alreadyConfigured: boolean;
  mcpVaultId?: string | null;
};

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_AGENT_MODEL = "claude-sonnet-4-6";
const SKILLS_DIR_RELATIVE = "plugin/commands";
const SKILLS_BETA_HEADER = "skills-2025-10-02";

// Config keys persisted to `swarm_config`. The docker-entrypoint hydrates env
// vars from these on worker boot.
const CONFIG_KEY_AGENT_ID = "managed_agent_id";
const CONFIG_KEY_ENVIRONMENT_ID = "managed_environment_id";
const CONFIG_KEY_API_KEY = "anthropic_api_key";
const CONFIG_KEY_MCP_VAULT_ID = "managed_mcp_vault_id";

// Display name for the swarm-MCP vault. Used as the lookup key on rerun so the
// upsert is idempotent — there is intentionally only one MCP vault per
// installation, scoped to the configured `MCP_BASE_URL`.
const MCP_VAULT_DISPLAY_NAME = "swarm-mcp";

// ─── Arg parsing + help ──────────────────────────────────────────────────────

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { force: false, showHelp: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--api-url" && args[i + 1]) {
      parsed.apiUrl = args[++i]!;
    } else if (arg === "--api-key" && args[i + 1]) {
      parsed.apiKey = args[++i]!;
    } else if (arg === "--force") {
      parsed.force = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.showHelp = true;
    }
  }

  return parsed;
}

function printHelp(): void {
  console.log(`
agent-swarm claude-managed-setup — Bootstrap Anthropic Managed Agents for the swarm

Usage:
  agent-swarm claude-managed-setup [options]

Options:
  --api-url <url>    Swarm API URL (default: MCP_BASE_URL or http://localhost:3013)
  --api-key <key>    Swarm API key   (default: API_KEY or 123123)
  --force            Recreate agent + environment even if already configured
  -h, --help         Show this help

This command:
  1. Creates an Anthropic-side environment (cloud, unrestricted networking).
  2. Uploads each plugin/commands/*.md as a managed-agents skill (skips on 409).
  3. Creates a managed-agents agent referencing the uploaded skills + the
     swarm MCP server (MCP_BASE_URL/mcp).
  4. Persists the resulting IDs to swarm_config (managed_agent_id,
     managed_environment_id, anthropic_api_key) via PUT /api/config.

Required environment variables:
  ANTHROPIC_API_KEY   Anthropic API key (prompted with masked input if missing).
  MCP_BASE_URL        Public HTTPS URL where Anthropic can reach the swarm MCP.
                       MUST start with https:// — fail-fast otherwise.

Optional:
  MANAGED_AGENT_MODEL Default model for the managed agent (default: ${DEFAULT_AGENT_MODEL}).

Re-running the command is idempotent: if managed_agent_id is already set in
swarm_config it exits with a "already configured" message. Pass --force to
recreate the Anthropic-side resources.
`);
}

// ─── Swarm-API helpers (HTTP only — no DB imports) ───────────────────────────

function apiHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

async function fetchConfigByKey(
  apiUrl: string,
  apiKey: string,
  key: string,
): Promise<SwarmConfigEntry | null> {
  // The list endpoint doesn't filter by key server-side, but the resolved
  // endpoint returns merged global+agent+repo entries, which is what the
  // worker entrypoint also uses. We filter client-side.
  const res = await fetch(
    `${apiUrl}/api/config/resolved?includeSecrets=true&key=${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  if (!res.ok) return null;

  const data = (await res.json()) as { configs?: SwarmConfigEntry[] };
  const entry = data.configs?.find((c) => c.key === key);
  return entry ?? null;
}

async function upsertConfig(
  apiUrl: string,
  apiKey: string,
  entry: { key: string; value: string; isSecret?: boolean; description?: string },
): Promise<void> {
  const res = await fetch(`${apiUrl}/api/config`, {
    method: "PUT",
    headers: apiHeaders(apiKey),
    body: JSON.stringify({
      scope: "global",
      key: entry.key,
      value: entry.value,
      isSecret: entry.isSecret ?? false,
      description: entry.description ?? null,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to upsert ${entry.key}: HTTP ${res.status} ${text}`);
  }
}

// ─── Skills upload helpers ───────────────────────────────────────────────────

/**
 * Slug used as the skill's `display_title`. Mirrors the slugs that
 * `bun run build:pi-skills` generates for the worker-side filesystem layout.
 */
function skillSlugFromFilename(filename: string): string {
  return filename.replace(/\.md$/i, "");
}

async function loadSkillFiles(
  skillsDir: string,
): Promise<Array<{ slug: string; absPath: string; content: string }>> {
  const entries = await readdir(skillsDir);
  const mdEntries = entries.filter((f) => f.toLowerCase().endsWith(".md"));
  const out: Array<{ slug: string; absPath: string; content: string }> = [];
  for (const filename of mdEntries) {
    const absPath = path.join(skillsDir, filename);
    const content = await readFile(absPath, "utf8");
    out.push({ slug: skillSlugFromFilename(filename), absPath, content });
  }
  return out;
}

async function uploadSkill(
  client: Anthropic,
  slug: string,
  content: string,
  log: (msg: string) => void,
  existingByTitle?: Map<string, string>,
): Promise<string | null> {
  // The SDK's beta.skills.create expects { display_title?, files: Uploadable[] }
  // and the API requires a SKILL.md at the root of the upload's top-level
  // folder. We name the single file "<slug>/SKILL.md" so each
  // plugin/commands/*.md becomes one skill in its own top-level folder.
  if (existingByTitle?.has(slug)) {
    const id = existingByTitle.get(slug)!;
    log(`  · skill "${slug}" already exists — reusing id=${id}`);
    return id;
  }
  try {
    const file = await toFile(Buffer.from(content, "utf8"), `${slug}/SKILL.md`, {
      type: "text/markdown",
    });
    const res: SkillCreateResponse = await client.beta.skills.create({
      display_title: slug,
      files: [file],
      betas: [SKILLS_BETA_HEADER],
    });
    log(`  + uploaded skill "${slug}" (id=${res.id})`);
    return res.id;
  } catch (err) {
    // The API returns 400 (not 409) when display_title is reused. Both shapes
    // are treated as "already exists" — caller pre-fetched the skill list to
    // recover the id, but we may still race a concurrent upload. Surface the
    // raw error if we can't recover.
    const isDisplayTitleConflict =
      err instanceof BadRequestError &&
      typeof err.message === "string" &&
      err.message.includes("display_title");
    if (err instanceof ConflictError || isDisplayTitleConflict) {
      log(`  · skill "${slug}" already exists (server-side) — skipping`);
      return null;
    }
    throw err;
  }
}

// ─── MCP vault upsert ────────────────────────────────────────────────────────

/**
 * Find or create the swarm-MCP vault, then ensure a static-bearer credential
 * exists for `mcpServerUrl` with the given `bearerToken`. Returns the vault id.
 *
 * Idempotency rules:
 *   - Vault: matched by `display_name === MCP_VAULT_DISPLAY_NAME`. Only one
 *     should exist per Anthropic account; if you somehow have multiple, the
 *     most recently created one wins (sorted by `created_at`). On rerun, no
 *     new vault is created.
 *   - Credential: matched by `auth.type === "static_bearer"` AND
 *     `auth.mcp_server_url === mcpServerUrl` (the URL is immutable per the
 *     SDK type docstring, so a URL change requires a new credential).
 *     The token itself is never returned in API responses, so on rerun we
 *     update the existing credential's token only when `force=true` (matches
 *     the agent-recreate semantics of `--force`).
 *
 * Anthropic's managed sandbox refuses to call our `/mcp` endpoint until a
 * matching credential exists in a vault that the session is bound to via
 * `vault_ids`. Calling this function from the setup CLI is what closes the
 * loop without an out-of-band dashboard step.
 */
export async function upsertMcpVault(
  client: Anthropic,
  mcpServerUrl: string,
  bearerToken: string,
  force: boolean,
  log: (msg: string) => void,
): Promise<string> {
  // 1. Find an existing swarm-MCP vault by display name.
  let vaultId: string | null = null;
  let vaultExisted = false;
  try {
    let mostRecent: { id: string; created_at: string } | null = null;
    for await (const v of client.beta.vaults.list({})) {
      if (v.archived_at) continue;
      if (v.display_name !== MCP_VAULT_DISPLAY_NAME) continue;
      if (!mostRecent || v.created_at > mostRecent.created_at) {
        mostRecent = { id: v.id, created_at: v.created_at };
      }
    }
    if (mostRecent) {
      vaultId = mostRecent.id;
      vaultExisted = true;
      log(`  · vault "${MCP_VAULT_DISPLAY_NAME}" already exists — reusing id=${vaultId}`);
    }
  } catch (err) {
    log(`  · vault list failed (${(err as Error).message}); proceeding to create`);
  }

  // 2. Create the vault if it didn't exist.
  if (!vaultId) {
    const created = await client.beta.vaults.create({ display_name: MCP_VAULT_DISPLAY_NAME });
    vaultId = created.id;
    log(`  + created vault "${MCP_VAULT_DISPLAY_NAME}" id=${vaultId}`);
  }

  // 3. Find or create-or-update the static-bearer credential matching mcpServerUrl.
  let existingCredentialId: string | null = null;
  if (vaultExisted) {
    try {
      for await (const c of client.beta.vaults.credentials.list(vaultId)) {
        if (c.archived_at) continue;
        if (
          c.auth?.type === "static_bearer" &&
          (c.auth as { mcp_server_url?: string }).mcp_server_url === mcpServerUrl
        ) {
          existingCredentialId = c.id;
          break;
        }
      }
    } catch (err) {
      log(`  · credential list failed (${(err as Error).message}); proceeding to create`);
    }
  }

  if (existingCredentialId) {
    if (force) {
      await client.beta.vaults.credentials.update(existingCredentialId, {
        vault_id: vaultId,
        auth: { type: "static_bearer", token: bearerToken },
      });
      log(`  + rotated credential token (--force) id=${existingCredentialId}`);
    } else {
      log(`  · credential for ${mcpServerUrl} already exists — leaving token alone`);
    }
  } else {
    const cred = await client.beta.vaults.credentials.create(vaultId, {
      auth: {
        type: "static_bearer",
        token: bearerToken,
        mcp_server_url: mcpServerUrl,
      },
    });
    log(`  + added static-bearer credential id=${cred.id} for ${mcpServerUrl}`);
  }

  return vaultId;
}

// ─── Validation helpers ──────────────────────────────────────────────────────

function validateMcpBaseUrl(mcpBaseUrl: string | undefined): string {
  if (!mcpBaseUrl || mcpBaseUrl.length === 0) {
    throw new Error(
      "MCP_BASE_URL is not set. Anthropic's managed sandboxes need a public HTTPS URL " +
        "to reach the swarm MCP server. Set MCP_BASE_URL=https://… in your .env or shell.",
    );
  }
  if (!mcpBaseUrl.startsWith("https://")) {
    throw new Error(
      `MCP_BASE_URL must start with https:// (got: ${mcpBaseUrl}). ` +
        "Anthropic's managed agents only connect to HTTPS MCP endpoints. ",
    );
  }
  return mcpBaseUrl;
}

// ─── Resolve config (defaults + prompts) ────────────────────────────────────

export async function resolveClaudeManagedSetupConfig(
  args: string[],
  deps: {
    env?: Record<string, string | undefined>;
    isInteractive?: boolean;
    promptSecret?: typeof promptHiddenInput;
  } = {},
): Promise<{
  apiUrl: string;
  apiKey: string;
  anthropicApiKey: string;
  mcpBaseUrl: string;
  agentModel: string;
  force: boolean;
  disableMcp: boolean;
}> {
  const env = deps.env ?? process.env;
  const parsed = parseArgs(args);
  const promptSecret = deps.promptSecret ?? promptHiddenInput;
  const isInteractive = deps.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);

  const apiUrl = parsed.apiUrl ?? env.MCP_BASE_URL ?? "http://localhost:3013";
  const apiKey = parsed.apiKey ?? env.API_KEY ?? "123123";

  let anthropicApiKey = env.ANTHROPIC_API_KEY ?? "";
  if (!anthropicApiKey && isInteractive) {
    anthropicApiKey = (
      await promptSecret(
        "Anthropic API key",
        "",
        "Paste your sk-ant-... key (input is hidden). Stored encrypted in swarm_config.",
      )
    ).trim();
  }
  if (!anthropicApiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is required. Either export it before running, or run interactively.",
    );
  }

  const mcpBaseUrl = validateMcpBaseUrl(env.MCP_BASE_URL);
  const agentModel = env.MANAGED_AGENT_MODEL ?? DEFAULT_AGENT_MODEL;
  const disableMcp = env.MANAGED_DISABLE_MCP === "1" || env.MANAGED_DISABLE_MCP === "true";

  return {
    apiUrl,
    apiKey,
    anthropicApiKey,
    mcpBaseUrl,
    agentModel,
    force: parsed.force,
    disableMcp,
  };
}

// ─── Core flow (testable) ────────────────────────────────────────────────────

export type RunClaudeManagedSetupDeps = {
  client?: Anthropic;
  fetchConfig?: typeof fetchConfigByKey;
  upsert?: typeof upsertConfig;
  loadSkills?: typeof loadSkillFiles;
  uploadOne?: typeof uploadSkill;
  skillsDir?: string;
  log?: (msg: string) => void;
};

export async function runClaudeManagedSetupFlow(
  config: {
    apiUrl: string;
    apiKey: string;
    anthropicApiKey: string;
    mcpBaseUrl: string;
    agentModel: string;
    force: boolean;
    disableMcp?: boolean;
  },
  deps: RunClaudeManagedSetupDeps = {},
): Promise<ClaudeManagedSetupResult> {
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const fetchCfg = deps.fetchConfig ?? fetchConfigByKey;
  const upsert = deps.upsert ?? upsertConfig;
  const loadSkills = deps.loadSkills ?? loadSkillFiles;
  const uploadOne = deps.uploadOne ?? uploadSkill;
  const skillsDir = deps.skillsDir ?? path.resolve(process.cwd(), SKILLS_DIR_RELATIVE);

  // Idempotency check: if an agent ID is already persisted, short-circuit
  // unless --force was passed.
  if (!config.force) {
    const existing = await fetchCfg(config.apiUrl, config.apiKey, CONFIG_KEY_AGENT_ID);
    if (existing?.value) {
      const existingEnv = await fetchCfg(config.apiUrl, config.apiKey, CONFIG_KEY_ENVIRONMENT_ID);
      log(
        `claude-managed already configured (managed_agent_id=${existing.value}). ` +
          "Re-run with --force to recreate.",
      );
      return {
        agentId: existing.value,
        environmentId: existingEnv?.value ?? "",
        skillIds: [],
        alreadyConfigured: true,
      };
    }
  }

  const client = deps.client ?? new Anthropic({ apiKey: config.anthropicApiKey });

  // 1. Create the environment.
  log("Creating Anthropic-side environment (swarm-worker-env)...");
  const env: BetaEnvironment = await client.beta.environments.create({
    name: "swarm-worker-env",
    config: {
      type: "cloud",
      networking: { type: "unrestricted" },
    },
  });
  log(`  + environment id=${env.id}`);

  // 2. Upload skills.
  log(`Uploading skills from ${skillsDir} ...`);
  const skillFiles = await loadSkills(skillsDir);
  log(`  found ${skillFiles.length} skill markdown file(s)`);
  // Pre-fetch existing custom skills so we can reuse their IDs on rerun. The
  // API returns 400 (not 409) on display_title collision and skill IDs aren't
  // surfaced from that error, so the only recovery is to look them up.
  const existingByTitle = new Map<string, string>();
  try {
    for await (const sk of client.beta.skills.list({
      source: "custom",
      betas: [SKILLS_BETA_HEADER],
    })) {
      if (sk.display_title) existingByTitle.set(sk.display_title, sk.id);
    }
  } catch (err) {
    log(`  · could not list existing skills (${(err as Error).message}); proceeding anyway`);
  }
  const skillIds: string[] = [];
  let reused = 0;
  let created = 0;
  for (const skill of skillFiles) {
    const wasExisting = existingByTitle.has(skill.slug);
    const id = await uploadOne(client, skill.slug, skill.content, log, existingByTitle);
    if (id) {
      skillIds.push(id);
      if (wasExisting) reused++;
      else created++;
    }
  }
  log(`  reused ${reused} existing skill(s); uploaded ${created} new skill(s)`);

  // 3. Create the agent.
  //
  // NOTE: Anthropic's managed-agents `mcp_servers` URL params don't accept
  // inline auth — credentials must live in an Anthropic-side vault keyed by
  // `mcp_server_url`. Until the setup CLI auto-provisions that vault (see
  // follow-up ticket — `MANAGED_DISABLE_MCP=1` is the temporary bypass), the
  // agent must be created WITHOUT mcp_servers / mcp_toolset, otherwise every
  // session errors out with `mcp_authentication_failed_error`.
  const mcpDisabled = config.disableMcp;
  const mcpServer: BetaManagedAgentsURLMCPServerParams | null = mcpDisabled
    ? null
    : {
        name: "agent-swarm",
        type: "url",
        url: `${config.mcpBaseUrl.replace(/\/$/, "")}/mcp`,
      };
  const skillsParam: BetaManagedAgentsCustomSkillParams[] = skillIds.map((id) => ({
    type: "custom",
    skill_id: id,
  }));
  const agentParams: AgentCreateParams = {
    name: "swarm-worker",
    model: config.agentModel,
    description:
      "Agent Swarm worker. Per-task system prompt is delivered in the user.message; the static system field is intentionally minimal.",
    system: mcpServer
      ? "You are an agent-swarm worker. Per-task instructions arrive in the next user message. Use the agent-swarm MCP server for swarm operations."
      : "You are an agent-swarm worker. Per-task instructions arrive in the next user message. (No MCP tools available in this configuration.)",
    tools: mcpServer
      ? [
          { type: "agent_toolset_20260401" },
          { type: "mcp_toolset", mcp_server_name: mcpServer.name },
        ]
      : [{ type: "agent_toolset_20260401" }],
    skills: skillsParam,
    ...(mcpServer ? { mcp_servers: [mcpServer] } : {}),
  };
  if (mcpDisabled) {
    log("MCP disabled (MANAGED_DISABLE_MCP=1) — agent will run without swarm tools.");
  }

  log(`Creating agent (model=${config.agentModel}) ...`);
  const agent: BetaManagedAgentsAgent = await client.beta.agents.create(agentParams);
  log(`  + agent id=${agent.id}`);

  // 3b. Upsert MCP vault + static-bearer credential when MCP is enabled.
  // Anthropic's managed sandbox refuses to call our `/mcp` endpoint until a
  // matching vault credential exists. Without this step the operator would
  // have to configure the vault manually via the Anthropic dashboard — see
  // DES-279 in the QA report (`thoughts/taras/qa/2026-04-29-…`) for context.
  let mcpVaultId: string | null = null;
  if (mcpServer) {
    log("Upserting Anthropic MCP vault + static-bearer credential ...");
    try {
      mcpVaultId = await upsertMcpVault(client, mcpServer.url, config.apiKey, config.force, log);
    } catch (err) {
      log(`  · MCP vault upsert failed: ${(err as Error).message}`);
      log(
        "  · The agent was created but MCP tool calls will fail with " +
          "`mcp_authentication_failed_error` until a vault credential exists. " +
          "Re-run with --force, or configure the vault manually via the Anthropic dashboard.",
      );
    }
  }

  // 4. Persist IDs to swarm_config.
  log("Persisting IDs to swarm_config via PUT /api/config ...");
  await upsert(config.apiUrl, config.apiKey, {
    key: CONFIG_KEY_AGENT_ID,
    value: agent.id,
    isSecret: false,
    description: "Anthropic Managed Agents agent ID (claude-managed-setup)",
  });
  await upsert(config.apiUrl, config.apiKey, {
    key: CONFIG_KEY_ENVIRONMENT_ID,
    value: env.id,
    isSecret: false,
    description: "Anthropic Managed Agents environment ID (claude-managed-setup)",
  });
  await upsert(config.apiUrl, config.apiKey, {
    key: CONFIG_KEY_API_KEY,
    value: config.anthropicApiKey,
    isSecret: true,
    description: "Anthropic API key for claude-managed provider",
  });
  if (mcpVaultId) {
    await upsert(config.apiUrl, config.apiKey, {
      key: CONFIG_KEY_MCP_VAULT_ID,
      value: mcpVaultId,
      isSecret: false,
      description:
        "Anthropic vault id holding the static-bearer credential for the swarm MCP server",
    });
    log(
      `  + persisted managed_agent_id, managed_environment_id, anthropic_api_key, managed_mcp_vault_id`,
    );
  } else {
    log("  + persisted managed_agent_id, managed_environment_id, anthropic_api_key");
  }

  log("");
  log("Done. Add the following to your .env if you prefer env-based config:");
  log(`  HARNESS_PROVIDER=claude-managed`);
  log(`  ANTHROPIC_API_KEY=<the key you just provided>`);
  log(`  MANAGED_AGENT_ID=${agent.id}`);
  log(`  MANAGED_ENVIRONMENT_ID=${env.id}`);
  if (mcpVaultId) log(`  MANAGED_MCP_VAULT_ID=${mcpVaultId}`);
  log("");
  log(
    "Or skip the .env entries — deployed workers automatically restore these from " +
      "swarm_config at boot via docker-entrypoint.sh.",
  );

  return {
    agentId: agent.id,
    environmentId: env.id,
    skillIds,
    alreadyConfigured: false,
    mcpVaultId,
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export type RunClaudeManagedSetupDepsRoot = {
  resolveConfig?: typeof resolveClaudeManagedSetupConfig;
  flow?: typeof runClaudeManagedSetupFlow;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  exit?: (code: number) => void;
};

export async function runClaudeManagedSetup(
  args: string[],
  deps: RunClaudeManagedSetupDepsRoot = {},
): Promise<void> {
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const error = deps.error ?? ((msg: string) => console.error(msg));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const resolveConfig = deps.resolveConfig ?? resolveClaudeManagedSetupConfig;
  const flow = deps.flow ?? runClaudeManagedSetupFlow;

  if (parseArgs(args).showHelp) {
    printHelp();
    return;
  }

  try {
    const config = await resolveConfig(args);
    log(`Target swarm API: ${config.apiUrl}`);
    log(`MCP base URL    : ${config.mcpBaseUrl}`);
    log(`Agent model     : ${config.agentModel}`);
    log("");
    await flow(config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error(`\n[claude-managed-setup] ${message}`);
    exit(1);
  }
}
