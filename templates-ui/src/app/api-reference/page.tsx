import type { Metadata } from "next";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { Badge } from "@/components/ui/badge";

export const metadata: Metadata = {
  title: "API",
  description:
    "Public HTTP API for the Agent Swarm template registry. Fetch agent templates, skills, schedules, and workflows as JSON.",
  openGraph: {
    title: "Agent Swarm Templates — API",
    description:
      "Public HTTP API for the Agent Swarm template registry. Fetch agent templates, skills, schedules, and workflows as JSON.",
    url: "https://templates.agent-swarm.dev/api-reference",
  },
};

const BASE_URL = "https://templates.agent-swarm.dev";

interface Endpoint {
  method: string;
  path: string;
  summary: string;
  description: string;
  params?: { name: string; desc: string }[];
  example: string;
  response: string;
}

const endpoints: Endpoint[] = [
  {
    method: "GET",
    path: "/api/templates",
    summary: "List everything in the registry",
    description:
      "Returns every agent template and every asset (skills, schedules, workflows) in a single payload. Use this to mirror or index the full registry.",
    example: `curl ${BASE_URL}/api/templates`,
    response: `{
  "templates": [
    {
      "name": "coder",
      "displayName": "Coder",
      "description": "...",
      "version": "1.0.0",
      "category": "official",
      "agentDefaults": { "role": "worker", "capabilities": ["core"], "maxTasks": 3 },
      "files": { "claudeMd": "CLAUDE.md", "soulMd": "SOUL.md", ... }
    }
  ],
  "assets": [
    {
      "kind": "skill",
      "name": "linear-interaction",
      "displayName": "Linear Interaction",
      "slug": "linear-interaction",
      "category": "skills",
      "version": "1.0.0",
      "placeholders": ["LINEAR_PROJECT_ID"],
      "must": true,
      "tags": ["linear", "tracker"]
    }
  ]
}`,
  },
  {
    method: "GET",
    path: "/api/templates/{category}/{name}",
    summary: "Fetch one template or asset (with file bodies)",
    description:
      "Returns a single item by category and name, including its full content. For agent templates the response carries the resolved file bodies (CLAUDE.md, SOUL.md, …). For assets it carries the rendered markdown body (skill content, schedule task, or workflow definition).",
    params: [
      {
        name: "category",
        desc: 'Agent templates: "official" or "community". Assets: "skills", "schedules", or "workflows".',
      },
      { name: "name", desc: "The slug of the template/asset, e.g. linear-interaction." },
    ],
    example: `# An asset (skill / schedule / workflow)
curl ${BASE_URL}/api/templates/skills/linear-interaction

# An agent template
curl ${BASE_URL}/api/templates/official/coder

# Pin an agent template version (optional @version suffix)
curl ${BASE_URL}/api/templates/official/coder@1.0.0`,
    response: `// Asset response
{
  "config": { "kind": "skill", "name": "linear-interaction", "must": true, ... },
  "body": "# Linear Interaction\\n\\nThe swarm's Linear integration is..."
}

// Agent template response
{
  "config": { "name": "coder", "agentDefaults": { ... }, ... },
  "files": { "claudeMd": "...", "soulMd": "...", "toolsMd": "...", ... }
}`,
  },
];

function MethodBadge({ method }: { method: string }) {
  return (
    <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 font-mono text-xs font-semibold text-emerald-600 dark:text-emerald-400">
      {method}
    </span>
  );
}

export default function ApiReferencePage() {
  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-12">
        <div className="mb-10">
          <h1 className="text-3xl font-bold tracking-tight">API Reference</h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            The template registry is backed by a small, public, read-only HTTP API. Agent-swarm
            workers and external tooling use it to fetch templates and assets as JSON. No
            authentication is required, and every endpoint sends permissive CORS headers
            (<code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">Access-Control-Allow-Origin: *</code>),
            so it is safe to call directly from a browser.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Base URL</span>
            <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs">{BASE_URL}</code>
          </div>
        </div>

        <div className="space-y-8">
          {endpoints.map((ep) => (
            <section
              key={ep.path}
              className="rounded-lg border border-border bg-card/50 p-6"
            >
              <div className="flex flex-wrap items-center gap-3">
                <MethodBadge method={ep.method} />
                <code className="font-mono text-sm font-semibold">{ep.path}</code>
              </div>
              <h2 className="mt-3 text-lg font-semibold">{ep.summary}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{ep.description}</p>

              {ep.params && (
                <div className="mt-4">
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Path parameters
                  </h3>
                  <ul className="space-y-1.5">
                    {ep.params.map((p) => (
                      <li key={p.name} className="text-sm">
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                          {p.name}
                        </code>{" "}
                        <span className="text-muted-foreground">— {p.desc}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Example request
                  </h3>
                  <pre className="overflow-x-auto rounded-md bg-muted p-4 text-xs">
                    <code>{ep.example}</code>
                  </pre>
                </div>
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Response (shape)
                  </h3>
                  <pre className="overflow-x-auto rounded-md bg-muted p-4 text-xs">
                    <code>{ep.response}</code>
                  </pre>
                </div>
              </div>
            </section>
          ))}
        </div>

        <section className="mt-8 rounded-lg border border-border bg-card/50 p-6">
          <h2 className="text-lg font-semibold">Notes &amp; conventions</h2>
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            <li>
              <Badge variant="outline" className="mr-2 text-xs">
                404
              </Badge>
              Unknown category/name returns{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">
                {`{ "error": "..." }`}
              </code>{" "}
              with a 404 status.
            </li>
            <li>
              <Badge variant="outline" className="mr-2 text-xs">
                versions
              </Badge>
              Agent templates accept an optional{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">@version</code> suffix;
              a mismatch returns 404 listing the available version.
            </li>
            <li>
              <Badge variant="outline" className="mr-2 text-xs">
                assets
              </Badge>
              Workflow asset bodies embed a runnable workflow definition as a fenced{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">```json</code> block —
              copy it straight into <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">create-workflow</code>.
            </li>
          </ul>
        </section>
      </main>
      <Footer />
    </div>
  );
}
