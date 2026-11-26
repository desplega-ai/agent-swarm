import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getLinkPreview, LinkPreviewRefusedError } from "../be/link-preview";
import { route } from "./route-def";
import { jsonError } from "./utils";

const LinkPreviewSchema = z.object({
  url: z.string(),
  ok: z.boolean(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  image: z.string().nullable(),
  siteName: z.string().nullable(),
});

const linkPreviewRoute = route({
  method: "get",
  path: "/api/link-preview",
  pattern: ["api", "link-preview"],
  summary: "Get the Open Graph preview of an external link",
  description:
    "Fetches the page server-side (cached) and returns its title, description, image and site name. " +
    "`ok: false` when the page could not be read. Loopback and private hosts are refused with 400.",
  tags: ["Tasks"],
  query: z.object({ url: z.string().min(1).max(2048) }),
  responses: {
    200: {
      description: "The preview, or `ok: false` with empty fields",
      schema: LinkPreviewSchema,
    },
    400: { description: "Missing, malformed or refused URL" },
  },
});

export async function handleLinkPreview(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (!linkPreviewRoute.match(req.method, pathSegments)) return false;
  const parsed = await linkPreviewRoute.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;
  try {
    linkPreviewRoute.respond(res, 200, await getLinkPreview(parsed.query.url));
  } catch (error) {
    if (!(error instanceof LinkPreviewRefusedError)) throw error;
    jsonError(res, error.message, 400);
  }
  return true;
}
