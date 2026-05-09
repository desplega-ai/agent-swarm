import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { createUser, getAllUsers, getUserById, updateUser } from "../be/db";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const listUsers = route({
  method: "get",
  path: "/api/users",
  pattern: ["api", "users"],
  summary: "List all users",
  tags: ["Users"],
  responses: {
    200: { description: "List of users" },
    401: { description: "Unauthorized" },
  },
  auth: { apiKey: true },
});

const createUserRoute = route({
  method: "post",
  path: "/api/users",
  pattern: ["api", "users"],
  summary: "Create a new user",
  tags: ["Users"],
  body: z.object({
    name: z.string().min(1),
    email: z.string().optional(),
    role: z.string().optional(),
    notes: z.string().optional(),
    slackUserId: z.string().optional(),
    linearUserId: z.string().optional(),
    githubUsername: z.string().optional(),
    gitlabUsername: z.string().optional(),
    emailAliases: z.array(z.string()).optional(),
    preferredChannel: z.string().optional(),
    timezone: z.string().optional(),
  }),
  responses: {
    200: { description: "User created" },
    400: { description: "Validation error" },
    401: { description: "Unauthorized" },
  },
  auth: { apiKey: true },
});

const updateUserRoute = route({
  method: "put",
  path: "/api/users/{id}",
  pattern: ["api", "users", null],
  summary: "Update an existing user (partial — at least one field required)",
  tags: ["Users"],
  params: z.object({ id: z.string() }),
  body: z
    .object({
      name: z.string().min(1).optional(),
      email: z.string().optional(),
      role: z.string().optional(),
      notes: z.string().optional(),
      slackUserId: z.string().optional(),
      linearUserId: z.string().optional(),
      githubUsername: z.string().optional(),
      gitlabUsername: z.string().optional(),
      emailAliases: z.array(z.string()).optional(),
      preferredChannel: z.string().optional(),
      timezone: z.string().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, {
      message: "At least one field must be provided",
    }),
  responses: {
    200: { description: "User updated" },
    400: { description: "Validation error or empty body" },
    401: { description: "Unauthorized" },
    404: { description: "User not found" },
  },
  auth: { apiKey: true },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleUsers(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (listUsers.match(req.method, pathSegments)) {
    const parsed = await listUsers.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const users = getAllUsers();
    json(res, { users });
    return true;
  }

  if (createUserRoute.match(req.method, pathSegments)) {
    const parsed = await createUserRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    try {
      const user = createUser(parsed.body);
      json(res, { user });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Failed to create user", 500);
    }
    return true;
  }

  if (updateUserRoute.match(req.method, pathSegments)) {
    const parsed = await updateUserRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    // 404 if user not found before update — keeps the contract honest.
    if (!getUserById(parsed.params.id)) {
      jsonError(res, "User not found", 404);
      return true;
    }

    try {
      const user = updateUser(parsed.params.id, parsed.body);
      if (!user) {
        jsonError(res, "User not found", 404);
        return true;
      }
      json(res, { user });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Failed to update user", 500);
    }
    return true;
  }

  return false;
}
