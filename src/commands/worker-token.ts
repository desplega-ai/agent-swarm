/**
 * `agent-swarm worker-token create|rotate|revoke`: manage the agent-bound
 * token a worker runs on in place of the swarm API key.
 *
 * Operator-run. It authenticates with the operator's own swarm API key and
 * talks to the API over HTTP only. The new token goes to stdout, once, so it
 * can be captured (`API_KEY=$(agent-swarm worker-token create --name w1)`);
 * everything else goes to stderr.
 */
import { getApiKey } from "../utils/api-key";

type Action = "create" | "rotate" | "revoke";

export type WorkerTokenArgs = {
  action?: Action;
  agentId?: string;
  name?: string;
  apiUrl?: string;
  apiKey?: string;
  ttlDays?: number;
  graceSec?: number;
  showHelp: boolean;
  error?: string;
};

export const WORKER_TOKEN_USAGE = `Usage:
  agent-swarm worker-token <create|rotate|revoke> (--agent-id <id> | --name <name>) [options]

Options:
  --agent-id <id>     Agent the token is bound to
  --name <name>       Agent name. create makes the agent when no agent has this name
  --ttl-days <n>      Token lifetime (create, rotate). Default: no expiry
  --grace-sec <n>     How long the old token keeps working after rotate (default 300)
  --api-url <url>     Swarm API URL (default: MCP_BASE_URL or http://localhost:3013)
  --api-key <key>     Operator swarm API key (default: AGENT_SWARM_API_KEY or API_KEY, falling back to 123123)
  -h, --help          Show this help`;

const ACTIONS = new Set<string>(["create", "rotate", "revoke"]);

export function parseWorkerTokenArgs(args: string[]): WorkerTokenArgs {
  const parsed: WorkerTokenArgs = { showHelp: false };
  const number = (flag: string, value: string | undefined, min: number) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min) parsed.error = `${flag} must be an integer >= ${min}`;
    return n;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") parsed.showHelp = true;
    else if (arg === "--agent-id") parsed.agentId = args[++i];
    else if (arg === "--name") parsed.name = args[++i];
    else if (arg === "--api-url") parsed.apiUrl = args[++i];
    else if (arg === "--api-key") parsed.apiKey = args[++i];
    else if (arg === "--ttl-days") parsed.ttlDays = number(arg, args[++i], 1);
    else if (arg === "--grace-sec") parsed.graceSec = number(arg, args[++i], 0);
    else if (!parsed.action && ACTIONS.has(arg)) parsed.action = arg as Action;
    else parsed.error = `Unknown argument: ${arg}`;
  }
  if (parsed.error || parsed.showHelp) return parsed;
  if (!parsed.action) parsed.error = "Missing action: create, rotate, or revoke";
  else if (!parsed.agentId === !parsed.name)
    parsed.error = "Pass exactly one of --agent-id or --name";
  return parsed;
}

type Deps = {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
};

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    return (JSON.parse(text) as { error?: string }).error ?? text;
  } catch {
    return text;
  }
}

/** Runs the command. Returns the process exit code. */
export async function runWorkerToken(args: string[], deps: Deps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetch ?? fetch;
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  const parsed = parseWorkerTokenArgs(args);
  if (parsed.showHelp) {
    stdout(WORKER_TOKEN_USAGE);
    return 0;
  }
  if (parsed.error) {
    stderr(`${parsed.error}\n\n${WORKER_TOKEN_USAGE}`);
    return 1;
  }

  const apiUrl = (parsed.apiUrl ?? env.MCP_BASE_URL ?? "http://localhost:3013").replace(/\/+$/, "");
  const apiKey = parsed.apiKey ?? (getApiKey(env) || "123123");
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  let agentId = parsed.agentId;
  let name: string | undefined;
  if (!agentId) {
    const res = await doFetch(`${apiUrl}/api/agents`, { headers });
    if (!res.ok) {
      stderr(`Listing agents failed (${res.status}): ${await readError(res)}`);
      return 1;
    }
    const { agents } = (await res.json()) as { agents: { id: string; name: string }[] };
    const matches = agents.filter((agent) => agent.name === parsed.name);
    if (matches.length > 1) {
      stderr(`Several agents are named "${parsed.name}"; pass --agent-id instead`);
      return 1;
    }
    agentId = matches[0]?.id;
    if (!agentId) {
      if (parsed.action !== "create") {
        stderr(`No agent is named "${parsed.name}"`);
        return 1;
      }
      agentId = crypto.randomUUID();
      name = parsed.name;
    }
  }

  const base = `${apiUrl}/api/agents/${encodeURIComponent(agentId)}/token`;
  const ttlMs = parsed.ttlDays === undefined ? undefined : parsed.ttlDays * 86_400_000;
  const res =
    parsed.action === "revoke"
      ? await doFetch(base, { method: "DELETE", headers })
      : await doFetch(parsed.action === "rotate" ? `${base}/rotate` : base, {
          method: "POST",
          headers,
          body: JSON.stringify(
            parsed.action === "rotate" ? { graceSec: parsed.graceSec, ttlMs } : { name, ttlMs },
          ),
        });
  if (!res.ok) {
    stderr(`worker-token ${parsed.action} failed (${res.status}): ${await readError(res)}`);
    return 1;
  }

  if (parsed.action === "revoke") {
    const { revoked } = (await res.json()) as { revoked: number };
    stderr(`Revoked ${revoked} worker token(s) of agent ${agentId}.`);
    return 0;
  }
  const token = (await res.json()) as {
    plaintext: string;
    expiresAt: string | null;
    agentCreated?: boolean;
    previousExpiresAt?: string;
  };
  if (token.agentCreated) stderr(`Created agent ${agentId} (${name}).`);
  stderr(
    `Worker token for agent ${agentId}, ${token.expiresAt ? `expires ${token.expiresAt}` : "no expiry"}.`,
  );
  if (token.previousExpiresAt)
    stderr(`The previous token stops working at ${token.previousExpiresAt}.`);
  stderr(`Set it as the worker's API_KEY with AGENT_ID=${agentId}. It is shown only once.`);
  stdout(token.plaintext);
  return 0;
}
