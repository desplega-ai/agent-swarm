import { openapi } from "@/lib/openapi";
import { createAPIPage } from "fumadocs-openapi/ui";
import client from "./api-page.client";

export const APIPage = createAPIPage(openapi, {
  client,
  // The spec's only server is the reader's own `http://localhost:3013`, so "Send" would
  // call their machine. Every page still shows the request and response shapes.
  playground: { enabled: false },
});
