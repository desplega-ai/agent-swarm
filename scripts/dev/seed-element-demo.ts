#!/usr/bin/env bun
// Seeds the two-app ElementRef demo: "Contacts" exports a bound, searchable
// table element; "Directory" embeds it and feeds it a search query via props.
import { getApiKey } from "../../src/utils/api-key";

const seedPath = new URL("./element-demo.seed.json", import.meta.url);
const seed = (await Bun.file(seedPath).json()) as {
  contacts: Record<string, unknown>;
  directory: Record<string, unknown>;
  rows: Array<{ values: Record<string, unknown> }>;
};

const baseUrl = (process.env.MCP_BASE_URL ?? "http://localhost:3013").replace(/\/$/, "");
const headers = {
  Authorization: `Bearer ${getApiKey()}`,
  "Content-Type": "application/json",
};

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${path} failed (${response.status}): ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

function appIdOf(result: Record<string, unknown>): string {
  const nested = (result.app as Record<string, unknown> | undefined)?.id;
  const id = nested ?? result.appId ?? result.id;
  if (typeof id !== "string") throw new Error(`No app id in response: ${JSON.stringify(result)}`);
  return id;
}

const contactsResult = await post("/api/apps", {
  name: "Contacts",
  description: "Element-demo defining app: exports a searchable contacts table",
  definition: seed.contacts,
});
const contactsAppId = appIdOf(contactsResult);

await post(`/api/apps/${contactsAppId}/models/contact/rows/bulk`, { rows: seed.rows });

// The consumer's ElementRef `app` prop must be a literal app id, so it is
// templated in the seed file and substituted with the freshly created id here.
const directoryDefinition = JSON.parse(
  JSON.stringify(seed.directory).replaceAll("__CONTACTS_APP_ID__", contactsAppId),
) as Record<string, unknown>;

const directoryResult = await post("/api/apps", {
  name: "Directory",
  description: "Element-demo consumer app: search input + embedded Contacts table",
  definition: directoryDefinition,
});
const directoryAppId = appIdOf(directoryResult);

console.log(`Contacts app id:  ${contactsAppId}`);
console.log(`Directory app id: ${directoryAppId}`);
console.log(`Open the dashboard at /apps/${directoryAppId} to try the search.`);
