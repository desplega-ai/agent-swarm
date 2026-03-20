import { generateFiles } from "fumadocs-openapi";
import { openapi } from "../lib/openapi";

void generateFiles({
  input: openapi,
  output: "./content/docs/api-reference",
  includeDescription: true,
  groupBy: "tag",
  addGeneratedComment: true,
});
