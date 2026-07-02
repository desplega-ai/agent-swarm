import type { IncomingMessage, ServerResponse } from "node:http";

export type RouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  pathSegments: string[];
  queryParams: URLSearchParams;
  myAgentId: string | undefined;
};

/** A route handler returns true if it handled the request, false otherwise */
export type RouteHandler = (ctx: RouteContext) => Promise<boolean>;
