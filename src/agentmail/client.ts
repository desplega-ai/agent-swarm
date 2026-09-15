/**
 * Typed fetch wrapper for the AgentMail REST API's reply-to-message endpoint.
 *
 * Confirmed against AgentMail's published OpenAPI spec (docs.agentmail.to/openapi.json,
 * `POST /v0/inboxes/{inbox_id}/messages/{message_id}/reply`): request body fields are
 * snake_case (`text`, `html`, `reply_to`, `to`, `cc`, `bcc`, `reply_all`, `attachments`,
 * `headers`, `labels`, `track_opens`), all optional. Replying via `message_id` keeps the
 * message threaded (In-Reply-To / References headers) without the caller constructing
 * them manually — see the `agentmail-sending` skill for the parallel `/messages/send`
 * (new-thread) convention, which uses the same base URL and auth scheme.
 */
export async function agentmailReplyToMessage(
  inboxId: string,
  messageId: string,
  body: { text: string },
): Promise<Response> {
  const apiKey = process.env.AGENTMAIL_API_KEY;
  if (!apiKey) {
    throw new Error("AGENTMAIL_API_KEY is not configured");
  }

  return fetch(
    `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}/reply`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: body.text }),
    },
  );
}
