import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const docsContentDir = resolve(repoRoot, "docs-site/content/docs");
const apiReferenceDir = resolve(repoRoot, "docs-site/content/docs/api-reference");
const baseUrl = "https://docs.agent-swarm.dev";

const retiredRoutes = ["/docs/api-reference/workflowevents", "/docs/api-reference/task-templates"];

const parentRoutes = ["/docs/api-reference/workflows", "/docs/api-reference/tasks"];

const movedOperations = [
  {
    path: "/api/workflow-runs/{runId}/events",
    method: "post",
    tag: "Workflows",
  },
  { path: "/api/workflow-events", method: "post", tag: "Workflows" },
  { path: "/api/task-templates", method: "get", tag: "Tasks" },
];

function apiReferenceRoutes() {
  return [...new Bun.Glob("*.mdx").scanSync({ cwd: apiReferenceDir })].map((file) => {
    const slug = file.slice(0, -".mdx".length);
    return slug === "index" ? "/docs/api-reference" : `/docs/api-reference/${slug}`;
  });
}

function generatedPage(route) {
  const slug = route.slice("/docs/api-reference/".length);
  return Bun.file(resolve(apiReferenceDir, `${slug}.mdx`)).text();
}

async function generatedOperationKeys() {
  const operationPattern = /{"path":"([^"]+)","method":"([^"]+)"}/g;
  const keys = [];

  for (const file of new Bun.Glob("*.mdx").scanSync({ cwd: apiReferenceDir })) {
    const content = await Bun.file(resolve(apiReferenceDir, file)).text();
    for (const match of content.matchAll(operationPattern)) {
      keys.push(`${match[2]} ${match[1]}`);
    }
  }

  return keys;
}

function contentRoutes() {
  return [...new Bun.Glob("**/*.mdx").scanSync({ cwd: docsContentDir })].map((file) => {
    const slug = file
      .replace(/^\(documentation\)\//, "")
      .replace(/\.mdx$/, "")
      .replace(/\/index$/, "");
    return slug === "index" ? "/docs" : `/docs/${slug}`;
  });
}

describe("docs API index footprint", () => {
  test("generated API pages consolidate retired tags into their parents", async () => {
    const routes = apiReferenceRoutes();

    expect(new Set(routes).size).toBe(routes.length);
    for (const route of retiredRoutes) {
      expect(routes).not.toContain(route);
      expect(
        await Bun.file(resolve(apiReferenceDir, `${route.split("/").at(-1)}.mdx`)).exists(),
      ).toBe(false);
    }
    for (const route of parentRoutes) {
      expect(routes).toContain(route);
    }

    const workflows = await generatedPage("/docs/api-reference/workflows");
    const tasks = await generatedPage("/docs/api-reference/tasks");
    expect(workflows).toContain('"path":"/api/workflow-runs/{runId}/events","method":"post"');
    expect(workflows).toContain('"path":"/api/workflow-events","method":"post"');
    expect(tasks).toContain('"path":"/api/task-templates","method":"get"');
  });

  test("OpenAPI and generated pages keep all 351 operations", async () => {
    const spec = await Bun.file(resolve(repoRoot, "openapi.json")).json();
    const operationKeys = [];
    const tags = new Set();

    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (!["get", "post", "put", "patch", "delete", "head", "options"].includes(method)) {
          continue;
        }
        operationKeys.push(`${method} ${path}`);
        for (const tag of operation.tags ?? []) tags.add(tag);
      }
    }

    expect(new Set(operationKeys).size).toBe(operationKeys.length);
    expect(tags.has("WorkflowEvents")).toBe(false);
    expect(tags.has("Task Templates")).toBe(false);

    for (const operation of movedOperations) {
      expect(spec.paths[operation.path]?.[operation.method]?.tags).toEqual([operation.tag]);
    }

    const generatedKeys = await generatedOperationKeys();
    expect(operationKeys).toHaveLength(351);
    expect(generatedKeys).toHaveLength(351);
    expect(new Set(generatedKeys)).toEqual(new Set(operationKeys));
  });

  test("keeps retired routes out of the 135-page sitemap source inventory", async () => {
    const urls = contentRoutes().map((route) => `${baseUrl}${route}`);
    const sitemapSource = await Bun.file(resolve(repoRoot, "docs-site/app/sitemap.ts")).text();

    expect(sitemapSource).toContain("source.getPages().map((page) => ({");
    expect(sitemapSource).toMatch(/url:\s*`\$\{baseUrl\}\$\{page\.url\}`/);
    expect(urls).toHaveLength(135);
    expect(new Set(urls).size).toBe(urls.length);
    for (const route of retiredRoutes) {
      expect(urls).not.toContain(`${baseUrl}${route}`);
    }
    for (const route of parentRoutes) {
      expect(urls).toContain(`${baseUrl}${route}`);
    }
  });

  test("retired HTML and Markdown routes redirect with 301", async () => {
    const config = (await Bun.file(resolve(repoRoot, "docs-site/next.config.mjs")).text()).replace(
      /\s+/g,
      "",
    );

    expect(config).toContain(
      '{source:"/docs/api-reference/workflowevents",destination:"/docs/api-reference/workflows",statusCode:301,}',
    );
    expect(config).toContain(
      '{source:"/docs/api-reference/task-templates",destination:"/docs/api-reference/tasks",statusCode:301,}',
    );
    for (const extension of [".md", ".mdx"]) {
      expect(config).toContain(
        `{source:"/docs/api-reference/workflowevents${extension}",destination:"/docs/api-reference/workflows${extension}",statusCode:301,}`,
      );
      expect(config).toContain(
        `{source:"/docs/api-reference/task-templates${extension}",destination:"/docs/api-reference/tasks${extension}",statusCode:301,}`,
      );
    }
  });
});
