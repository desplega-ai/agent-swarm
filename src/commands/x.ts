import { scrubSecrets } from "../utils/secret-scrubber";
import {
  DEFAULT_COMPOSIO_BASE_URL,
  executeComposioRequest,
  formatComposioResultForCli,
  parseComposioArgs,
} from "../x/composio";

interface XCommandDeps {
  env?: Record<string, string | undefined>;
  error?: (message: string) => void;
  exit?: (code: number) => void;
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

export { parseComposioArgs } from "../x/composio";

export async function runXCommand(argv: string[], deps: XCommandDeps = {}): Promise<void> {
  const [target, ...rest] = argv;
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const exit = deps.exit ?? process.exit;

  if (!target || target === "help" || target === "-h" || target === "--help") {
    printXHelp(log);
    return;
  }

  switch (target) {
    case "composio":
      await runComposioCommand(rest, deps);
      return;
    default:
      error(`Unknown x target: ${target}`);
      printXHelp(error);
      exit(1);
  }
}

export async function runComposioCommand(argv: string[], deps: XCommandDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const exit = deps.exit ?? process.exit;
  const env = deps.env ?? process.env;

  if (argv.length === 0 || argv[0] === "help" || argv[0] === "-h" || argv[0] === "--help") {
    printComposioHelp(log);
    return;
  }

  let parsed: ReturnType<typeof parseComposioArgs>;
  try {
    parsed = parseComposioArgs(argv, env);
  } catch (err) {
    error(`composio: ${scrubSecrets(errorMessage(err))}`);
    printComposioHelp(error);
    exit(1);
    return;
  }

  const result = await executeComposioRequest(parsed, { env, fetch: deps.fetch });

  if (!result.ok) {
    if (result.status > 0) error(`composio: HTTP ${result.status} ${result.statusText}`.trim());
    else error(`composio: ${result.error ?? result.statusText}`);
    if (result.formattedBody) error(result.formattedBody);
    exit(1);
    return;
  }

  log(formatComposioResultForCli(result));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function printXHelp(log: (message: string) => void): void {
  log(`Usage: agent-swarm x <target> [args]

Targets:
  composio    Route a request to the Composio REST API

Examples:
  agent-swarm x composio GET /tools
  agent-swarm x composio POST /tools/execute/GITHUB_CREATE_AN_ISSUE --body '{"arguments":{}}'`);
}

function printComposioHelp(log: (message: string) => void): void {
  log(`Usage: agent-swarm x composio <method> <path> [options]

Routes an HTTP request to the Composio REST API.

Arguments:
  <method>              GET, POST, PUT, PATCH, DELETE, or HEAD
  <path>                API path relative to ${DEFAULT_COMPOSIO_BASE_URL}

Options:
  --body, --data <json> JSON request body
  -q, --query k=v       Append a query parameter (repeatable)
  -H, --header k=v      Add a header (repeatable)
  --base-url <url>      Override base URL (default: COMPOSIO_BASE_URL or v3.1 API)
  --org                 Use COMPOSIO_ORG_API_KEY and x-org-api-key
  --raw                 Print response text without JSON pretty formatting
  -h, --help            Show this help

Environment:
  COMPOSIO_API_KEY      Project API key for x-api-key auth
  COMPOSIO_ORG_API_KEY  Optional organization key for --org
  COMPOSIO_BASE_URL     Optional API base URL override

Examples:
  agent-swarm x composio GET /tools
  agent-swarm x composio GET /tools --query limit=10
  agent-swarm x composio POST /tool_router/session --body '{"user_id":"swarm"}'
  agent-swarm x composio POST /tools/execute/GITHUB_CREATE_AN_ISSUE --body '{"arguments":{}}'`);
}
