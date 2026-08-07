import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import * as z from "zod";

// Patches the zod prototype with `.openapi()` BEFORE any schema module that
// names components evaluates. Files that call `.openapi("Name")` on their
// schemas (src/types.ts and friends) must import z from HERE, not from "zod",
// so the extension is guaranteed to have run — importing from "zod" directly
// works only if some other module happened to load this one first.
extendZodWithOpenApi(z);

export { z };
