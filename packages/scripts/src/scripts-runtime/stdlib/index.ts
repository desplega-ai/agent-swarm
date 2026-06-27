import { Redacted } from "../redacted";
import { runtimeFetch, runtimeFetchJson } from "./fetch";
import { glob } from "./glob";
import { grep } from "./grep";
import { table } from "./table";

export const stdlib = {
  fetch: runtimeFetch,
  fetchJson: runtimeFetchJson,
  grep,
  glob,
  table,
  Redacted,
};

export { runtimeFetch as fetch, runtimeFetchJson as fetchJson, glob, grep, table, Redacted };
