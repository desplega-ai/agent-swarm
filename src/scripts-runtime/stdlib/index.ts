import { Redacted } from "../redacted";
import { runtimeFetch } from "./fetch";
import { glob } from "./glob";
import { grep } from "./grep";
import { table } from "./table";

export const stdlib = {
  fetch: runtimeFetch,
  grep,
  glob,
  table,
  Redacted,
};

export { runtimeFetch as fetch, glob, grep, table, Redacted };
