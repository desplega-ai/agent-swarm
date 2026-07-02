import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { resolveHttpAuditUserId } from "../be/audit-user";
import { listUserFavorites, setUserFavorite } from "../be/db";
import { FavoriteItemTypeSchema } from "../types";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

const listFavorites = route({
  method: "get",
  path: "/api/favorites",
  pattern: ["api", "favorites"],
  summary: "List favorites for the authenticated user",
  tags: ["Favorites"],
  query: z.object({
    itemType: FavoriteItemTypeSchema.optional(),
    itemIds: z.string().optional(),
  }),
  responses: {
    200: { description: "Favorite rows and favorite item ids" },
    401: { description: "No authenticated user context" },
  },
});

const putFavorite = route({
  method: "put",
  path: "/api/favorites",
  pattern: ["api", "favorites"],
  summary: "Set favorite state for an item",
  tags: ["Favorites"],
  body: z.object({
    itemType: FavoriteItemTypeSchema,
    itemId: z.string().min(1),
    favorite: z.boolean(),
  }),
  responses: {
    200: { description: "Favorite state" },
    401: { description: "No authenticated user context" },
  },
});

export async function handleFavorites(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (listFavorites.match(req.method, pathSegments)) {
    const parsed = await listFavorites.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const userId = resolveHttpAuditUserId(req, myAgentId);
    if (!userId) {
      jsonError(res, "Authenticated user required to read favorites", 401);
      return true;
    }
    const itemIds = parsed.query.itemIds
      ?.split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const favorites = listUserFavorites({
      userId,
      itemType: parsed.query.itemType,
      itemIds,
    });
    json(res, {
      favorites,
      favoriteIds: favorites.map((favorite) => favorite.itemId),
    });
    return true;
  }

  if (putFavorite.match(req.method, pathSegments)) {
    const parsed = await putFavorite.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const userId = resolveHttpAuditUserId(req, myAgentId);
    if (!userId) {
      jsonError(res, "Authenticated user required to update favorites", 401);
      return true;
    }
    const favorite = setUserFavorite({
      userId,
      itemType: parsed.body.itemType,
      itemId: parsed.body.itemId,
      favorite: parsed.body.favorite,
      actorUserId: userId,
    });
    json(res, {
      favorite: parsed.body.favorite,
      itemType: parsed.body.itemType,
      itemId: parsed.body.itemId,
      row: favorite,
    });
    return true;
  }

  return false;
}
