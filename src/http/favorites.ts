import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { listFavorites as listFavoriteRows, setFavorite } from "../be/db";
import { FavoriteItemTypeSchema, UserFavoriteSchema } from "../types";
import { resolveHttpFavoriteOwner } from "./favorite-owner";
import { route } from "./route-def";
import { jsonError } from "./utils";

const listFavorites = route({
  method: "get",
  path: "/api/favorites",
  pattern: ["api", "favorites"],
  summary: "List favorites for the authenticated principal",
  tags: ["Favorites"],
  query: z.object({
    itemType: FavoriteItemTypeSchema.optional(),
    itemIds: z.string().optional(),
  }),
  responses: {
    200: {
      description: "Favorite rows and favorite item ids",
      schema: z.object({
        favorites: z.array(UserFavoriteSchema),
        favoriteIds: z.array(z.string()),
      }),
    },
    401: { description: "No authenticated principal context" },
  },
});

const putFavorite = route({
  method: "put",
  path: "/api/favorites",
  pattern: ["api", "favorites"],
  summary: "Set favorite state for an item",
  tags: ["Favorites"],
  rbac: { permission: "favorite.write.own" },
  body: z.object({
    itemType: FavoriteItemTypeSchema,
    itemId: z.string().min(1),
    favorite: z.boolean(),
  }),
  responses: {
    200: {
      description: "Favorite state",
      schema: z.object({
        favorite: z.boolean(),
        itemType: FavoriteItemTypeSchema,
        itemId: z.string(),
        row: UserFavoriteSchema.nullable(),
      }),
    },
    401: { description: "No authenticated principal context" },
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
    const owner = await resolveHttpFavoriteOwner(req, myAgentId);
    if (!owner) {
      jsonError(res, "Authenticated principal required to read favorites", 401);
      return true;
    }
    const itemIds = parsed.query.itemIds
      ?.split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const favorites = await listFavoriteRows({
      favoriteScope: owner.scope,
      itemType: parsed.query.itemType,
      itemIds,
    });
    listFavorites.respond(res, 200, {
      favorites,
      favoriteIds: favorites.map((favorite) => favorite.itemId),
    });
    return true;
  }

  if (putFavorite.match(req.method, pathSegments)) {
    const parsed = await putFavorite.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const owner = await resolveHttpFavoriteOwner(req, myAgentId);
    if (!owner) {
      jsonError(res, "Authenticated principal required to update favorites", 401);
      return true;
    }
    const favorite = await setFavorite({
      favoriteScope: owner.scope,
      userId: owner.userId,
      itemType: parsed.body.itemType,
      itemId: parsed.body.itemId,
      favorite: parsed.body.favorite,
      actorId: owner.actorId,
    });
    putFavorite.respond(res, 200, {
      favorite: parsed.body.favorite,
      itemType: parsed.body.itemType,
      itemId: parsed.body.itemId,
      row: favorite,
    });
    return true;
  }

  return false;
}
