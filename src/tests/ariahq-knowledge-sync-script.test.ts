import { describe, expect, test } from "bun:test";
import ariaKnowledgeSync from "../be/seed-scripts/catalog/ariahq-knowledge-sync";

describe("ariahq-knowledge-sync seed script", () => {
  test("maps an OpenAPI page, advances its cursor, and commits evidence", async () => {
    const calls: Array<{ action: string; [key: string]: unknown }> = [];
    const ctx = {
      api: {
        "google-drive": {
          async listFiles(args: Record<string, unknown>) {
            expect(args).toEqual({ folderId: "root", pageToken: "cursor-1" });
            return {
              files: [
                {
                  id: "file-1",
                  version: "7",
                  name: "Operating plan",
                  text: "Jamie owns the operating plan.",
                  modifiedTime: "2026-08-11T14:00:00.000Z",
                  webViewLink: "https://drive.example/file-1",
                },
              ],
              nextPageToken: "cursor-2",
            };
          },
        },
      },
      swarm: {
        async ariahq_source(args: { action: string; [key: string]: unknown }) {
          calls.push(args);
          if (args.action === "begin") {
            return {
              success: true,
              data: {
                success: true,
                source: {
                  id: "00000000-0000-4000-8000-000000000001",
                  name: "Drive",
                  connectionSlug: "google-drive",
                  cursor: "cursor-1",
                  syncConfig: {
                    listOperation: "listFiles",
                    listArgs: { folderId: "root" },
                    recordsPath: "files",
                    cursor: { requestPath: "pageToken", responsePath: "nextPageToken" },
                    fieldMap: {
                      sourceRef: "id",
                      sourceRevision: "version",
                      title: "name",
                      content: "text",
                      sourceUrl: "webViewLink",
                      effectiveAt: "modifiedTime",
                    },
                  },
                },
                run: { id: "00000000-0000-4000-8000-000000000002" },
              },
            };
          }
          return { success: true, data: { success: true } };
        },
      },
    };

    const result = await ariaKnowledgeSync(
      { sourceId: "00000000-0000-4000-8000-000000000001" },
      ctx,
    );

    expect(result).toEqual({ recordsSeen: 1, nextCursor: "cursor-2" });
    expect(calls[1]).toMatchObject({
      action: "commit",
      nextCursor: "cursor-2",
      records: [
        {
          sourceRef: "file-1",
          sourceRevision: "7",
          title: "Operating plan",
          content: "Jamie owns the operating plan.",
        },
      ],
    });
  });

  test("records a scrub-safe failed run when provider mapping fails", async () => {
    const calls: Array<{ action: string; [key: string]: unknown }> = [];
    const ctx = {
      api: {
        hubspot: {
          async contacts() {
            return { results: [{ id: "1" }] };
          },
        },
      },
      swarm: {
        async ariahq_source(args: { action: string; [key: string]: unknown }) {
          calls.push(args);
          if (args.action === "begin") {
            return {
              success: true,
              data: {
                success: true,
                source: {
                  id: "00000000-0000-4000-8000-000000000003",
                  name: "HubSpot",
                  connectionSlug: "hubspot",
                  syncConfig: {
                    listOperation: "contacts",
                    recordsPath: "results",
                    fieldMap: { sourceRef: "id" },
                  },
                },
                run: { id: "00000000-0000-4000-8000-000000000004" },
              },
            };
          }
          return { success: true, data: { success: true } };
        },
      },
    };

    await expect(
      ariaKnowledgeSync({ sourceId: "00000000-0000-4000-8000-000000000003" }, ctx),
    ).rejects.toThrow("missing required field mapping");
    expect(calls.at(-1)).toMatchObject({ action: "fail" });
  });
});
