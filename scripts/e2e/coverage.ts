import type { ApiClient, HttpCall } from "./http";
import { asRecord, expectStatus } from "./http";

type Operation = { method: string; template: string; group: string; literalSegments: number };

export type Coverage = {
  routes: {
    total: number;
    covered: number;
    percent: number;
    byGroup: Record<string, { total: number; covered: number }>;
    uncovered: string[];
    unknown: string[];
  };
  mcpTools: { total: number; covered: number; percent: number; uncovered: string[] };
};

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function templateRegex(template: string): RegExp {
  const parts = template
    .split("/")
    .map((part) => (/^\{[^}]+\}$/.test(part) ? "[^/]+" : escapeRegex(part)));
  return new RegExp(`^${parts.join("/")}$`);
}

function groupFor(template: string): string {
  const parts = template.split("/").filter(Boolean);
  return parts[0] === "api" ? (parts[1] ?? "api") : (parts[0] ?? "root");
}

function percent(covered: number, total: number): number {
  return total === 0 ? 0 : Math.round((covered / total) * 1000) / 10;
}

function readOperations(document: unknown): Operation[] {
  const paths = asRecord(asRecord(document).paths);
  const operations: Operation[] = [];
  for (const [template, pathItem] of Object.entries(paths)) {
    const item = asRecord(pathItem);
    for (const method of Object.keys(item)) {
      if (!METHODS.has(method)) continue;
      operations.push({
        method: method.toUpperCase(),
        template,
        group: groupFor(template),
        literalSegments: template
          .split("/")
          .filter((segment) => segment && !/^\{[^}]+\}$/.test(segment)).length,
      });
    }
  }
  return operations;
}

function matchOperation(call: HttpCall, operations: Operation[]): Operation | undefined {
  return operations
    .filter(
      (operation) =>
        operation.method === call.method && templateRegex(operation.template).test(call.path),
    )
    .sort((a, b) => b.literalSegments - a.literalSegments)[0];
}

export async function computeCoverage(
  api: ApiClient,
  calls: readonly HttpCall[],
  toolUniverse: ReadonlySet<string>,
  calledTools: ReadonlySet<string>,
): Promise<Coverage> {
  const response = await api("GET", "/openapi.json");
  expectStatus(response, [200], "fetch OpenAPI document");
  const operations = readOperations(response.json);
  const coveredKeys = new Set<string>();
  const unknown = new Set<string>();
  for (const call of calls) {
    const operation = matchOperation(call, operations);
    if (operation) coveredKeys.add(`${operation.method} ${operation.template}`);
    else unknown.add(`${call.method} ${call.path}`);
  }

  const byGroup: Record<string, { total: number; covered: number }> = {};
  for (const operation of operations) {
    const group = byGroup[operation.group] ?? { total: 0, covered: 0 };
    byGroup[operation.group] = {
      total: group.total + 1,
      covered:
        group.covered + (coveredKeys.has(`${operation.method} ${operation.template}`) ? 1 : 0),
    };
  }
  const uncovered = operations
    .map((operation) => `${operation.method} ${operation.template}`)
    .filter((key) => !coveredKeys.has(key))
    .sort();
  const uncoveredTools = [...toolUniverse].filter((name) => !calledTools.has(name)).sort();
  const coveredTools = [...toolUniverse].filter((name) => calledTools.has(name)).length;
  return {
    routes: {
      total: operations.length,
      covered: coveredKeys.size,
      percent: percent(coveredKeys.size, operations.length),
      byGroup,
      uncovered,
      unknown: [...unknown].sort(),
    },
    mcpTools: {
      total: toolUniverse.size,
      covered: coveredTools,
      percent: percent(coveredTools, toolUniverse.size),
      uncovered: uncoveredTools,
    },
  };
}
