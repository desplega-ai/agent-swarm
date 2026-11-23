// Memory: store records with unique markers, read each one back, find each
// one with a search that used the hybrid or vector path, then delete them.
// Embeddings come from the swarm's own embedding server. No LLM is called.
const ANIMALS = ["walrus", "heron", "pangolin", "axolotl", "ibex", "tapir", "quokka", "narwhal"];
const COLORS = ["violet", "amber", "teal", "crimson", "ochre", "indigo", "jade", "coral"];
const PLACES = ["Reykjavik", "Valparaiso", "Tbilisi", "Windhoek", "Hobart", "Ushuaia"];

function pick(list: string[], seed: number): string {
  return list[seed % list.length] ?? "thing";
}

export default async function (_args: unknown, ctx: ScriptContext) {
  return stressRun(ctx, "memory", async (t, env) => {
    const count = 3 * env.level;
    const records = Array.from({ length: count }, (_, i) => {
      const seed = Math.floor(Math.random() * 1_000_000);
      const phrase = `${pick(COLORS, seed)} ${pick(ANIMALS, seed >> 3)} counts ${seed} lanterns in ${pick(PLACES, seed >> 6)}`;
      return {
        name: `stress-mem-${env.id}-${i}`,
        phrase,
        // One record in three carries characters that are hard to store.
        content: `Stress pack synthetic record, not a real memory, ignore it. A ${phrase}.${
          i % 3 === 0 ? " Marks: 😀 𝄞 שלום é 'quote' \\ %_" : ""
        }`,
        id: "",
      };
    });

    // 1. Store, in parallel.
    const stored = (await Promise.all(
      records.map((r) =>
        ctx.swarm.memory_store({
          name: r.name,
          content: r.content,
          scope: "agent",
          tags: ["stress-pack"],
        }),
      ),
    )) as Sdk[];
    stored.forEach((res, i) => {
      const record = records[i];
      if (record) record.id = res.data?.memoryIds?.[0] ?? "";
    });
    const storeProblems = stored
      .filter((res) => !res.success || !res.data?.memoryIds?.length)
      .map((res) => `HTTP ${res.status} ${JSON.stringify(res.data).slice(0, 160)}`);
    t.ok("store-returns-an-id", storeProblems.length === 0, storeProblems.slice(0, 3));

    // 2. Read each one back by id. The content must be unchanged.
    const readProblems: unknown[] = [];
    await Promise.all(
      records
        .filter((r) => r.id)
        .map(async (r) => {
          const got = (await ctx.swarm.memory_get({
            id: r.id,
            intent: "stress pack self-check",
          })) as Sdk;
          const content = got.data?.content ?? got.data?.memory?.content;
          if (!got.success || content !== r.content) {
            readProblems.push({
              status: got.status,
              want: r.content.slice(-40),
              got: String(content).slice(-40),
            });
          }
        }),
    );
    t.ok("read-back-by-id-is-unchanged", readProblems.length === 0, readProblems.slice(0, 3));

    // 3. Find each one with a search. The embedding is written in the
    //    background, so the search is tried a few times.
    const found = new Map<string, string>();
    let searchStatus = 0;
    let attempts = 0;
    for (; attempts < 3 && found.size < records.length; attempts++) {
      await sleep(1000);
      await Promise.all(
        records
          .filter((r) => r.id && !found.has(r.id))
          .map(async (r) => {
            const res = (await ctx.swarm.memory_search({
              query: r.phrase,
              intent: "stress pack self-check",
              scope: "agent",
              limit: 10,
            })) as Sdk;
            searchStatus = res.status;
            const hit = ((res.data?.results ?? []) as Any[]).find((item) => item.id === r.id);
            if (hit) found.set(r.id, String(hit.retrievalSource ?? "unknown"));
          }),
      );
    }
    t.ok("search-finds-every-record", found.size === records.length, {
      found: found.size,
      want: records.length,
      searchStatus,
      attempts,
    });
    const paths = [...new Set(found.values())];
    t.ok(
      "search-used-vector-or-hybrid-path",
      found.size > 0 && paths.every((path) => path === "vec" || path === "hybrid"),
      { paths },
    );

    // 4. Delete, then each id must be gone.
    const deleted = (await Promise.all(
      records.filter((r) => r.id).map((r) => ctx.swarm.memory_delete({ id: r.id })),
    )) as Sdk[];
    t.ok(
      "delete-succeeds",
      deleted.every((res) => res.success),
      deleted.map((res) => res.status),
    );
    const after = (await Promise.all(
      records
        .filter((r) => r.id)
        .map((r) => ctx.swarm.memory_get({ id: r.id, intent: "stress pack self-check" })),
    )) as Sdk[];
    t.ok(
      "deleted-records-are-gone",
      after.every((res) => res.status === 404),
      after.map((res) => res.status),
    );

    return { stored: records.length, found: found.size, paths, searchAttempts: attempts };
  });
}
