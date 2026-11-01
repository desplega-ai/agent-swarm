import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { Cleanup, registerWorker } from "./platformb-helpers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MISSING_ID = "00000000-0000-4000-8000-000000000000";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A raw GET that keeps the bytes: `ctx.api` reads the body as text, which would corrupt a binary
 * download. The call is recorded so it counts toward route coverage.
 */
async function download(
  ctx: ScenarioContext,
  path: string,
): Promise<{ status: number; bytes: Uint8Array; headers: Headers }> {
  const started = performance.now();
  const response = await fetch(`${ctx.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${ctx.apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  ctx.recordHttpCall(
    "GET",
    path.split("?")[0] ?? path,
    response.status,
    performance.now() - started,
  );
  return { status: response.status, bytes, headers: response.headers };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * The file-storage routes against the local backend (AGENT_FS_LOCAL_DIR, provider local-fs): the
 * capabilities, a task attachment's whole life (raw binary upload, list, metadata, download,
 * signed URL, delete), and the agent-fs credential and invite routes, which answer their
 * "agent-fs is not configured" contract because no agent-fs server is wired.
 */
export const platformbFs: Scenario = {
  name: "platformb-fs",
  order: 675,
  async run(ctx) {
    const cleanup = new Cleanup();
    const taskIds: string[] = [];
    cleanup.add("cancel tasks", async () => {
      for (const id of taskIds) await ctx.api("POST", `/api/tasks/${id}/cancel`, { body: {} });
    });

    await cleanup.around(async () => {
      // --- capabilities
      let response = await ctx.api("GET", "/api/fs/capabilities");
      expectStatus(response, [200], "read file-storage capabilities");
      const capabilities = asRecord(response.json);
      const signedUrl = asRecord(asRecord(capabilities.capabilities).signedUrl);
      expect(
        capabilities.providerId === "local-fs" && typeof signedUrl.supported === "boolean",
        `Capabilities are ${JSON.stringify(capabilities)}`,
      );
      expectStatus(
        await ctx.api("GET", "/api/fs/capabilities", { apiKey: null }),
        [401],
        "capabilities without a key",
      );

      // --- a task to attach files to
      const created = await ctx.api("POST", "/api/tasks", {
        body: { task: `fs attachments ${ctx.nonce}`, source: "api" },
      });
      expectStatus(created, [201], "create a task for attachments");
      const taskId = asString(asRecord(created.json).id, "task id");
      taskIds.push(taskId);
      const base = `/api/fs/tasks/${taskId}/files`;

      response = await ctx.api("GET", base);
      expectStatus(response, [200], "list attachments of a new task");
      expect(asRecords(response.json, "attachments").length === 0, "A new task has attachments");

      // --- upload a text file with every query field
      const text = new TextEncoder().encode(`hello fs ${ctx.nonce}`);
      response = await ctx.api(
        "POST",
        `${base}?name=notes-${ctx.nonce}.txt&intent=input&description=${encodeURIComponent("e2e notes")}&isPrimary=true`,
        { rawBody: new Blob([text], { type: "text/plain" }) },
      );
      expectStatus(response, [201], "upload a text attachment");
      const notes = asRecord(response.json);
      const notesId = asString(notes.id, "attachment id");
      expect(UUID.test(notesId), "Attachment id is not a UUID");
      expect(
        notes.taskId === taskId &&
          notes.name === `notes-${ctx.nonce}.txt` &&
          notes.kind === "shared-fs" &&
          notes.providerId === "local-fs" &&
          notes.path === `tasks/${taskId}/notes-${ctx.nonce}.txt` &&
          String(notes.mimeType).startsWith("text/plain") &&
          notes.sizeBytes === text.length &&
          notes.sha256 === (await sha256Hex(text)) &&
          notes.intent === "input" &&
          notes.description === "e2e notes" &&
          notes.isPrimary === true &&
          typeof notes.createdAt === "string",
        `Upload response is ${JSON.stringify(notes)}`,
      );
      const row = ctx.db.get<{
        task_id: string;
        name: string;
        size_bytes: number;
        sha256: string;
        is_primary: number;
        provider_id: string;
      }>(
        "SELECT task_id, name, size_bytes, sha256, is_primary, provider_id FROM task_attachments WHERE id = ?",
        [notesId],
      );
      expect(
        row?.task_id === taskId &&
          row.size_bytes === text.length &&
          row.sha256 === notes.sha256 &&
          row.is_primary === 1 &&
          row.provider_id === "local-fs",
        `task_attachments row is ${JSON.stringify(row)}`,
      );

      // --- upload binary content that is not valid text
      const binary = new Uint8Array(4096);
      crypto.getRandomValues(binary);
      binary[0] = 0xff;
      response = await ctx.api("POST", `${base}?name=blob-${ctx.nonce}.bin`, {
        rawBody: new Blob([binary]),
      });
      expectStatus(response, [201], "upload a binary attachment");
      const blobRecord = asRecord(response.json);
      const blobId = asString(blobRecord.id, "binary attachment id");
      expect(
        blobRecord.mimeType === "application/octet-stream" &&
          blobRecord.sizeBytes === binary.length &&
          blobRecord.sha256 === (await sha256Hex(binary)) &&
          blobRecord.isPrimary === false &&
          blobRecord.intent === undefined,
        `Binary upload response is ${JSON.stringify(blobRecord)}`,
      );

      // --- list and metadata
      response = await ctx.api("GET", base);
      expectStatus(response, [200], "list attachments");
      const attachments = asRecords(response.json, "attachments");
      expect(
        attachments.length === 2 &&
          attachments.some((attachment) => attachment.id === notesId) &&
          attachments.some((attachment) => attachment.id === blobId),
        `Attachment list has ${attachments.length} entries`,
      );
      response = await ctx.api("GET", `${base}/${notesId}`);
      expectStatus(response, [200], "read attachment metadata");
      expect(
        JSON.stringify(response.json) === JSON.stringify(notes),
        "Metadata differs from the upload response",
      );

      // --- raw download returns the exact bytes
      const rawText = await download(ctx, `${base}/${notesId}/raw`);
      expect(rawText.status === 200, `Raw text download answered ${rawText.status}`);
      expect(sameBytes(rawText.bytes, text), "Raw text download differs from the upload");
      expect(
        (rawText.headers.get("content-type") ?? "").startsWith("text/plain") &&
          rawText.headers.get("content-length") === String(text.length) &&
          (rawText.headers.get("content-disposition") ?? "").includes(
            `filename="notes-${ctx.nonce}.txt"`,
          ),
        `Raw text headers are ${rawText.headers.get("content-type")} / ${rawText.headers.get("content-disposition")}`,
      );
      const rawBinary = await download(ctx, `${base}/${blobId}/raw`);
      expect(rawBinary.status === 200, `Raw binary download answered ${rawBinary.status}`);
      expect(sameBytes(rawBinary.bytes, binary), "Raw binary download differs from the upload");

      // --- signed URL: the local provider has none, an agent-fs provider would
      response = await ctx.api("GET", `${base}/${notesId}/signed-url?expiresIn=600`);
      if (signedUrl.supported === true) {
        expectStatus(response, [200], "signed URL from a provider that supports them");
        expect(
          typeof asRecord(response.json).url === "string" &&
            asRecord(response.json).expiresIn === 600,
          "Signed URL response is malformed",
        );
      } else {
        expectStatus(response, [501], "signed URL from the local provider");
        expect(
          String(asRecord(response.json).error).includes("does not support signed URLs"),
          `Signed URL refusal is ${String(asRecord(response.json).error)}`,
        );
      }
      expectStatus(
        await ctx.api("GET", `${base}/${notesId}/signed-url?expiresIn=9999`),
        [400],
        "signed URL beyond the hour cap",
      );

      // --- upload negatives
      expectStatus(
        await ctx.api("POST", base, { rawBody: new Blob([text], { type: "text/plain" }) }),
        [400],
        "upload without a name",
      );
      expectStatus(
        await ctx.api("POST", `${base}?name=x.txt&isPrimary=yes`, { rawBody: new Blob([text]) }),
        [400],
        "upload with a bad isPrimary",
      );
      expectStatus(
        await ctx.api("POST", `/api/fs/tasks/${MISSING_ID}/files?name=x.txt`, {
          rawBody: new Blob([text]),
        }),
        [404],
        "upload to a missing task",
      );
      expectStatus(
        await ctx.api("POST", "/api/fs/tasks/not-a-uuid/files?name=x.txt", {
          rawBody: new Blob([text]),
        }),
        [400],
        "upload to a task id that is not a UUID",
      );
      response = await ctx.api("POST", `${base}?name=too-big.bin`, {
        rawBody: new Blob([new Uint8Array(50 * 1024 * 1024 + 1)]),
      });
      expectStatus(response, [413], "upload over the 50 MiB cap");
      expect(
        asRecords((await ctx.api("GET", base)).json, "attachments").length === 2,
        "A rejected upload left an attachment",
      );
      expectStatus(
        await ctx.api("POST", `${base}?name=nokey.txt`, {
          apiKey: null,
          rawBody: new Blob([text]),
        }),
        [401],
        "upload without a key",
      );

      // --- read and delete negatives
      for (const [label, suffix] of [
        ["metadata", ""],
        ["raw", "/raw"],
        ["signed-url", "/signed-url"],
      ] as const) {
        expectStatus(
          await ctx.api("GET", `${base}/${MISSING_ID}${suffix}`),
          [404],
          `${label} of a missing attachment`,
        );
        expectStatus(
          await ctx.api("GET", `/api/fs/tasks/${MISSING_ID}/files/${notesId}${suffix}`),
          [404],
          `${label} on a missing task`,
        );
      }
      expectStatus(
        await ctx.api("GET", `${base}/not-a-uuid`),
        [400],
        "metadata of an attachment id that is not a UUID",
      );
      expectStatus(
        await ctx.api("DELETE", `${base}/${MISSING_ID}`),
        [404],
        "delete a missing attachment",
      );
      expectStatus(
        await ctx.api("DELETE", `/api/fs/tasks/${MISSING_ID}/files/${notesId}`),
        [404],
        "delete on a missing task",
      );

      // --- delete removes the row and the bytes
      expectStatus(await ctx.api("DELETE", `${base}/${notesId}`), [204], "delete the text file");
      expectStatus(await ctx.api("DELETE", `${base}/${notesId}`), [404], "delete it twice");
      expectStatus(await ctx.api("GET", `${base}/${notesId}`), [404], "read the deleted file");
      expect(
        (await download(ctx, `${base}/${notesId}/raw`)).status === 404,
        "A deleted file can still be downloaded",
      );
      expect(
        ctx.db.get("SELECT id FROM task_attachments WHERE id = ?", [notesId]) === null,
        "The deleted attachment is still in task_attachments",
      );
      response = await ctx.api("GET", base);
      expect(
        asRecords(response.json, "attachments")
          .map((attachment) => attachment.id)
          .join() === blobId,
        "Only the binary attachment should remain",
      );
      expect(
        sameBytes((await download(ctx, `${base}/${blobId}/raw`)).bytes, binary),
        "Deleting one attachment disturbed another",
      );
      expectStatus(await ctx.api("DELETE", `${base}/${blobId}`), [204], "delete the binary file");

      // --- agent-fs credentials: the local backend has no agent-fs account to provision.
      const workerId = await registerWorker(ctx, `e2e-platformb-fs-${ctx.nonce}`);
      expectStatus(
        await ctx.api("POST", "/api/fs/agent-credentials", { body: {} }),
        [400],
        "agent-credentials without X-Agent-ID",
      );
      response = await ctx.api("POST", "/api/fs/agent-credentials", {
        agentId: workerId,
        body: {},
      });
      expectStatus(response, [200], "agent-credentials with the local backend");
      expect(
        asRecord(response.json).enabled === false &&
          asRecord(response.json).created === false &&
          asRecord(response.json).agentId === workerId,
        `agent-credentials answered ${JSON.stringify(response.json)}`,
      );
      expectStatus(
        await ctx.api("POST", "/api/fs/agent-credentials", { apiKey: null, agentId: workerId }),
        [401],
        "agent-credentials without a key",
      );

      // --- invite: validated first, then refused because no agent-fs server is configured.
      expectStatus(
        await ctx.api("POST", "/api/fs/members/invite", { body: { email: "not-an-email" } }),
        [400],
        "invite a bad email",
      );
      expectStatus(
        await ctx.api("POST", "/api/fs/members/invite", {
          body: { email: `e2e-${ctx.nonce}@example.invalid`, role: "owner" },
        }),
        [400],
        "invite with an unknown role",
      );
      response = await ctx.api("POST", "/api/fs/members/invite", {
        body: { email: `e2e-${ctx.nonce}@example.invalid` },
      });
      expectStatus(response, [500], "invite with no agent-fs server");
      expect(
        String(asRecord(response.json).error).includes("AGENT_FS_API_URL is not configured"),
        `Invite error is ${String(asRecord(response.json).error)}`,
      );
      expectStatus(
        await ctx.api("POST", "/api/fs/members/invite", {
          apiKey: null,
          body: { email: `e2e-${ctx.nonce}@example.invalid` },
        }),
        [401],
        "invite without a key",
      );
    });
  },
};
